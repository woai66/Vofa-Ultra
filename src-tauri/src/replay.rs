use std::fs::File;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::capture::{
    CaptureDirection, CaptureHeader, CaptureItem, CaptureReadError, CaptureReader, CaptureRecord,
    CaptureRecordStats,
};

const CONTROL_QUEUE_CAPACITY: usize = 16;
const ACK_QUEUE_CAPACITY: usize = 64;
const MAX_BATCH_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_BATCH_RECORDS: usize = 128;
const MAX_BATCH_SPAN_US: u64 = 16_000;
const MAX_PATH_CHARS: usize = 4096;
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(10);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const SCAN_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const POSITION_EVENT_INTERVAL: Duration = Duration::from_millis(100);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatePayload {
    status: String,
    session_id: u64,
    generation: u64,
    revision: u64,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    header: Option<CaptureHeader>,
    complete: bool,
    position_us: u64,
    duration_us: u64,
    data_bytes: u64,
    record_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayBatchRecordPayload {
    direction: String,
    timestamp_us: u64,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayBatchPayload<'a> {
    session_id: u64,
    generation: u64,
    sequence: u64,
    start_us: u64,
    end_us: u64,
    data_bytes: u64,
    records: &'a [ReplayBatchRecordPayload],
}

pub struct ReplayState {
    transition: Mutex<()>,
    core: Arc<ReplayCore>,
}

impl Default for ReplayState {
    fn default() -> Self {
        Self {
            transition: Mutex::new(()),
            core: Arc::new(ReplayCore {
                shared: Mutex::new(SharedReplayState::default()),
            }),
        }
    }
}

impl Drop for ReplayState {
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
            let _ = worker.force_close_and_join();
        }
    }
}

struct ReplayCore {
    shared: Mutex<SharedReplayState>,
}

struct SharedReplayState {
    status: ReplayStatus,
    session_id: u64,
    generation: u64,
    revision: u64,
    path: String,
    header: Option<CaptureHeader>,
    complete: bool,
    position_us: u64,
    duration_us: u64,
    data_bytes: u64,
    record_count: u64,
    message: Option<String>,
    worker: Option<ReplayWorkerHandle>,
}

impl Default for SharedReplayState {
    fn default() -> Self {
        Self {
            status: ReplayStatus::Idle,
            session_id: 0,
            generation: 0,
            revision: 0,
            path: String::new(),
            header: None,
            complete: false,
            position_us: 0,
            duration_us: 0,
            data_bytes: 0,
            record_count: 0,
            message: None,
            worker: None,
        }
    }
}

impl SharedReplayState {
    fn snapshot(&self) -> ReplayStatePayload {
        ReplayStatePayload {
            status: self.status.as_str().to_owned(),
            session_id: self.session_id,
            generation: self.generation,
            revision: self.revision,
            path: self.path.clone(),
            header: self.header.clone(),
            complete: self.complete,
            position_us: self.position_us,
            duration_us: self.duration_us,
            data_bytes: self.data_bytes,
            record_count: self.record_count,
            message: self.message.clone(),
        }
    }

    fn touch(&mut self) -> ReplayStatePayload {
        self.revision = self.revision.saturating_add(1);
        self.snapshot()
    }

    fn reset_idle(&mut self) -> ReplayStatePayload {
        self.status = ReplayStatus::Idle;
        self.generation = next_generation(self.generation);
        self.path.clear();
        self.header = None;
        self.complete = false;
        self.position_us = 0;
        self.duration_us = 0;
        self.data_bytes = 0;
        self.record_count = 0;
        self.message = None;
        self.touch()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReplayStatus {
    Idle,
    Loading,
    Ready,
    Playing,
    Paused,
    Stopping,
    Completed,
    Error,
}

impl ReplayStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Playing => "playing",
            Self::Paused => "paused",
            Self::Stopping => "stopping",
            Self::Completed => "completed",
            Self::Error => "error",
        }
    }
}

