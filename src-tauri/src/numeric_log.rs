#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, ErrorKind, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

use crate::recording_directory::resolve_custom_recording_directory;

const CSV_HEADER: &str = concat!(
    "sample_index,timestamp_unix_us,elapsed_us,channel_kind,channel_id,",
    "channel_name,value\r\n"
);
const UTF8_BOM: &[u8] = &[0xef, 0xbb, 0xbf];
const MAX_BATCH_SAMPLES: usize = 512;
const MAX_CHANNEL_ID_BYTES: usize = 128;
const MAX_CHANNEL_NAME_BYTES: usize = 256;
const WRITER_QUEUE_BATCHES: usize = 64;
const WRITER_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const WRITER_QUEUE_SAMPLES: usize = 4096;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const WRITER_START_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_FINALIZE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_ABORT_MESSAGE_CHARS: usize = 512;
const WRITER_PHASE_ACTIVE: u8 = 0;
const WRITER_PHASE_FINISH_REQUESTED: u8 = 1;
const WRITER_PHASE_COMMITTING: u8 = 2;
const WRITER_PHASE_ABORTED: u8 = 3;
const WRITER_PHASE_COMPLETED: u8 = 4;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NumericChannelKind {
    Base,
    Derived,
}

impl NumericChannelKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Derived => "derived",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NumericLogStartRequest {
    source: String,
    protocol: String,
    destination_directory: Option<String>,
}

impl NumericLogStartRequest {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.source.as_str(), "serial" | "simulator") {
            return Err(format!("不支持的数值日志数据源: {}", self.source));
        }
        if !matches!(self.protocol.as_str(), "firewater" | "justfloat") {
            return Err(format!("不支持的数值日志协议: {}", self.protocol));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NumericLogSample {
    timestamp_unix_us: u64,
    channel_kind: NumericChannelKind,
    channel_id: String,
    channel_name: String,
    value: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericLogStatePayload {
    status: String,
    session_id: u64,
    revision: u64,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at_unix_ms: Option<u64>,
    output_bytes: u64,
    sample_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub struct NumericLogState {
    transition: Arc<Mutex<()>>,
    core: Arc<NumericLogCore>,
}

impl Default for NumericLogState {
    fn default() -> Self {
        Self {
            transition: Arc::new(Mutex::new(())),
            core: Arc::new(NumericLogCore {
                shared: Mutex::new(SharedNumericLogState::default()),
            }),
        }
    }
}

impl NumericLogState {
    fn lifecycle_handle(&self) -> NumericLogLifecycleHandle {
        NumericLogLifecycleHandle {
            transition: Arc::clone(&self.transition),
            core: Arc::clone(&self.core),
        }
    }
}

impl Drop for NumericLogState {
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
        if let Some(mut worker) = worker {
            worker.begin_abort();
            let (done_sender, done_receiver) = mpsc::channel();
            if thread::Builder::new()
                .name("vofa-numeric-log-shutdown".to_owned())
                .spawn(move || {
                    let _ = worker.join();
                    let _ = done_sender.send(());
                })
                .is_ok()
            {
                let _ = done_receiver.recv_timeout(SHUTDOWN_FINALIZE_TIMEOUT);
            }
        }
    }
}

#[derive(Clone)]
struct NumericLogLifecycleHandle {
    transition: Arc<Mutex<()>>,
    core: Arc<NumericLogCore>,
}

struct NumericLogCore {
    shared: Mutex<SharedNumericLogState>,
}

struct SharedNumericLogState {
    status: NumericLogStatus,
    session_id: u64,
    revision: u64,
    path: String,
    started_at_unix_ms: Option<u64>,
    ended_at_unix_ms: Option<u64>,
    output_bytes: u64,
    sample_count: u64,
    message: Option<String>,
    worker: Option<NumericLogWorker>,
}

impl Default for SharedNumericLogState {
    fn default() -> Self {
        Self {
            status: NumericLogStatus::Idle,
            session_id: 0,
            revision: 0,
            path: String::new(),
            started_at_unix_ms: None,
            ended_at_unix_ms: None,
            output_bytes: 0,
            sample_count: 0,
            message: None,
            worker: None,
        }
    }
}

impl SharedNumericLogState {
    fn snapshot(&self) -> NumericLogStatePayload {
        NumericLogStatePayload {
            status: self.status.as_str().to_owned(),
            session_id: self.session_id,
            revision: self.revision,
            path: self.path.clone(),
            started_at_unix_ms: self.started_at_unix_ms,
            ended_at_unix_ms: self.ended_at_unix_ms,
            output_bytes: self.output_bytes,
            sample_count: self.sample_count,
            message: self.message.clone(),
        }
    }

    fn touch(&mut self) -> NumericLogStatePayload {
        self.revision = self.revision.saturating_add(1);
        self.snapshot()
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_writer_outcome(
        &mut self,
        session_id: u64,
        outcome: WriterOutcome,
        part_path: &Path,
        final_path: &Path,
        output_bytes: u64,
        sample_count: u64,
    ) -> Option<NumericLogStatePayload> {
        if self.session_id != session_id {
            return None;
        }
        self.output_bytes = output_bytes;
        self.sample_count = sample_count;
        self.ended_at_unix_ms = Some(unix_millis());
        let preserve_error = self.status == NumericLogStatus::Error && self.message.is_some();
        match outcome {
            WriterOutcome::Completed => {
                self.path = final_path.to_string_lossy().into_owned();
                if !preserve_error {
                    self.status = NumericLogStatus::Idle;
                    self.message = Some("数值日志已完成".to_owned());
                }
            }
            WriterOutcome::Aborted => {
                self.path = part_path.to_string_lossy().into_owned();
                if !preserve_error {
                    self.status = NumericLogStatus::Error;
                    self.message = Some("数值日志已中止，已保留部分文件".to_owned());
                }
            }
            WriterOutcome::Failed(message) => {
                self.path = part_path.to_string_lossy().into_owned();
                if !preserve_error {
                    self.status = NumericLogStatus::Error;
                    self.message = Some(message);
                }
            }
        }
        Some(self.touch())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NumericLogStatus {
    Idle,
    Recording,
    Stopping,
    Error,
}

impl NumericLogStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Recording => "recording",
            Self::Stopping => "stopping",
            Self::Error => "error",
        }
    }
}

struct NumericLogWorker {
    session_id: u64,
    sender: Option<mpsc::SyncSender<WriterCommand>>,
    control: Arc<WriterControl>,
    byte_budget: Arc<ResourceBudget>,
    sample_budget: Arc<ResourceBudget>,
    started: Instant,
    join_handle: Option<JoinHandle<()>>,
}

impl NumericLogWorker {
    fn finish_and_join(mut self) -> Result<(), String> {
        let sender = self.sender.take();
        let send_result = if self.control.request_finish() {
            match sender {
                Some(sender) => sender
                    .send(WriterCommand::Finish)
                    .map_err(|_| "数值日志写入线程已停止".to_owned()),
                None => Err("数值日志写入通道已关闭".to_owned()),
            }
        } else if self.control.is_aborted() {
            drop(sender);
            Ok(())
        } else {
            drop(sender);
            Err("数值日志已经进入提交阶段".to_owned())
        };
        let join_result = self.join();
        join_result.and(send_result)
    }

    fn abort_and_join(mut self) -> Result<(), String> {
        self.begin_abort();
        self.join()
    }

    fn begin_abort(&mut self) -> bool {
        let accepted = self.control.request_abort();
        drop(self.sender.take());
        accepted
    }

    fn join(&mut self) -> Result<(), String> {
        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|panic| format!("数值日志写入线程异常退出: {}", panic_message(panic)))?;
        }
        Ok(())
    }
}

