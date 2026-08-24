use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, ErrorKind, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::capture::{
    CaptureDirection, CaptureHeader, CaptureItem, CaptureReadError, CaptureReader, CaptureRecord,
    CaptureRecordStats, CaptureState,
};

const MAX_PATH_CHARS: usize = 4096;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const SHUTDOWN_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
const PHASE_RUNNING: u8 = 0;
const PHASE_CANCELLED: u8 = 1;
const PHASE_COMMITTING: u8 = 2;
const PHASE_COMPLETED: u8 = 3;

type InputReader = CaptureReader<CountingReader<BufReader<File>>>;
type OutputWriter = CountingWriter<BufWriter<File>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureExportRequest {
    source_path: String,
    destination_path: String,
    format: String,
    direction: String,
    allow_incomplete: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureExportStatePayload {
    status: String,
    phase: String,
    job_id: u64,
    revision: u64,
    source_path: String,
    destination_path: String,
    format: String,
    direction: String,
    allow_incomplete: bool,
    total_input_bytes: u64,
    processed_input_bytes: u64,
    processed_data_bytes: u64,
    processed_records: u64,
    exported_data_bytes: u64,
    exported_records: u64,
    output_bytes: u64,
    source_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub struct CaptureExportState {
    transition: Mutex<()>,
    core: Arc<ExportCore>,
}

impl Default for CaptureExportState {
    fn default() -> Self {
        Self {
            transition: Mutex::new(()),
            core: Arc::new(ExportCore {
                shared: Mutex::new(SharedExportState::default()),
            }),
        }
    }
}

impl Drop for CaptureExportState {
    fn drop(&mut self) {
        let _transition = self
            .transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let worker = self
            .core
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .worker
            .take();
        if let Some(worker) = worker {
            worker.control.request_cancel();
            let (done_sender, done_receiver) = mpsc::channel();
            let spawn_result = thread::Builder::new()
                .name("vofa-export-shutdown".to_owned())
                .spawn(move || {
                    let _ = worker.join();
                    let _ = done_sender.send(());
                });
            if spawn_result.is_ok() {
                let _ = done_receiver.recv_timeout(SHUTDOWN_JOIN_TIMEOUT);
            }
        }
    }
}

struct ExportCore {
    shared: Mutex<SharedExportState>,
}

struct SharedExportState {
    status: ExportStatus,
    phase: ExportPhase,
    job_id: u64,
    revision: u64,
    source_path: String,
    destination_path: String,
    format: String,
    direction: String,
    allow_incomplete: bool,
    total_input_bytes: u64,
    processed_input_bytes: u64,
    processed_data_bytes: u64,
    processed_records: u64,
    exported_data_bytes: u64,
    exported_records: u64,
    output_bytes: u64,
    source_complete: bool,
    started_at_unix_ms: Option<u64>,
    ended_at_unix_ms: Option<u64>,
    message: Option<String>,
    worker: Option<ExportWorker>,
}

impl Default for SharedExportState {
    fn default() -> Self {
        Self {
            status: ExportStatus::Idle,
            phase: ExportPhase::Idle,
            job_id: 0,
            revision: 0,
            source_path: String::new(),
            destination_path: String::new(),
            format: "csv".to_owned(),
            direction: "both".to_owned(),
            allow_incomplete: false,
            total_input_bytes: 0,
            processed_input_bytes: 0,
            processed_data_bytes: 0,
            processed_records: 0,
            exported_data_bytes: 0,
            exported_records: 0,
            output_bytes: 0,
            source_complete: false,
            started_at_unix_ms: None,
            ended_at_unix_ms: None,
            message: None,
            worker: None,
        }
    }
}

impl SharedExportState {
    fn snapshot(&self) -> CaptureExportStatePayload {
        CaptureExportStatePayload {
            status: self.status.as_str().to_owned(),
            phase: self.phase.as_str().to_owned(),
            job_id: self.job_id,
            revision: self.revision,
            source_path: self.source_path.clone(),
            destination_path: self.destination_path.clone(),
            format: self.format.clone(),
            direction: self.direction.clone(),
            allow_incomplete: self.allow_incomplete,
            total_input_bytes: self.total_input_bytes,
            processed_input_bytes: self.processed_input_bytes,
            processed_data_bytes: self.processed_data_bytes,
            processed_records: self.processed_records,
            exported_data_bytes: self.exported_data_bytes,
            exported_records: self.exported_records,
            output_bytes: self.output_bytes,
            source_complete: self.source_complete,
            started_at_unix_ms: self.started_at_unix_ms,
            ended_at_unix_ms: self.ended_at_unix_ms,
            message: self.message.clone(),
        }
    }

    fn touch(&mut self) -> CaptureExportStatePayload {
        self.revision = self.revision.saturating_add(1);
        self.snapshot()
    }

    fn reset_idle(&mut self) -> CaptureExportStatePayload {
        let job_id = self.job_id;
        let revision = self.revision;
        *self = Self::default();
        self.job_id = job_id;
        self.revision = revision;
        self.touch()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExportStatus {
    Idle,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Error,
}

impl ExportStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExportPhase {
    Idle,
    Preparing,
    Reading,
    Finalizing,
    Committing,
    Done,
}

impl ExportPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Reading => "reading",
            Self::Finalizing => "finalizing",
            Self::Committing => "committing",
            Self::Done => "done",
        }
    }
}

struct ExportWorker {
    job_id: u64,
    control: Arc<ExportControl>,
    join_handle: Option<JoinHandle<()>>,
}

impl ExportWorker {
    fn cancel_and_join(mut self) -> Result<(), String> {
        self.control.request_cancel();
        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|panic| format!("导出线程异常退出: {}", panic_message(panic)))?;
        }
        Ok(())
    }

    fn join(mut self) -> Result<(), String> {
        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|panic| format!("导出线程异常退出: {}", panic_message(panic)))?;
        }
        Ok(())
    }
}

struct ExportControl {
    phase: AtomicU8,
}