struct ReplayWorkerHandle {
    session_id: u64,
    control_sender: mpsc::SyncSender<ControlCommand>,
    ack_sender: mpsc::SyncSender<ReplayAck>,
    shutdown: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl ReplayWorkerHandle {
    fn close_and_join(mut self) -> Result<(), String> {
        let (reply_sender, reply_receiver) = mpsc::channel();
        let command = ControlCommand {
            session_id: self.session_id,
            generation: None,
            kind: ControlKind::Close,
            reply: Some(reply_sender),
        };
        let send_result = self
            .control_sender
            .try_send(command)
            .map_err(|error| control_send_error(error, "关闭"));
        let reply_result = match send_result {
            Ok(()) => match reply_receiver.recv_timeout(COMMAND_TIMEOUT) {
                Ok(result) => result.map(|_| ()),
                Err(mpsc::RecvTimeoutError::Timeout) => Err("等待回放关闭超时".to_owned()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    Err("回放线程未返回关闭结果".to_owned())
                }
            },
            Err(message) => Err(message),
        };
        if reply_result.is_err() {
            self.shutdown.store(true, Ordering::Release);
        }
        let join_result = self.join();
        join_result.and(reply_result)
    }

    fn force_close_and_join(mut self) -> Result<(), String> {
        self.shutdown.store(true, Ordering::Release);
        let _ = self.control_sender.try_send(ControlCommand {
            session_id: self.session_id,
            generation: None,
            kind: ControlKind::Close,
            reply: None,
        });
        self.join()
    }

    fn join(&mut self) -> Result<(), String> {
        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|panic| format!("回放线程异常退出: {}", panic_message(panic)))?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum ControlKind {
    Play,
    Pause,
    Stop,
    Close,
}

struct ControlCommand {
    session_id: u64,
    generation: Option<u64>,
    kind: ControlKind,
    reply: Option<mpsc::Sender<Result<ReplayStatePayload, String>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReplayAck {
    session_id: u64,
    generation: u64,
    sequence: u64,
}

impl ReplayAck {
    fn matches(self, session_id: u64, generation: u64, sequence: u64) -> bool {
        self.session_id == session_id && self.generation == generation && self.sequence == sequence
    }
}

#[tauri::command]
pub fn get_replay_state(state: State<'_, ReplayState>) -> Result<ReplayStatePayload, String> {
    snapshot_replay_state(&state)
}

#[tauri::command]
pub async fn open_replay(
    app: AppHandle,
    state: State<'_, ReplayState>,
    path: String,
) -> Result<ReplayStatePayload, String> {
    open_replay_inner(&app, &state, path)
}

fn open_replay_inner(
    app: &AppHandle,
    state: &ReplayState,
    path: String,
) -> Result<ReplayStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "回放生命周期锁已损坏".to_owned())?;

    // 先验证新文件，失败时保留当前回放会话。
    let candidate = open_replay_candidate(path)?;
    let stale_worker = state
        .core
        .shared
        .lock()
        .map_err(|_| "回放状态锁已损坏".to_owned())?
        .worker
        .take();
    if let Some(worker) = stale_worker {
        worker.close_and_join()?;
    }

    let ReplayCandidate {
        path: candidate_path,
        path_text,
        header,
        reader,
    } = candidate;

    let session_id = {
        let shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "回放状态锁已损坏".to_owned())?;
        shared.session_id.wrapping_add(1).max(1)
    };
    let (control_sender, control_receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
    let (ack_sender, ack_receiver) = mpsc::sync_channel(ACK_QUEUE_CAPACITY);
    let (start_sender, start_receiver) = mpsc::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let worker_core = Arc::clone(&state.core);
    let panic_core = Arc::clone(&state.core);
    let worker_app = app.clone();
    let panic_app = app.clone();
    let worker_path = candidate_path.clone();
    let worker_header = header.clone();
    let join_handle = thread::Builder::new()
        .name("vofa-replay-worker".to_owned())
        .spawn(move || {
            if start_receiver.recv().is_err() {
                panic_core.clear_worker(session_id);
                return;
            }
            let result = catch_unwind(AssertUnwindSafe(|| {
                run_replay_worker(
                    worker_app,
                    worker_core,
                    session_id,
                    worker_path,
                    worker_header,
                    reader,
                    control_receiver,
                    ack_receiver,
                    worker_shutdown,
                );
            }));
            if let Err(panic) = result {
                panic_core.publish_worker_error(
                    &panic_app,
                    session_id,
                    format!("回放线程异常退出: {}", panic_message(panic)),
                );
            }
            panic_core.clear_worker(session_id);
        })
        .map_err(|error| {
            let message = format!("创建回放线程失败: {error}");
            state
                .core
                .publish_open_error(app, session_id, path_text.clone(), message.clone());
            message
        })?;

    let payload = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "回放状态锁已损坏".to_owned())?;
        shared.status = ReplayStatus::Loading;
        shared.session_id = session_id;
        shared.generation = 0;
        shared.path = path_text;
        shared.header = Some(header);
        shared.complete = false;
        shared.position_us = 0;
        shared.duration_us = 0;
        shared.data_bytes = 0;
        shared.record_count = 0;
        shared.message = Some("正在扫描捕获文件".to_owned());
        shared.worker = Some(ReplayWorkerHandle {
            session_id,
            control_sender,
            ack_sender,
            shutdown,
            join_handle: Some(join_handle),
        });
        shared.touch()
    };
    emit_state(app, payload.clone());

    if start_sender.send(()).is_err() {
        let worker = state
            .core
            .shared
            .lock()
            .map_err(|_| "回放状态锁已损坏".to_owned())?
            .worker
            .take();
        if let Some(worker) = worker {
            let _ = worker.force_close_and_join();
        }
        let message = "回放线程未能启动".to_owned();
        state
            .core
            .publish_worker_error(app, session_id, message.clone());
        return Err(message);
    }

    Ok(payload)
}

#[tauri::command]
pub fn play_replay(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
) -> Result<ReplayStatePayload, String> {
    request_control(&app, &state, session_id, None, ControlKind::Play)
}

#[tauri::command]
pub fn pause_replay(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
    generation: u64,
) -> Result<ReplayStatePayload, String> {
    request_control(
        &app,
        &state,
        session_id,
        Some(generation),
        ControlKind::Pause,
    )
}

#[tauri::command]
pub fn stop_replay(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
    generation: u64,
) -> Result<ReplayStatePayload, String> {
    request_control(
        &app,
        &state,
        session_id,
        Some(generation),
        ControlKind::Stop,
    )
}

#[tauri::command]
pub fn close_replay(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
) -> Result<ReplayStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "回放生命周期锁已损坏".to_owned())?;
    let worker = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "回放状态锁已损坏".to_owned())?;
        if shared.session_id != session_id {
            return Err("回放会话已变化，请刷新后重试".to_owned());
        }
        shared.worker.take()
    };

    if let Some(worker) = worker {
        if let Err(message) = worker.close_and_join() {
            state
                .core
                .publish_worker_error(&app, session_id, message.clone());
            return Err(message);
        }
    } else {
        state.core.publish_idle(&app, session_id);
    }
    snapshot_replay_state(&state)
}

#[tauri::command]
pub fn ack_replay_batch(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
    generation: u64,
    sequence: u64,
) -> Result<(), String> {
    let ack_sender = {
        let shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "回放状态锁已损坏".to_owned())?;
        if shared.session_id != session_id || shared.generation != generation {
            return Ok(());
        }
        let Some(worker) = shared.worker.as_ref() else {
            return Ok(());
        };
        if worker.session_id != session_id {
            return Ok(());
        }
        worker.ack_sender.clone()
    };

    match ack_sender.try_send(ReplayAck {
        session_id,
        generation,
        sequence,
    }) {
        Ok(()) => Ok(()),
        Err(mpsc::TrySendError::Full(_)) => Err("回放 ACK 队列已满".to_owned()),
        Err(mpsc::TrySendError::Disconnected(_)) => {
            let message = "回放线程已停止".to_owned();
            state
                .core
                .publish_worker_error(&app, session_id, message.clone());
            Err(message)
        }
    }
}