struct WriterControl {
    phase: AtomicU8,
}

impl WriterControl {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(WRITER_PHASE_ACTIVE),
        }
    }

    fn request_finish(&self) -> bool {
        let mut phase = self.phase.load(Ordering::Acquire);
        loop {
            match phase {
                WRITER_PHASE_ACTIVE => match self.phase.compare_exchange_weak(
                    phase,
                    WRITER_PHASE_FINISH_REQUESTED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => return true,
                    Err(actual) => phase = actual,
                },
                WRITER_PHASE_FINISH_REQUESTED => return true,
                _ => return false,
            }
        }
    }

    fn request_abort(&self) -> bool {
        let mut phase = self.phase.load(Ordering::Acquire);
        loop {
            match phase {
                WRITER_PHASE_ACTIVE | WRITER_PHASE_FINISH_REQUESTED => {
                    match self.phase.compare_exchange_weak(
                        phase,
                        WRITER_PHASE_ABORTED,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    ) {
                        Ok(_) => return true,
                        Err(actual) => phase = actual,
                    }
                }
                WRITER_PHASE_ABORTED => return true,
                _ => return false,
            }
        }
    }

    fn begin_commit(&self) -> bool {
        self.phase
            .compare_exchange(
                WRITER_PHASE_FINISH_REQUESTED,
                WRITER_PHASE_COMMITTING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn mark_completed(&self) {
        self.phase.store(WRITER_PHASE_COMPLETED, Ordering::Release);
    }

    fn is_aborted(&self) -> bool {
        self.phase.load(Ordering::Acquire) == WRITER_PHASE_ABORTED
    }
}

enum WriterCommand {
    Batch(QueuedBatch),
    Finish,
}

struct QueuedBatch {
    session_id: u64,
    elapsed_us: u64,
    samples: Vec<NumericLogSample>,
    _byte_reservation: ResourceReservation,
    _sample_reservation: ResourceReservation,
}

struct ResourceBudget {
    capacity: usize,
    used: AtomicUsize,
}

impl ResourceBudget {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            used: AtomicUsize::new(0),
        }
    }

    fn try_reserve(self: &Arc<Self>, size: usize) -> Option<ResourceReservation> {
        let mut used = self.used.load(Ordering::Acquire);
        loop {
            let next = used.checked_add(size)?;
            if next > self.capacity {
                return None;
            }
            match self
                .used
                .compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    return Some(ResourceReservation {
                        budget: Arc::clone(self),
                        size,
                    })
                }
                Err(actual) => used = actual,
            }
        }
    }
}

struct ResourceReservation {
    budget: Arc<ResourceBudget>,
    size: usize,
}

impl Drop for ResourceReservation {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.size, Ordering::AcqRel);
    }
}

enum WriterOutcome {
    Completed,
    Aborted,
    Failed(String),
}

impl NumericLogCore {
    fn append(
        &self,
        app: &AppHandle,
        expected_session_id: u64,
        samples: Vec<NumericLogSample>,
    ) -> Result<(), String> {
        let mut event = None;
        let result = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "数值日志状态锁已损坏".to_owned())?;
            let worker_session_id = shared.worker.as_ref().map(|worker| worker.session_id);
            if shared.session_id != expected_session_id
                || worker_session_id != Some(expected_session_id)
            {
                return Ok(());
            }

