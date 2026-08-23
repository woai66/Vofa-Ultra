use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter, State};

use crate::capture::{CaptureDirection, CaptureRecorderHandle, CaptureState};

const READ_BUFFER_SIZE: usize = 16 * 1024;
const SERIAL_TIMEOUT_MS: u64 = 20;
const WRITE_QUEUE_CAPACITY: usize = 256;
const MAX_WRITE_SIZE: usize = 64 * 1024;
const WRITE_CHUNK_SIZE: usize = 4 * 1024;
const WRITE_BUDGET_PER_TICK: usize = 32 * 1024;

pub struct SerialState {
    transition: Arc<Mutex<()>>,
    shared: Arc<Mutex<SharedSerialState>>,
}

impl Default for SerialState {
    fn default() -> Self {
        Self {
            transition: Arc::new(Mutex::new(())),
            shared: Arc::new(Mutex::new(SharedSerialState::default())),
        }
    }
}

struct SharedSerialState {
    connection_request: u64,
    pending_connection_request: Option<u64>,
    generation: u64,
    revision: u64,
    status: SerialStatus,
    port_name: String,
    message: Option<String>,
    error_code: Option<SerialErrorCode>,
    worker: Option<SerialWorker>,
}

impl Default for SharedSerialState {
    fn default() -> Self {
        Self {
            connection_request: 0,
            pending_connection_request: None,
            generation: 0,
            revision: 0,
            status: SerialStatus::Disconnected,
            port_name: String::new(),
            message: None,
            error_code: None,
            worker: None,
        }
    }
}

impl SharedSerialState {
    fn transition(
        &mut self,
        status: SerialStatus,
        port_name: String,
        message: Option<String>,
        error_code: Option<SerialErrorCode>,
    ) -> SerialStatePayload {
        self.revision = self.revision.saturating_add(1);
        self.status = status;
        self.port_name = port_name;
        self.message = message;
        self.error_code = error_code;
        self.snapshot()
    }

    fn is_connecting_generation(&self, generation: u64) -> bool {
        self.generation == generation && self.status == SerialStatus::Connecting
    }

    fn is_connection_attempt_current(&self, request: u64, generation: u64) -> bool {
        self.pending_connection_request == Some(request)
            && self.is_connecting_generation(generation)
    }

    fn complete_connection(
        &mut self,
        request: u64,
        generation: u64,
        port_name: String,
    ) -> Option<SerialStatePayload> {
        if !self.is_connection_attempt_current(request, generation) {
            return None;
        }

        self.pending_connection_request = None;
        Some(self.transition(SerialStatus::Connected, port_name, None, None))
    }

    fn snapshot(&self) -> SerialStatePayload {
        SerialStatePayload {
            status: self.status.as_str().to_owned(),
            port_name: self.port_name.clone(),
            message: self.message.clone(),
            error_code: self.error_code.map(|code| code.as_str().to_owned()),
            generation: self.generation,
            revision: self.revision,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SerialStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SerialErrorCode {
    InvalidConfig,
    OpenFailed,
    DtrFailed,
    RtsFailed,
    WorkerStartFailed,
    ReadFailed,
    WriteFailed,
    WorkerPanic,
    Unknown,
}

impl SerialErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid-config",
            Self::OpenFailed => "open-failed",
            Self::DtrFailed => "dtr-failed",
            Self::RtsFailed => "rts-failed",
            Self::WorkerStartFailed => "worker-start-failed",
            Self::ReadFailed => "read-failed",
            Self::WriteFailed => "write-failed",
            Self::WorkerPanic => "worker-panic",
            Self::Unknown => "unknown",
        }
    }
}

struct SerialFailure {
    code: SerialErrorCode,
    message: String,
}

impl SerialFailure {
    fn new(code: SerialErrorCode, message: String) -> Self {
        Self { code, message }
    }
}

impl SerialStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Error => "error",
        }
    }
}

