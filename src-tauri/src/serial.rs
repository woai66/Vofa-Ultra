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
    transition: Mutex<()>,
    shared: Arc<Mutex<SharedSerialState>>,
}

impl Default for SerialState {
    fn default() -> Self {
        Self {
            transition: Mutex::new(()),
            shared: Arc::new(Mutex::new(SharedSerialState::default())),
        }
    }
}

struct SharedSerialState {
    generation: u64,
    revision: u64,
    status: SerialStatus,
    port_name: String,
    message: Option<String>,
    worker: Option<SerialWorker>,
}

impl Default for SharedSerialState {
    fn default() -> Self {
        Self {
            generation: 0,
            revision: 0,
            status: SerialStatus::Disconnected,
            port_name: String::new(),
            message: None,
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
    ) -> SerialStatePayload {
        self.revision = self.revision.saturating_add(1);
        self.status = status;
        self.port_name = port_name;
        self.message = message;
        self.snapshot()
    }

    fn snapshot(&self) -> SerialStatePayload {
        SerialStatePayload {
            status: self.status.as_str().to_owned(),
            port_name: self.port_name.clone(),
            message: self.message.clone(),
            generation: self.generation,
            revision: self.revision,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SerialStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
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
    fn stop(mut self) -> Result<(), String> {
        self.cancel.store(true, Ordering::Release);
        drop(self.command_tx.take());

        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|panic| format!("串口工作线程异常退出: {}", panic_message(panic)))?;
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
pub fn connect_serial(
    app: AppHandle,
    state: State<'_, SerialState>,
    capture_state: State<'_, CaptureState>,
    config: SerialConfig,
) -> Result<SerialStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "串口生命周期锁已损坏".to_owned())?;
    stop_current_worker(&app, &state.shared)?;

    let port_name = config.port_name.clone();
    let generation = begin_connection(&app, &state.shared, &port_name)?;
    config
        .validate(true)
        .map_err(|message| fail_connection(&app, &state.shared, generation, &port_name, message))?;
    let data_bits = parse_data_bits(config.data_bits)
        .map_err(|message| fail_connection(&app, &state.shared, generation, &port_name, message))?;
    let parity = parse_parity(&config.parity)
        .map_err(|message| fail_connection(&app, &state.shared, generation, &port_name, message))?;
    let stop_bits = parse_stop_bits(config.stop_bits)
        .map_err(|message| fail_connection(&app, &state.shared, generation, &port_name, message))?;
    let flow_control = parse_flow_control(&config.flow_control)
        .map_err(|message| fail_connection(&app, &state.shared, generation, &port_name, message))?;
    let hardware_flow_control = matches!(flow_control, FlowControl::Hardware);

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
                &state.shared,
                generation,
                &port_name,
                format!("无法打开串口 {}: {error}", config.port_name),
            )
        })?;

    port.write_data_terminal_ready(config.dtr)
        .map_err(|error| {
            fail_connection(
                &app,
                &state.shared,
                generation,
                &port_name,
                format!("设置 DTR 失败: {error}"),
            )
        })?;
    if !hardware_flow_control {
        port.write_request_to_send(config.rts).map_err(|error| {
            fail_connection(
                &app,
                &state.shared,
                generation,
                &port_name,
                format!("设置 RTS 失败: {error}"),
            )
        })?;
    }

    let (command_tx, command_rx) = mpsc::sync_channel(WRITE_QUEUE_CAPACITY);
    let (start_tx, start_rx) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let worker_shared = Arc::clone(&state.shared);
    let worker_app = app.clone();
    let worker_port_name = port_name.clone();
    let recorder = capture_state.recorder_handle();
    let join_handle = match thread::Builder::new()
        .name("vofa-serial-worker".to_owned())
        .spawn(move || {
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
        }) {
        Ok(join_handle) => join_handle,
        Err(error) => {
            let message = format!("创建串口工作线程失败: {error}");
            return Err(fail_connection(
                &app,
                &state.shared,
                generation,
                &port_name,
                message,
            ));
        }
    };

    let payload = {
        let mut shared = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        shared.worker = Some(SerialWorker {
            generation,
            command_tx: Some(command_tx),
            cancel,
            join_handle: Some(join_handle),
        });
        shared.transition(SerialStatus::Connected, port_name.clone(), None)
    };
    emit_state(&app, payload.clone());

    if start_tx.send(()).is_err() {
        let message = "串口工作线程未能启动".to_owned();
        let worker = state
            .shared
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?
            .worker
            .take();
        if let Some(worker) = worker {
            let _ = worker.stop();
        }
        return Err(fail_connection(
            &app,
            &state.shared,
            generation,
            &port_name,
            message,
        ));
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
        if shared.status != SerialStatus::Disconnected || shared.message.is_some() {
            let port_name = shared.port_name.clone();
            shared.transition(SerialStatus::Disconnected, port_name, None)
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

    if let Err(message) = worker.stop() {
        let payload = {
            let mut shared = shared_state
                .lock()
                .map_err(|_| "串口状态锁已损坏".to_owned())?;
            if shared.generation != generation {
                return Err(message);
            }
            let port_name = shared.port_name.clone();
            shared.transition(SerialStatus::Error, port_name, Some(message.clone()))
        };
        emit_state(app, payload);
        return Err(message);
    }

    Ok(())
}

fn begin_connection(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    port_name: &str,
) -> Result<u64, String> {
    let (generation, payload) = {
        let mut shared = shared_state
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_owned())?;
        shared.generation = shared.generation.wrapping_add(1).max(1);
        let generation = shared.generation;
        let payload = shared.transition(SerialStatus::Connecting, port_name.to_owned(), None);
        (generation, payload)
    };
    emit_state(app, payload);
    Ok(generation)
}

fn fail_connection(
    app: &AppHandle,
    shared_state: &Arc<Mutex<SharedSerialState>>,
    generation: u64,
    port_name: &str,
    message: String,
) -> String {
    let payload = shared_state.lock().ok().and_then(|mut shared| {
        if shared.generation != generation {
            return None;
        }
        Some(shared.transition(
            SerialStatus::Error,
            port_name.to_owned(),
            Some(message.clone()),
        ))
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
    message
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
    let mut terminal_error: Option<String> = None;

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
                    terminal_error = Some("串口发送失败: 写入操作未取得进展".to_owned());
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
                    terminal_error = Some(format!("串口发送失败: {error}"));
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
                terminal_error = Some(format!("串口读取失败: {error}"));
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
    terminal_error: Option<String>,
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
            Some(message) => shared.transition(SerialStatus::Error, port_name, Some(message)),
            None => shared.transition(SerialStatus::Disconnected, port_name, None),
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
        let connecting = shared.transition(SerialStatus::Connecting, "COM3".to_owned(), None);
        let connected = shared.transition(SerialStatus::Connected, "COM3".to_owned(), None);

        assert!(connected.revision > connecting.revision);
        assert_eq!(connected.status, "connected");
    }
}