            match shared.status {
                NumericLogStatus::Idle | NumericLogStatus::Stopping => Ok(()),
                NumericLogStatus::Error => Err(shared
                    .message
                    .clone()
                    .unwrap_or_else(|| "数值日志已经终止".to_owned())),
                NumericLogStatus::Recording => {
                    if let Err(message) = validate_batch(&samples) {
                        event = Some(fail_active_log(&mut shared, message.clone()));
                        Err(message)
                    } else if samples.is_empty() {
                        Ok(())
                    } else if let Some(worker) = shared.worker.as_ref() {
                        let session_id = worker.session_id;
                        let elapsed_us = duration_micros(worker.started.elapsed());
                        let byte_budget = Arc::clone(&worker.byte_budget);
                        let sample_budget = Arc::clone(&worker.sample_budget);
                        let sender = worker.sender.clone();
                        let batch_bytes = estimate_batch_bytes(&samples, samples.capacity())
                            .ok_or_else(|| "数值日志批次内存大小溢出，日志已中止".to_owned());

                        match (sender, batch_bytes) {
                            (Some(sender), Ok(batch_bytes)) => {
                                let byte_reservation = byte_budget.try_reserve(batch_bytes);
                                if let Some(byte_reservation) = byte_reservation {
                                    let sample_reservation =
                                        sample_budget.try_reserve(samples.len());
                                    if let Some(sample_reservation) = sample_reservation {
                                        let batch = QueuedBatch {
                                            session_id,
                                            elapsed_us,
                                            samples,
                                            _byte_reservation: byte_reservation,
                                            _sample_reservation: sample_reservation,
                                        };
                                        match sender.try_send(WriterCommand::Batch(batch)) {
                                            Ok(()) => Ok(()),
                                            Err(mpsc::TrySendError::Full(_)) => {
                                                let message =
                                                    "数值日志写入队列已满，日志已中止".to_owned();
                                                event = Some(fail_active_log(
                                                    &mut shared,
                                                    message.clone(),
                                                ));
                                                Err(message)
                                            }
                                            Err(mpsc::TrySendError::Disconnected(_)) => {
                                                let message =
                                                    "数值日志写入线程已停止，日志已中止".to_owned();
                                                event = Some(fail_active_log(
                                                    &mut shared,
                                                    message.clone(),
                                                ));
                                                Err(message)
                                            }
                                        }
                                    } else {
                                        let message = format!(
                                            "数值日志队列超过 {WRITER_QUEUE_SAMPLES} 条样本，日志已中止"
                                        );
                                        event = Some(fail_active_log(&mut shared, message.clone()));
                                        Err(message)
                                    }
                                } else {
                                    let message = format!(
                                        "数值日志队列超过 {} MiB，日志已中止",
                                        WRITER_QUEUE_BYTES / 1024 / 1024
                                    );
                                    event = Some(fail_active_log(&mut shared, message.clone()));
                                    Err(message)
                                }
                            }
                            (None, _) => {
                                let message = "数值日志写入通道已关闭，日志已中止".to_owned();
                                event = Some(fail_active_log(&mut shared, message.clone()));
                                Err(message)
                            }
                            (_, Err(message)) => {
                                event = Some(fail_active_log(&mut shared, message.clone()));
                                Err(message)
                            }
                        }
                    } else {
                        let message = "数值日志状态异常：写入线程不存在".to_owned();
                        event = Some(fail_active_log(&mut shared, message.clone()));
                        Err(message)
                    }
                }
            }
        };

        if let Some(payload) = event {
            emit_state(app, payload);
        }
        result
    }

    fn publish_progress(
        &self,
        app: &AppHandle,
        session_id: u64,
        output_bytes: u64,
        sample_count: u64,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id
                || (shared.output_bytes == output_bytes && shared.sample_count == sample_count)
            {
                return None;
            }
            shared.output_bytes = output_bytes;
            shared.sample_count = sample_count;
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_writer(
        &self,
        app: &AppHandle,
        session_id: u64,
        outcome: WriterOutcome,
        part_path: &Path,
        final_path: &Path,
        output_bytes: u64,
        sample_count: u64,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            shared.apply_writer_outcome(
                session_id,
                outcome,
                part_path,
                final_path,
                output_bytes,
                sample_count,
            )
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn publish_writer_panic(
        &self,
        app: &AppHandle,
        session_id: u64,
        part_path: &Path,
        message: String,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id {
                return None;
            }
            shared.status = NumericLogStatus::Error;
            shared.path = part_path.to_string_lossy().into_owned();
            shared.ended_at_unix_ms = Some(unix_millis());
            shared.message = Some(message);
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }
}

#[tauri::command]
pub fn get_numeric_log_state(
    state: State<'_, NumericLogState>,
) -> Result<NumericLogStatePayload, String> {
    snapshot_numeric_log_state(&state)
}

#[tauri::command]
pub async fn start_numeric_log(
    app: AppHandle,
    state: State<'_, NumericLogState>,
    request: NumericLogStartRequest,
) -> Result<NumericLogStatePayload, String> {
    let lifecycle = state.lifecycle_handle();
    tauri::async_runtime::spawn_blocking(move || {
        start_numeric_log_blocking(app, lifecycle, request)
    })
    .await
    .map_err(|error| format!("启动数值日志任务失败: {error}"))?
}

#[tauri::command]
pub fn append_numeric_log(
    app: AppHandle,
    state: State<'_, NumericLogState>,
    session_id: u64,
    samples: Vec<NumericLogSample>,
) -> Result<(), String> {
    state.core.append(&app, session_id, samples)
}

#[tauri::command]
pub async fn stop_numeric_log(
    app: AppHandle,
    state: State<'_, NumericLogState>,
) -> Result<NumericLogStatePayload, String> {
    let lifecycle = state.lifecycle_handle();
    tauri::async_runtime::spawn_blocking(move || stop_numeric_log_blocking(app, lifecycle))
        .await
        .map_err(|error| format!("停止数值日志任务失败: {error}"))?
}

#[tauri::command]
pub async fn abort_numeric_log(
    app: AppHandle,
    state: State<'_, NumericLogState>,
    message: String,
) -> Result<NumericLogStatePayload, String> {
    let lifecycle = state.lifecycle_handle();
    tauri::async_runtime::spawn_blocking(move || {
        abort_numeric_log_blocking(app, lifecycle, message)
    })
    .await
    .map_err(|error| format!("中止数值日志任务失败: {error}"))?
}

fn snapshot_numeric_log_state(state: &NumericLogState) -> Result<NumericLogStatePayload, String> {
    state
        .core
        .shared
        .lock()
        .map_err(|_| "数值日志状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

fn start_numeric_log_blocking(
    app: AppHandle,
    state: NumericLogLifecycleHandle,
    request: NumericLogStartRequest,
) -> Result<NumericLogStatePayload, String> {
    request.validate()?;
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "数值日志生命周期锁已损坏".to_owned())?;

    let stale_worker = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "数值日志状态锁已损坏".to_owned())?;
        if matches!(
            shared.status,
            NumericLogStatus::Recording | NumericLogStatus::Stopping
        ) {
            return Err("已有数值日志任务正在进行".to_owned());
        }
        shared.worker.take()
    };
    if let Some(worker) = stale_worker {
        worker.abort_and_join()?;
    }

    let started = Instant::now();
    let started_at_unix_ms = unix_millis();
    let session_id = {
        let shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "数值日志状态锁已损坏".to_owned())?;
        shared
            .session_id
            .checked_add(1)
            .ok_or_else(|| "数值日志会话标识已耗尽，请重启应用".to_owned())?
    };

    let (file, part_path, final_path) = create_numeric_log_file(
        &app,
        request.destination_directory.as_deref(),
        started_at_unix_ms,
        session_id,
    )
    .inspect_err(|message| {
        publish_start_error(
            &app,
            &state.core,
            session_id,
            started_at_unix_ms,
            String::new(),
            message.clone(),
        );
    })?;
    let part_path_text = part_path.to_string_lossy().into_owned();
    let (sender, receiver) = mpsc::sync_channel(WRITER_QUEUE_BATCHES);
    let (ready_sender, ready_receiver) = mpsc::channel();
    let control = Arc::new(WriterControl::new());
    let byte_budget = Arc::new(ResourceBudget::new(WRITER_QUEUE_BYTES));
    let sample_budget = Arc::new(ResourceBudget::new(WRITER_QUEUE_SAMPLES));
    let thread_control = Arc::clone(&control);
    let thread_core = Arc::clone(&state.core);
    let thread_app = app.clone();
    let panic_core = Arc::clone(&state.core);
    let panic_app = app.clone();
    let panic_part_path = part_path.clone();
    let thread_part_path = part_path.clone();
    let thread_final_path = final_path.clone();
    let join_handle = thread::Builder::new()
        .name("vofa-numeric-log-writer".to_owned())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                run_numeric_log_writer(
                    thread_app,
                    thread_core,
                    session_id,
                    file,
                    thread_part_path,
                    thread_final_path,
                    receiver,
                    thread_control,
                    ready_sender,
                );
            }));
            if let Err(panic) = result {
                panic_core.publish_writer_panic(
                    &panic_app,
                    session_id,
                    &panic_part_path,
                    format!("数值日志写入线程异常退出: {}", panic_message(panic)),
                );
            }
        })
        .map_err(|error| {
            let message = format!("创建数值日志写入线程失败: {error}");
            publish_start_error(
                &app,
                &state.core,
                session_id,
                started_at_unix_ms,
                part_path_text.clone(),
                message.clone(),
            );
            message
        })?;

    let worker = NumericLogWorker {
        session_id,
        sender: Some(sender),
        control,
        byte_budget,
        sample_budget,
        started,
        join_handle: Some(join_handle),
    };
    let ready_result = match ready_receiver.recv_timeout(WRITER_START_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err("数值日志文件初始化超时".to_owned()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("数值日志写入线程在初始化时意外停止".to_owned())
        }
    };
    let initial_output_bytes = match ready_result {
        Ok(output_bytes) => output_bytes,
        Err(message) => {
            let _ = worker.abort_and_join();
            publish_start_error(
                &app,
                &state.core,
                session_id,
                started_at_unix_ms,
                part_path_text,
                message.clone(),
            );
            return Err(message);
        }
    };

    let payload = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "数值日志状态锁已损坏".to_owned())?;
        shared.status = NumericLogStatus::Recording;
        shared.session_id = session_id;
        shared.path = part_path_text;
        shared.started_at_unix_ms = Some(started_at_unix_ms);
        shared.ended_at_unix_ms = None;
        shared.output_bytes = initial_output_bytes;
        shared.sample_count = 0;
        shared.message = None;
        shared.worker = Some(worker);
        shared.touch()
    };
    emit_state(&app, payload.clone());
    Ok(payload)
}