impl ExportControl {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(PHASE_RUNNING),
        }
    }

    fn request_cancel(&self) -> bool {
        self.phase
            .compare_exchange(
                PHASE_RUNNING,
                PHASE_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn is_cancelled(&self) -> bool {
        self.phase.load(Ordering::Acquire) == PHASE_CANCELLED
    }

    fn begin_commit(&self) -> bool {
        self.phase
            .compare_exchange(
                PHASE_RUNNING,
                PHASE_COMMITTING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn mark_completed(&self) {
        self.phase.store(PHASE_COMPLETED, Ordering::Release);
    }
}

#[derive(Clone, Copy)]
enum ExportFormat {
    Csv,
    Jsonl,
    Binary,
}

impl ExportFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "csv" => Ok(Self::Csv),
            "jsonl" => Ok(Self::Jsonl),
            "binary" => Ok(Self::Binary),
            _ => Err(format!("不支持的导出格式: {value}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Jsonl => "jsonl",
            Self::Binary => "binary",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Jsonl => "jsonl",
            Self::Binary => "bin",
        }
    }
}

#[derive(Clone, Copy)]
enum ExportDirection {
    Both,
    Rx,
    Tx,
}

impl ExportDirection {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "both" => Ok(Self::Both),
            "rx" => Ok(Self::Rx),
            "tx" => Ok(Self::Tx),
            _ => Err(format!("不支持的导出方向: {value}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Both => "both",
            Self::Rx => "rx",
            Self::Tx => "tx",
        }
    }

    fn matches(self, direction: CaptureDirection) -> bool {
        matches!(self, Self::Both)
            || matches!((self, direction), (Self::Rx, CaptureDirection::Rx))
            || matches!((self, direction), (Self::Tx, CaptureDirection::Tx))
    }
}

struct PreparedExport {
    source_path: PathBuf,
    destination_path: PathBuf,
    temp_path: PathBuf,
    format: ExportFormat,
    direction: ExportDirection,
    allow_incomplete: bool,
    header: CaptureHeader,
    reader: InputReader,
    input_count: Arc<AtomicU64>,
    writer: Option<OutputWriter>,
    source_fingerprint: SourceFingerprint,
}

#[derive(Clone, Copy)]
struct SourceFingerprint {
    length: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Default)]
struct ExportProgress {
    processed_input_bytes: u64,
    processed_data_bytes: u64,
    processed_records: u64,
    exported_data_bytes: u64,
    exported_records: u64,
    output_bytes: u64,
}

enum WorkerOutcome {
    Completed {
        progress: ExportProgress,
        source_complete: bool,
        message: String,
    },
    Cancelled {
        progress: ExportProgress,
        message: String,
    },
    Failed {
        progress: ExportProgress,
        message: String,
    },
}

#[tauri::command]
pub fn get_capture_export_state(
    state: State<'_, CaptureExportState>,
) -> Result<CaptureExportStatePayload, String> {
    snapshot_export_state(&state)
}

#[tauri::command]
pub fn start_capture_export(
    app: AppHandle,
    state: State<'_, CaptureExportState>,
    capture_state: State<'_, CaptureState>,
    request: CaptureExportRequest,
) -> Result<CaptureExportStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "导出生命周期锁已损坏".to_owned())?;
    if capture_state.has_active_capture()? {
        return Err("录制进行中不能导出，请先完成当前捕获文件".to_owned());
    }

    let stale_worker = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "导出状态锁已损坏".to_owned())?;
        if matches!(
            shared.status,
            ExportStatus::Running | ExportStatus::Cancelling
        ) {
            return Err("已有捕获导出任务正在运行".to_owned());
        }
        shared.worker.take()
    };
    if let Some(worker) = stale_worker {
        worker.join()?;
    }

    let job_id = state
        .core
        .shared
        .lock()
        .map_err(|_| "导出状态锁已损坏".to_owned())?
        .job_id
        .wrapping_add(1)
        .max(1);
    let prepared = prepare_export(request, job_id)?;
    let total_input_bytes = prepared.source_fingerprint.length;
    let source_path_text = prepared.source_path.to_string_lossy().into_owned();
    let destination_path_text = prepared.destination_path.to_string_lossy().into_owned();
    let format_text = prepared.format.as_str().to_owned();
    let direction_text = prepared.direction.as_str().to_owned();
    let allow_incomplete = prepared.allow_incomplete;
    let temp_path = prepared.temp_path.clone();
    let control = Arc::new(ExportControl::new());
    let worker_control = Arc::clone(&control);
    let worker_core = Arc::clone(&state.core);
    let worker_app = app.clone();
    let panic_core = Arc::clone(&state.core);
    let panic_app = app.clone();
    let panic_temp_path = temp_path.clone();
    let (start_sender, start_receiver) = mpsc::channel();
    let join_handle = thread::Builder::new()
        .name("vofa-capture-export".to_owned())
        .spawn(move || {
            if start_receiver.recv().is_err() {
                let _ = remove_temp_file(&panic_temp_path);
                return;
            }
            let result = catch_unwind(AssertUnwindSafe(|| {
                run_export_worker(&worker_app, &worker_core, job_id, worker_control, prepared);
            }));
            if let Err(panic) = result {
                let cleanup = remove_temp_file(&panic_temp_path).err();
                let mut message = format!("导出线程异常退出: {}", panic_message(panic));
                if let Some(cleanup) = cleanup {
                    message.push_str(&format!("；{cleanup}"));
                }
                panic_core.publish_terminal(
                    &panic_app,
                    job_id,
                    ExportStatus::Error,
                    &ExportProgress::default(),
                    false,
                    message,
                );
            }
        })
        .map_err(|error| {
            let _ = remove_temp_file(&temp_path);
            format!("创建导出线程失败: {error}")
        })?;

    let payload = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "导出状态锁已损坏".to_owned())?;
        shared.status = ExportStatus::Running;
        shared.phase = ExportPhase::Preparing;
        shared.job_id = job_id;
        shared.source_path = source_path_text;
        shared.destination_path = destination_path_text;
        shared.format = format_text;
        shared.direction = direction_text;
        shared.allow_incomplete = allow_incomplete;
        shared.total_input_bytes = total_input_bytes;
        shared.processed_input_bytes = 0;
        shared.processed_data_bytes = 0;
        shared.processed_records = 0;
        shared.exported_data_bytes = 0;
        shared.exported_records = 0;
        shared.output_bytes = 0;
        shared.source_complete = false;
        shared.started_at_unix_ms = Some(unix_millis());
        shared.ended_at_unix_ms = None;
        shared.message = Some("正在准备流式导出".to_owned());
        shared.worker = Some(ExportWorker {
            job_id,
            control,
            join_handle: Some(join_handle),
        });
        shared.touch()
    };
    emit_state(&app, payload.clone());

    if start_sender.send(()).is_err() {
        let worker = state
            .core
            .shared
            .lock()
            .map_err(|_| "导出状态锁已损坏".to_owned())?
            .worker
            .take();
        if let Some(worker) = worker {
            let _ = worker.cancel_and_join();
        }
        let message = "导出线程未能启动".to_owned();
        state.core.publish_terminal(
            &app,
            job_id,
            ExportStatus::Error,
            &ExportProgress::default(),
            false,
            message.clone(),
        );
        return Err(message);
    }

    Ok(payload)
}