struct SerialWorker {
    generation: u64,
    command_tx: Option<mpsc::SyncSender<WorkerCommand>>,
    cancel: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl SerialWorker {
    fn stop(mut self) -> Result<(), SerialFailure> {
        self.cancel.store(true, Ordering::Release);
        drop(self.command_tx.take());

        if let Some(join_handle) = self.join_handle.take() {
            join_handle.join().map_err(|panic| {
                SerialFailure::new(
                    SerialErrorCode::WorkerPanic,
                    format!("串口工作线程异常退出: {}", panic_message(panic)),
                )
            })?;
        }
        Ok(())
    }
}

enum WorkerCommand {
    Write(Vec<u8>),
}

struct PendingWrite {
    data: Vec<u8>,
    offset: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialConfig {
    pub(crate) port_name: String,
    pub(crate) baud_rate: u32,
    pub(crate) data_bits: u8,
    pub(crate) parity: String,
    pub(crate) stop_bits: u8,
    pub(crate) flow_control: String,
    pub(crate) dtr: bool,
    pub(crate) rts: bool,
}

impl SerialConfig {
    pub(crate) fn validate(&self, require_port_name: bool) -> Result<(), String> {
        if require_port_name && self.port_name.trim().is_empty() {
            return Err("串口名称不能为空".to_owned());
        }
        if self.baud_rate == 0 {
            return Err("波特率必须大于 0".to_owned());
        }
        parse_data_bits(self.data_bits)?;
        parse_parity(&self.parity)?;
        parse_stop_bits(self.stop_bits)?;
        parse_flow_control(&self.flow_control)?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfoDto {
    name: String,
    kind: String,
    manufacturer: Option<String>,
    product: Option<String>,
    serial_number: Option<String>,
    vendor_id: Option<u16>,
    product_id: Option<u16>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialDataPayload {
    data: String,
    received_at: u64,
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialTxPayload {
    data: String,
    byte_count: usize,
    transmitted_at: u64,
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialStatePayload {
    status: String,
    port_name: String,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    generation: u64,
    revision: u64,
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfoDto>, String> {
    let ports = serialport::available_ports().map_err(|error| error.to_string())?;

    Ok(ports
        .into_iter()
        .map(|port| {
            let (kind, manufacturer, product, serial_number, vendor_id, product_id) =
                match port.port_type {
                    SerialPortType::UsbPort(info) => (
                        "usb".to_owned(),
                        info.manufacturer,
                        info.product,
                        info.serial_number,
                        Some(info.vid),
                        Some(info.pid),
                    ),
                    SerialPortType::BluetoothPort => {
                        ("bluetooth".to_owned(), None, None, None, None, None)
                    }
                    SerialPortType::PciPort => ("pci".to_owned(), None, None, None, None, None),
                    SerialPortType::Unknown => ("unknown".to_owned(), None, None, None, None, None),
                };

            SerialPortInfoDto {
                name: port.port_name,
                kind,
                manufacturer,
                product,
                serial_number,
                vendor_id,
                product_id,
            }
        })
        .collect())
}

#[tauri::command]
pub fn get_serial_state(state: State<'_, SerialState>) -> Result<SerialStatePayload, String> {
    state
        .shared
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

#[tauri::command]
pub async fn connect_serial(
    app: AppHandle,
    state: State<'_, SerialState>,
    capture_state: State<'_, CaptureState>,
    config: SerialConfig,
) -> Result<SerialStatePayload, String> {
    let request = register_connection_attempt(&state.shared)?;
    let transition = Arc::clone(&state.transition);
    let shared_state = Arc::clone(&state.shared);
    let recorder = capture_state.recorder_handle();
    let task_app = app.clone();
    let task_shared_state = Arc::clone(&shared_state);

    match tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            connect_serial_blocking(
                task_app,
                transition,
                task_shared_state,
                recorder,
                config,
                request,
            )
        }))
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(panic)) => {
            let message = format!("串口连接任务异常退出: {}", panic_message(panic));
            fail_connection_task(
                &app,
                &shared_state,
                request,
                SerialErrorCode::WorkerPanic,
                message.clone(),
            );
            Err(message)
        }
        Err(error) => {
            let message = format!("串口连接任务异常退出: {error}");
            fail_connection_task(
                &app,
                &shared_state,
                request,
                SerialErrorCode::Unknown,
                message.clone(),
            );
            Err(message)
        }
    }
}

fn connect_serial_blocking(
    app: AppHandle,
    transition: Arc<Mutex<()>>,
    shared_state: Arc<Mutex<SharedSerialState>>,
    recorder: CaptureRecorderHandle,
    config: SerialConfig,
    request: u64,
) -> Result<SerialStatePayload, String> {
    let port_name = config.port_name.clone();
    let _transition = transition.lock().map_err(|_| {
        fail_connection_task(
            &app,
            &shared_state,
            request,
            SerialErrorCode::Unknown,
            "串口生命周期锁已损坏".to_owned(),
        )
    })?;
    let generation = begin_connection(&app, &shared_state, request, &port_name)?;
    stop_current_worker(&app, &shared_state).map_err(|message| {
        fail_connection(
            &app,
            &shared_state,
            request,
            generation,
            &port_name,
            SerialErrorCode::WorkerPanic,
            message,
        )
    })?;
    ensure_connection_attempt_current(&shared_state, request, generation)?;
    config.validate(true).map_err(|message| {
        fail_connection(
            &app,
            &shared_state,
            request,
            generation,
            &port_name,
            SerialErrorCode::InvalidConfig,
            message,
        )
    })?;
    let data_bits = parse_data_bits(config.data_bits).map_err(|message| {
        fail_connection(
            &app,
            &shared_state,
            request,
            generation,
            &port_name,
            SerialErrorCode::InvalidConfig,
            message,
        )
    })?;
    let parity = parse_parity(&config.parity).map_err(|message| {
        fail_connection(
            &app,
            &shared_state,
            request,
            generation,
            &port_name,
            SerialErrorCode::InvalidConfig,
            message,
        )
    })?;
    let stop_bits = parse_stop_bits(config.stop_bits).map_err(|message| {
        fail_connection(
            &app,
            &shared_state,
            request,
            generation,
            &port_name,
            SerialErrorCode::InvalidConfig,
            message,
        )
    })?;
    let flow_control = parse_flow_control(&config.flow_control).map_err(|message| {
        fail_connection(
            &app,
            &shared_state,
            request,
            generation,
            &port_name,
            SerialErrorCode::InvalidConfig,
            message,
        )
    })?;
    let hardware_flow_control = matches!(flow_control, FlowControl::Hardware);

    ensure_connection_attempt_current(&shared_state, request, generation)?;
    let mut port = serialport::new(&config.port_name, config.baud_rate)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(SERIAL_TIMEOUT_MS))
        .open()
        .map_err(|error| {
            fail_connection(
                &app,
                &shared_state,
                request,
                generation,
                &port_name,
                SerialErrorCode::OpenFailed,
                format!("无法打开串口 {}: {error}", config.port_name),
            )
        })?;
    ensure_connection_attempt_current(&shared_state, request, generation)?;

    ensure_connection_attempt_current(&shared_state, request, generation)?;
    port.write_data_terminal_ready(config.dtr)
        .map_err(|error| {
            fail_connection(
                &app,
                &shared_state,
                request,
                generation,
                &port_name,
                SerialErrorCode::DtrFailed,
                format!("设置 DTR 失败: {error}"),
            )
        })?;
    ensure_connection_attempt_current(&shared_state, request, generation)?;
    if !hardware_flow_control {
        ensure_connection_attempt_current(&shared_state, request, generation)?;
        port.write_request_to_send(config.rts).map_err(|error| {
            fail_connection(
                &app,
                &shared_state,
                request,
                generation,
                &port_name,
                SerialErrorCode::RtsFailed,
                format!("设置 RTS 失败: {error}"),
            )
        })?;
        ensure_connection_attempt_current(&shared_state, request, generation)?;
    }

    ensure_connection_attempt_current(&shared_state, request, generation)?;
    let (command_tx, command_rx) = mpsc::sync_channel(WRITE_QUEUE_CAPACITY);
    let (start_tx, start_rx) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let worker_shared = Arc::clone(&shared_state);
    let worker_app = app.clone();
    let worker_port_name = port_name.clone();
    let join_handle = match thread::Builder::new()
        .name("vofa-serial-worker".to_owned())
        .spawn(move || {
            let panic_app = worker_app.clone();
            let panic_shared = Arc::clone(&worker_shared);
            let panic_port_name = worker_port_name.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_serial_worker(
                    worker_app,
                    worker_shared,
                    generation,
                    worker_port_name,
                    port,
                    command_rx,
                    start_rx,
                    worker_cancel,
                    recorder,
                );
            }));
            if let Err(panic) = result {
                finish_worker(
                    &panic_app,
                    &panic_shared,
                    generation,
                    panic_port_name,
                    Some(SerialFailure::new(
                        SerialErrorCode::WorkerPanic,
                        format!("串口工作线程异常退出: {}", panic_message(panic)),
                    )),
                );
            }
        }) {
        Ok(join_handle) => join_handle,
        Err(error) => {
            let message = format!("创建串口工作线程失败: {error}");
            return Err(fail_connection(
                &app,
                &shared_state,
                request,
                generation,
                &port_name,
                SerialErrorCode::WorkerStartFailed,
                message,
            ));
        }
    };