fn stop_numeric_log_blocking(
    app: AppHandle,
    state: NumericLogLifecycleHandle,
) -> Result<NumericLogStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "数值日志生命周期锁已损坏".to_owned())?;
    let (worker, should_finish, transition_payload) = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "数值日志状态锁已损坏".to_owned())?;
        let should_finish = shared.status == NumericLogStatus::Recording;
        let worker = shared.worker.take();
        let payload = if should_finish {
            shared.status = NumericLogStatus::Stopping;
            shared.message = Some("正在完成数值日志".to_owned());
            Some(shared.touch())
        } else {
            None
        };
        (worker, should_finish, payload)
    };
    if let Some(payload) = transition_payload {
        emit_state(&app, payload);
    }

    if let Some(worker) = worker {
        let result = if should_finish {
            worker.finish_and_join()
        } else {
            worker.abort_and_join()
        };
        if let Err(message) = result {
            publish_finalization_error(&app, &state.core, message);
        }
    }
    snapshot_from_core(&state.core)
}

fn abort_numeric_log_blocking(
    app: AppHandle,
    state: NumericLogLifecycleHandle,
    message: String,
) -> Result<NumericLogStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "数值日志生命周期锁已损坏".to_owned())?;
    let message = sanitize_abort_message(message);
    let (worker, payload) = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "数值日志状态锁已损坏".to_owned())?;
        let mut worker = shared.worker.take();
        let accepted = worker.as_mut().is_some_and(NumericLogWorker::begin_abort);
        let payload = if accepted {
            if shared.status != NumericLogStatus::Error || shared.message.is_none() {
                shared.status = NumericLogStatus::Error;
                shared.ended_at_unix_ms = Some(unix_millis());
                shared.message = Some(message);
            }
            Some(shared.touch())
        } else {
            if let Some(worker) = worker.take() {
                shared.worker = Some(worker);
            }
            None
        };
        (worker, payload)
    };
    if let Some(payload) = payload {
        emit_state(&app, payload);
    }
    if let Some(mut worker) = worker {
        if let Err(message) = worker.join() {
            publish_finalization_error(&app, &state.core, message);
        }
    }
    snapshot_from_core(&state.core)
}