#[tauri::command]
pub fn cancel_capture_export(
    app: AppHandle,
    state: State<'_, CaptureExportState>,
    job_id: u64,
) -> Result<CaptureExportStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "导出生命周期锁已损坏".to_owned())?;
    let payload = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "导出状态锁已损坏".to_owned())?;
        if shared.job_id != job_id {
            return Err("导出任务已变化，请刷新后重试".to_owned());
        }
        if shared.status != ExportStatus::Running {
            return Ok(shared.snapshot());
        }
        let Some(worker) = shared
            .worker
            .as_ref()
            .filter(|worker| worker.job_id == job_id)
        else {
            return Err("导出线程未运行".to_owned());
        };
        if !worker.control.request_cancel() {
            return Ok(shared.snapshot());
        }
        shared.status = ExportStatus::Cancelling;
        shared.message = Some("正在取消导出并清理临时文件".to_owned());
        shared.touch()
    };
    emit_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn clear_capture_export(
    app: AppHandle,
    state: State<'_, CaptureExportState>,
) -> Result<CaptureExportStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "导出生命周期锁已损坏".to_owned())?;
    let worker = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "导出状态锁已损坏".to_owned())?;
        if matches!(
            shared.status,
            ExportStatus::Running | ExportStatus::Cancelling
        ) {
            return Err("导出任务运行中，不能清除状态".to_owned());
        }
        shared.worker.take()
    };
    if let Some(worker) = worker {
        worker.join()?;
    }
    let payload = state
        .core
        .shared
        .lock()
        .map_err(|_| "导出状态锁已损坏".to_owned())?
        .reset_idle();
    emit_state(&app, payload.clone());
    Ok(payload)
}

fn snapshot_export_state(state: &CaptureExportState) -> Result<CaptureExportStatePayload, String> {
    state
        .core
        .shared
        .lock()
        .map_err(|_| "导出状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

fn prepare_export(request: CaptureExportRequest, job_id: u64) -> Result<PreparedExport, String> {
    let format = ExportFormat::parse(request.format.trim())?;
    let direction = ExportDirection::parse(request.direction.trim())?;
    if matches!(format, ExportFormat::Binary) && matches!(direction, ExportDirection::Both) {
        return Err("二进制导出会丢失方向信息，请选择仅 RX 或仅 TX".to_owned());
    }

    let source_path = canonical_source_path(&request.source_path)?;
    let destination_path = normalized_destination_path(&request.destination_path, format)?;
    if destination_path.exists() {
        let destination_metadata = fs::metadata(&destination_path)
            .map_err(|error| format!("无法读取导出目标信息: {error}"))?;
        if !destination_metadata.is_file() {
            return Err("导出目标不是普通文件".to_owned());
        }
        let canonical_destination = fs::canonicalize(&destination_path)
            .map_err(|error| format!("无法解析导出目标路径: {error}"))?;
        if canonical_destination == source_path {
            return Err("导出目标不能覆盖源捕获文件".to_owned());
        }
    }

    let file = File::open(&source_path)
        .map_err(|error| format!("无法打开捕获文件 {}: {error}", source_path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取捕获文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err("捕获路径不是普通文件".to_owned());
    }
    let source_fingerprint = SourceFingerprint {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    };
    let input_count = Arc::new(AtomicU64::new(0));
    let counting_reader = CountingReader::new(BufReader::new(file), Arc::clone(&input_count));
    let reader = CaptureReader::new(counting_reader).map_err(|error| error.to_string())?;
    let header = reader.header().clone();
    let (temp_file, temp_path) = create_temp_file(&destination_path, job_id)?;
    let writer = CountingWriter::new(BufWriter::new(temp_file));

    Ok(PreparedExport {
        source_path,
        destination_path,
        temp_path,
        format,
        direction,
        allow_incomplete: request.allow_incomplete,
        header,
        reader,
        input_count,
        writer: Some(writer),
        source_fingerprint,
    })
}

fn canonical_source_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = validate_path_text(value, "请选择要导出的 .vucap 文件")?;
    let path = PathBuf::from(trimmed);
    let is_vucap = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("vucap"))
        .unwrap_or(false);
    if !is_vucap {
        return Err("只能导出 .vucap 捕获文件".to_owned());
    }
    fs::canonicalize(&path).map_err(|error| format!("无法解析捕获文件路径: {error}"))
}

fn normalized_destination_path(value: &str, format: ExportFormat) -> Result<PathBuf, String> {
    let trimmed = validate_path_text(value, "请选择导出文件位置")?;
    let path = PathBuf::from(trimmed);
    let extension_matches = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case(format.extension()))
        .unwrap_or(false);
    if !extension_matches {
        return Err(format!(
            "{} 导出文件必须使用 .{} 扩展名",
            format.as_str().to_uppercase(),
            format.extension()
        ));
    }
    let filename = path
        .file_name()
        .ok_or_else(|| "导出目标缺少文件名".to_owned())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let parent = match parent {
        Some(parent) => parent.to_path_buf(),
        None => std::env::current_dir().map_err(|error| format!("无法读取当前目录: {error}"))?,
    };
    let parent = fs::canonicalize(&parent)
        .map_err(|error| format!("无法解析导出目录 {}: {error}", parent.display()))?;
    Ok(parent.join(filename))
}