fn request_control(
    app: &AppHandle,
    state: &ReplayState,
    session_id: u64,
    generation: Option<u64>,
    kind: ControlKind,
) -> Result<ReplayStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "回放生命周期锁已损坏".to_owned())?;
    let control_sender = {
        let shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "回放状态锁已损坏".to_owned())?;
        if shared.session_id != session_id {
            return Err("回放会话已变化，请刷新后重试".to_owned());
        }
        if !control_generation_matches(shared.generation, generation) {
            return Err("回放代次已变化，请刷新后重试".to_owned());
        }
        shared
            .worker
            .as_ref()
            .filter(|worker| worker.session_id == session_id)
            .map(|worker| worker.control_sender.clone())
            .ok_or_else(|| "回放线程未运行".to_owned())?
    };
    let (reply_sender, reply_receiver) = mpsc::channel();
    let command = ControlCommand {
        session_id,
        generation,
        kind,
        reply: Some(reply_sender),
    };

    control_sender.try_send(command).map_err(|error| {
        let message = control_send_error(error, control_kind_name(kind));
        if message == "回放线程已停止" {
            state
                .core
                .publish_worker_error(app, session_id, message.clone());
        }
        message
    })?;
    match reply_receiver.recv_timeout(COMMAND_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("等待回放{}响应超时", control_kind_name(kind)))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let message = "回放线程未返回控制结果".to_owned();
            state
                .core
                .publish_worker_error(app, session_id, message.clone());
            Err(message)
        }
    }
}

fn snapshot_replay_state(state: &ReplayState) -> Result<ReplayStatePayload, String> {
    state
        .core
        .shared
        .lock()
        .map_err(|_| "回放状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

struct ReplayCandidate {
    path: PathBuf,
    path_text: String,
    header: CaptureHeader,
    reader: CaptureReader<File>,
}

fn open_replay_candidate(path: String) -> Result<ReplayCandidate, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("请选择要回放的 .vucap 文件".to_owned());
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err("回放文件路径过长".to_owned());
    }

    let path_buf = PathBuf::from(path);
    let is_vucap = path_buf
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("vucap"))
        .unwrap_or(false);
    if !is_vucap {
        return Err("只能打开 .vucap 捕获文件".to_owned());
    }

    let file = File::open(&path_buf)
        .map_err(|error| format!("无法打开回放文件 {}: {error}", path_buf.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取回放文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err("回放路径不是普通文件".to_owned());
    }
    let reader = CaptureReader::new(file).map_err(|error| error.to_string())?;
    let header = reader.header().clone();

    Ok(ReplayCandidate {
        path: path_buf,
        path_text: path.to_owned(),
        header,
        reader,
    })
}

fn control_send_error(error: mpsc::TrySendError<ControlCommand>, action: &str) -> String {
    match error {
        mpsc::TrySendError::Full(_) => format!("回放控制队列已满，无法{action}"),
        mpsc::TrySendError::Disconnected(_) => "回放线程已停止".to_owned(),
    }
}

fn control_kind_name(kind: ControlKind) -> &'static str {
    match kind {
        ControlKind::Play => "播放",
        ControlKind::Pause => "暂停",
        ControlKind::Stop => "停止",
        ControlKind::Close => "关闭",
    }
}

fn control_generation_matches(current_generation: u64, requested_generation: Option<u64>) -> bool {
    requested_generation
        .map(|generation| generation == current_generation)
        .unwrap_or(true)
}