fn snapshot_from_core(core: &Arc<NumericLogCore>) -> Result<NumericLogStatePayload, String> {
    core.shared
        .lock()
        .map_err(|_| "数值日志状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

#[allow(clippy::too_many_arguments)]
fn run_numeric_log_writer(
    app: AppHandle,
    core: Arc<NumericLogCore>,
    session_id: u64,
    file: File,
    part_path: PathBuf,
    final_path: PathBuf,
    receiver: mpsc::Receiver<WriterCommand>,
    control: Arc<WriterControl>,
    ready_sender: mpsc::Sender<Result<u64, String>>,
) {
    let mut writer = BufWriter::new(file);
    let mut output_bytes = 0_u64;
    let mut sample_count = 0_u64;
    let mut last_progress = Instant::now();
    let mut progress_dirty = false;

    let initialize_result = write_csv_preamble(&mut writer)
        .and_then(|written| {
            output_bytes = written;
            writer.flush()
        })
        .map_err(|error| format!("初始化数值日志文件失败: {error}"));
    let mut outcome = match initialize_result {
        Ok(()) => {
            if ready_sender.send(Ok(output_bytes)).is_ok() {
                None
            } else {
                control.request_abort();
                Some(WriterOutcome::Aborted)
            }
        }
        Err(message) => {
            let _ = ready_sender.send(Err(message.clone()));
            Some(WriterOutcome::Failed(message))
        }
    };

    while outcome.is_none() {
        if control.is_aborted() {
            outcome = Some(WriterOutcome::Aborted);
            break;
        }
        match receiver.recv_timeout(PROGRESS_INTERVAL) {
            Ok(WriterCommand::Batch(batch)) => {
                if batch.session_id != session_id {
                    outcome = Some(WriterOutcome::Failed("数值日志会话标识不匹配".to_owned()));
                    continue;
                }
                for sample in &batch.samples {
                    let sample_index = sample_count;
                    match write_csv_sample(&mut writer, sample_index, batch.elapsed_us, sample) {
                        Ok(written) => {
                            output_bytes = output_bytes.saturating_add(written);
                            sample_count = sample_count.saturating_add(1);
                        }
                        Err(error) => {
                            outcome =
                                Some(WriterOutcome::Failed(format!("写入数值日志失败: {error}")));
                            break;
                        }
                    }
                }
                progress_dirty = true;
            }
            Ok(WriterCommand::Finish) => {
                outcome = Some(if control.begin_commit() {
                    WriterOutcome::Completed
                } else if control.is_aborted() {
                    WriterOutcome::Aborted
                } else {
                    WriterOutcome::Failed("数值日志提交阶段状态无效".to_owned())
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                outcome = Some(if control.is_aborted() {
                    WriterOutcome::Aborted
                } else {
                    WriterOutcome::Failed("数值日志写入通道意外关闭".to_owned())
                });
            }
        }

        if progress_dirty && last_progress.elapsed() >= PROGRESS_INTERVAL {
            if let Err(error) = writer.flush() {
                outcome = Some(WriterOutcome::Failed(format!(
                    "刷新数值日志文件失败: {error}"
                )));
            } else {
                core.publish_progress(&app, session_id, output_bytes, sample_count);
                progress_dirty = false;
                last_progress = Instant::now();
            }
        }
    }

    let mut outcome = outcome.unwrap_or(WriterOutcome::Aborted);
    if let Err(error) = writer.flush() {
        outcome = WriterOutcome::Failed(format!("刷新数值日志文件失败: {error}"));
    } else if let Err(error) = writer.get_ref().sync_all() {
        outcome = WriterOutcome::Failed(format!("同步数值日志文件失败: {error}"));
    }
    drop(writer);

    if matches!(&outcome, WriterOutcome::Completed) {
        match commit_part_file(&part_path, &final_path) {
            Ok(()) => control.mark_completed(),
            Err(message) => outcome = WriterOutcome::Failed(message),
        }
    }
    core.finish_writer(
        &app,
        session_id,
        outcome,
        &part_path,
        &final_path,
        output_bytes,
        sample_count,
    );
}

#[cfg(target_os = "linux")]
fn commit_part_file(part_path: &Path, final_path: &Path) -> Result<(), String> {
    let part_path_c = unix_path_to_c_string(part_path)?;
    let final_path_c = unix_path_to_c_string(final_path)?;

    // 直接调用系统调用，避免引入较新 glibc 符号，同时让碰撞检测与移动保持原子。
    let renamed = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            part_path_c.as_ptr(),
            libc::AT_FDCWD,
            final_path_c.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if renamed == -1 {
        return Err(commit_file_error(final_path));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn commit_part_file(part_path: &Path, final_path: &Path) -> Result<(), String> {
    let part_path_c = unix_path_to_c_string(part_path)?;
    let final_path_c = unix_path_to_c_string(final_path)?;

    // RENAME_EXCL 让目标存在检查与移动由内核作为同一个原子操作完成。
    let renamed = unsafe {
        libc::renamex_np(
            part_path_c.as_ptr(),
            final_path_c.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if renamed == -1 {
        return Err(commit_file_error(final_path));
    }
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn commit_part_file(part_path: &Path, final_path: &Path) -> Result<(), String> {
    fs::hard_link(part_path, final_path)
        .map_err(|error| format!("提交数值日志文件 {} 失败: {error}", final_path.display()))?;
    fs::remove_file(part_path).map_err(|error| {
        format!(
            "移除数值日志临时文件 {} 失败: {error}；已保留最终文件 {}",
            part_path.display(),
            final_path.display()
        )
    })
}

#[cfg(windows)]
fn commit_part_file(part_path: &Path, final_path: &Path) -> Result<(), String> {
    let part_path_wide = part_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let final_path_wide = final_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();

    // 不传 MOVEFILE_REPLACE_EXISTING，确保提交与碰撞检测是同一个原子操作。
    let moved = unsafe { MoveFileExW(part_path_wide.as_ptr(), final_path_wide.as_ptr(), 0) };
    if moved == 0 {
        return Err(commit_file_error(final_path));
    }
    Ok(())
}

#[cfg(unix)]
fn unix_path_to_c_string(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("数值日志文件路径包含 NUL 字节: {}", path.display()))
}

fn commit_file_error(final_path: &Path) -> String {
    format!(
        "提交数值日志文件 {} 失败: {}",
        final_path.display(),
        io::Error::last_os_error()
    )
}

fn write_csv_preamble<W: Write>(writer: &mut W) -> io::Result<u64> {
    writer.write_all(UTF8_BOM)?;
    writer.write_all(CSV_HEADER.as_bytes())?;
    Ok((UTF8_BOM.len() + CSV_HEADER.len()) as u64)
}

fn write_csv_sample<W: Write>(
    writer: &mut W,
    sample_index: u64,
    elapsed_us: u64,
    sample: &NumericLogSample,
) -> io::Result<u64> {
    let row = format!(
        "{sample_index},{},{elapsed_us},{},{},{},{}\r\n",
        sample.timestamp_unix_us,
        sample.channel_kind.as_str(),
        encode_csv_text(&sample.channel_id),
        encode_csv_text(&sample.channel_name),
        sample.value,
    );
    writer.write_all(row.as_bytes())?;
    Ok(row.len() as u64)
}

fn encode_csv_text(value: &str) -> String {
    let protected = if starts_like_formula(value) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if protected
        .bytes()
        .any(|byte| matches!(byte, b',' | b'"' | b'\r' | b'\n'))
    {
        format!("\"{}\"", protected.replace('"', "\"\""))
    } else {
        protected
    }
}

fn starts_like_formula(value: &str) -> bool {
    matches!(
        value.trim_start().chars().next(),
        Some('=' | '+' | '-' | '@')
    )
}

fn validate_batch(samples: &[NumericLogSample]) -> Result<(), String> {
    if samples.len() > MAX_BATCH_SAMPLES {
        return Err(format!(
            "单批数值日志最多包含 {MAX_BATCH_SAMPLES} 条样本，日志已中止"
        ));
    }
    for sample in samples {
        validate_sample(sample)?;
    }
    Ok(())
}

fn validate_sample(sample: &NumericLogSample) -> Result<(), String> {
    if sample.channel_id.is_empty() {
        return Err("数值日志通道 ID 不能为空，日志已中止".to_owned());
    }
    if sample.channel_id.len() > MAX_CHANNEL_ID_BYTES {
        return Err(format!(
            "数值日志通道 ID 不能超过 {MAX_CHANNEL_ID_BYTES} 字节，日志已中止"
        ));
    }
    if sample.channel_name.len() > MAX_CHANNEL_NAME_BYTES {
        return Err(format!(
            "数值日志通道名称不能超过 {MAX_CHANNEL_NAME_BYTES} 字节，日志已中止"
        ));
    }
    if sample.channel_id.chars().any(char::is_control)
        || sample.channel_name.chars().any(char::is_control)
    {
        return Err("数值日志通道字段不能包含控制字符，日志已中止".to_owned());
    }
    if !sample.value.is_finite() {
        return Err("数值日志只接受有限数值，日志已中止".to_owned());
    }
    Ok(())
}

fn estimate_batch_bytes(samples: &[NumericLogSample], allocation_capacity: usize) -> Option<usize> {
    let mut size = std::mem::size_of::<QueuedBatch>();
    size = size
        .checked_add(allocation_capacity.checked_mul(std::mem::size_of::<NumericLogSample>())?)?;
    for sample in samples {
        size = size.checked_add(sample.channel_id.capacity())?;
        size = size.checked_add(sample.channel_name.capacity())?;
    }
    Some(size)
}

fn create_numeric_log_file(
    app: &AppHandle,
    destination_directory: Option<&str>,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf, PathBuf), String> {
    if let Some(directory) = resolve_custom_recording_directory(destination_directory)? {
        return create_file_in_existing_directory(&directory, started_at_unix_ms, session_id)
            .map_err(|error| format!("自定义记录目录不可用: {error}"));
    }

    let mut errors = Vec::new();
    match app.path().download_dir() {
        Ok(path) => {
            let directory = path.join("Vofa-Ultra");
            match create_file_in_directory(&directory, started_at_unix_ms, session_id) {
                Ok(result) => return Ok(result),
                Err(error) => errors.push(format!("下载目录不可用: {error}")),
            }
        }
        Err(error) => errors.push(format!("无法定位下载目录: {error}")),
    }
    match app.path().app_data_dir() {
        Ok(path) => {
            let directory = path.join("recordings");
            match create_file_in_directory(&directory, started_at_unix_ms, session_id) {
                Ok(result) => return Ok(result),
                Err(error) => errors.push(format!("应用数据目录不可用: {error}")),
            }
        }
        Err(error) => errors.push(format!("无法定位应用数据目录: {error}")),
    }
    Err(format!("无法创建数值日志文件：{}", errors.join("；")))
}

fn create_file_in_directory(
    directory: &Path,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf, PathBuf), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("创建目录 {} 失败: {error}", directory.display()))?;

    create_file_in_existing_directory(directory, started_at_unix_ms, session_id)
}

fn create_file_in_existing_directory(
    directory: &Path,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf, PathBuf), String> {
    if !directory.is_dir() {
        return Err(format!(
            "记录目录不存在或不是文件夹: {}",
            directory.display()
        ));
    }
    for suffix in 0..100_u16 {
        let stem = if suffix == 0 {
            format!("numeric-{started_at_unix_ms}-{session_id}")
        } else {
            format!("numeric-{started_at_unix_ms}-{session_id}-{suffix}")
        };
        let final_path = directory.join(format!("{stem}.csv"));
        if final_path.exists() {
            continue;
        }
        let part_path = directory.join(format!("{stem}.csv.part"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
        {
            Ok(file) => return Ok((file, part_path, final_path)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("创建 {} 失败: {error}", part_path.display())),
        }
    }
    Err("同名数值日志文件过多，请稍后重试".to_owned())
}

fn fail_active_log(shared: &mut SharedNumericLogState, message: String) -> NumericLogStatePayload {
    if let Some(worker) = shared.worker.as_ref() {
        worker.control.request_abort();
    }
    shared.status = NumericLogStatus::Error;
    shared.ended_at_unix_ms = Some(unix_millis());
    shared.message = Some(message);
    shared.touch()
}

fn publish_start_error(
    app: &AppHandle,
    core: &Arc<NumericLogCore>,
    session_id: u64,
    started_at_unix_ms: u64,
    path: String,
    message: String,
) {
    let payload = core.shared.lock().ok().map(|mut shared| {
        shared.status = NumericLogStatus::Error;
        shared.session_id = session_id;
        shared.path = path;
        shared.started_at_unix_ms = Some(started_at_unix_ms);
        shared.ended_at_unix_ms = Some(unix_millis());
        shared.output_bytes = 0;
        shared.sample_count = 0;
        shared.message = Some(message);
        shared.touch()
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
}

fn publish_finalization_error(app: &AppHandle, core: &Arc<NumericLogCore>, message: String) {
    let payload = core.shared.lock().ok().map(|mut shared| {
        if shared.status != NumericLogStatus::Error || shared.message.is_none() {
            shared.status = NumericLogStatus::Error;
            shared.ended_at_unix_ms = Some(unix_millis());
            shared.message = Some(message);
        }
        shared.touch()
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
}

fn sanitize_abort_message(message: String) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "数值日志已由调用方中止".to_owned();
    }
    trimmed.chars().take(MAX_ABORT_MESSAGE_CHARS).collect()
}

fn emit_state(app: &AppHandle, payload: NumericLogStatePayload) {
    let _ = app.emit("numeric-log://state", payload);
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn duration_micros(duration: Duration) -> u64 {
    duration.as_micros().try_into().unwrap_or(u64::MAX)
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
    use super::*;

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
                "vofa-ultra-numeric-{name}-{}-{nonce}",
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

    fn sample(id: &str, name: &str, value: f64) -> NumericLogSample {
        NumericLogSample {
            timestamp_unix_us: 1_750_000_000_123_456,
            channel_kind: NumericChannelKind::Base,
            channel_id: id.to_owned(),
            channel_name: name.to_owned(),
            value,
        }
    }

    #[test]
    fn csv_schema_uses_bom_fixed_header_and_crlf() {
        let mut bytes = Vec::new();
        let written = write_csv_preamble(&mut bytes).unwrap();

        assert_eq!(written as usize, UTF8_BOM.len() + CSV_HEADER.len());
        assert!(bytes.starts_with(UTF8_BOM));
        assert_eq!(&bytes[UTF8_BOM.len()..], CSV_HEADER.as_bytes());
        assert!(CSV_HEADER.ends_with("\r\n"));
        assert!(!CSV_HEADER[..CSV_HEADER.len() - 2].contains('\n'));
    }

    #[test]
    fn csv_row_is_long_form_and_locale_independent() {
        let mut bytes = Vec::new();
        let written =
            write_csv_sample(&mut bytes, 7, 99, &sample("channel-0", "温度", 1.25)).unwrap();
        let text = String::from_utf8(bytes).unwrap();

        assert_eq!(written as usize, text.len());
        assert_eq!(text, "7,1750000000123456,99,base,channel-0,温度,1.25\r\n");
    }

    #[test]
    fn output_byte_count_covers_bom_header_and_complete_rows() {
        let mut bytes = Vec::new();
        let mut output_bytes = write_csv_preamble(&mut bytes).unwrap();
        output_bytes +=
            write_csv_sample(&mut bytes, 0, 10, &sample("channel-0", "温度", 1.25)).unwrap();
        output_bytes +=
            write_csv_sample(&mut bytes, 1, 20, &sample("derived:ema", "滤波", -2.5)).unwrap();

        assert_eq!(output_bytes as usize, bytes.len());
        assert!(bytes.starts_with(UTF8_BOM));
        let text = String::from_utf8(bytes[UTF8_BOM.len()..].to_vec()).unwrap();
        assert!(text.starts_with(CSV_HEADER));
        assert_eq!(text.lines().count(), 3);
        assert!(text.ends_with("\r\n"));
    }

    #[test]
    fn csv_text_escapes_rfc4180_characters_and_formula_prefixes() {
        assert_eq!(encode_csv_text("plain"), "plain");
        assert_eq!(encode_csv_text("a,b"), "\"a,b\"");
        assert_eq!(encode_csv_text("a\"b"), "\"a\"\"b\"");
        assert_eq!(encode_csv_text("a\r\nb"), "\"a\r\nb\"");
        assert_eq!(encode_csv_text("=1+1"), "'=1+1");
        assert_eq!(encode_csv_text("  @SUM(A1)"), "'  @SUM(A1)");
        assert_eq!(encode_csv_text("-safe,name"), "\"'-safe,name\"");
    }

    #[test]
    fn validates_batch_sample_and_utf8_byte_limits() {
        assert!(validate_batch(&[]).is_ok());
        let too_many = (0..=MAX_BATCH_SAMPLES)
            .map(|index| sample(&format!("channel-{index}"), "CH", index as f64))
            .collect::<Vec<_>>();
        assert!(validate_batch(&too_many).unwrap_err().contains("512"));

        assert!(validate_sample(&sample("", "CH", 1.0)).is_err());
        assert!(
            validate_sample(&sample(&"x".repeat(MAX_CHANNEL_ID_BYTES + 1), "CH", 1.0)).is_err()
        );
        assert!(validate_sample(&sample("channel-0", &"界".repeat(86), 1.0)).is_err());
        assert!(validate_sample(&sample("channel-0", "bad\nname", 1.0)).is_err());
        assert!(validate_sample(&sample("channel-0", "CH", f64::NAN)).is_err());
        assert!(validate_sample(&sample("channel-0", "CH", f64::INFINITY)).is_err());
    }

    #[test]
    fn validates_start_request_and_channel_kind() {
        let valid = NumericLogStartRequest {
            source: "serial".to_owned(),
            protocol: "firewater".to_owned(),
            destination_directory: Some("/captures".to_owned()),
        };
        assert!(valid.validate().is_ok());
        assert!(NumericLogStartRequest {
            source: "network".to_owned(),
            protocol: "firewater".to_owned(),
            destination_directory: None,
        }
        .validate()
        .is_err());
        assert!(NumericLogStartRequest {
            source: "simulator".to_owned(),
            protocol: "raw".to_owned(),
            destination_directory: None,
        }
        .validate()
        .is_err());
        assert!(serde_json::from_str::<NumericLogSample>(
            r#"{
                "timestampUnixUs":1,
                "channelKind":"plugin",
                "channelId":"channel-0",
                "channelName":"CH 1",
                "value":1
            }"#,
        )
        .is_err());
    }

    #[test]
    fn start_request_reads_optional_camel_case_directory() {
        let request: NumericLogStartRequest = serde_json::from_str(
            r#"{
                "source":"serial",
                "protocol":"firewater",
                "destinationDirectory":"/captures"
            }"#,
        )
        .unwrap();
        assert_eq!(request.destination_directory.as_deref(), Some("/captures"));

        let request: NumericLogStartRequest =
            serde_json::from_str(r#"{"source":"serial","protocol":"firewater"}"#).unwrap();
        assert_eq!(request.destination_directory, None);
    }

    #[test]
    fn resource_budget_releases_capacity_when_reservation_drops() {
        let budget = Arc::new(ResourceBudget::new(8));
        let first = budget.try_reserve(5).unwrap();
        assert!(budget.try_reserve(4).is_none());
        let second = budget.try_reserve(3).unwrap();
        assert_eq!(budget.used.load(Ordering::Acquire), 8);

        drop(first);
        assert_eq!(budget.used.load(Ordering::Acquire), 3);
        assert!(budget.try_reserve(5).is_some());
        drop(second);
    }

    #[test]
    fn estimates_owned_batch_memory() {
        let samples = vec![
            sample("channel-0", "温度", 1.0),
            sample("derived:x", "滤波", 2.0),
        ];
        let bytes = estimate_batch_bytes(&samples, samples.capacity()).unwrap();

        assert!(bytes >= std::mem::size_of::<QueuedBatch>());
        assert!(bytes >= samples.capacity() * std::mem::size_of::<NumericLogSample>());
    }

    #[test]
    fn state_payload_serializes_camel_case_and_omits_absent_fields() {
        let payload = SharedNumericLogState::default().snapshot();
        let value = serde_json::to_value(payload).unwrap();

        assert_eq!(value["status"], "idle");
        assert_eq!(value["sessionId"], 0);
        assert_eq!(value["revision"], 0);
        assert_eq!(value["outputBytes"], 0);
        assert_eq!(value["sampleCount"], 0);
        assert!(value.get("startedAtUnixMs").is_none());
        assert!(value.get("endedAtUnixMs").is_none());
        assert!(value.get("message").is_none());
    }

    #[test]
    fn completed_state_uses_final_path_and_failed_state_keeps_part_path() {
        let part_path = PathBuf::from("session.csv.part");
        let final_path = PathBuf::from("session.csv");
        let mut completed = SharedNumericLogState {
            status: NumericLogStatus::Stopping,
            session_id: 7,
            ..SharedNumericLogState::default()
        };
        let payload = completed
            .apply_writer_outcome(7, WriterOutcome::Completed, &part_path, &final_path, 321, 4)
            .unwrap();
        assert_eq!(payload.status, "idle");
        assert_eq!(payload.path, final_path.to_string_lossy());
        assert_eq!(payload.output_bytes, 321);
        assert_eq!(payload.sample_count, 4);

        let mut failed = SharedNumericLogState {
            status: NumericLogStatus::Stopping,
            session_id: 8,
            ..SharedNumericLogState::default()
        };
        let payload = failed
            .apply_writer_outcome(
                8,
                WriterOutcome::Failed("磁盘错误".to_owned()),
                &part_path,
                &final_path,
                123,
                2,
            )
            .unwrap();
        assert_eq!(payload.status, "error");
        assert_eq!(payload.path, part_path.to_string_lossy());
        assert_eq!(payload.message.as_deref(), Some("磁盘错误"));
    }

    #[test]
    fn commit_publishes_part_and_failure_preserves_part() {
        let directory = TestDirectory::new("commit");
        let part_path = directory.join("session.csv.part");
        let final_path = directory.join("session.csv");
        fs::write(&part_path, b"complete").unwrap();

        commit_part_file(&part_path, &final_path).unwrap();
        assert!(!part_path.exists());
        assert_eq!(fs::read(&final_path).unwrap(), b"complete");

        let failed_part = directory.join("failed.csv.part");
        let missing_parent = directory.join("missing");
        let failed_final = missing_parent.join("failed.csv");
        fs::write(&failed_part, b"partial").unwrap();
        assert!(commit_part_file(&failed_part, &failed_final).is_err());
        assert_eq!(fs::read(&failed_part).unwrap(), b"partial");
        assert!(!failed_final.exists());
    }

    #[test]
    fn commit_never_replaces_a_final_file_created_after_start() {
        let directory = TestDirectory::new("late-collision");
        let part_path = directory.join("session.csv.part");
        let final_path = directory.join("session.csv");
        fs::write(&part_path, b"complete-log").unwrap();
        fs::write(&final_path, b"external-file").unwrap();

        assert!(commit_part_file(&part_path, &final_path).is_err());
        assert_eq!(fs::read(&part_path).unwrap(), b"complete-log");
        assert_eq!(fs::read(&final_path).unwrap(), b"external-file");
    }

    #[test]
    fn numeric_file_creation_avoids_existing_final_and_part_files() {
        let directory = TestDirectory::new("collision");
        let first_final = directory.join("numeric-1000-7.csv");
        let second_part = directory.join("numeric-1000-7-1.csv.part");
        fs::write(&first_final, b"existing-final").unwrap();
        fs::write(&second_part, b"existing-part").unwrap();

        let (file, part_path, final_path) =
            create_file_in_directory(&directory.path, 1000, 7).unwrap();
        drop(file);

        assert_eq!(part_path, directory.join("numeric-1000-7-2.csv.part"));
        assert_eq!(final_path, directory.join("numeric-1000-7-2.csv"));
        assert_eq!(fs::read(first_final).unwrap(), b"existing-final");
        assert_eq!(fs::read(second_part).unwrap(), b"existing-part");
    }

    #[test]
    fn explicit_numeric_directory_is_not_recreated_after_validation() {
        let directory = TestDirectory::new("removed");
        let resolved = resolve_custom_recording_directory(directory.path.to_str())
            .unwrap()
            .unwrap();
        fs::remove_dir_all(&directory.path).unwrap();

        assert!(create_file_in_existing_directory(&resolved, 1000, 7).is_err());
        assert!(!resolved.exists());
    }

    #[test]
    fn writer_control_finishes_only_through_commit() {
        let control = WriterControl::new();

        assert!(control.request_finish());
        assert!(control.request_finish());
        assert!(control.begin_commit());
        assert!(!control.request_abort());
        assert!(!control.begin_commit());
        control.mark_completed();
        assert!(!control.request_finish());
        assert!(!control.request_abort());
    }

    #[test]
    fn writer_control_abort_wins_before_commit() {
        let active = WriterControl::new();
        assert!(active.request_abort());
        assert!(active.request_abort());
        assert!(active.is_aborted());
        assert!(!active.request_finish());
        assert!(!active.begin_commit());

        let finishing = WriterControl::new();
        assert!(finishing.request_finish());
        assert!(finishing.request_abort());
        assert!(finishing.is_aborted());
        assert!(!finishing.begin_commit());
    }

    #[test]
    fn worker_finish_and_abort_join_without_blocking() {
        let finish_control = Arc::new(WriterControl::new());
        let (finish_sender, finish_receiver) = mpsc::sync_channel(1);
        let (finish_seen_sender, finish_seen_receiver) = mpsc::channel();
        let finish_thread = thread::spawn(move || {
            let seen = matches!(finish_receiver.recv(), Ok(WriterCommand::Finish));
            finish_seen_sender.send(seen).unwrap();
        });
        let finish_worker = test_worker(finish_sender, finish_control, finish_thread);
        finish_worker.finish_and_join().unwrap();
        assert_eq!(
            finish_seen_receiver.recv_timeout(Duration::from_secs(1)),
            Ok(true)
        );

        let abort_control = Arc::new(WriterControl::new());
        let (abort_sender, abort_receiver) = mpsc::sync_channel(1);
        let (abort_seen_sender, abort_seen_receiver) = mpsc::channel();
        let abort_thread = thread::spawn(move || {
            abort_seen_sender
                .send(abort_receiver.recv().is_err())
                .unwrap();
        });
        let abort_worker = test_worker(abort_sender, abort_control, abort_thread);
        abort_worker.abort_and_join().unwrap();
        assert_eq!(
            abort_seen_receiver.recv_timeout(Duration::from_secs(1)),
            Ok(true)
        );
    }

    #[test]
    fn state_drop_releases_shared_lock_before_joining_worker() {
        let state = NumericLogState::default();
        let core = Arc::clone(&state.core);
        let control = Arc::new(WriterControl::new());
        let (sender, receiver) = mpsc::sync_channel(1);
        let writer_thread = thread::spawn(move || {
            assert!(receiver.recv().is_err());
            let _shared = core.shared.lock().unwrap();
        });
        state.core.shared.lock().unwrap().worker =
            Some(test_worker(sender, control, writer_thread));

        let (drop_done_sender, drop_done_receiver) = mpsc::channel();
        thread::spawn(move || {
            drop(state);
            drop_done_sender.send(()).unwrap();
        });
        assert_eq!(
            drop_done_receiver.recv_timeout(Duration::from_secs(1)),
            Ok(())
        );
    }

    #[test]
    fn abort_message_is_bounded_and_has_default() {
        assert_eq!(
            sanitize_abort_message("  ".to_owned()),
            "数值日志已由调用方中止"
        );
        assert_eq!(sanitize_abort_message(" message ".to_owned()), "message");
        assert_eq!(
            sanitize_abort_message("x".repeat(MAX_ABORT_MESSAGE_CHARS + 10)).len(),
            MAX_ABORT_MESSAGE_CHARS
        );
    }

    fn test_worker(
        sender: mpsc::SyncSender<WriterCommand>,
        control: Arc<WriterControl>,
        join_handle: JoinHandle<()>,
    ) -> NumericLogWorker {
        NumericLogWorker {
            session_id: 1,
            sender: Some(sender),
            control,
            byte_budget: Arc::new(ResourceBudget::new(WRITER_QUEUE_BYTES)),
            sample_budget: Arc::new(ResourceBudget::new(WRITER_QUEUE_SAMPLES)),
            started: Instant::now(),
            join_handle: Some(join_handle),
        }
    }
}