fn validate_path_text<'a>(value: &'a str, empty_message: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(empty_message.to_owned());
    }
    if trimmed.chars().count() > MAX_PATH_CHARS {
        return Err("文件路径过长".to_owned());
    }
    Ok(trimmed)
}

fn create_temp_file(destination: &Path, job_id: u64) -> Result<(File, PathBuf), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "导出目标缺少父目录".to_owned())?;
    let filename = destination
        .file_name()
        .ok_or_else(|| "导出目标缺少文件名".to_owned())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for suffix in 0..100_u16 {
        let mut temp_name = filename.to_os_string();
        temp_name.push(format!(
            ".vofa-export-{}-{job_id}-{nonce}-{suffix}.tmp",
            std::process::id()
        ));
        let temp_path = parent.join(temp_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((file, temp_path)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "无法创建导出临时文件 {}: {error}",
                    temp_path.display()
                ))
            }
        }
    }
    Err("无法分配唯一的导出临时文件".to_owned())
}

fn run_export_worker(
    app: &AppHandle,
    core: &Arc<ExportCore>,
    job_id: u64,
    control: Arc<ExportControl>,
    mut prepared: PreparedExport,
) {
    let temp_path = prepared.temp_path.clone();
    let mut last_progress = Instant::now();
    core.publish_progress(
        app,
        job_id,
        ExportPhase::Reading,
        &ExportProgress {
            processed_input_bytes: prepared.input_count.load(Ordering::Acquire),
            ..ExportProgress::default()
        },
        Some("正在读取并转换捕获记录".to_owned()),
    );

    let writer = prepared.writer.take().expect("导出 writer 只会取出一次");
    let mut sink = match ExportSink::new(prepared.format, writer, &prepared.header) {
        Ok(sink) => sink,
        Err(message) => {
            let outcome = cleanup_failed_output(
                WorkerOutcome::Failed {
                    progress: ExportProgress::default(),
                    message,
                },
                &temp_path,
            );
            if let WorkerOutcome::Failed { progress, message } = outcome {
                core.publish_terminal(app, job_id, ExportStatus::Error, &progress, false, message);
            }
            return;
        }
    };
    let process_result = process_capture(
        &mut prepared.reader,
        &prepared.header,
        &mut sink,
        prepared.direction,
        prepared.allow_incomplete,
        &control,
        || prepared.input_count.load(Ordering::Acquire),
        |progress| {
            if last_progress.elapsed() >= PROGRESS_INTERVAL {
                core.publish_progress(app, job_id, ExportPhase::Reading, progress, None);
                last_progress = Instant::now();
            }
        },
    );

    let outcome = match process_result {
        Ok(result) => finalize_export(app, core, job_id, &control, prepared, result, sink),
        Err(ProcessFailure::Cancelled { progress }) => {
            drop(sink);
            WorkerOutcome::Cancelled {
                progress,
                message: "导出已取消，未修改目标文件".to_owned(),
            }
        }
        Err(ProcessFailure::Failed { progress, message }) => {
            drop(sink);
            WorkerOutcome::Failed { progress, message }
        }
    };

    let outcome = cleanup_failed_output(outcome, &temp_path);
    match outcome {
        WorkerOutcome::Completed {
            progress,
            source_complete,
            message,
        } => core.publish_terminal(
            app,
            job_id,
            ExportStatus::Completed,
            &progress,
            source_complete,
            message,
        ),
        WorkerOutcome::Cancelled { progress, message } => core.publish_terminal(
            app,
            job_id,
            ExportStatus::Cancelled,
            &progress,
            false,
            message,
        ),
        WorkerOutcome::Failed { progress, message } => {
            core.publish_terminal(app, job_id, ExportStatus::Error, &progress, false, message)
        }
    }
}

struct ProcessResult {
    progress: ExportProgress,
    source_complete: bool,
    warning: Option<String>,
    duration_us: u64,
}

enum ProcessFailure {
    Cancelled {
        progress: ExportProgress,
    },
    Failed {
        progress: ExportProgress,
        message: String,
    },
}

#[allow(clippy::too_many_arguments)]
fn process_capture<R, F, P>(
    reader: &mut CaptureReader<R>,
    header: &CaptureHeader,
    sink: &mut ExportSink,
    direction: ExportDirection,
    allow_incomplete: bool,
    control: &ExportControl,
    input_position: F,
    mut on_progress: P,
) -> Result<ProcessResult, ProcessFailure>
where
    R: Read,
    F: Fn() -> u64,
    P: FnMut(&ExportProgress),
{
    let mut stats = CaptureRecordStats::default();
    let mut progress = ExportProgress::default();
    let (source_complete, warning) = loop {
        if control.is_cancelled() {
            progress.processed_input_bytes = input_position();
            return Err(ProcessFailure::Cancelled { progress });
        }
        match reader.next() {
            Some(Ok(CaptureItem::Record(record))) => {
                if control.is_cancelled() {
                    progress.processed_input_bytes = input_position();
                    return Err(ProcessFailure::Cancelled { progress });
                }
                if let Err(message) = stats.observe(&record) {
                    progress.processed_input_bytes = input_position();
                    return Err(ProcessFailure::Failed { progress, message });
                }
                progress.processed_input_bytes = input_position();
                progress.processed_data_bytes = stats.data_bytes();
                progress.processed_records = stats.record_count();
                if direction.matches(record.direction) {
                    if let Err(error) = sink.write_record(header, stats.record_count(), &record) {
                        return Err(ProcessFailure::Failed {
                            progress,
                            message: format!("写入导出数据失败: {error}"),
                        });
                    }
                    progress.exported_data_bytes = progress
                        .exported_data_bytes
                        .saturating_add(record.payload.len() as u64);
                    progress.exported_records = progress.exported_records.saturating_add(1);
                    progress.output_bytes = sink.output_bytes();
                }
                on_progress(&progress);
            }
            Some(Ok(CaptureItem::Footer(_))) => {
                progress.processed_input_bytes = input_position();
                break (true, None);
            }
            Some(Err(error @ CaptureReadError::Truncated(_))) => {
                progress.processed_input_bytes = input_position();
                if !allow_incomplete {
                    return Err(ProcessFailure::Failed {
                        progress,
                        message: format!(
                            "捕获文件不完整，未生成导出文件（{error}）。可启用“允许有效前缀”后重试"
                        ),
                    });
                }
                break (
                    false,
                    Some(format!(
                        "源捕获不完整，仅导出已验证的完整记录前缀（{error}）"
                    )),
                );
            }
            Some(Err(error)) => {
                progress.processed_input_bytes = input_position();
                return Err(ProcessFailure::Failed {
                    progress,
                    message: error.to_string(),
                });
            }
            None => {
                progress.processed_input_bytes = input_position();
                if !allow_incomplete {
                    return Err(ProcessFailure::Failed {
                        progress,
                        message: "捕获文件缺少结束标记，未生成导出文件。可启用“允许有效前缀”后重试"
                            .to_owned(),
                    });
                }
                break (
                    false,
                    Some("源捕获缺少结束标记，仅导出已验证的完整记录前缀".to_owned()),
                );
            }
        }
    };

    if control.is_cancelled() {
        return Err(ProcessFailure::Cancelled { progress });
    }
    if let Err(error) = sink.write_summary(
        source_complete,
        stats.duration_us(),
        &progress,
        warning.as_deref(),
    ) {
        return Err(ProcessFailure::Failed {
            progress,
            message: format!("写入导出摘要失败: {error}"),
        });
    }
    progress.output_bytes = sink.output_bytes();
    Ok(ProcessResult {
        progress,
        source_complete,
        warning,
        duration_us: stats.duration_us(),
    })
}

