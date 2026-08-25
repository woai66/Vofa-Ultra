use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter, State};

use crate::capture::{CaptureDirection, CaptureRecorderHandle, CaptureState};
use crate::modbus_rtu::{
    silent_interval, ModbusRequestSpec, ModbusResponseCollector, ResponseErrorCode, ResponseMatch,
    BUS_ACQUIRE_TIMEOUT, MAX_TRANSACTION_TIMEOUT_MS, MIN_TRANSACTION_TIMEOUT_MS,
};

const READ_BUFFER_SIZE: usize = 16 * 1024;
const SERIAL_TIMEOUT_MS: u64 = 20;
const WRITE_QUEUE_CAPACITY: usize = 256;
const MAX_WRITE_SIZE: usize = 64 * 1024;
const WRITE_CHUNK_SIZE: usize = 4 * 1024;
const WRITE_BUDGET_PER_TICK: usize = 32 * 1024;
const MAX_JAVASCRIPT_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// 零容量握手确保 reader 只预取下一块，通道本身不会再缓存第三个 64 KiB 块。
const FILE_READ_CHANNEL_CAPACITY: usize = 0;
const MODBUS_REQUEST_QUEUED: u8 = 0;
const MODBUS_REQUEST_TRANSMITTING: u8 = 1;
const MODBUS_REQUEST_TRANSMITTED: u8 = 2;
const FILE_SEND_QUEUED: u8 = 0;
const FILE_SEND_TRANSMITTING: u8 = 1;
const FILE_SEND_CANCEL_REQUESTED: u8 = 2;
const FILE_SEND_DRAINING: u8 = 3;
const FILE_SEND_CANCELLED_MESSAGE: &str = "文件发送已取消；驱动已缓冲的字节仍可能发出";
const FILE_SEND_CONNECTION_ENDED_MESSAGE: &str =
    "串口连接已结束，文件发送已取消；驱动已缓冲的字节仍可能发出";

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
    active_modbus: Option<ActiveModbusControl>,
    file_send_sequence: u64,
    file_send_revision: u64,
    file_send_snapshot: SerialFileSendSnapshot,
    active_file_send: Option<ActiveFileSendControl>,
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
            active_modbus: None,
            file_send_sequence: 0,
            file_send_revision: 0,
            file_send_snapshot: SerialFileSendSnapshot::default(),
            active_file_send: None,
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

    fn file_send_payload(&self) -> SerialFileSendPayload {
        SerialFileSendPayload {
            job_id: self.file_send_snapshot.job_id,
            revision: self.file_send_revision,
            generation: self.file_send_snapshot.generation,
            status: self.file_send_snapshot.status.as_str().to_owned(),
            file_name: self.file_send_snapshot.file_name.clone(),
            total_bytes: self.file_send_snapshot.total_bytes,
            transmitted_bytes: self.file_send_snapshot.transmitted_bytes,
            queued_at: self.file_send_snapshot.queued_at,
            started_at: self.file_send_snapshot.started_at,
            ended_at: self.file_send_snapshot.ended_at,
            error_code: self.file_send_snapshot.error_code.clone(),
            message: self.file_send_snapshot.message.clone(),
        }
    }

    fn touch_file_send(&mut self) -> SerialFileSendPayload {
        self.file_send_revision = self.file_send_revision.saturating_add(1);
        self.file_send_payload()
    }

    fn ensure_file_send_admission(&self) -> Result<(), String> {
        if self.status != SerialStatus::Connected {
            return Err("串口尚未连接".to_owned());
        }
        if self.active_modbus.is_some() {
            return Err("Modbus RTU 事务进行中，暂不能发送文件".to_owned());
        }
        if self.active_file_send.is_some() {
            return Err("已有文件发送任务正在运行".to_owned());
        }
        Ok(())
    }

    fn queue_file_send(
        &mut self,
        generation: u64,
        file_name: String,
        total_bytes: u64,
        phase: Arc<AtomicU8>,
    ) -> Result<SerialFileSendPayload, String> {
        self.file_send_sequence = self
            .file_send_sequence
            .checked_add(1)
            .ok_or_else(|| "文件发送任务序号已耗尽，请重启应用".to_owned())?;
        let job_id = self.file_send_sequence;
        let queued_at = unix_millis();
        self.file_send_snapshot = SerialFileSendSnapshot {
            job_id,
            generation,
            status: SerialFileSendStatus::Queued,
            file_name,
            total_bytes,
            transmitted_bytes: 0,
            queued_at: Some(queued_at),
            started_at: None,
            ended_at: None,
            error_code: None,
            message: "文件已进入串口发送队列".to_owned(),
        };
        self.active_file_send = Some(ActiveFileSendControl {
            job_id,
            generation,
            phase,
        });
        Ok(self.touch_file_send())
    }

    fn mark_file_send_sending(
        &mut self,
        job_id: u64,
        generation: u64,
    ) -> Option<SerialFileSendPayload> {
        if !self.file_send_is_current(job_id, generation)
            || self.file_send_snapshot.status != SerialFileSendStatus::Queued
        {
            return None;
        }
        self.file_send_snapshot.status = SerialFileSendStatus::Sending;
        self.file_send_snapshot.started_at = Some(unix_millis());
        self.file_send_snapshot.message = "正在发送文件".to_owned();
        Some(self.touch_file_send())
    }

    fn update_file_send_progress(
        &mut self,
        job_id: u64,
        generation: u64,
        transmitted_bytes: u64,
    ) -> Option<SerialFileSendPayload> {
        if !self.file_send_is_current(job_id, generation) {
            return None;
        }
        let transmitted_bytes = transmitted_bytes.min(self.file_send_snapshot.total_bytes);
        if transmitted_bytes <= self.file_send_snapshot.transmitted_bytes {
            return None;
        }
        self.file_send_snapshot.transmitted_bytes = transmitted_bytes;
        Some(self.touch_file_send())
    }

    fn request_file_send_cancel(&mut self, job_id: u64) -> (bool, Option<SerialFileSendPayload>) {
        let Some(active) = self.active_file_send.as_ref() else {
            return (false, None);
        };
        if active.job_id != job_id || active.generation != self.generation {
            return (false, None);
        }

        loop {
            let phase = active.phase.load(Ordering::Acquire);
            match phase {
                FILE_SEND_QUEUED | FILE_SEND_TRANSMITTING => {
                    if active
                        .phase
                        .compare_exchange(
                            phase,
                            FILE_SEND_CANCEL_REQUESTED,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_err()
                    {
                        continue;
                    }
                    self.file_send_snapshot.status = SerialFileSendStatus::Cancelling;
                    self.file_send_snapshot.message = "正在取消文件发送".to_owned();
                    return (true, Some(self.touch_file_send()));
                }
                FILE_SEND_CANCEL_REQUESTED => return (true, None),
                FILE_SEND_DRAINING => return (false, None),
                _ => return (false, None),
            }
        }
    }

    fn finish_file_send(
        &mut self,
        job_id: u64,
        generation: u64,
        status: SerialFileSendStatus,
        error_code: Option<&str>,
        message: String,
    ) -> Option<SerialFileSendPayload> {
        if !self.file_send_is_current(job_id, generation) {
            return None;
        }
        self.active_file_send = None;
        self.file_send_snapshot.status = status;
        self.file_send_snapshot.ended_at = Some(unix_millis());
        self.file_send_snapshot.error_code = error_code.map(str::to_owned);
        self.file_send_snapshot.message = message;
        Some(self.touch_file_send())
    }

    fn file_send_is_current(&self, job_id: u64, generation: u64) -> bool {
        self.generation == generation
            && self
                .active_file_send
                .as_ref()
                .is_some_and(|active| active.job_id == job_id && active.generation == generation)
            && self.file_send_snapshot.job_id == job_id
            && self.file_send_snapshot.generation == generation
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SerialFileSendStatus {
    Idle,
    Queued,
    Sending,
    Cancelling,
    Completed,
    Cancelled,
    Error,
}

impl SerialFileSendStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Queued => "queued",
            Self::Sending => "sending",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
        }
    }
}

struct SerialFileSendSnapshot {
    job_id: u64,
    generation: u64,
    status: SerialFileSendStatus,
    file_name: String,
    total_bytes: u64,
    transmitted_bytes: u64,
    queued_at: Option<u64>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    error_code: Option<String>,
    message: String,
}