impl ReplayCore {
    fn publish_transition<F>(
        &self,
        app: &AppHandle,
        session_id: u64,
        transition: F,
    ) -> Result<ReplayStatePayload, String>
    where
        F: FnOnce(&mut SharedReplayState) -> Result<(), String>,
    {
        let payload = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "回放状态锁已损坏".to_owned())?;
            if shared.session_id != session_id {
                return Err("回放会话已变化".to_owned());
            }
            transition(&mut shared)?;
            shared.touch()
        };
        emit_state(app, payload.clone());
        Ok(payload)
    }

    fn publish_scan_progress(
        &self,
        app: &AppHandle,
        session_id: u64,
        accumulator: &ScanAccumulator,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id || shared.status != ReplayStatus::Loading {
                return None;
            }
            shared.duration_us = accumulator.duration_us();
            shared.data_bytes = accumulator.stats.data_bytes();
            shared.record_count = accumulator.stats.record_count();
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn publish_ready(
        &self,
        app: &AppHandle,
        session_id: u64,
        summary: &ScanSummary,
    ) -> Result<ReplayStatePayload, String> {
        self.publish_transition(app, session_id, |shared| {
            shared.status = ReplayStatus::Ready;
            shared.complete = summary.complete;
            shared.position_us = 0;
            shared.duration_us = summary.duration_us;
            shared.data_bytes = summary.data_bytes;
            shared.record_count = summary.record_count;
            shared.message = summary.message.clone();
            Ok(())
        })
    }

    fn publish_worker_error(&self, app: &AppHandle, session_id: u64, message: String) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id || shared.status == ReplayStatus::Idle {
                return None;
            }
            shared.status = ReplayStatus::Error;
            shared.message = Some(message);
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn publish_open_error(&self, app: &AppHandle, session_id: u64, path: String, message: String) {
        let payload = self.shared.lock().ok().map(|mut shared| {
            shared.status = ReplayStatus::Error;
            shared.session_id = session_id;
            shared.generation = 0;
            shared.path = path;
            shared.header = None;
            shared.complete = false;
            shared.position_us = 0;
            shared.duration_us = 0;
            shared.data_bytes = 0;
            shared.record_count = 0;
            shared.message = Some(message);
            shared.touch()
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn publish_idle(&self, app: &AppHandle, session_id: u64) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id {
                return None;
            }
            Some(shared.reset_idle())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn update_position(
        &self,
        app: &AppHandle,
        session_id: u64,
        position_us: u64,
        emit: bool,
    ) -> Result<(), String> {
        let payload = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "回放状态锁已损坏".to_owned())?;
            if shared.session_id != session_id {
                return Err("回放会话已变化".to_owned());
            }
            shared.position_us = position_us;
            emit.then(|| shared.touch())
        };
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
        Ok(())
    }

    fn clear_worker(&self, session_id: u64) {
        if let Ok(mut shared) = self.shared.lock() {
            let matches = shared
                .worker
                .as_ref()
                .map(|worker| worker.session_id == session_id)
                .unwrap_or(false);
            if matches {
                shared.worker.take();
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ScanSummary {
    complete: bool,
    duration_us: u64,
    data_bytes: u64,
    record_count: u64,
    message: Option<String>,
}

#[derive(Default)]
struct ScanAccumulator {
    stats: CaptureRecordStats,
}

impl ScanAccumulator {
    fn observe(&mut self, record: &CaptureRecord) -> Result<(), String> {
        self.stats.observe(record)
    }

    fn duration_us(&self) -> u64 {
        self.stats.duration_us()
    }

    fn finish(self, complete: bool, message: Option<String>) -> ScanSummary {
        ScanSummary {
            complete,
            duration_us: self.stats.duration_us(),
            data_bytes: self.stats.data_bytes(),
            record_count: self.stats.record_count(),
            message,
        }
    }
}

enum ScanResult {
    Ready(ScanSummary),
    Closed,
    Failed(String),
}

#[allow(clippy::too_many_arguments)]
fn run_replay_worker(
    app: AppHandle,
    core: Arc<ReplayCore>,
    session_id: u64,
    path: PathBuf,
    header: CaptureHeader,
    mut reader: CaptureReader<File>,
    control_receiver: mpsc::Receiver<ControlCommand>,
    ack_receiver: mpsc::Receiver<ReplayAck>,
    shutdown: Arc<AtomicBool>,
) {
    let scan_result = scan_capture(
        &app,
        &core,
        session_id,
        &mut reader,
        &control_receiver,
        &ack_receiver,
        &shutdown,
    );
    drop(reader);

    let summary = match scan_result {
        ScanResult::Ready(summary) => summary,
        ScanResult::Closed => return,
        ScanResult::Failed(message) => {
            core.publish_worker_error(&app, session_id, message);
            return;
        }
    };
    if let Err(message) = core.publish_ready(&app, session_id, &summary) {
        core.publish_worker_error(&app, session_id, message);
        return;
    }

    let runtime = ReplayRuntime::new(
        app,
        core,
        session_id,
        path,
        header,
        summary,
        control_receiver,
        ack_receiver,
        shutdown,
    );
    let error_app = runtime.app.clone();
    let error_core = Arc::clone(&runtime.core);
    if let Err(message) = runtime.run() {
        error_core.publish_worker_error(&error_app, session_id, message);
    }
}

fn scan_capture(
    app: &AppHandle,
    core: &Arc<ReplayCore>,
    session_id: u64,
    reader: &mut CaptureReader<File>,
    control_receiver: &mpsc::Receiver<ControlCommand>,
    ack_receiver: &mpsc::Receiver<ReplayAck>,
    shutdown: &Arc<AtomicBool>,
) -> ScanResult {
    let mut accumulator = ScanAccumulator::default();
    let mut last_progress = Instant::now();

    loop {
        if shutdown.load(Ordering::Acquire) {
            core.publish_idle(app, session_id);
            return ScanResult::Closed;
        }
        match poll_scan_control(app, core, session_id, control_receiver) {
            Ok(true) => return ScanResult::Closed,
            Ok(false) => {}
            Err(message) => return ScanResult::Failed(message),
        }
        while ack_receiver.try_recv().is_ok() {}

        match reader.next() {
            Some(Ok(CaptureItem::Record(record))) => {
                if let Err(message) = accumulator.observe(&record) {
                    return ScanResult::Failed(message);
                }
                if last_progress.elapsed() >= SCAN_PROGRESS_INTERVAL {
                    core.publish_scan_progress(app, session_id, &accumulator);
                    last_progress = Instant::now();
                }
            }
            Some(Ok(CaptureItem::Footer(_))) => {
                return ScanResult::Ready(accumulator.finish(true, None));
            }
            Some(Err(error @ CaptureReadError::Truncated(_))) => {
                let message = format!("捕获文件未正常结束，将回放已验证的完整记录前缀（{error}）");
                return ScanResult::Ready(accumulator.finish(false, Some(message)));
            }
            Some(Err(error)) => return ScanResult::Failed(error.to_string()),
            None => {
                let message = "捕获文件缺少结束标记，将回放已验证的完整记录前缀".to_owned();
                return ScanResult::Ready(accumulator.finish(false, Some(message)));
            }
        }
    }
}

fn poll_scan_control(
    app: &AppHandle,
    core: &Arc<ReplayCore>,
    session_id: u64,
    control_receiver: &mpsc::Receiver<ControlCommand>,
) -> Result<bool, String> {
    loop {
        match control_receiver.try_recv() {
            Ok(command) if command.session_id != session_id => {
                reply_control(command, Err("回放会话已变化".to_owned()));
            }
            Ok(command) if !control_generation_matches(0, command.generation) => {
                reply_control(command, Err("回放代次已变化".to_owned()));
            }
            Ok(command) if matches!(command.kind, ControlKind::Close) => {
                core.publish_idle(app, session_id);
                let payload = core
                    .shared
                    .lock()
                    .map_err(|_| "回放状态锁已损坏".to_owned())?
                    .snapshot();
                reply_control(command, Ok(payload));
                return Ok(true);
            }
            Ok(command) => {
                let action = control_kind_name(command.kind);
                reply_control(command, Err(format!("捕获文件正在扫描，暂时无法{action}")));
            }
            Err(mpsc::TryRecvError::Empty) => return Ok(false),
            Err(mpsc::TryRecvError::Disconnected) => return Err("回放控制通道意外关闭".to_owned()),
        }
    }
}

fn reply_control(command: ControlCommand, result: Result<ReplayStatePayload, String>) {
    if let Some(reply) = command.reply {
        let _ = reply.send(result);
    }
}

fn reply_transition(
    command: ControlCommand,
    result: Result<ReplayStatePayload, String>,
) -> Result<(), String> {
    let error = result.as_ref().err().cloned();
    reply_control(command, result);
    match error {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

struct ReplayCursor {
    reader: CaptureReader<File>,
    lookahead: Option<CaptureRecord>,
    last_timestamp_us: Option<u64>,
    data_bytes_read: u64,
    records_read: u64,
    end_verified: bool,
}

impl ReplayCursor {
    fn open(path: &Path, expected_header: &CaptureHeader) -> Result<Self, String> {
        let file = File::open(path)
            .map_err(|error| format!("重新打开回放文件 {} 失败: {error}", path.display()))?;
        let reader = CaptureReader::new(file).map_err(|error| error.to_string())?;
        if reader.header() != expected_header {
            return Err("回放文件在扫描后发生变化：文件头不一致".to_owned());
        }
        Ok(Self {
            reader,
            lookahead: None,
            last_timestamp_us: None,
            data_bytes_read: 0,
            records_read: 0,
            end_verified: false,
        })
    }

    fn next_record(&mut self, summary: &ScanSummary) -> Result<Option<CaptureRecord>, String> {
        if self.records_read < summary.record_count {
            let record = match self.reader.next() {
                Some(Ok(CaptureItem::Record(record))) => record,
                Some(Ok(CaptureItem::Footer(_))) => {
                    return Err("回放文件在扫描后发生变化：记录提前结束".to_owned())
                }
                Some(Err(error)) => return Err(error.to_string()),
                None => return Err("回放文件在扫描后发生变化：记录提前结束".to_owned()),
            };
            if self
                .last_timestamp_us
                .map(|last| record.timestamp_us < last)
                .unwrap_or(false)
            {
                return Err(format!(
                    "回放时间戳从 {} 微秒回退到 {} 微秒",
                    self.last_timestamp_us.unwrap_or(0),
                    record.timestamp_us
                ));
            }
            self.last_timestamp_us = Some(record.timestamp_us);
            self.data_bytes_read = self
                .data_bytes_read
                .saturating_add(record.payload.len() as u64);
            self.records_read = self.records_read.saturating_add(1);
            return Ok(Some(record));
        }

        self.verify_end(summary)?;
        Ok(None)
    }

    fn verify_end(&mut self, summary: &ScanSummary) -> Result<(), String> {
        if self.end_verified {
            return Ok(());
        }
        if self.data_bytes_read != summary.data_bytes {
            return Err(format!(
                "回放文件在扫描后发生变化：期望 {} 字节，实际 {} 字节",
                summary.data_bytes, self.data_bytes_read
            ));
        }

        let valid_end = match self.reader.next() {
            Some(Ok(CaptureItem::Footer(_))) => summary.complete,
            Some(Err(CaptureReadError::Truncated(_))) => !summary.complete,
            Some(Ok(CaptureItem::Record(_))) => false,
            Some(Err(error)) => return Err(error.to_string()),
            None => false,
        };
        if !valid_end {
            return Err("回放文件在扫描后发生变化：结束状态不一致".to_owned());
        }
        self.end_verified = true;
        Ok(())
    }
}

#[derive(Default)]
struct BatchAccumulator {
    start_us: Option<u64>,
    end_us: u64,
    payload_bytes: usize,
    record_count: usize,
}

impl BatchAccumulator {
    fn accepts(&self, record: &CaptureRecord) -> bool {
        if self.record_count == 0 {
            return record.payload.len() <= MAX_BATCH_PAYLOAD_BYTES;
        }
        let Some(start_us) = self.start_us else {
            return false;
        };
        self.record_count < MAX_BATCH_RECORDS
            && self
                .payload_bytes
                .checked_add(record.payload.len())
                .map(|bytes| bytes <= MAX_BATCH_PAYLOAD_BYTES)
                .unwrap_or(false)
            && record.timestamp_us.saturating_sub(start_us) <= MAX_BATCH_SPAN_US
    }

    fn push(&mut self, record: &CaptureRecord) {
        if self.start_us.is_none() {
            self.start_us = Some(record.timestamp_us);
        }
        self.end_us = record.timestamp_us;
        self.payload_bytes = self.payload_bytes.saturating_add(record.payload.len());
        self.record_count = self.record_count.saturating_add(1);
    }
}

struct PendingBatch {
    start_us: u64,
    end_us: u64,
    data_bytes: u64,
    records: Vec<ReplayBatchRecordPayload>,
}

fn build_next_batch(
    cursor: &mut ReplayCursor,
    summary: &ScanSummary,
) -> Result<Option<PendingBatch>, String> {
    let first = match cursor.lookahead.take() {
        Some(record) => Some(record),
        None => cursor.next_record(summary)?,
    };
    let Some(first) = first else {
        return Ok(None);
    };

    let mut accumulator = BatchAccumulator::default();
    let mut records = Vec::with_capacity(MAX_BATCH_RECORDS);
    accumulator.push(&first);
    records.push(to_batch_record(first));

    while records.len() < MAX_BATCH_RECORDS {
        let Some(record) = cursor.next_record(summary)? else {
            break;
        };
        if !accumulator.accepts(&record) {
            cursor.lookahead = Some(record);
            break;
        }
        accumulator.push(&record);
        records.push(to_batch_record(record));
    }

    Ok(Some(PendingBatch {
        start_us: accumulator.start_us.unwrap_or(0),
        end_us: accumulator.end_us,
        data_bytes: accumulator.payload_bytes as u64,
        records,
    }))
}

fn to_batch_record(record: CaptureRecord) -> ReplayBatchRecordPayload {
    ReplayBatchRecordPayload {
        direction: match record.direction {
            CaptureDirection::Rx => "rx".to_owned(),
            CaptureDirection::Tx => "tx".to_owned(),
        },
        timestamp_us: record.timestamp_us,
        data: record.payload,
    }
}

struct PlaybackAnchor {
    instant: Instant,
    capture_us: u64,
}

struct ReplayRuntime {
    app: AppHandle,
    core: Arc<ReplayCore>,
    session_id: u64,
    path: PathBuf,
    header: CaptureHeader,
    summary: ScanSummary,
    control_receiver: mpsc::Receiver<ControlCommand>,
    ack_receiver: mpsc::Receiver<ReplayAck>,
    shutdown: Arc<AtomicBool>,
    mode: ReplayStatus,
    generation: u64,
    next_sequence: u64,
    position_us: u64,
    cursor: Option<ReplayCursor>,
    pending_batch: Option<PendingBatch>,
    waiting_start_ack: bool,
    anchor: Option<PlaybackAnchor>,
    last_position_event: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RuntimeControl {
    Continue,
    Exit,
}

impl ReplayRuntime {
    #[allow(clippy::too_many_arguments)]
    fn new(
        app: AppHandle,
        core: Arc<ReplayCore>,
        session_id: u64,
        path: PathBuf,
        header: CaptureHeader,
        summary: ScanSummary,
        control_receiver: mpsc::Receiver<ControlCommand>,
        ack_receiver: mpsc::Receiver<ReplayAck>,
        shutdown: Arc<AtomicBool>,
    ) -> Self {
        Self {
            app,
            core,
            session_id,
            path,
            header,
            summary,
            control_receiver,
            ack_receiver,
            shutdown,
            mode: ReplayStatus::Ready,
            generation: 0,
            next_sequence: 1,
            position_us: 0,
            cursor: None,
            pending_batch: None,
            waiting_start_ack: false,
            anchor: None,
            last_position_event: Instant::now(),
        }
    }

    fn run(mut self) -> Result<(), String> {
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                self.publish_closed(None)?;
                return Ok(());
            }

            if self.mode != ReplayStatus::Playing {
                match self.control_receiver.recv_timeout(IDLE_POLL_INTERVAL) {
                    Ok(command) => {
                        if matches!(self.handle_control(command)?, RuntimeControl::Exit) {
                            return Ok(());
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => self.drain_stale_acks(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("回放控制通道意外关闭".to_owned())
                    }
                }
                continue;
            }

            if self.waiting_start_ack {
                if matches!(self.wait_for_start_ack()?, RuntimeControl::Exit) {
                    return Ok(());
                }
                continue;
            }

            if self.pending_batch.is_none() {
                self.ensure_cursor()?;
                let cursor = self
                    .cursor
                    .as_mut()
                    .ok_or_else(|| "播放游标未能创建".to_owned())?;
                let batch = build_next_batch(cursor, &self.summary)?;
                let Some(batch) = batch else {
                    self.publish_completed()?;
                    continue;
                };
                self.pending_batch = Some(batch);
            }

            if matches!(self.wait_for_batch_time()?, RuntimeControl::Exit) {
                return Ok(());
            }
            if self.mode != ReplayStatus::Playing || self.waiting_start_ack {
                continue;
            }
            self.emit_pending_batch()?;
            if matches!(self.wait_for_batch_ack()?, RuntimeControl::Exit) {
                return Ok(());
            }
        }
    }

    fn ensure_cursor(&mut self) -> Result<(), String> {
        if self.cursor.is_none() {
            self.cursor = Some(ReplayCursor::open(&self.path, &self.header)?);
        }
        Ok(())
    }

    fn wait_for_start_ack(&mut self) -> Result<RuntimeControl, String> {
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                self.publish_closed(None)?;
                return Ok(RuntimeControl::Exit);
            }
            match self.control_receiver.try_recv() {
                Ok(command) => {
                    let result = self.handle_control(command)?;
                    if result == RuntimeControl::Exit || self.mode != ReplayStatus::Playing {
                        return Ok(result);
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("回放控制通道意外关闭".to_owned())
                }
            }

            match self.ack_receiver.recv_timeout(WORKER_POLL_INTERVAL) {
                Ok(ack) if ack.matches(self.session_id, self.generation, 0) => {
                    self.waiting_start_ack = false;
                    self.anchor = Some(PlaybackAnchor {
                        instant: Instant::now(),
                        capture_us: self.position_us,
                    });
                    return Ok(RuntimeControl::Continue);
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("回放 ACK 通道意外关闭".to_owned())
                }
            }
        }
    }

    fn wait_for_batch_time(&mut self) -> Result<RuntimeControl, String> {
        let batch_end_us = self
            .pending_batch
            .as_ref()
            .map(|batch| batch.end_us)
            .ok_or_else(|| "回放批次不存在".to_owned())?;
        let anchor = self
            .anchor
            .as_ref()
            .ok_or_else(|| "回放时钟尚未启动".to_owned())?;
        let delay_us = batch_end_us
            .checked_sub(anchor.capture_us)
            .ok_or_else(|| "回放批次时间早于当前游标".to_owned())?;
        let target = anchor
            .instant
            .checked_add(Duration::from_micros(delay_us))
            .ok_or_else(|| "回放时间戳超出单调时钟范围".to_owned())?;

        loop {
            if self.shutdown.load(Ordering::Acquire) {
                self.publish_closed(None)?;
                return Ok(RuntimeControl::Exit);
            }
            let now = Instant::now();
            if now >= target {
                return Ok(RuntimeControl::Continue);
            }
            let timeout = target.duration_since(now).min(WORKER_POLL_INTERVAL);
            match self.control_receiver.recv_timeout(timeout) {
                Ok(command) => {
                    let result = self.handle_control(command)?;
                    if result == RuntimeControl::Exit || self.mode != ReplayStatus::Playing {
                        return Ok(result);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => self.drain_stale_acks(),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("回放控制通道意外关闭".to_owned())
                }
            }
        }
    }

    fn emit_pending_batch(&self) -> Result<(), String> {
        let batch = self
            .pending_batch
            .as_ref()
            .ok_or_else(|| "回放批次不存在".to_owned())?;
        let payload = ReplayBatchPayload {
            session_id: self.session_id,
            generation: self.generation,
            sequence: self.next_sequence,
            start_us: batch.start_us,
            end_us: batch.end_us,
            data_bytes: batch.data_bytes,
            records: &batch.records,
        };
        self.app
            .emit("replay://batch", payload)
            .map_err(|error| format!("发送回放批次失败: {error}"))
    }

    fn wait_for_batch_ack(&mut self) -> Result<RuntimeControl, String> {
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                self.publish_closed(None)?;
                return Ok(RuntimeControl::Exit);
            }
            match self.control_receiver.try_recv() {
                Ok(command) => {
                    let result = self.handle_control(command)?;
                    if result == RuntimeControl::Exit || self.mode != ReplayStatus::Playing {
                        return Ok(result);
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("回放控制通道意外关闭".to_owned())
                }
            }

            match self.ack_receiver.recv_timeout(WORKER_POLL_INTERVAL) {
                Ok(ack) if ack.matches(self.session_id, self.generation, self.next_sequence) => {
                    let batch = self
                        .pending_batch
                        .take()
                        .ok_or_else(|| "回放批次不存在".to_owned())?;
                    self.position_us = batch.end_us;
                    self.next_sequence = self
                        .next_sequence
                        .checked_add(1)
                        .ok_or_else(|| "回放批次序号已耗尽".to_owned())?;
                    let should_emit = self.last_position_event.elapsed() >= POSITION_EVENT_INTERVAL;
                    self.core.update_position(
                        &self.app,
                        self.session_id,
                        self.position_us,
                        should_emit,
                    )?;
                    if should_emit {
                        self.last_position_event = Instant::now();
                    }
                    return Ok(RuntimeControl::Continue);
                }
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("回放 ACK 通道意外关闭".to_owned())
                }
            }
        }
    }

    fn handle_control(&mut self, command: ControlCommand) -> Result<RuntimeControl, String> {
        if command.session_id != self.session_id {
            reply_control(command, Err("回放会话已变化".to_owned()));
            return Ok(RuntimeControl::Continue);
        }
        if !control_generation_matches(self.generation, command.generation) {
            reply_control(command, Err("回放代次已变化".to_owned()));
            return Ok(RuntimeControl::Continue);
        }

        match command.kind {
            ControlKind::Play => self.handle_play(command),
            ControlKind::Pause => self.handle_pause(command),
            ControlKind::Stop => self.handle_stop(command),
            ControlKind::Close => self.handle_close(command),
        }
    }

    fn handle_play(&mut self, command: ControlCommand) -> Result<RuntimeControl, String> {
        if self.mode == ReplayStatus::Playing {
            let snapshot = self
                .core
                .shared
                .lock()
                .map_err(|_| "回放状态锁已损坏".to_owned())?
                .snapshot();
            reply_control(command, Ok(snapshot));
            return Ok(RuntimeControl::Continue);
        }
        if !matches!(
            self.mode,
            ReplayStatus::Ready | ReplayStatus::Paused | ReplayStatus::Completed
        ) {
            reply_control(command, Err("当前回放状态无法开始播放".to_owned()));
            return Ok(RuntimeControl::Continue);
        }
        if self.mode == ReplayStatus::Completed {
            self.cursor = None;
            self.pending_batch = None;
            self.position_us = 0;
        }

        self.generation = next_generation(self.generation);
        self.next_sequence = 1;
        self.waiting_start_ack = true;
        self.anchor = None;
        self.mode = ReplayStatus::Playing;
        let generation = self.generation;
        let position_us = self.position_us;
        let message = self.summary.message.clone();
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Playing;
                shared.generation = generation;
                shared.position_us = position_us;
                shared.message = message;
                Ok(())
            });
        reply_transition(command, result)?;
        Ok(RuntimeControl::Continue)
    }

    fn handle_pause(&mut self, command: ControlCommand) -> Result<RuntimeControl, String> {
        if self.mode != ReplayStatus::Playing {
            let snapshot = self
                .core
                .shared
                .lock()
                .map_err(|_| "回放状态锁已损坏".to_owned())?
                .snapshot();
            reply_control(command, Ok(snapshot));
            return Ok(RuntimeControl::Continue);
        }

        self.generation = next_generation(self.generation);
        self.waiting_start_ack = false;
        self.anchor = None;
        self.mode = ReplayStatus::Paused;
        let generation = self.generation;
        let position_us = self.position_us;
        let message = self.summary.message.clone();
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Paused;
                shared.generation = generation;
                shared.position_us = position_us;
                shared.message = message;
                Ok(())
            });
        reply_transition(command, result)?;
        Ok(RuntimeControl::Continue)
    }

    fn handle_stop(&mut self, command: ControlCommand) -> Result<RuntimeControl, String> {
        if self.mode == ReplayStatus::Ready {
            let snapshot = self
                .core
                .shared
                .lock()
                .map_err(|_| "回放状态锁已损坏".to_owned())?
                .snapshot();
            reply_control(command, Ok(snapshot));
            return Ok(RuntimeControl::Continue);
        }

        self.generation = next_generation(self.generation);
        self.waiting_start_ack = false;
        self.anchor = None;
        self.mode = ReplayStatus::Stopping;
        let generation = self.generation;
        if let Err(message) =
            self.core
                .publish_transition(&self.app, self.session_id, move |shared| {
                    shared.status = ReplayStatus::Stopping;
                    shared.generation = generation;
                    Ok(())
                })
        {
            reply_control(command, Err(message.clone()));
            return Err(message);
        }

        self.cursor = None;
        self.pending_batch = None;
        self.position_us = 0;
        self.mode = ReplayStatus::Ready;
        let message = self.summary.message.clone();
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Ready;
                shared.position_us = 0;
                shared.message = message;
                Ok(())
            });
        reply_transition(command, result)?;
        Ok(RuntimeControl::Continue)
    }

    fn handle_close(&mut self, command: ControlCommand) -> Result<RuntimeControl, String> {
        self.publish_closed(Some(command))?;
        Ok(RuntimeControl::Exit)
    }

    fn publish_completed(&mut self) -> Result<(), String> {
        self.mode = ReplayStatus::Completed;
        self.position_us = self.summary.duration_us;
        self.cursor = None;
        self.pending_batch = None;
        self.anchor = None;
        self.waiting_start_ack = false;
        let position_us = self.position_us;
        let message = self.summary.message.clone();
        self.core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Completed;
                shared.position_us = position_us;
                shared.message = message;
                Ok(())
            })?;
        Ok(())
    }

    fn publish_closed(&mut self, command: Option<ControlCommand>) -> Result<(), String> {
        self.generation = next_generation(self.generation);
        self.mode = ReplayStatus::Idle;
        self.cursor = None;
        self.pending_batch = None;
        self.anchor = None;
        self.waiting_start_ack = false;
        let generation = self.generation;
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Idle;
                shared.generation = generation;
                shared.path.clear();
                shared.header = None;
                shared.complete = false;
                shared.position_us = 0;
                shared.duration_us = 0;
                shared.data_bytes = 0;
                shared.record_count = 0;
                shared.message = None;
                Ok(())
            });
        if let Some(command) = command {
            reply_control(command, result.clone());
        }
        result.map(|_| ())
    }

    fn drain_stale_acks(&self) {
        while self.ack_receiver.try_recv().is_ok() {}
    }
}