fn finalize_export(
    app: &AppHandle,
    core: &Arc<ExportCore>,
    job_id: u64,
    control: &ExportControl,
    prepared: PreparedExport,
    mut result: ProcessResult,
    mut sink: ExportSink,
) -> WorkerOutcome {
    core.publish_progress(
        app,
        job_id,
        ExportPhase::Finalizing,
        &result.progress,
        Some("正在刷新并校验导出文件".to_owned()),
    );
    if let Err(error) = sink.flush_and_sync() {
        return WorkerOutcome::Failed {
            progress: result.progress,
            message: format!("刷新导出文件失败: {error}"),
        };
    }
    result.progress.output_bytes = sink.output_bytes();
    drop(sink);

    if control.is_cancelled() {
        return WorkerOutcome::Cancelled {
            progress: result.progress,
            message: "导出已取消，未修改目标文件".to_owned(),
        };
    }
    if let Err(message) =
        verify_source_unchanged(&prepared.source_path, prepared.source_fingerprint)
    {
        return WorkerOutcome::Failed {
            progress: result.progress,
            message,
        };
    }
    if !control.begin_commit() {
        return WorkerOutcome::Cancelled {
            progress: result.progress,
            message: "导出已取消，未修改目标文件".to_owned(),
        };
    }
    core.publish_progress(
        app,
        job_id,
        ExportPhase::Committing,
        &result.progress,
        Some("正在原子提交导出文件".to_owned()),
    );

    let commit_warning = match DestinationCommit::new(
        prepared.temp_path,
        prepared.destination_path,
        job_id,
    )
    .commit()
    {
        Ok(warning) => warning,
        Err(message) => {
            return WorkerOutcome::Failed {
                progress: result.progress,
                message,
            }
        }
    };
    control.mark_completed();
    let mut message = format!(
        "导出完成：{} 条记录，{} 字节数据，时长 {} 微秒",
        result.progress.exported_records, result.progress.exported_data_bytes, result.duration_us
    );
    if let Some(warning) = result.warning {
        message.push_str(&format!("；{warning}"));
    }
    if let Some(warning) = commit_warning {
        message.push_str(&format!("；{warning}"));
    }
    WorkerOutcome::Completed {
        progress: result.progress,
        source_complete: result.source_complete,
        message,
    }
}

fn verify_source_unchanged(path: &Path, expected: SourceFingerprint) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("导出期间无法重新读取源捕获文件信息: {error}"))?;
    let actual = SourceFingerprint {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    };
    if actual.length != expected.length || actual.modified != expected.modified {
        return Err("源捕获文件在导出期间发生变化，已放弃提交".to_owned());
    }
    Ok(())
}

fn cleanup_failed_output(outcome: WorkerOutcome, temp_path: &Path) -> WorkerOutcome {
    if matches!(outcome, WorkerOutcome::Completed { .. }) {
        return outcome;
    }
    let cleanup_error = remove_temp_file(temp_path).err();
    match (outcome, cleanup_error) {
        (
            WorkerOutcome::Cancelled {
                progress,
                mut message,
            },
            Some(error),
        ) => {
            message.push_str(&format!("；{error}"));
            WorkerOutcome::Cancelled { progress, message }
        }
        (
            WorkerOutcome::Failed {
                progress,
                mut message,
            },
            Some(error),
        ) => {
            message.push_str(&format!("；{error}"));
            WorkerOutcome::Failed { progress, message }
        }
        (outcome, _) => outcome,
    }
}

fn remove_temp_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清理临时文件 {} 失败: {error}", path.display())),
    }
}

struct DestinationCommit {
    temp_path: PathBuf,
    destination_path: PathBuf,
    backup_path: Option<PathBuf>,
    committed: bool,
    job_id: u64,
}

impl DestinationCommit {
    fn new(temp_path: PathBuf, destination_path: PathBuf, job_id: u64) -> Self {
        Self {
            temp_path,
            destination_path,
            backup_path: None,
            committed: false,
            job_id,
        }
    }

    fn commit(mut self) -> Result<Option<String>, String> {
        if self.destination_path.exists() {
            let backup_path = unique_backup_path(&self.destination_path, self.job_id)?;
            fs::rename(&self.destination_path, &backup_path).map_err(|error| {
                format!(
                    "备份现有目标文件 {} 失败: {error}",
                    self.destination_path.display()
                )
            })?;
            self.backup_path = Some(backup_path);
        }

        if let Err(error) = fs::rename(&self.temp_path, &self.destination_path) {
            let restore_error = self.restore_backup().err();
            let mut message = format!(
                "提交导出文件 {} 失败: {error}",
                self.destination_path.display()
            );
            if let Some(restore_error) = restore_error {
                message.push_str(&format!("；{restore_error}"));
            }
            return Err(message);
        }

        let warning = self.backup_path.as_ref().and_then(|backup_path| {
            fs::remove_file(backup_path).err().map(|error| {
                format!(
                    "导出已提交，但旧文件备份 {} 清理失败: {error}",
                    backup_path.display()
                )
            })
        });
        self.committed = true;
        Ok(warning)
    }