    let mut pending_worker = Some(SerialWorker {
        generation,
        command_tx: Some(command_tx),
        cancel,
        join_handle: Some(join_handle),
    });

    if let Err(message) = ensure_connection_attempt_current(&shared_state, request, generation) {
        drop(start_tx);
        if let Some(worker) = pending_worker.take() {
            let _ = worker.stop();
        }
        return Err(message);
    }

    let payload = {
        let mut shared = shared_state
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        if !shared.is_connection_attempt_current(request, generation) {
            None
        } else {
            shared.worker = pending_worker.take();
            match shared.complete_connection(request, generation, port_name.clone()) {
                Some(payload) => Some(payload),
                None => {
                    pending_worker = shared.worker.take();
                    None
                }
            }
        }
    };
    let Some(payload) = payload else {
        drop(start_tx);
        if let Some(worker) = pending_worker.take() {
            let _ = worker.stop();
        }
        return Err(connection_cancelled_message());
    };
    emit_state(&app, payload.clone());

    if start_tx.send(()).is_err() {
        let mut failure = SerialFailure::new(
            SerialErrorCode::WorkerStartFailed,
            "串口工作线程未能启动".to_owned(),
        );
        let worker = shared_state
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?
            .worker
            .take();
        if let Some(worker) = worker {
            if let Err(stop_failure) = worker.stop() {
                failure = stop_failure;
            }
        }
        return Err(fail_current_generation(
            &app,
            &shared_state,
            generation,
            &port_name,
            failure.code,
            failure.message,
        ));
    }