impl Default for SerialFileSendSnapshot {
    fn default() -> Self {
        Self {
            job_id: 0,
            generation: 0,
            status: SerialFileSendStatus::Idle,
            file_name: String::new(),
            total_bytes: 0,
            transmitted_bytes: 0,
            queued_at: None,
            started_at: None,
            ended_at: None,
            error_code: None,
            message: "暂无文件发送任务".to_owned(),
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

struct ActiveModbusControl {
    transaction_id: u64,
    generation: u64,
    request: Vec<u8>,
    queued_at: u64,
    cancel: Arc<AtomicBool>,
    request_phase: Arc<AtomicU8>,
}

struct ActiveFileSendControl {
    job_id: u64,
    generation: u64,
    phase: Arc<AtomicU8>,
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
    StartModbus(ModbusCommand),
    StartFileSend(FileSendCommand),
}

struct ModbusCommand {
    transaction_id: u64,
    spec: ModbusRequestSpec,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
    request_phase: Arc<AtomicU8>,
}

struct ModbusCancelRequest {
    generation: u64,
    finish_before_transmit: bool,
}

struct FileSendCommand {
    job_id: u64,
    generation: u64,
    file: File,
    total_bytes: u64,
    phase: Arc<AtomicU8>,
}

enum FileReadMessage {
    Chunk(Vec<u8>),
    Eof,
    Error { code: &'static str, message: String },
}

struct FileSendRuntime {
    job_id: u64,
    generation: u64,
    total_bytes: u64,
    transmitted_bytes: u64,
    phase: Arc<AtomicU8>,
    chunk_rx: mpsc::Receiver<FileReadMessage>,
}

enum PendingWriteOrigin {
    Normal,
    Modbus(ModbusCommand),
    FileSend { job_id: u64 },
}

struct PendingWrite {
    data: Vec<u8>,
    offset: usize,
    origin: PendingWriteOrigin,
}

enum ModbusRuntime {
    WaitingSilence {
        command: ModbusCommand,
        waiting_since: Instant,
    },
    AwaitingResponse {
        transaction_id: u64,
        collector: ModbusResponseCollector,
        cancel: Arc<AtomicBool>,
        started_at: u64,
        started: Instant,
        deadline: Instant,
    },
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
struct SerialModbusTransactionPayload {
    transaction_id: u64,
    status: String,
    request: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<String>,
    started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
    duration_ms: u64,
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exception_code: Option<u8>,
    message: String,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialFileSendPayload {
    job_id: u64,
    revision: u64,
    generation: u64,
    status: String,
    file_name: String,
    total_bytes: u64,
    transmitted_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    queued_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    message: String,
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
pub fn get_serial_file_send_state(
    state: State<'_, SerialState>,
) -> Result<SerialFileSendPayload, String> {
    state
        .shared
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())
        .map(|shared| shared.file_send_payload())
}

#[tauri::command]
pub fn start_serial_file_send(
    app: AppHandle,
    state: State<'_, SerialState>,
    path: String,
) -> Result<SerialFileSendPayload, String> {
    if path.is_empty() {
        return Err("待发送文件路径不能为空".to_owned());
    }
    let file_name = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "无法识别待发送文件名".to_owned())?;
    let expected_generation = {
        let shared = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        shared.ensure_file_send_admission()?;
        shared.generation
    };

    let file = File::open(&path).map_err(|error| format!("无法打开待发送文件: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取待发送文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err("待发送路径不是普通文件".to_owned());
    }
    let total_bytes = metadata.len();
    validate_file_send_size(total_bytes)?;
    let phase = Arc::new(AtomicU8::new(FILE_SEND_QUEUED));
    let (command_tx, payload) = {
        let mut shared = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        if shared.generation != expected_generation {
            return Err("串口连接已发生变化，请重新选择文件".to_owned());
        }
        shared.ensure_file_send_admission()?;
        let command_tx = shared
            .worker
            .as_ref()
            .filter(|worker| worker.generation == expected_generation)
            .and_then(|worker| worker.command_tx.as_ref())
            .cloned()
            .ok_or_else(|| "串口工作线程未运行".to_owned())?;
        let payload = shared.queue_file_send(
            expected_generation,
            file_name,
            total_bytes,
            Arc::clone(&phase),
        )?;
        (command_tx, payload)
    };

    emit_file_send_state(&app, payload.clone());
    let job_id = payload.job_id;
    let command = WorkerCommand::StartFileSend(FileSendCommand {
        job_id,
        generation: expected_generation,
        file,
        total_bytes,
        phase,
    });
    if let Err(error) = command_tx.try_send(command) {
        let (error_code, message) = match error {
            mpsc::TrySendError::Full(_) => (
                "queue-full",
                "串口发送队列已满，无法启动文件发送".to_owned(),
            ),
            mpsc::TrySendError::Disconnected(_) => {
                ("worker-stopped", "串口工作线程已停止".to_owned())
            }
        };
        publish_file_send_terminal(
            &app,
            &state.shared,
            job_id,
            expected_generation,
            SerialFileSendStatus::Error,
            Some(error_code),
            message.clone(),
        );
        return Err(message);
    }

    Ok(payload)
}

#[tauri::command]
pub fn cancel_serial_file_send(
    app: AppHandle,
    state: State<'_, SerialState>,
    job_id: u64,
) -> Result<bool, String> {
    let (accepted, payload) = {
        let mut shared = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        shared.request_file_send_cancel(job_id)
    };
    if let Some(payload) = payload {
        emit_file_send_state(&app, payload);
    }
    Ok(accepted)
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
    let modbus_silent_interval = silent_interval(
        config.baud_rate,
        config.data_bits,
        config.parity != "none",
        config.stop_bits,
    );

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
                    modbus_silent_interval,
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
    if shared.active_modbus.is_some() {
        return Err("Modbus RTU 事务进行中，暂不能发送其他数据".to_owned());
    }
    if shared.active_file_send.is_some() {
        return Err("文件发送进行中，暂不能发送其他数据".to_owned());
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

#[tauri::command]
pub fn start_modbus_transaction(
    state: State<'_, SerialState>,
    transaction_id: u64,
    request: Vec<u8>,
    timeout_ms: u64,
) -> Result<(), String> {
    if transaction_id == 0 || transaction_id > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Err("Modbus RTU 事务编号无效".to_owned());
    }
    if !(MIN_TRANSACTION_TIMEOUT_MS..=MAX_TRANSACTION_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!(
            "Modbus RTU 响应超时必须是 {MIN_TRANSACTION_TIMEOUT_MS}-{MAX_TRANSACTION_TIMEOUT_MS} ms"
        ));
    }
    let spec = ModbusRequestSpec::parse(request)?;
    let (command_tx, generation, cancel, request_phase) = {
        let mut shared = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        if shared.status != SerialStatus::Connected {
            return Err("串口尚未连接".to_owned());
        }
        if shared.active_modbus.is_some() {
            return Err("已有 Modbus RTU 事务正在运行".to_owned());
        }
        if shared.active_file_send.is_some() {
            return Err("文件发送进行中，暂不能启动 Modbus RTU 事务".to_owned());
        }
        let generation = shared.generation;
        let command_tx = shared
            .worker
            .as_ref()
            .filter(|worker| worker.generation == generation)
            .and_then(|worker| worker.command_tx.as_ref())
            .cloned()
            .ok_or_else(|| "串口工作线程未运行".to_owned())?;
        let cancel = Arc::new(AtomicBool::new(false));
        let request_phase = Arc::new(AtomicU8::new(MODBUS_REQUEST_QUEUED));
        shared.active_modbus = Some(ActiveModbusControl {
            transaction_id,
            generation,
            request: spec.request().to_vec(),
            queued_at: unix_millis(),
            cancel: Arc::clone(&cancel),
            request_phase: Arc::clone(&request_phase),
        });
        (command_tx, generation, cancel, request_phase)
    };

    let command = WorkerCommand::StartModbus(ModbusCommand {
        transaction_id,
        spec,
        timeout: Duration::from_millis(timeout_ms),
        cancel,
        request_phase,
    });
    command_tx.try_send(command).map_err(|error| {
        if let Ok(mut shared) = state.shared.lock() {
            if shared.active_modbus.as_ref().is_some_and(|active| {
                active.transaction_id == transaction_id && active.generation == generation
            }) {
                shared.active_modbus = None;
            }
        }
        match error {
            mpsc::TrySendError::Full(_) => "串口发送队列已满，无法启动 Modbus RTU 事务".to_owned(),
            mpsc::TrySendError::Disconnected(_) => "串口工作线程已停止".to_owned(),
        }
    })
}

#[tauri::command]
pub fn cancel_modbus_transaction(
    app: AppHandle,
    state: State<'_, SerialState>,
    transaction_id: u64,
) -> Result<bool, String> {
    let Some(request) = request_modbus_cancel(&state.shared, transaction_id)? else {
        return Ok(false);
    };
    if request.finish_before_transmit {
        finish_modbus_transaction(
            &app,
            &state.shared,
            request.generation,
            transaction_id,
            "cancelled",
            None,
            None,
            Duration::ZERO,
            Some("cancelled"),
            None,
            "Modbus RTU 事务已取消，请求尚未发送",
        );
    }
    Ok(true)
}

fn request_modbus_cancel(
    shared_state: &Arc<Mutex<SharedSerialState>>,
    transaction_id: u64,
) -> Result<Option<ModbusCancelRequest>, String> {
    let shared = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?;
    let Some(active) = shared.active_modbus.as_ref() else {
        return Ok(None);
    };
    if active.transaction_id != transaction_id || active.generation != shared.generation {
        return Ok(None);
    }
    active.cancel.store(true, Ordering::Release);
    Ok(Some(ModbusCancelRequest {
        generation: active.generation,
        finish_before_transmit: active.request_phase.load(Ordering::Acquire)
            == MODBUS_REQUEST_QUEUED,
    }))
}

fn stop_current_worker(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
) -> Result<(), String> {
    let active_file_send = request_current_file_send_cancel(app, shared_state)?;
    let worker = shared_state
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_owned())?
        .worker
        .take();

    let Some(worker) = worker else {
        if let Some((job_id, generation)) = active_file_send {
            publish_file_send_terminal(
                app,
                shared_state,
                job_id,
                generation,
                SerialFileSendStatus::Cancelled,
                Some("cancelled"),
                FILE_SEND_CONNECTION_ENDED_MESSAGE.to_owned(),
            );
        }
        return Ok(());
    };
    let generation = worker.generation;

    if let Err(failure) = worker.stop() {
        if let Some((job_id, generation)) = active_file_send {
            publish_file_send_terminal(
                app,
                shared_state,
                job_id,
                generation,
                SerialFileSendStatus::Error,
                Some("connection-lost"),
                failure.message.clone(),
            );
        }
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

    if let Some((job_id, generation)) = active_file_send {
        publish_file_send_terminal(
            app,
            shared_state,
            job_id,
            generation,
            SerialFileSendStatus::Cancelled,
            Some("cancelled"),
            FILE_SEND_CONNECTION_ENDED_MESSAGE.to_owned(),
        );
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
    let active_transaction = shared_state.lock().ok().and_then(|shared| {
        shared
            .active_modbus
            .as_ref()
            .map(|active| (active.generation, active.transaction_id))
    });
    if let Some((generation, transaction_id)) = active_transaction {
        finish_modbus_transaction(
            app,
            shared_state,
            generation,
            transaction_id,
            "cancelled",
            None,
            None,
            Duration::ZERO,
            Some("connection-change"),
            None,
            "串口连接正在切换，Modbus RTU 事务已取消",
        );
    }
    if let Err(message) = stop_current_worker(app, shared_state) {
        if let Ok(mut shared) = shared_state.lock() {
            if shared.pending_connection_request == Some(request) {
                shared.pending_connection_request = None;
            }
        }
        return Err(message);
    }
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

fn validate_file_send_size(total_bytes: u64) -> Result<(), String> {
    if total_bytes > MAX_JAVASCRIPT_SAFE_INTEGER {
        return Err("文件过大，无法提供精确的发送进度".to_owned());
    }
    Ok(())
}

fn stream_file_chunks<R: Read>(
    mut reader: R,
    total_bytes: u64,
    phase: Arc<AtomicU8>,
    chunk_tx: mpsc::SyncSender<FileReadMessage>,
) {
    let mut remaining = total_bytes;
    while remaining > 0 {
        if phase.load(Ordering::Acquire) == FILE_SEND_CANCEL_REQUESTED {
            return;
        }
        let chunk_length = remaining.min(MAX_WRITE_SIZE as u64) as usize;
        let mut chunk = vec![0_u8; chunk_length];
        let mut offset = 0;
        while offset < chunk_length {
            if phase.load(Ordering::Acquire) == FILE_SEND_CANCEL_REQUESTED {
                return;
            }
            match reader.read(&mut chunk[offset..]) {
                Ok(0) => {
                    let _ = chunk_tx.send(FileReadMessage::Error {
                        code: "source-truncated",
                        message: "源文件在发送过程中被截短".to_owned(),
                    });
                    return;
                }
                Ok(byte_count) => offset += byte_count,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => {
                    let _ = chunk_tx.send(FileReadMessage::Error {
                        code: "source-read-failed",
                        message: format!("读取待发送文件失败: {error}"),
                    });
                    return;
                }
            }
        }
        remaining -= chunk_length as u64;
        if chunk_tx.send(FileReadMessage::Chunk(chunk)).is_err() {
            return;
        }
    }

    if phase.load(Ordering::Acquire) != FILE_SEND_CANCEL_REQUESTED {
        let _ = chunk_tx.send(FileReadMessage::Eof);
    }
}

fn create_file_send_runtime(command: FileSendCommand) -> Result<FileSendRuntime, String> {
    let FileSendCommand {
        job_id,
        generation,
        file,
        total_bytes,
        phase,
    } = command;
    let (chunk_tx, chunk_rx) = mpsc::sync_channel(FILE_READ_CHANNEL_CAPACITY);
    let reader_phase = Arc::clone(&phase);
    thread::Builder::new()
        .name(format!("vofa-file-reader-{job_id}"))
        .spawn(move || stream_file_chunks(file, total_bytes, reader_phase, chunk_tx))
        .map_err(|error| format!("创建文件读取线程失败: {error}"))?;

    Ok(FileSendRuntime {
        job_id,
        generation,
        total_bytes,
        transmitted_bytes: 0,
        phase,
        chunk_rx,
    })
}

fn publish_file_send_sending(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    job_id: u64,
    generation: u64,
) -> bool {
    let payload = shared_state
        .lock()
        .ok()
        .and_then(|mut shared| shared.mark_file_send_sending(job_id, generation));
    if let Some(payload) = payload {
        emit_file_send_state(app, payload);
        true
    } else {
        false
    }
}

fn publish_file_send_progress(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    job_id: u64,
    generation: u64,
    transmitted_bytes: u64,
) {
    let payload = shared_state.lock().ok().and_then(|mut shared| {
        shared.update_file_send_progress(job_id, generation, transmitted_bytes)
    });
    if let Some(payload) = payload {
        emit_file_send_state(app, payload);
    }
}

fn publish_file_send_terminal(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    job_id: u64,
    generation: u64,
    status: SerialFileSendStatus,
    error_code: Option<&str>,
    message: String,
) {
    let payload = shared_state.lock().ok().and_then(|mut shared| {
        shared.finish_file_send(job_id, generation, status, error_code, message)
    });
    if let Some(payload) = payload {
        emit_file_send_state(app, payload);
    }
}

fn request_current_file_send_cancel(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
) -> Result<Option<(u64, u64)>, String> {
    let (active, payload) = {
        let mut shared = shared_state
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        let active = shared
            .active_file_send
            .as_ref()
            .filter(|active| active.generation == shared.generation)
            .map(|active| (active.job_id, active.generation));
        let payload = active.and_then(|(job_id, _)| shared.request_file_send_cancel(job_id).1);
        (active, payload)
    };
    if let Some(payload) = payload {
        emit_file_send_state(app, payload);
    }
    Ok(active)
}

fn take_file_send_prefix(pending_write: &mut Option<PendingWrite>, job_id: u64) -> Option<Vec<u8>> {
    let matches_job = pending_write.as_ref().is_some_and(|pending| {
        matches!(pending.origin, PendingWriteOrigin::FileSend { job_id: pending_job_id }
            if pending_job_id == job_id)
    });
    if !matches_job {
        return None;
    }
    let mut pending = pending_write.take().expect("待发送文件块应当存在");
    pending.data.truncate(pending.offset);
    Some(pending.data)
}

fn emit_serial_tx(app: &AppHandle, generation: u64, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let _ = app.emit(
        "serial://tx",
        SerialTxPayload {
            data: BASE64_STANDARD.encode(data),
            byte_count: data.len(),
            transmitted_at: unix_millis(),
            generation,
        },
    );
}

fn settle_file_send_bytes(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    runtime: &mut FileSendRuntime,
    data: &[u8],
    allow_drain: bool,
) -> bool {
    let byte_count = u64::try_from(data.len()).unwrap_or(u64::MAX);
    let transmitted_bytes = runtime
        .transmitted_bytes
        .saturating_add(byte_count)
        .min(runtime.total_bytes);
    let ready_to_drain = allow_drain
        && transmitted_bytes == runtime.total_bytes
        && runtime
            .phase
            .compare_exchange(
                FILE_SEND_TRANSMITTING,
                FILE_SEND_DRAINING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
    runtime.transmitted_bytes = transmitted_bytes;
    emit_serial_tx(app, runtime.generation, data);
    publish_file_send_progress(
        app,
        shared_state,
        runtime.job_id,
        runtime.generation,
        transmitted_bytes,
    );
    ready_to_drain
}

fn settle_cancelled_file_send(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    pending_write: &mut Option<PendingWrite>,
    file_runtime: &mut Option<FileSendRuntime>,
) -> bool {
    let cancellation = file_runtime
        .as_ref()
        .is_some_and(|runtime| runtime.phase.load(Ordering::Acquire) == FILE_SEND_CANCEL_REQUESTED);
    if !cancellation {
        return false;
    }

    let mut runtime = file_runtime.take().expect("文件发送运行时应当存在");
    if let Some(prefix) = take_file_send_prefix(pending_write, runtime.job_id) {
        settle_file_send_bytes(app, shared_state, &mut runtime, &prefix, false);
    }
    publish_file_send_terminal(
        app,
        shared_state,
        runtime.job_id,
        runtime.generation,
        SerialFileSendStatus::Cancelled,
        Some("cancelled"),
        FILE_SEND_CANCELLED_MESSAGE.to_owned(),
    );
    true
}

fn file_reader_disconnect_was_cancelled(runtime: &FileSendRuntime) -> bool {
    runtime.phase.load(Ordering::Acquire) == FILE_SEND_CANCEL_REQUESTED
}

fn finish_active_file_send_after_serial_failure(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    pending_write: &mut Option<PendingWrite>,
    file_runtime: &mut Option<FileSendRuntime>,
    failure: &SerialFailure,
) {
    let Some(mut runtime) = file_runtime.take() else {
        return;
    };
    if let Some(prefix) = take_file_send_prefix(pending_write, runtime.job_id) {
        settle_file_send_bytes(app, shared_state, &mut runtime, &prefix, false);
    }
    let error_code = if failure.code == SerialErrorCode::WriteFailed {
        "write-failed"
    } else {
        "connection-lost"
    };
    publish_file_send_terminal(
        app,
        shared_state,
        runtime.job_id,
        runtime.generation,
        SerialFileSendStatus::Error,
        Some(error_code),
        failure.message.clone(),
    );
}

fn should_cancel_modbus_before_first_write(pending: &PendingWrite) -> bool {
    let PendingWriteOrigin::Modbus(command) = &pending.origin else {
        return false;
    };
    if pending.offset != 0 {
        return false;
    }
    if command.cancel.load(Ordering::Acquire) {
        return true;
    }

    command
        .request_phase
        .store(MODBUS_REQUEST_TRANSMITTING, Ordering::Release);
    command.cancel.load(Ordering::Acquire)
}

fn flush_and_mark_bus_activity<W: Write + ?Sized>(
    output: &mut W,
    last_bus_activity: &mut Instant,
) -> std::io::Result<()> {
    output.flush()?;
    *last_bus_activity = Instant::now();
    Ok(())
}

fn flush_file_send_output<W: Write + ?Sized>(
    output: &mut W,
    last_bus_activity: &mut Instant,
) -> Result<(), SerialFailure> {
    flush_and_mark_bus_activity(output, last_bus_activity).map_err(|error| {
        SerialFailure::new(
            SerialErrorCode::WriteFailed,
            format!("串口发送失败: 无法刷新文件发送数据: {error}"),
        )
    })
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
    modbus_silent_interval: Duration,
) {
    if start_rx.recv().is_err() {
        return;
    }

    let mut read_buffer = [0_u8; READ_BUFFER_SIZE];
    let mut pending_write: Option<PendingWrite> = None;
    let mut modbus_runtime: Option<ModbusRuntime> = None;
    let mut file_runtime: Option<FileSendRuntime> = None;
    let mut terminal_error: Option<SerialFailure> = None;
    let mut last_bus_activity = Instant::now();
    let mut output_needs_drain = false;

    'worker: while !cancel.load(Ordering::Acquire) {
        if settle_cancelled_file_send(&app, &shared_state, &mut pending_write, &mut file_runtime) {
            continue;
        }
        if let Some(runtime) = modbus_runtime.take() {
            match runtime {
                ModbusRuntime::WaitingSilence {
                    command,
                    waiting_since,
                } => {
                    if command.cancel.load(Ordering::Acquire) {
                        finish_modbus_transaction(
                            &app,
                            &shared_state,
                            generation,
                            command.transaction_id,
                            "cancelled",
                            None,
                            None,
                            Duration::ZERO,
                            Some("cancelled"),
                            None,
                            "Modbus RTU 事务已取消，请求尚未发送",
                        );
                    } else if waiting_since.elapsed() >= BUS_ACQUIRE_TIMEOUT {
                        finish_modbus_transaction(
                            &app,
                            &shared_state,
                            generation,
                            command.transaction_id,
                            "error",
                            None,
                            None,
                            waiting_since.elapsed(),
                            Some("bus-busy"),
                            None,
                            "总线持续有数据，未能取得 Modbus RTU 帧间静默窗口",
                        );
                    } else if last_bus_activity.elapsed() >= modbus_silent_interval {
                        pending_write = Some(PendingWrite {
                            data: command.spec.request().to_vec(),
                            offset: 0,
                            origin: PendingWriteOrigin::Modbus(command),
                        });
                    } else {
                        modbus_runtime = Some(ModbusRuntime::WaitingSilence {
                            command,
                            waiting_since,
                        });
                    }
                }
                ModbusRuntime::AwaitingResponse {
                    transaction_id,
                    collector,
                    cancel: transaction_cancel,
                    started_at,
                    started,
                    deadline,
                } => {
                    if transaction_cancel.load(Ordering::Acquire) {
                        finish_modbus_transaction(
                            &app,
                            &shared_state,
                            generation,
                            transaction_id,
                            "cancelled",
                            None,
                            Some(started_at),
                            started.elapsed(),
                            Some("cancelled-after-transmit"),
                            None,
                            "事务已取消，但请求已经发出，写操作可能已被设备执行",
                        );
                    } else if Instant::now() >= deadline {
                        match collector.last_error() {
                            Some(error) => finish_modbus_protocol_error(
                                &app,
                                &shared_state,
                                generation,
                                transaction_id,
                                error,
                                started_at,
                                started.elapsed(),
                            ),
                            None => finish_modbus_transaction(
                                &app,
                                &shared_state,
                                generation,
                                transaction_id,
                                "timeout",
                                None,
                                Some(started_at),
                                started.elapsed(),
                                Some("response-timeout"),
                                None,
                                "等待 Modbus RTU 响应超时",
                            ),
                        }
                    } else {
                        modbus_runtime = Some(ModbusRuntime::AwaitingResponse {
                            transaction_id,
                            collector,
                            cancel: transaction_cancel,
                            started_at,
                            started,
                            deadline,
                        });
                    }
                }
            }
        }

        let mut write_budget = WRITE_BUDGET_PER_TICK;
        while write_budget > 0 && modbus_runtime.is_none() && !cancel.load(Ordering::Acquire) {
            if settle_cancelled_file_send(
                &app,
                &shared_state,
                &mut pending_write,
                &mut file_runtime,
            ) {
                continue 'worker;
            }
            if pending_write.is_none() {
                if file_runtime.is_some() {
                    let file_message = file_runtime
                        .as_ref()
                        .expect("文件发送运行时应当存在")
                        .chunk_rx
                        .try_recv();
                    match file_message {
                        Ok(FileReadMessage::Chunk(data)) => {
                            let job_id = file_runtime
                                .as_ref()
                                .expect("文件发送运行时应当存在")
                                .job_id;
                            pending_write = Some(PendingWrite {
                                data,
                                offset: 0,
                                origin: PendingWriteOrigin::FileSend { job_id },
                            });
                        }
                        Ok(FileReadMessage::Eof) => {
                            let runtime = file_runtime.as_ref().expect("文件发送运行时应当存在");
                            if runtime.transmitted_bytes != runtime.total_bytes {
                                let runtime = file_runtime.take().expect("文件发送运行时应当存在");
                                publish_file_send_terminal(
                                    &app,
                                    &shared_state,
                                    runtime.job_id,
                                    runtime.generation,
                                    SerialFileSendStatus::Error,
                                    Some("source-truncated"),
                                    "源文件在发送过程中被截短".to_owned(),
                                );
                                continue 'worker;
                            }
                            if runtime
                                .phase
                                .compare_exchange(
                                    FILE_SEND_TRANSMITTING,
                                    FILE_SEND_DRAINING,
                                    Ordering::AcqRel,
                                    Ordering::Acquire,
                                )
                                .is_err()
                            {
                                continue 'worker;
                            }
                            if let Err(failure) =
                                flush_file_send_output(&mut *port, &mut last_bus_activity)
                            {
                                let runtime = file_runtime.take().expect("文件发送运行时应当存在");
                                publish_file_send_terminal(
                                    &app,
                                    &shared_state,
                                    runtime.job_id,
                                    runtime.generation,
                                    SerialFileSendStatus::Error,
                                    Some("write-failed"),
                                    failure.message.clone(),
                                );
                                terminal_error = Some(failure);
                                break 'worker;
                            }
                            output_needs_drain = false;
                            let runtime = file_runtime.take().expect("文件发送运行时应当存在");
                            publish_file_send_terminal(
                                &app,
                                &shared_state,
                                runtime.job_id,
                                runtime.generation,
                                SerialFileSendStatus::Completed,
                                None,
                                "文件发送已完成".to_owned(),
                            );
                            continue 'worker;
                        }
                        Ok(FileReadMessage::Error { code, message }) => {
                            let runtime = file_runtime.take().expect("文件发送运行时应当存在");
                            publish_file_send_terminal(
                                &app,
                                &shared_state,
                                runtime.job_id,
                                runtime.generation,
                                SerialFileSendStatus::Error,
                                Some(code),
                                message,
                            );
                            continue 'worker;
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => {
                            if file_runtime
                                .as_ref()
                                .is_some_and(file_reader_disconnect_was_cancelled)
                            {
                                continue 'worker;
                            }
                            let runtime = file_runtime.take().expect("文件发送运行时应当存在");
                            publish_file_send_terminal(
                                &app,
                                &shared_state,
                                runtime.job_id,
                                runtime.generation,
                                SerialFileSendStatus::Error,
                                Some("source-read-failed"),
                                "文件读取线程意外退出".to_owned(),
                            );
                            continue 'worker;
                        }
                    }
                } else {
                    match command_rx.try_recv() {
                        Ok(WorkerCommand::Write(data)) => {
                            pending_write = Some(PendingWrite {
                                data,
                                offset: 0,
                                origin: PendingWriteOrigin::Normal,
                            });
                        }
                        Ok(WorkerCommand::StartModbus(command)) => {
                            if command.cancel.load(Ordering::Acquire) {
                                finish_modbus_transaction(
                                    &app,
                                    &shared_state,
                                    generation,
                                    command.transaction_id,
                                    "cancelled",
                                    None,
                                    None,
                                    Duration::ZERO,
                                    Some("cancelled"),
                                    None,
                                    "Modbus RTU 事务已取消，请求尚未发送",
                                );
                            } else {
                                if output_needs_drain {
                                    if let Err(error) = flush_and_mark_bus_activity(
                                        &mut *port,
                                        &mut last_bus_activity,
                                    ) {
                                        terminal_error = Some(SerialFailure::new(
                                        SerialErrorCode::WriteFailed,
                                        format!(
                                            "串口发送失败: 无法排空 Modbus RTU 事务前的发送数据: {error}"
                                        ),
                                    ));
                                        break 'worker;
                                    }
                                    output_needs_drain = false;
                                }
                                modbus_runtime = Some(ModbusRuntime::WaitingSilence {
                                    command,
                                    waiting_since: Instant::now(),
                                });
                            }
                            break;
                        }
                        Ok(WorkerCommand::StartFileSend(command)) => {
                            let job_id = command.job_id;
                            let command_generation = command.generation;
                            if command_generation != generation {
                                publish_file_send_terminal(
                                    &app,
                                    &shared_state,
                                    job_id,
                                    command_generation,
                                    SerialFileSendStatus::Error,
                                    Some("connection-changed"),
                                    "串口连接已发生变化，文件发送未启动".to_owned(),
                                );
                                break;
                            }
                            if command
                                .phase
                                .compare_exchange(
                                    FILE_SEND_QUEUED,
                                    FILE_SEND_TRANSMITTING,
                                    Ordering::AcqRel,
                                    Ordering::Acquire,
                                )
                                .is_err()
                            {
                                publish_file_send_terminal(
                                    &app,
                                    &shared_state,
                                    job_id,
                                    generation,
                                    SerialFileSendStatus::Cancelled,
                                    Some("cancelled"),
                                    "文件发送已取消，请求尚未开始".to_owned(),
                                );
                                break;
                            }
                            match create_file_send_runtime(command) {
                                Ok(runtime) => {
                                    if !publish_file_send_sending(
                                        &app,
                                        &shared_state,
                                        job_id,
                                        generation,
                                    ) {
                                        runtime
                                            .phase
                                            .store(FILE_SEND_CANCEL_REQUESTED, Ordering::Release);
                                    }
                                    file_runtime = Some(runtime);
                                }
                                Err(message) => {
                                    publish_file_send_terminal(
                                        &app,
                                        &shared_state,
                                        job_id,
                                        generation,
                                        SerialFileSendStatus::Error,
                                        Some("reader-start-failed"),
                                        message,
                                    );
                                }
                            }
                            break;
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => break 'worker,
                    }
                }
            }

            let Some(pending) = pending_write.as_mut() else {
                break;
            };
            if should_cancel_modbus_before_first_write(pending) {
                let cancelled = pending_write.take().expect("待发送数据应当存在");
                if let PendingWriteOrigin::Modbus(command) = cancelled.origin {
                    finish_modbus_transaction(
                        &app,
                        &shared_state,
                        generation,
                        command.transaction_id,
                        "cancelled",
                        None,
                        None,
                        Duration::ZERO,
                        Some("cancelled"),
                        None,
                        "Modbus RTU 事务已取消，请求尚未发送",
                    );
                }
                break;
            }
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
                    last_bus_activity = Instant::now();
                    output_needs_drain = true;
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
                        match completed.origin {
                            PendingWriteOrigin::Normal => {
                                emit_serial_tx(&app, generation, &completed.data);
                            }
                            PendingWriteOrigin::FileSend { job_id } => {
                                let Some(runtime) = file_runtime.as_mut().filter(|runtime| {
                                    runtime.job_id == job_id && runtime.generation == generation
                                }) else {
                                    continue 'worker;
                                };
                                let ready_to_drain = settle_file_send_bytes(
                                    &app,
                                    &shared_state,
                                    runtime,
                                    &completed.data,
                                    true,
                                );
                                if ready_to_drain {
                                    if let Err(failure) =
                                        flush_file_send_output(&mut *port, &mut last_bus_activity)
                                    {
                                        let runtime =
                                            file_runtime.take().expect("文件发送运行时应当存在");
                                        publish_file_send_terminal(
                                            &app,
                                            &shared_state,
                                            runtime.job_id,
                                            runtime.generation,
                                            SerialFileSendStatus::Error,
                                            Some("write-failed"),
                                            failure.message.clone(),
                                        );
                                        terminal_error = Some(failure);
                                        break 'worker;
                                    }
                                    output_needs_drain = false;
                                    let runtime =
                                        file_runtime.take().expect("文件发送运行时应当存在");
                                    publish_file_send_terminal(
                                        &app,
                                        &shared_state,
                                        runtime.job_id,
                                        runtime.generation,
                                        SerialFileSendStatus::Completed,
                                        None,
                                        "文件发送已完成".to_owned(),
                                    );
                                    continue 'worker;
                                }
                            }
                            PendingWriteOrigin::Modbus(command) => {
                                if let Err(error) =
                                    flush_and_mark_bus_activity(&mut *port, &mut last_bus_activity)
                                {
                                    terminal_error = Some(SerialFailure::new(
                                        SerialErrorCode::WriteFailed,
                                        format!("串口发送失败: 无法刷新 Modbus RTU 请求: {error}"),
                                    ));
                                    break 'worker;
                                }
                                output_needs_drain = false;
                                command
                                    .request_phase
                                    .store(MODBUS_REQUEST_TRANSMITTED, Ordering::Release);
                                let transmitted_at = unix_millis();
                                let _ = app.emit(
                                    "serial://tx",
                                    SerialTxPayload {
                                        data: BASE64_STANDARD.encode(&completed.data),
                                        byte_count: completed.data.len(),
                                        transmitted_at,
                                        generation,
                                    },
                                );
                                if command.spec.is_broadcast() {
                                    finish_modbus_transaction(
                                        &app,
                                        &shared_state,
                                        generation,
                                        command.transaction_id,
                                        "completed",
                                        None,
                                        Some(transmitted_at),
                                        Duration::ZERO,
                                        None,
                                        None,
                                        "Modbus RTU 广播写入已完成，不等待响应",
                                    );
                                } else if command.cancel.load(Ordering::Acquire) {
                                    finish_modbus_transaction(
                                        &app,
                                        &shared_state,
                                        generation,
                                        command.transaction_id,
                                        "cancelled",
                                        None,
                                        Some(transmitted_at),
                                        Duration::ZERO,
                                        Some("cancelled-after-transmit"),
                                        None,
                                        "事务已取消，但请求已经发出，写操作可能已被设备执行",
                                    );
                                } else {
                                    let started = Instant::now();
                                    emit_modbus_waiting(
                                        &app,
                                        &shared_state,
                                        generation,
                                        command.transaction_id,
                                        transmitted_at,
                                    );
                                    modbus_runtime = Some(ModbusRuntime::AwaitingResponse {
                                        transaction_id: command.transaction_id,
                                        collector: ModbusResponseCollector::new(command.spec),
                                        cancel: command.cancel,
                                        started_at: transmitted_at,
                                        started,
                                        deadline: started + command.timeout,
                                    });
                                    break;
                                }
                            }
                        }
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
                last_bus_activity = Instant::now();
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
                let response_match = match modbus_runtime.as_mut() {
                    Some(ModbusRuntime::AwaitingResponse { collector, .. }) => {
                        collector.push(&read_buffer[..byte_count])
                    }
                    _ => None,
                };
                if let Some(response_match) = response_match {
                    let Some(ModbusRuntime::AwaitingResponse {
                        transaction_id,
                        started_at,
                        started,
                        ..
                    }) = modbus_runtime.take()
                    else {
                        continue;
                    };
                    match response_match {
                        ResponseMatch::Normal(response) => finish_modbus_transaction(
                            &app,
                            &shared_state,
                            generation,
                            transaction_id,
                            "completed",
                            Some(response),
                            Some(started_at),
                            started.elapsed(),
                            None,
                            None,
                            "Modbus RTU 事务已完成",
                        ),
                        ResponseMatch::Exception { frame, code } => {
                            finish_modbus_transaction(
                                &app,
                                &shared_state,
                                generation,
                                transaction_id,
                                "exception",
                                Some(frame),
                                Some(started_at),
                                started.elapsed(),
                                Some("exception-response"),
                                Some(code),
                                "设备返回 Modbus RTU 异常响应",
                            );
                        }
                        ResponseMatch::ProtocolError(error) => finish_modbus_protocol_error(
                            &app,
                            &shared_state,
                            generation,
                            transaction_id,
                            error,
                            started_at,
                            started.elapsed(),
                        ),
                    }
                }
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

    if let Some(failure) = terminal_error.as_ref() {
        finish_active_file_send_after_serial_failure(
            &app,
            &shared_state,
            &mut pending_write,
            &mut file_runtime,
            failure,
        );
    } else if let Some(runtime) = file_runtime.as_ref() {
        let phase = runtime.phase.load(Ordering::Acquire);
        if matches!(phase, FILE_SEND_QUEUED | FILE_SEND_TRANSMITTING) {
            let _ = runtime.phase.compare_exchange(
                phase,
                FILE_SEND_CANCEL_REQUESTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        settle_cancelled_file_send(&app, &shared_state, &mut pending_write, &mut file_runtime);
    }

    finish_worker(&app, &shared_state, generation, port_name, terminal_error);
}

#[allow(clippy::too_many_arguments)]
fn finish_modbus_transaction(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    transaction_id: u64,
    status: &str,
    response: Option<Vec<u8>>,
    started_at: Option<u64>,
    duration: Duration,
    error_code: Option<&str>,
    exception_code: Option<u8>,
    message: &str,
) {
    let active = {
        let Ok(mut shared) = shared_state.lock() else {
            return;
        };
        if shared.generation != generation
            || !shared.active_modbus.as_ref().is_some_and(|active| {
                active.transaction_id == transaction_id && active.generation == generation
            })
        {
            return;
        }
        shared.active_modbus.take()
    };
    let Some(active) = active else {
        return;
    };
    let ended_at = unix_millis();
    let started_at = started_at.unwrap_or(active.queued_at);
    let _ = app.emit(
        "serial://modbus-transaction",
        SerialModbusTransactionPayload {
            transaction_id,
            status: status.to_owned(),
            request: BASE64_STANDARD.encode(active.request),
            response: response.map(|bytes| BASE64_STANDARD.encode(bytes)),
            started_at,
            ended_at: Some(ended_at),
            duration_ms: duration.as_millis().try_into().unwrap_or(u64::MAX),
            generation,
            error_code: error_code.map(str::to_owned),
            exception_code,
            message: message.to_owned(),
        },
    );
}

fn finish_modbus_protocol_error(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    transaction_id: u64,
    error: ResponseErrorCode,
    started_at: u64,
    duration: Duration,
) {
    finish_modbus_transaction(
        app,
        shared_state,
        generation,
        transaction_id,
        "error",
        None,
        Some(started_at),
        duration,
        Some(error.as_str()),
        None,
        error.message(),
    );
}

fn emit_modbus_waiting(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    transaction_id: u64,
    started_at: u64,
) {
    let request = {
        let Ok(shared) = shared_state.lock() else {
            return;
        };
        let Some(active) = shared.active_modbus.as_ref().filter(|active| {
            active.transaction_id == transaction_id && active.generation == generation
        }) else {
            return;
        };
        active.request.clone()
    };
    let _ = app.emit(
        "serial://modbus-transaction",
        SerialModbusTransactionPayload {
            transaction_id,
            status: "waiting".to_owned(),
            request: BASE64_STANDARD.encode(request),
            response: None,
            started_at,
            ended_at: None,
            duration_ms: 0,
            generation,
            error_code: None,
            exception_code: None,
            message: "等待 Modbus RTU 响应".to_owned(),
        },
    );
}

fn finish_worker(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    port_name: String,
    terminal_error: Option<SerialFailure>,
) {
    let active_transaction = shared_state.lock().ok().and_then(|shared| {
        shared
            .active_modbus
            .as_ref()
            .filter(|active| active.generation == generation)
            .map(|active| active.transaction_id)
    });
    if let Some(transaction_id) = active_transaction {
        let message = terminal_error
            .as_ref()
            .map(|failure| failure.message.as_str())
            .unwrap_or("串口连接已结束，Modbus RTU 事务未完成");
        finish_modbus_transaction(
            app,
            shared_state,
            generation,
            transaction_id,
            "error",
            None,
            None,
            Duration::ZERO,
            Some("connection-lost"),
            None,
            message,
        );
    }
    let active_file_send = shared_state.lock().ok().and_then(|shared| {
        shared
            .active_file_send
            .as_ref()
            .filter(|active| active.generation == generation)
            .map(|active| (active.job_id, Arc::clone(&active.phase)))
    });
    if let Some((job_id, phase)) = active_file_send {
        if terminal_error.is_none() {
            let current_phase = phase.load(Ordering::Acquire);
            if matches!(current_phase, FILE_SEND_QUEUED | FILE_SEND_TRANSMITTING) {
                let _ = phase.compare_exchange(
                    current_phase,
                    FILE_SEND_CANCEL_REQUESTED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
            }
        }
        match terminal_error.as_ref() {
            Some(failure) => publish_file_send_terminal(
                app,
                shared_state,
                job_id,
                generation,
                SerialFileSendStatus::Error,
                Some(if failure.code == SerialErrorCode::WriteFailed {
                    "write-failed"
                } else {
                    "connection-lost"
                }),
                failure.message.clone(),
            ),
            None => publish_file_send_terminal(
                app,
                shared_state,
                job_id,
                generation,
                SerialFileSendStatus::Cancelled,
                Some("cancelled"),
                FILE_SEND_CONNECTION_ENDED_MESSAGE.to_owned(),
            ),
        }
    }
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

fn emit_file_send_state(app: &AppHandle, payload: SerialFileSendPayload) {
    let _ = app.emit("serial://file-send", payload);
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

    #[test]
    fn queued_modbus_cancel_finishes_immediately_but_transmitting_cancel_waits_for_worker() {
        let shared_state = Arc::new(Mutex::new(SharedSerialState::default()));
        let queued_cancel = Arc::new(AtomicBool::new(false));
        let queued_phase = Arc::new(AtomicU8::new(MODBUS_REQUEST_QUEUED));
        {
            let mut shared = shared_state.lock().unwrap();
            shared.generation = 7;
            shared.active_modbus = Some(ActiveModbusControl {
                transaction_id: 11,
                generation: 7,
                request: vec![1, 3, 0, 0, 0, 1, 0x84, 0x0a],
                queued_at: 100,
                cancel: Arc::clone(&queued_cancel),
                request_phase: Arc::clone(&queued_phase),
            });
        }

        let queued = request_modbus_cancel(&shared_state, 11)
            .unwrap()
            .expect("排队事务应当存在");
        assert_eq!(queued.generation, 7);
        assert!(queued.finish_before_transmit);
        assert!(queued_cancel.load(Ordering::Acquire));

        let transmitting_cancel = Arc::new(AtomicBool::new(false));
        let transmitting_phase = Arc::new(AtomicU8::new(MODBUS_REQUEST_TRANSMITTING));
        {
            let mut shared = shared_state.lock().unwrap();
            shared.active_modbus = Some(ActiveModbusControl {
                transaction_id: 12,
                generation: 7,
                request: vec![1, 3, 0, 0, 0, 1, 0x84, 0x0a],
                queued_at: 200,
                cancel: Arc::clone(&transmitting_cancel),
                request_phase: transmitting_phase,
            });
        }

        let transmitting = request_modbus_cancel(&shared_state, 12)
            .unwrap()
            .expect("发送中的事务应当存在");
        assert!(!transmitting.finish_before_transmit);
        assert!(transmitting_cancel.load(Ordering::Acquire));
    }

    #[test]
    fn file_reader_streams_bounded_chunks_in_order_without_duplicates() {
        let source: Vec<u8> = (0..(MAX_WRITE_SIZE + 37))
            .map(|index| (index % 251) as u8)
            .collect();
        let messages = collect_file_messages(
            std::io::Cursor::new(source.clone()),
            source.len() as u64,
            Arc::new(AtomicU8::new(FILE_SEND_TRANSMITTING)),
        );
        let mut reconstructed = Vec::new();
        let mut chunk_lengths = Vec::new();
        let mut saw_eof = false;
        for message in messages {
            match message {
                FileReadMessage::Chunk(chunk) => {
                    chunk_lengths.push(chunk.len());
                    reconstructed.extend_from_slice(&chunk);
                }
                FileReadMessage::Eof => saw_eof = true,
                FileReadMessage::Error { message, .. } => panic!("意外读取错误: {message}"),
            }
        }

        assert_eq!(chunk_lengths, vec![MAX_WRITE_SIZE, 37]);
        assert_eq!(reconstructed, source);
        assert!(saw_eof);
    }

    #[test]
    fn empty_file_reader_emits_only_eof() {
        let messages = collect_file_messages(
            std::io::Cursor::new(Vec::<u8>::new()),
            0,
            Arc::new(AtomicU8::new(FILE_SEND_TRANSMITTING)),
        );
        assert!(matches!(messages.as_slice(), [FileReadMessage::Eof]));
    }

    #[test]
    fn file_send_size_must_fit_javascript_safe_integer() {
        assert!(validate_file_send_size(MAX_JAVASCRIPT_SAFE_INTEGER).is_ok());
        assert!(validate_file_send_size(MAX_JAVASCRIPT_SAFE_INTEGER + 1).is_err());
    }

    #[test]
    fn rendezvous_file_reader_can_be_polled_with_try_recv() {
        let phase = Arc::new(AtomicU8::new(FILE_SEND_TRANSMITTING));
        let (chunk_tx, chunk_rx) = mpsc::sync_channel(FILE_READ_CHANNEL_CAPACITY);
        let producer = thread::spawn(move || {
            stream_file_chunks(std::io::Cursor::new(vec![1, 2, 3]), 3, phase, chunk_tx);
        });

        let receive_before = |deadline: Instant| loop {
            match chunk_rx.try_recv() {
                Ok(message) => break message,
                Err(mpsc::TryRecvError::Empty) if Instant::now() < deadline => {
                    thread::yield_now();
                }
                Err(error) => panic!("文件读取通道未按期产生消息: {error}"),
            }
        };
        let chunk = receive_before(Instant::now() + Duration::from_secs(1));
        assert!(matches!(chunk, FileReadMessage::Chunk(data) if data == vec![1, 2, 3]));
        let eof = receive_before(Instant::now() + Duration::from_secs(1));
        assert!(matches!(eof, FileReadMessage::Eof));
        producer.join().unwrap();
    }

    #[test]
    fn file_reader_reports_truncation_and_read_errors_and_ignores_growth() {
        let truncated = collect_file_messages(
            std::io::Cursor::new(vec![1, 2, 3]),
            4,
            Arc::new(AtomicU8::new(FILE_SEND_TRANSMITTING)),
        );
        assert!(truncated.iter().any(|message| {
            matches!(
                message,
                FileReadMessage::Error {
                    code: "source-truncated",
                    ..
                }
            )
        }));

        let failed = collect_file_messages(
            FailingReader,
            1,
            Arc::new(AtomicU8::new(FILE_SEND_TRANSMITTING)),
        );
        assert!(failed.iter().any(|message| {
            matches!(
                message,
                FileReadMessage::Error {
                    code: "source-read-failed",
                    ..
                }
            )
        }));

        let grown = collect_file_messages(
            std::io::Cursor::new(vec![10, 20, 30, 40]),
            2,
            Arc::new(AtomicU8::new(FILE_SEND_TRANSMITTING)),
        );
        let chunks: Vec<Vec<u8>> = grown
            .into_iter()
            .filter_map(|message| match message {
                FileReadMessage::Chunk(chunk) => Some(chunk),
                _ => None,
            })
            .collect();
        assert_eq!(chunks, vec![vec![10, 20]]);
    }

    #[test]
    fn cancelled_file_reader_stops_without_publishing_data() {
        let messages = collect_file_messages(
            std::io::Cursor::new(vec![1, 2, 3]),
            3,
            Arc::new(AtomicU8::new(FILE_SEND_CANCEL_REQUESTED)),
        );
        assert!(messages.is_empty());
    }

    #[test]
    fn cancelled_reader_disconnect_is_not_classified_as_a_read_failure() {
        let (chunk_tx, chunk_rx) = mpsc::channel();
        drop(chunk_tx);
        let phase = Arc::new(AtomicU8::new(FILE_SEND_CANCEL_REQUESTED));
        let runtime = FileSendRuntime {
            job_id: 1,
            generation: 2,
            total_bytes: 3,
            transmitted_bytes: 0,
            phase: Arc::clone(&phase),
            chunk_rx,
        };
        assert!(file_reader_disconnect_was_cancelled(&runtime));

        phase.store(FILE_SEND_TRANSMITTING, Ordering::Release);
        assert!(!file_reader_disconnect_was_cancelled(&runtime));
    }

    #[test]
    fn file_send_cancel_is_allowed_until_draining() {
        for initial_phase in [FILE_SEND_QUEUED, FILE_SEND_TRANSMITTING] {
            let (mut shared, phase, job_id) = test_file_send_state(7);
            phase.store(initial_phase, Ordering::Release);
            if initial_phase == FILE_SEND_TRANSMITTING {
                assert!(shared.mark_file_send_sending(job_id, 7).is_some());
            }
            let revision = shared.file_send_revision;
            let (accepted, payload) = shared.request_file_send_cancel(job_id);
            assert!(accepted);
            assert_eq!(payload.expect("首次取消应发布状态").status, "cancelling");
            assert_eq!(phase.load(Ordering::Acquire), FILE_SEND_CANCEL_REQUESTED);

            let (accepted_again, repeated_payload) = shared.request_file_send_cancel(job_id);
            assert!(accepted_again);
            assert!(repeated_payload.is_none());
            assert_eq!(shared.file_send_revision, revision + 1);
        }

        let (mut shared, phase, job_id) = test_file_send_state(9);
        phase.store(FILE_SEND_TRANSMITTING, Ordering::Release);
        assert!(shared.mark_file_send_sending(job_id, 9).is_some());
        phase.store(FILE_SEND_DRAINING, Ordering::Release);
        let revision = shared.file_send_revision;
        let (accepted, payload) = shared.request_file_send_cancel(job_id);
        assert!(!accepted);
        assert!(payload.is_none());
        assert_eq!(shared.file_send_revision, revision);
    }

    #[test]
    fn stale_file_job_or_generation_cannot_update_state_or_add_a_terminal_event() {
        let (mut shared, phase, job_id) = test_file_send_state(12);
        phase.store(FILE_SEND_TRANSMITTING, Ordering::Release);
        assert!(shared.mark_file_send_sending(job_id, 12).is_some());
        let revision = shared.file_send_revision;

        assert!(shared
            .update_file_send_progress(job_id + 1, 12, 4)
            .is_none());
        assert!(shared
            .finish_file_send(
                job_id,
                11,
                SerialFileSendStatus::Cancelled,
                Some("cancelled"),
                "过期任务".to_owned(),
            )
            .is_none());
        assert_eq!(shared.file_send_revision, revision);

        assert!(shared.update_file_send_progress(job_id, 12, 4).is_some());
        let terminal = shared
            .finish_file_send(
                job_id,
                12,
                SerialFileSendStatus::Cancelled,
                Some("cancelled"),
                "文件发送已取消".to_owned(),
            )
            .expect("当前任务应当产生终态");
        assert_eq!(terminal.status, "cancelled");
        let terminal_revision = shared.file_send_revision;
        assert!(shared
            .finish_file_send(
                job_id,
                12,
                SerialFileSendStatus::Error,
                Some("connection-lost"),
                "重复终态".to_owned(),
            )
            .is_none());
        assert_eq!(shared.file_send_revision, terminal_revision);
    }

    #[test]
    fn partial_file_write_prefix_is_taken_exactly_once() {
        let mut pending = Some(PendingWrite {
            data: vec![1, 2, 3, 4, 5],
            offset: 3,
            origin: PendingWriteOrigin::FileSend { job_id: 21 },
        });
        assert_eq!(take_file_send_prefix(&mut pending, 21), Some(vec![1, 2, 3]));
        assert!(take_file_send_prefix(&mut pending, 21).is_none());

        let mut normal = Some(PendingWrite {
            data: vec![7, 8],
            offset: 1,
            origin: PendingWriteOrigin::Normal,
        });
        assert!(take_file_send_prefix(&mut normal, 21).is_none());
        assert!(normal.is_some());
    }

    #[test]
    fn file_send_admission_rejects_disconnected_modbus_and_active_file() {
        let mut shared = SharedSerialState::default();
        assert!(shared.ensure_file_send_admission().is_err());

        shared.status = SerialStatus::Connected;
        shared.generation = 3;
        assert!(shared.ensure_file_send_admission().is_ok());
        shared.active_modbus = Some(ActiveModbusControl {
            transaction_id: 1,
            generation: 3,
            request: vec![1, 3, 0, 0, 0, 1, 0x84, 0x0a],
            queued_at: 0,
            cancel: Arc::new(AtomicBool::new(false)),
            request_phase: Arc::new(AtomicU8::new(MODBUS_REQUEST_QUEUED)),
        });
        assert!(shared.ensure_file_send_admission().is_err());

        shared.active_modbus = None;
        let phase = Arc::new(AtomicU8::new(FILE_SEND_QUEUED));
        shared
            .queue_file_send(3, "firmware.bin".to_owned(), 8, phase)
            .unwrap();
        assert!(shared.ensure_file_send_admission().is_err());
    }

    #[test]
    fn file_send_payload_uses_camel_case_without_exposing_a_path() {
        let (shared, _, _) = test_file_send_state(4);
        let value = serde_json::to_value(shared.file_send_payload()).unwrap();
        assert_eq!(value["fileName"], "firmware.bin");
        assert_eq!(value["totalBytes"], 16);
        assert!(value.get("file_name").is_none());
        assert!(value.get("path").is_none());
    }

    #[test]
    fn file_flush_failure_maps_to_serial_write_failure() {
        let mut last_bus_activity = Instant::now() - Duration::from_secs(1);
        let mut output = FlushProbe::default();
        assert!(flush_file_send_output(&mut output, &mut last_bus_activity).is_ok());
        assert!(output.flushed_at.is_some());

        let previous_activity = last_bus_activity;
        let mut failed_output = FlushProbe {
            fail: true,
            ..FlushProbe::default()
        };
        let failure = flush_file_send_output(&mut failed_output, &mut last_bus_activity)
            .expect_err("flush 失败必须阻止完成");
        assert_eq!(failure.code, SerialErrorCode::WriteFailed);
        assert_eq!(last_bus_activity, previous_activity);
    }

    #[test]
    fn bus_activity_is_reanchored_only_after_output_flush_succeeds() {
        let mut output = FlushProbe::default();
        let mut last_bus_activity = Instant::now() - Duration::from_secs(1);
        flush_and_mark_bus_activity(&mut output, &mut last_bus_activity).unwrap();
        assert!(last_bus_activity >= output.flushed_at.expect("应记录 flush 时刻"));

        let previous_activity = last_bus_activity;
        let mut failed_output = FlushProbe {
            fail: true,
            ..FlushProbe::default()
        };
        assert!(flush_and_mark_bus_activity(&mut failed_output, &mut last_bus_activity).is_err());
        assert_eq!(last_bus_activity, previous_activity);
    }

    #[derive(Default)]
    struct FlushProbe {
        flushed_at: Option<Instant>,
        fail: bool,
    }

    impl Write for FlushProbe {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flushed_at = Some(Instant::now());
            if self.fail {
                Err(std::io::Error::other("flush failed"))
            } else {
                Ok(())
            }
        }
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _bytes: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("read failed"))
        }
    }

    fn collect_file_messages<R: Read + Send + 'static>(
        reader: R,
        total_bytes: u64,
        phase: Arc<AtomicU8>,
    ) -> Vec<FileReadMessage> {
        let (chunk_tx, chunk_rx) = mpsc::sync_channel(FILE_READ_CHANNEL_CAPACITY);
        let producer =
            thread::spawn(move || stream_file_chunks(reader, total_bytes, phase, chunk_tx));
        let messages = chunk_rx.into_iter().collect();
        producer.join().unwrap();
        messages
    }

    fn test_file_send_state(generation: u64) -> (SharedSerialState, Arc<AtomicU8>, u64) {
        let mut shared = SharedSerialState {
            generation,
            status: SerialStatus::Connected,
            ..SharedSerialState::default()
        };
        let phase = Arc::new(AtomicU8::new(FILE_SEND_QUEUED));
        let payload = shared
            .queue_file_send(
                generation,
                "firmware.bin".to_owned(),
                16,
                Arc::clone(&phase),
            )
            .unwrap();
        (shared, phase, payload.job_id)
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