    fn restore_backup(&mut self) -> Result<(), String> {
        let Some(backup_path) = self.backup_path.as_ref() else {
            return Ok(());
        };
        if self.destination_path.exists() {
            return Ok(());
        }
        fs::rename(backup_path, &self.destination_path).map_err(|error| {
            format!(
                "恢复旧目标文件失败，备份仍位于 {}: {error}",
                backup_path.display()
            )
        })
    }
}

impl Drop for DestinationCommit {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let _ = self.restore_backup();
    }
}

fn unique_backup_path(destination: &Path, job_id: u64) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "导出目标缺少父目录".to_owned())?;
    let filename = destination
        .file_name()
        .ok_or_else(|| "导出目标缺少文件名".to_owned())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for suffix in 0..100_u16 {
        let mut backup_name = filename.to_os_string();
        backup_name.push(format!(
            ".vofa-backup-{}-{job_id}-{nonce}-{suffix}",
            std::process::id()
        ));
        let path = parent.join(backup_name);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("无法分配唯一的目标文件备份路径".to_owned())
}

enum ExportSink {
    Csv(OutputWriter),
    Jsonl(OutputWriter),
    Binary(OutputWriter),
}

impl ExportSink {
    fn new(
        format: ExportFormat,
        mut writer: OutputWriter,
        header: &CaptureHeader,
    ) -> Result<Self, String> {
        match format {
            ExportFormat::Csv => {
                writer
                    .write_all(
                        concat!(
                            "record_index,timestamp_us,unix_time_us,direction,payload_length,",
                            "payload_hex\r\n"
                        )
                        .as_bytes(),
                    )
                    .map_err(|error| format!("写入 CSV 文件头失败: {error}"))?;
                Ok(Self::Csv(writer))
            }
            ExportFormat::Jsonl => {
                let metadata = json!({
                    "type": "metadata",
                    "schema": "vofa-ultra.capture-export",
                    "version": 1,
                    "payloadEncoding": "base64",
                    "capture": header,
                });
                write_json_line(&mut writer, &metadata)
                    .map_err(|error| format!("写入 JSONL 元数据失败: {error}"))?;
                Ok(Self::Jsonl(writer))
            }
            ExportFormat::Binary => Ok(Self::Binary(writer)),
        }
    }

    fn write_record(
        &mut self,
        header: &CaptureHeader,
        record_index: u64,
        record: &CaptureRecord,
    ) -> io::Result<()> {
        match self {
            Self::Csv(writer) => write_csv_record(writer, header, record_index, record),
            Self::Jsonl(writer) => {
                let payload = json!({
                    "type": "record",
                    "recordIndex": record_index,
                    "timestampUs": record.timestamp_us,
                    "unixTimeUs": absolute_unix_micros(header, record.timestamp_us),
                    "direction": direction_name(record.direction),
                    "payloadLength": record.payload.len(),
                    "payloadBase64": BASE64_STANDARD.encode(&record.payload),
                });
                write_json_line(writer, &payload)
            }
            Self::Binary(writer) => writer.write_all(&record.payload),
        }
    }

    fn write_summary(
        &mut self,
        source_complete: bool,
        duration_us: u64,
        progress: &ExportProgress,
        warning: Option<&str>,
    ) -> io::Result<()> {
        if let Self::Jsonl(writer) = self {
            let summary = json!({
                "type": "summary",
                "sourceComplete": source_complete,
                "durationUs": duration_us,
                "processedRecords": progress.processed_records,
                "processedDataBytes": progress.processed_data_bytes,
                "exportedRecords": progress.exported_records,
                "exportedDataBytes": progress.exported_data_bytes,
                "warning": warning,
            });
            write_json_line(writer, &summary)?;
        }
        Ok(())
    }

    fn output_bytes(&self) -> u64 {
        match self {
            Self::Csv(writer) | Self::Jsonl(writer) | Self::Binary(writer) => writer.count(),
        }
    }

    fn flush_and_sync(&mut self) -> io::Result<()> {
        let writer = match self {
            Self::Csv(writer) | Self::Jsonl(writer) | Self::Binary(writer) => writer,
        };
        writer.flush()?;
        writer.inner().get_ref().sync_all()
    }
}

fn write_csv_record(
    writer: &mut OutputWriter,
    header: &CaptureHeader,
    record_index: u64,
    record: &CaptureRecord,
) -> io::Result<()> {
    let payload_hex = encode_hex(&record.payload);
    write!(
        writer,
        "{record_index},{},{},{},{},{}\r\n",
        record.timestamp_us,
        absolute_unix_micros(header, record.timestamp_us),
        direction_name(record.direction),
        record.payload.len(),
        payload_hex
    )
}

fn write_json_line<T: Serialize>(writer: &mut OutputWriter, value: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(io::Error::other)?;
    writer.write_all(b"\n")
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn absolute_unix_micros(header: &CaptureHeader, timestamp_us: u64) -> u64 {
    header
        .started_at_unix_ms
        .saturating_mul(1_000)
        .saturating_add(timestamp_us)
}

fn direction_name(direction: CaptureDirection) -> &'static str {
    match direction {
        CaptureDirection::Rx => "rx",
        CaptureDirection::Tx => "tx",
    }
}

struct CountingReader<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R> CountingReader<R> {
    fn new(inner: R, count: Arc<AtomicU64>) -> Self {
        Self { inner, count }
    }
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.count.fetch_add(read as u64, Ordering::AcqRel);
        Ok(read)
    }
}

struct CountingWriter<W> {
    inner: W,
    count: u64,
}