    Ok(payload)
}

#[tauri::command]
pub fn cancel_serial_connect(
    app: AppHandle,
    state: State<'_, SerialState>,
) -> Result<SerialStatePayload, String> {
    let (payload, changed) = cancel_connecting_state(&state.shared)?;
    if changed {
        emit_state(&app, payload.clone());
    }
    Ok(payload)
}

#[tauri::command]
pub fn disconnect_serial(
    app: AppHandle,
    state: State<'_, SerialState>,
) -> Result<SerialStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "串口生命周期锁已损坏".to_owned())?;
    stop_current_worker(&app, &state.shared)?;

    let payload = {
        let mut shared = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        if shared.status != SerialStatus::Disconnected
            || shared.message.is_some()
            || shared.error_code.is_some()
        {
            let port_name = shared.port_name.clone();
            shared.transition(SerialStatus::Disconnected, port_name, None, None)
        } else {
            shared.snapshot()
        }
    };
    emit_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn send_serial(state: State<'_, SerialState>, data: Vec<u8>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    if data.len() > MAX_WRITE_SIZE {
        return Err(format!(
            "单次发送不能超过 {} KiB，请拆分后重试",
            MAX_WRITE_SIZE / 1024
        ));
    }

    let shared = state
        .shared
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?;
    if shared.status != SerialStatus::Connected {
        return Err("串口尚未连接".to_owned());
    }

    let worker = shared
        .worker
        .as_ref()
        .filter(|worker| worker.generation == shared.generation)
        .ok_or_else(|| "串口工作线程未运行".to_owned())?;
    let command_tx = worker
        .command_tx
        .as_ref()
        .ok_or_else(|| "串口工作线程已停止".to_owned())?;

    command_tx
        .try_send(WorkerCommand::Write(data))
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => "串口发送队列已满，请降低发送速率".to_owned(),
            mpsc::TrySendError::Disconnected(_) => "串口工作线程已停止".to_owned(),
        })
}

fn stop_current_worker(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
) -> Result<(), String> {
    let worker = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?
        .worker
        .take();

    let Some(worker) = worker else {
        return Ok(());
    };
    let generation = worker.generation;

    if let Err(failure) = worker.stop() {
        let payload = {
            let mut shared = shared_state
                .lock()
                .map_err(|_| "串口状态锁已损坏".to_owned())?;
            if shared.generation != generation {
                return Err(failure.message);
            }
            let port_name = shared.port_name.clone();
            shared.transition(
                SerialStatus::Error,
                port_name,
                Some(failure.message.clone()),
                Some(failure.code),
            )
        };
        emit_state(app, payload);
        return Err(failure.message);
    }

    Ok(())
}