fn next_generation(generation: u64) -> u64 {
    generation.wrapping_add(1).max(1)
}

fn emit_state(app: &AppHandle, payload: ReplayStatePayload) {
    let _ = app.emit("replay://state", payload);
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

    fn record(timestamp_us: u64, payload_size: usize) -> CaptureRecord {
        CaptureRecord {
            direction: CaptureDirection::Rx,
            timestamp_us,
            payload: vec![0; payload_size],
        }
    }

    #[test]
    fn scan_accepts_equal_timestamps_and_rejects_regression() {
        let mut accumulator = ScanAccumulator::default();
        accumulator.observe(&record(10, 2)).unwrap();
        accumulator.observe(&record(10, 3)).unwrap();

        let error = accumulator.observe(&record(9, 1)).unwrap_err();
        assert!(error.contains("回退"));
        assert_eq!(accumulator.stats.data_bytes(), 5);
        assert_eq!(accumulator.stats.record_count(), 2);
    }

    #[test]
    fn incomplete_scan_summary_keeps_verified_prefix() {
        let mut accumulator = ScanAccumulator::default();
        accumulator.observe(&record(20, 4)).unwrap();
        accumulator.observe(&record(35, 6)).unwrap();
        let summary = accumulator.finish(false, Some("文件不完整".to_owned()));

        assert!(!summary.complete);
        assert_eq!(summary.duration_us, 35);
        assert_eq!(summary.data_bytes, 10);
        assert_eq!(summary.record_count, 2);
        assert_eq!(summary.message.as_deref(), Some("文件不完整"));
    }

    #[test]
    fn batch_limits_payload_record_count_and_capture_span() {
        let mut payload_batch = BatchAccumulator::default();
        payload_batch.push(&record(0, MAX_BATCH_PAYLOAD_BYTES - 1));
        assert!(payload_batch.accepts(&record(1, 1)));
        assert!(!payload_batch.accepts(&record(1, 2)));

        let mut span_batch = BatchAccumulator::default();
        span_batch.push(&record(100, 1));
        assert!(span_batch.accepts(&record(100 + MAX_BATCH_SPAN_US, 1)));
        assert!(!span_batch.accepts(&record(101 + MAX_BATCH_SPAN_US, 1)));

        let mut count_batch = BatchAccumulator::default();
        for _ in 0..MAX_BATCH_RECORDS {
            count_batch.push(&record(0, 0));
        }
        assert!(!count_batch.accepts(&record(0, 0)));
    }

    #[test]
    fn ack_barrier_rejects_stale_generation_and_sequence() {
        let ack = ReplayAck {
            session_id: 7,
            generation: 3,
            sequence: 11,
        };

        assert!(ack.matches(7, 3, 11));
        assert!(!ack.matches(6, 3, 11));
        assert!(!ack.matches(7, 2, 11));
        assert!(!ack.matches(7, 3, 10));
    }

    #[test]
    fn sequence_zero_is_reserved_for_generation_start_ack() {
        let start_ack = ReplayAck {
            session_id: 2,
            generation: 9,
            sequence: 0,
        };
        let first_batch_ack = ReplayAck {
            sequence: 1,
            ..start_ack
        };

        assert!(start_ack.matches(2, 9, 0));
        assert!(!first_batch_ack.matches(2, 9, 0));
        assert!(first_batch_ack.matches(2, 9, 1));
    }

    #[test]
    fn generation_never_uses_zero_even_after_wrap() {
        assert_eq!(next_generation(0), 1);
        assert_eq!(next_generation(8), 9);
        assert_eq!(next_generation(u64::MAX), 1);
    }

    #[test]
    fn generation_guard_accepts_current_or_unscoped_control_only() {
        assert!(control_generation_matches(4, Some(4)));
        assert!(control_generation_matches(4, None));
        assert!(!control_generation_matches(4, Some(3)));
        assert!(!control_generation_matches(4, Some(5)));
    }

    #[test]
    fn idle_state_omits_optional_payload_fields() {
        let json = serde_json::to_value(SharedReplayState::default().snapshot()).unwrap();

        assert!(json.get("header").is_none());
        assert!(json.get("message").is_none());
        assert_eq!(
            json.get("complete").and_then(|value| value.as_bool()),
            Some(false)
        );
    }
}