impl<W> CountingWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner, count: 0 }
    }

    fn count(&self) -> u64 {
        self.count
    }

    fn inner(&self) -> &W {
        &self.inner
    }
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.count = self.count.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl ExportCore {
    fn publish_progress(
        &self,
        app: &AppHandle,
        job_id: u64,
        phase: ExportPhase,
        progress: &ExportProgress,
        message: Option<String>,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.job_id != job_id
                || !matches!(
                    shared.status,
                    ExportStatus::Running | ExportStatus::Cancelling
                )
            {
                return None;
            }
            shared.phase = phase;
            shared.processed_input_bytes = progress.processed_input_bytes;
            shared.processed_data_bytes = progress.processed_data_bytes;
            shared.processed_records = progress.processed_records;
            shared.exported_data_bytes = progress.exported_data_bytes;
            shared.exported_records = progress.exported_records;
            shared.output_bytes = progress.output_bytes;
            if shared.status == ExportStatus::Running {
                if let Some(message) = message {
                    shared.message = Some(message);
                }
            }
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn publish_terminal(
        &self,
        app: &AppHandle,
        job_id: u64,
        status: ExportStatus,
        progress: &ExportProgress,
        source_complete: bool,
        message: String,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.job_id != job_id {
                return None;
            }
            shared.status = status;
            shared.phase = ExportPhase::Done;
            shared.processed_input_bytes = progress.processed_input_bytes;
            shared.processed_data_bytes = progress.processed_data_bytes;
            shared.processed_records = progress.processed_records;
            shared.exported_data_bytes = progress.exported_data_bytes;
            shared.exported_records = progress.exported_records;
            shared.output_bytes = progress.output_bytes;
            shared.source_complete = source_complete;
            shared.ended_at_unix_ms = Some(unix_millis());
            shared.message = Some(message);
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }
}

fn emit_state(app: &AppHandle, payload: CaptureExportStatePayload) {
    let _ = app.emit("capture-export://state", payload);
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::Value;

    use super::*;
    use crate::capture::{CAPTURE_MAGIC, CAPTURE_VERSION};
    use crate::serial::SerialConfig;

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vofa-ultra-export-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn join(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_header() -> CaptureHeader {
        CaptureHeader {
            source: "simulator".to_owned(),
            protocol: "raw".to_owned(),
            serial_config: SerialConfig {
                port_name: String::new(),
                baud_rate: 115_200,
                data_bits: 8,
                parity: "none".to_owned(),
                stop_bits: 1,
                flow_control: "none".to_owned(),
                dtr: true,
                rts: true,
            },
            started_at_unix_ms: 1_700_000_000_000,
            time_unit: "microseconds".to_owned(),
        }
    }

    fn capture_bytes(records: &[(CaptureDirection, u64, &[u8])], complete: bool) -> Vec<u8> {
        let header_bytes = serde_json::to_vec(&sample_header()).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&CAPTURE_MAGIC);
        bytes.extend_from_slice(&CAPTURE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header_bytes);

        let mut data_bytes = 0_u64;
        for (direction, timestamp_us, payload) in records {
            bytes.push(0x01);
            bytes.push(match direction {
                CaptureDirection::Rx => 0,
                CaptureDirection::Tx => 1,
            });
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(&timestamp_us.to_le_bytes());
            bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            bytes.extend_from_slice(payload);
            data_bytes = data_bytes.saturating_add(payload.len() as u64);
        }
        if complete {
            bytes.push(0xff);
            bytes.extend_from_slice(&[0_u8; 7]);
            bytes.extend_from_slice(&data_bytes.to_le_bytes());
            bytes.extend_from_slice(&(records.len() as u64).to_le_bytes());
        }
        bytes
    }

    fn process_to_file(
        directory: &TestDirectory,
        name: &str,
        bytes: Vec<u8>,
        format: ExportFormat,
        direction: ExportDirection,
        allow_incomplete: bool,
        control: &ExportControl,
    ) -> (Result<ProcessResult, ProcessFailure>, PathBuf) {
        let input_size = bytes.len() as u64;
        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        let header = reader.header().clone();
        let path = directory.join(name);
        let file = File::create(&path).unwrap();
        let writer = CountingWriter::new(BufWriter::new(file));
        let mut sink = ExportSink::new(format, writer, &header).unwrap();
        let result = process_capture(
            &mut reader,
            &header,
            &mut sink,
            direction,
            allow_incomplete,
            control,
            || input_size,
            |_| {},
        );
        sink.flush_and_sync().unwrap();
        drop(sink);
        (result, path)
    }

    #[test]
    fn csv_is_lossless_and_does_not_emit_untrusted_text() {
        let directory = TestDirectory::new("csv");
        let bytes = capture_bytes(
            &[
                (CaptureDirection::Rx, 10, b"=2+2"),
                (CaptureDirection::Tx, 25, &[0, b'\n', 0xff]),
            ],
            true,
        );
        let control = ExportControl::new();
        let (result, path) = process_to_file(
            &directory,
            "capture.csv",
            bytes,
            ExportFormat::Csv,
            ExportDirection::Both,
            false,
            &control,
        );

        let result = result.unwrap_or_else(|_| panic!("CSV 导出不应失败"));
        assert!(result.source_complete);
        let output = fs::read_to_string(path).unwrap();
        assert_eq!(
            output,
            concat!(
                "record_index,timestamp_us,unix_time_us,direction,payload_length,payload_hex\r\n",
                "1,10,1700000000000010,rx,4,3D322B32\r\n",
                "2,25,1700000000000025,tx,3,000AFF\r\n"
            )
        );
        assert!(!output.contains("=2+2"));
    }

    #[test]
    fn jsonl_keeps_metadata_filtered_records_and_summary() {
        let directory = TestDirectory::new("jsonl");
        let bytes = capture_bytes(
            &[
                (CaptureDirection::Rx, 0, &[1, 2]),
                (CaptureDirection::Tx, 7, &[3]),
                (CaptureDirection::Rx, 9, &[4, 5]),
            ],
            true,
        );
        let control = ExportControl::new();
        let (result, path) = process_to_file(
            &directory,
            "capture.jsonl",
            bytes,
            ExportFormat::Jsonl,
            ExportDirection::Rx,
            false,
            &control,
        );

        let result = result.unwrap_or_else(|_| panic!("JSONL 导出不应失败"));
        assert_eq!(result.progress.processed_records, 3);
        assert_eq!(result.progress.exported_records, 2);
        let lines = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["type"], "metadata");
        assert_eq!(lines[0]["capture"]["protocol"], "raw");
        assert_eq!(lines[1]["recordIndex"], 1);
        assert_eq!(lines[1]["payloadBase64"], "AQI=");
        assert_eq!(lines[2]["recordIndex"], 3);
        assert_eq!(lines[2]["payloadBase64"], "BAU=");
        assert_eq!(lines[3]["type"], "summary");
        assert_eq!(lines[3]["processedRecords"], 3);
        assert_eq!(lines[3]["exportedRecords"], 2);
        assert_eq!(lines[3]["sourceComplete"], true);
    }

    #[test]
    fn binary_concatenates_only_the_selected_direction() {
        let directory = TestDirectory::new("binary");
        let bytes = capture_bytes(
            &[
                (CaptureDirection::Rx, 0, &[1, 2]),
                (CaptureDirection::Tx, 1, &[3, 4]),
                (CaptureDirection::Rx, 2, &[5]),
            ],
            true,
        );
        let control = ExportControl::new();
        let (result, path) = process_to_file(
            &directory,
            "capture.bin",
            bytes,
            ExportFormat::Binary,
            ExportDirection::Tx,
            false,
            &control,
        );

        let result = result.unwrap_or_else(|_| panic!("BIN 导出不应失败"));
        assert_eq!(result.progress.exported_records, 1);
        assert_eq!(result.progress.exported_data_bytes, 2);
        assert_eq!(fs::read(path).unwrap(), vec![3, 4]);
    }

    #[test]
    fn incomplete_source_requires_explicit_prefix_permission() {
        let records = [(CaptureDirection::Rx, 5, &[0xaa, 0xbb][..])];
        let bytes = capture_bytes(&records, false);
        let rejected_directory = TestDirectory::new("incomplete-rejected");
        let rejected_control = ExportControl::new();
        let (rejected, _) = process_to_file(
            &rejected_directory,
            "capture.csv",
            bytes.clone(),
            ExportFormat::Csv,
            ExportDirection::Both,
            false,
            &rejected_control,
        );
        assert!(matches!(
            rejected,
            Err(ProcessFailure::Failed { message, .. }) if message.contains("不完整")
        ));

        let allowed_directory = TestDirectory::new("incomplete-allowed");
        let allowed_control = ExportControl::new();
        let (allowed, _) = process_to_file(
            &allowed_directory,
            "capture.jsonl",
            bytes,
            ExportFormat::Jsonl,
            ExportDirection::Both,
            true,
            &allowed_control,
        );
        let allowed = allowed.unwrap_or_else(|_| panic!("允许有效前缀后不应失败"));
        assert!(!allowed.source_complete);
        assert_eq!(allowed.progress.exported_records, 1);
        assert!(allowed
            .warning
            .as_deref()
            .unwrap_or_default()
            .contains("不完整"));
    }

    #[test]
    fn rejects_timestamp_regression_and_observes_precommit_cancellation() {
        let regression_directory = TestDirectory::new("regression");
        let regression = capture_bytes(
            &[
                (CaptureDirection::Rx, 10, &[1]),
                (CaptureDirection::Rx, 9, &[2]),
            ],
            true,
        );
        let regression_control = ExportControl::new();
        let (result, _) = process_to_file(
            &regression_directory,
            "capture.csv",
            regression,
            ExportFormat::Csv,
            ExportDirection::Both,
            false,
            &regression_control,
        );
        assert!(matches!(
            result,
            Err(ProcessFailure::Failed { message, .. }) if message.contains("回退")
        ));

        let cancelled_directory = TestDirectory::new("cancelled");
        let cancelled = capture_bytes(&[(CaptureDirection::Rx, 0, &[1])], true);
        let cancelled_control = ExportControl::new();
        assert!(cancelled_control.request_cancel());
        assert!(!cancelled_control.begin_commit());
        let (result, _) = process_to_file(
            &cancelled_directory,
            "capture.csv",
            cancelled,
            ExportFormat::Csv,
            ExportDirection::Both,
            false,
            &cancelled_control,
        );
        assert!(matches!(result, Err(ProcessFailure::Cancelled { .. })));
    }

    #[test]
    fn destination_commit_replaces_existing_file_without_leaving_backup() {
        let directory = TestDirectory::new("commit");
        let destination = directory.join("capture.csv");
        let temp = directory.join("capture.tmp");
        fs::write(&destination, b"old").unwrap();
        fs::write(&temp, b"new").unwrap();

        let warning = DestinationCommit::new(temp, destination.clone(), 7)
            .commit()
            .unwrap();
        assert!(warning.is_none());
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        let remaining = fs::read_dir(&directory.path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec!["capture.csv"]);
    }

    #[test]
    fn failed_commit_restores_existing_destination() {
        let directory = TestDirectory::new("commit-restore");
        let destination = directory.join("capture.csv");
        let missing_temp = directory.join("missing.tmp");
        fs::write(&destination, b"old").unwrap();

        let error = DestinationCommit::new(missing_temp, destination.clone(), 8)
            .commit()
            .unwrap_err();
        assert!(error.contains("提交导出文件"));
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        let remaining = fs::read_dir(&directory.path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec!["capture.csv"]);
    }

    #[test]
    fn failed_or_cancelled_outcome_removes_temporary_file() {
        let directory = TestDirectory::new("cleanup");
        let temp = directory.join("capture.tmp");
        fs::write(&temp, b"partial").unwrap();
        let outcome = cleanup_failed_output(
            WorkerOutcome::Cancelled {
                progress: ExportProgress::default(),
                message: "已取消".to_owned(),
            },
            &temp,
        );

        assert!(matches!(outcome, WorkerOutcome::Cancelled { .. }));
        assert!(!temp.exists());
        let control = ExportControl::new();
        assert!(control.begin_commit());
        assert!(!control.request_cancel());
    }

    #[test]
    fn binary_request_rejects_ambiguous_bidirectional_output() {
        let request = CaptureExportRequest {
            source_path: "capture.vucap".to_owned(),
            destination_path: "capture.bin".to_owned(),
            format: "binary".to_owned(),
            direction: "both".to_owned(),
            allow_incomplete: false,
        };

        let error = prepare_export(request, 1).err().unwrap();
        assert!(error.contains("仅 RX 或仅 TX"));
    }
}