fn register_connection_attempt(
    shared_state: &Arc<Mutex<SharedSerialState>>,
) -> Result<u64, String> {
    let mut shared = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?;
    shared.connection_request = shared
        .connection_request
        .checked_add(1)
        .ok_or_else(|| "串口连接请求序号已耗尽，请重启应用".to_owned())?;
    let request = shared.connection_request;
    shared.pending_connection_request = Some(request);
    Ok(request)
}

fn begin_connection_state(
    shared_state: &Arc<Mutex<SharedSerialState>>,
    request: u64,
    port_name: &str,
) -> Result<(u64, SerialStatePayload), String> {
    let mut shared = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?;
    if shared.pending_connection_request != Some(request) {
        return Err(connection_cancelled_message());
    }
    let generation = match advance_generation(&mut shared) {
        Ok(generation) => generation,
        Err(message) => {
            shared.pending_connection_request = None;
            return Err(message);
        }
    };
    let payload = shared.transition(SerialStatus::Connecting, port_name.to_owned(), None, None);
    Ok((generation, payload))
}

fn begin_connection(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    request: u64,
    port_name: &str,
) -> Result<u64, String> {
    let (generation, payload) = begin_connection_state(shared_state, request, port_name)?;
    emit_state(app, payload);
    Ok(generation)
}

fn fail_connection(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    request: u64,
    generation: u64,
    port_name: &str,
    code: SerialErrorCode,
    message: String,
) -> String {
    let payload = shared_state.lock().ok().and_then(|mut shared| {
        if !shared.is_connection_attempt_current(request, generation) {
            return None;
        }
        shared.pending_connection_request = None;
        Some(shared.transition(
            SerialStatus::Error,
            port_name.to_owned(),
            Some(message.clone()),
            Some(code),
        ))
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
        message
    } else {
        connection_cancelled_message()
    }
}

fn fail_current_generation(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    port_name: &str,
    code: SerialErrorCode,
    message: String,
) -> String {
    let payload = shared_state.lock().ok().and_then(|mut shared| {
        if shared.generation != generation
            || !matches!(
                shared.status,
                SerialStatus::Connecting | SerialStatus::Connected
            )
        {
            return None;
        }
        Some(shared.transition(
            SerialStatus::Error,
            port_name.to_owned(),
            Some(message.clone()),
            Some(code),
        ))
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
    message
}

fn fail_connection_task(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    request: u64,
    code: SerialErrorCode,
    message: String,
) -> String {
    let payload = shared_state.lock().ok().and_then(|mut shared| {
        if shared.pending_connection_request != Some(request) {
            return None;
        }
        shared.pending_connection_request = None;
        if shared.status != SerialStatus::Connecting {
            return None;
        }
        let port_name = shared.port_name.clone();
        Some(shared.transition(
            SerialStatus::Error,
            port_name,
            Some(message.clone()),
            Some(code),
        ))
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
    message
}

fn ensure_connection_attempt_current(
    shared_state: &Arc<Mutex<SharedSerialState>>,
    request: u64,
    generation: u64,
) -> Result<(), String> {
    let shared = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?;
    if shared.is_connection_attempt_current(request, generation) {
        Ok(())
    } else {
        Err(connection_cancelled_message())
    }
}

fn cancel_connecting_state(
    shared_state: &Arc<Mutex<SharedSerialState>>,
) -> Result<(SerialStatePayload, bool), String> {
    let mut shared = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?;
    shared.pending_connection_request = None;
    if shared.status != SerialStatus::Connecting {
        return Ok((shared.snapshot(), false));
    }

    advance_generation(&mut shared)?;
    let port_name = shared.port_name.clone();
    let payload = shared.transition(SerialStatus::Disconnected, port_name, None, None);
    Ok((payload, true))
}

fn advance_generation(shared: &mut SharedSerialState) -> Result<u64, String> {
    shared.generation = shared
        .generation
        .checked_add(1)
        .ok_or_else(|| "串口连接代次已耗尽，请重启应用".to_owned())?;
    Ok(shared.generation)
}

fn connection_cancelled_message() -> String {
    "串口连接已取消".to_owned()
}

#[allow(clippy::too_many_arguments)]
fn run_serial_worker(
    app: AppHandle,
    shared_state: Arc<Mutex<SharedSerialState>>,
    generation: u64,
    port_name: String,
    mut port: Box<dyn serialport::SerialPort>,
    command_rx: mpsc::Receiver<WorkerCommand>,
    start_rx: mpsc::Receiver<()>,
    cancel: Arc<AtomicBool>,
    recorder: CaptureRecorderHandle,
) {
    if start_rx.recv().is_err() {
        return;
    }

    let mut read_buffer = [0_u8; READ_BUFFER_SIZE];
    let mut pending_write: Option<PendingWrite> = None;
    let mut terminal_error: Option<SerialFailure> = None;

    'worker: while !cancel.load(Ordering::Acquire) {
        let mut write_budget = WRITE_BUDGET_PER_TICK;
        while write_budget > 0 && !cancel.load(Ordering::Acquire) {
            if pending_write.is_none() {
                match command_rx.try_recv() {
                    Ok(WorkerCommand::Write(data)) => {
                        pending_write = Some(PendingWrite { data, offset: 0 });
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break 'worker,
                }
            }

            let Some(pending) = pending_write.as_mut() else {
                break;
            };
            let remaining = pending.data.len() - pending.offset;
            let chunk_length = remaining.min(WRITE_CHUNK_SIZE).min(write_budget);
            let chunk_end = pending.offset + chunk_length;
            let capture_session_id = recorder.active_session_id();

            match port.write(&pending.data[pending.offset..chunk_end]) {
                Ok(0) => {
                    terminal_error = Some(SerialFailure::new(
                        SerialErrorCode::WriteFailed,
                        "串口发送失败: 写入操作未取得进展".to_owned(),
                    ));
                    break 'worker;
                }
                Ok(byte_count) => {
                    let written_start = pending.offset;
                    let written_end = written_start + byte_count;
                    pending.offset = written_end;
                    write_budget -= byte_count;
                    if let Some(session_id) = capture_session_id {
                        let _ = recorder.append_for_session(
                            &app,
                            session_id,
                            CaptureDirection::Tx,
                            &pending.data[written_start..written_end],
                        );
                    }

                    if pending.offset == pending.data.len() {
                        let completed = pending_write.take().expect("待发送数据应当存在");
                        let _ = app.emit(
                            "serial://tx",
                            SerialTxPayload {
                                data: BASE64_STANDARD.encode(&completed.data),
                                byte_count: completed.data.len(),
                                transmitted_at: unix_millis(),
                                generation,
                            },
                        );
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error)
                    if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
                {
                    break;
                }
                Err(error) => {
                    terminal_error = Some(SerialFailure::new(
                        SerialErrorCode::WriteFailed,
                        format!("串口发送失败: {error}"),
                    ));
                    break 'worker;
                }
            }
        }

        if cancel.load(Ordering::Acquire) {
            break;
        }

        let capture_session_id = recorder.active_session_id();
        match port.read(&mut read_buffer) {
            Ok(byte_count) if byte_count > 0 => {
                if let Some(session_id) = capture_session_id {
                    let _ = recorder.append_for_session(
                        &app,
                        session_id,
                        CaptureDirection::Rx,
                        &read_buffer[..byte_count],
                    );
                }
                let _ = app.emit(
                    "serial://data",
                    SerialDataPayload {
                        data: BASE64_STANDARD.encode(&read_buffer[..byte_count]),
                        received_at: unix_millis(),
                        generation,
                    },
                );
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock
                ) => {}
            Err(error) => {
                terminal_error = Some(SerialFailure::new(
                    SerialErrorCode::ReadFailed,
                    format!("串口读取失败: {error}"),
                ));
                break;
            }
        }
    }

    finish_worker(&app, &shared_state, generation, port_name, terminal_error);
}

fn finish_worker(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    port_name: String,
    terminal_error: Option<SerialFailure>,
) {
    let payload = {
        let Ok(mut shared) = shared_state.lock() else {
            return;
        };
        if shared.generation != generation {
            return;
        }

        if let Some(worker) = shared.worker.as_mut() {
            if worker.generation == generation {
                worker.command_tx.take();
            }
        }

        match terminal_error {
            Some(failure) => shared.transition(
                SerialStatus::Error,
                port_name,
                Some(failure.message),
                Some(failure.code),
            ),
            None => shared.transition(SerialStatus::Disconnected, port_name, None, None),
        }
    };
    emit_state(app, payload);
}

fn emit_state(app: &AppHandle, payload: SerialStatePayload) {
    let _ = app.emit("serial://state", payload);
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn panic_message(panic: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "未知 panic".to_owned()
    }
}

fn parse_data_bits(value: u8) -> Result<DataBits, String> {
    match value {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(format!("不支持的数据位: {value}")),
    }
}

fn parse_parity(value: &str) -> Result<Parity, String> {
    match value {
        "none" => Ok(Parity::None),
        "odd" => Ok(Parity::Odd),
        "even" => Ok(Parity::Even),
        _ => Err(format!("不支持的校验方式: {value}")),
    }
}

fn parse_stop_bits(value: u8) -> Result<StopBits, String> {
    match value {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err(format!("不支持的停止位: {value}")),
    }
}

fn parse_flow_control(value: &str) -> Result<FlowControl, String> {
    match value {
        "none" => Ok(FlowControl::None),
        "software" => Ok(FlowControl::Software),
        "hardware" => Ok(FlowControl::Hardware),
        _ => Err(format!("不支持的流控方式: {value}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_serial_options() {
        assert!(matches!(parse_data_bits(8), Ok(DataBits::Eight)));
        assert!(matches!(parse_parity("even"), Ok(Parity::Even)));
        assert!(matches!(parse_stop_bits(2), Ok(StopBits::Two)));
        assert!(matches!(
            parse_flow_control("hardware"),
            Ok(FlowControl::Hardware)
        ));
    }

    #[test]
    fn rejects_unknown_serial_options() {
        assert!(parse_data_bits(9).is_err());
        assert!(parse_parity("mark").is_err());
        assert!(parse_stop_bits(3).is_err());
        assert!(parse_flow_control("magic").is_err());
    }

    #[test]
    fn validates_serial_config_and_rejects_unknown_fields() {
        let valid = SerialConfig {
            port_name: "COM3".to_owned(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".to_owned(),
            stop_bits: 1,
            flow_control: "none".to_owned(),
            dtr: true,
            rts: true,
        };
        assert!(valid.validate(true).is_ok());

        let mut invalid = valid.clone();
        invalid.baud_rate = 0;
        assert!(invalid.validate(true).is_err());

        let json = serde_json::to_string(&valid).unwrap();
        let json = json.replace("}", ",\"futureOption\":true}");
        assert!(serde_json::from_str::<SerialConfig>(&json).is_err());
    }

    #[test]
    fn state_revision_is_monotonic() {
        let mut shared = SharedSerialState::default();
        let connecting = shared.transition(SerialStatus::Connecting, "COM3".to_owned(), None, None);
        let connected = shared.transition(SerialStatus::Connected, "COM3".to_owned(), None, None);

        assert!(connected.revision > connecting.revision);
        assert_eq!(connected.status, "connected");
    }

    #[test]
    fn cancel_only_changes_connecting_state() {
        for status in [
            SerialStatus::Disconnected,
            SerialStatus::Connected,
            SerialStatus::Error,
        ] {
            let shared_state = Arc::new(Mutex::new(SharedSerialState::default()));
            {
                let mut shared = shared_state.lock().unwrap();
                shared.generation = 7;
                shared.status = status;
                shared.revision = 11;
                if status == SerialStatus::Connected {
                    shared.worker = Some(test_worker(7));
                }
            }

            let (payload, changed) = cancel_connecting_state(&shared_state).unwrap();
            let shared = shared_state.lock().unwrap();
            assert!(!changed);
            assert_eq!(payload.generation, 7);
            assert_eq!(payload.revision, 11);
            assert_eq!(shared.status, status);
            if status == SerialStatus::Connected {
                assert!(shared.worker.is_some());
            }
        }
    }

    #[test]
    fn cancel_advances_generation_and_revision_once() {
        let shared_state = Arc::new(Mutex::new(SharedSerialState::default()));
        {
            let mut shared = shared_state.lock().unwrap();
            shared.generation = 4;
            shared.transition(SerialStatus::Connecting, "COM3".to_owned(), None, None);
        }

        let (cancelled, changed) = cancel_connecting_state(&shared_state).unwrap();
        assert!(changed);
        assert_eq!(cancelled.status, "disconnected");
        assert_eq!(cancelled.generation, 5);
        assert_eq!(cancelled.revision, 2);

        let (repeated, changed_again) = cancel_connecting_state(&shared_state).unwrap();
        assert!(!changed_again);
        assert_eq!(repeated.generation, cancelled.generation);
        assert_eq!(repeated.revision, cancelled.revision);
    }

    #[test]
    fn cancel_before_blocking_attempt_begins_prevents_connecting_transition() {
        let transition = Arc::new(Mutex::new(()));
        let shared_state = Arc::new(Mutex::new(SharedSerialState::default()));
        let request = register_connection_attempt(&shared_state).unwrap();
        let transition_guard = transition.lock().unwrap();
        let task_transition = Arc::clone(&transition);
        let task_shared_state = Arc::clone(&shared_state);
        let (waiting_tx, waiting_rx) = mpsc::channel();
        let task = thread::spawn(move || {
            waiting_tx.send(()).unwrap();
            let _transition = task_transition.lock().unwrap();
            begin_connection_state(&task_shared_state, request, "COM3")
        });

        waiting_rx.recv().unwrap();
        let (cancelled, changed) = cancel_connecting_state(&shared_state).unwrap();
        assert!(!changed);
        assert_eq!(cancelled.status, "disconnected");
        drop(transition_guard);

        let result = task.join().unwrap();
        assert_eq!(result.err().as_deref(), Some("串口连接已取消"));
        let shared = shared_state.lock().unwrap();
        assert_eq!(shared.status, SerialStatus::Disconnected);
        assert_eq!(shared.generation, 0);
        assert_eq!(shared.revision, 0);
        assert!(shared.pending_connection_request.is_none());
        assert!(shared.worker.is_none());
    }

    #[test]
    fn cancelled_generation_cannot_complete_a_new_connection() {
        let shared_state = Arc::new(Mutex::new(SharedSerialState::default()));
        let old_request = register_connection_attempt(&shared_state).unwrap();
        let (old_generation, _) =
            begin_connection_state(&shared_state, old_request, "COM3").unwrap();
        cancel_connecting_state(&shared_state).unwrap();

        let current_request = register_connection_attempt(&shared_state).unwrap();
        let (current_generation, _) =
            begin_connection_state(&shared_state, current_request, "COM4").unwrap();
        let mut shared = shared_state.lock().unwrap();

        assert!(shared
            .complete_connection(old_request, old_generation, "COM3".to_owned())
            .is_none());
        assert_eq!(shared.status, SerialStatus::Connecting);
        assert!(shared
            .complete_connection(current_request, current_generation, "COM4".to_owned())
            .is_some());
        assert_eq!(shared.status, SerialStatus::Connected);
    }

    #[test]
    fn serial_error_code_uses_camel_case_payload_field() {
        let mut shared = SharedSerialState::default();
        let payload = shared.transition(
            SerialStatus::Error,
            "COM3".to_owned(),
            Some("读取失败".to_owned()),
            Some(SerialErrorCode::ReadFailed),
        );
        let json = serde_json::to_value(payload).unwrap();

        assert_eq!(json["errorCode"], "read-failed");
        assert!(json.get("error_code").is_none());

        let cleared = shared.transition(SerialStatus::Disconnected, "COM3".to_owned(), None, None);
        let cleared_json = serde_json::to_value(cleared).unwrap();
        assert!(cleared_json.get("errorCode").is_none());
    }

    #[test]
    fn serial_error_codes_are_stable() {
        let codes = [
            (SerialErrorCode::InvalidConfig, "invalid-config"),
            (SerialErrorCode::OpenFailed, "open-failed"),
            (SerialErrorCode::DtrFailed, "dtr-failed"),
            (SerialErrorCode::RtsFailed, "rts-failed"),
            (SerialErrorCode::WorkerStartFailed, "worker-start-failed"),
            (SerialErrorCode::ReadFailed, "read-failed"),
            (SerialErrorCode::WriteFailed, "write-failed"),
            (SerialErrorCode::WorkerPanic, "worker-panic"),
            (SerialErrorCode::Unknown, "unknown"),
        ];

        for (code, expected) in codes {
            assert_eq!(code.as_str(), expected);
        }
    }

    fn test_worker(generation: u64) -> SerialWorker {
        let (command_tx, _command_rx) = mpsc::sync_channel(1);
        SerialWorker {
            generation,
            command_tx: Some(command_tx),
            cancel: Arc::new(AtomicBool::new(false)),
            join_handle: None,
        }
    }
}
