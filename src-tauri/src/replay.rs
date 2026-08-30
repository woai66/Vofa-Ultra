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
    CaptureDirection, CaptureHeader, CaptureItem, CaptureMarker, CaptureMarkerColor,
    CaptureReadError, CaptureReader, CaptureRecord, CaptureRecordStats,
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
const REPLAY_INDEX_MEMORY_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const REPLAY_INDEX_MAX_CHECKPOINTS: usize =
    REPLAY_INDEX_MEMORY_LIMIT_BYTES / std::mem::size_of::<ReplayCheckpoint>();
const JUSTFLOAT_TAIL: [u8; 4] = [0x00, 0x00, 0x80, 0x7f];
const JUSTFLOAT_TAIL_FAILURE: [usize; 4] = [0, 1, 0, 0];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ReplaySpeed {
    Quarter,
    Half,
    #[default]
    Normal,
    Double,
    Quadruple,
}

impl ReplaySpeed {
    fn parse(value: f64) -> Result<Self, String> {
        if !value.is_finite() {
            return Err("回放倍速必须是有限值".to_owned());
        }

        if value == 0.25 {
            Ok(Self::Quarter)
        } else if value == 0.5 {
            Ok(Self::Half)
        } else if value == 1.0 {
            Ok(Self::Normal)
        } else if value == 2.0 {
            Ok(Self::Double)
        } else if value == 4.0 {
            Ok(Self::Quadruple)
        } else {
            Err("回放倍速仅支持 0.25×、0.5×、1×、2× 或 4×".to_owned())
        }
    }

    fn as_f64(self) -> f64 {
        match self {
            Self::Quarter => 0.25,
            Self::Half => 0.5,
            Self::Normal => 1.0,
            Self::Double => 2.0,
            Self::Quadruple => 4.0,
        }
    }

    fn quarter_units(self) -> u64 {
        match self {
            Self::Quarter => 1,
            Self::Half => 2,
            Self::Normal => 4,
            Self::Double => 8,
            Self::Quadruple => 16,
        }
    }
}

fn scaled_wall_duration(capture_us: u64, speed: ReplaySpeed) -> Duration {
    let total_nanoseconds = u128::from(capture_us) * 4_000 / u128::from(speed.quarter_units());
    let seconds = (total_nanoseconds / 1_000_000_000) as u64;
    let nanoseconds = (total_nanoseconds % 1_000_000_000) as u32;
    Duration::new(seconds, nanoseconds)
}

fn scaled_capture_elapsed(wall_elapsed: Duration, speed: ReplaySpeed) -> u64 {
    let capture_us = wall_elapsed
        .as_nanos()
        .saturating_mul(u128::from(speed.quarter_units()))
        / 4_000;
    u64::try_from(capture_us).unwrap_or(u64::MAX)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatePayload {
    status: String,
    session_id: u64,
    generation: u64,
    timeline_revision: u64,
    revision: u64,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    header: Option<CaptureHeader>,
    format_version: u16,
    complete: bool,
    speed: f64,
    position_us: u64,
    duration_us: u64,
    data_bytes: u64,
    record_count: u64,
    marker_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayMarkerPayload {
    index: u64,
    timestamp_us: u64,
    label: String,
    color: CaptureMarkerColor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMarkersPayload {
    session_id: u64,
    markers: Vec<ReplayMarkerPayload>,
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
    timeline_revision: u64,
    revision: u64,
    path: String,
    header: Option<CaptureHeader>,
    format_version: u16,
    complete: bool,
    speed: ReplaySpeed,
    position_us: u64,
    duration_us: u64,
    data_bytes: u64,
    record_count: u64,
    marker_count: u64,
    markers: Vec<ReplayMarkerPayload>,
    message: Option<String>,
    worker: Option<ReplayWorkerHandle>,
}

impl Default for SharedReplayState {
    fn default() -> Self {
        Self {
            status: ReplayStatus::Idle,
            session_id: 0,
            generation: 0,
            timeline_revision: 0,
            revision: 0,
            path: String::new(),
            header: None,
            format_version: 0,
            complete: false,
            speed: ReplaySpeed::default(),
            position_us: 0,
            duration_us: 0,
            data_bytes: 0,
            record_count: 0,
            marker_count: 0,
            markers: Vec::new(),
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
            timeline_revision: self.timeline_revision,
            revision: self.revision,
            path: self.path.clone(),
            header: self.header.clone(),
            format_version: self.format_version,
            complete: self.complete,
            speed: self.speed.as_f64(),
            position_us: self.position_us,
            duration_us: self.duration_us,
            data_bytes: self.data_bytes,
            record_count: self.record_count,
            marker_count: self.marker_count,
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
        self.timeline_revision = 0;
        self.path.clear();
        self.header = None;
        self.format_version = 0;
        self.complete = false;
        self.speed = ReplaySpeed::default();
        self.position_us = 0;
        self.duration_us = 0;
        self.data_bytes = 0;
        self.record_count = 0;
        self.marker_count = 0;
        self.markers.clear();
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
    Seeking,
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
            Self::Seeking => "seeking",
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
    Seek { target_us: u64 },
    SetSpeed { speed: ReplaySpeed },
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
pub fn get_replay_markers(
    state: State<'_, ReplayState>,
    session_id: u64,
) -> Result<ReplayMarkersPayload, String> {
    let shared = state
        .core
        .shared
        .lock()
        .map_err(|_| "回放状态锁已损坏".to_owned())?;
    if shared.session_id != session_id || shared.status == ReplayStatus::Idle {
        return Err("回放会话已变化".to_owned());
    }
    Ok(ReplayMarkersPayload {
        session_id,
        markers: shared.markers.clone(),
    })
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
        format_version,
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
                    format_version,
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
        shared.timeline_revision = 0;
        shared.path = path_text;
        shared.header = Some(header);
        shared.format_version = format_version;
        shared.complete = false;
        shared.speed = ReplaySpeed::default();
        shared.position_us = 0;
        shared.duration_us = 0;
        shared.data_bytes = 0;
        shared.record_count = 0;
        shared.marker_count = 0;
        shared.markers.clear();
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
    generation: u64,
) -> Result<ReplayStatePayload, String> {
    request_control(
        &app,
        &state,
        session_id,
        Some(generation),
        ControlKind::Play,
    )
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
pub fn seek_replay(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
    generation: u64,
    target_us: u64,
) -> Result<ReplayStatePayload, String> {
    request_control(
        &app,
        &state,
        session_id,
        Some(generation),
        ControlKind::Seek { target_us },
    )
}

#[tauri::command]
pub fn set_replay_speed(
    app: AppHandle,
    state: State<'_, ReplayState>,
    session_id: u64,
    generation: u64,
    speed: f64,
) -> Result<ReplayStatePayload, String> {
    let speed = ReplaySpeed::parse(speed)?;
    request_control(
        &app,
        &state,
        session_id,
        Some(generation),
        ControlKind::SetSpeed { speed },
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
    format_version: u16,
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
    let format_version = reader.version();
    let header = reader.header().clone();

    Ok(ReplayCandidate {
        path: path_buf,
        path_text: path.to_owned(),
        header,
        format_version,
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
        ControlKind::Seek { .. } => "定位",
        ControlKind::SetSpeed { .. } => "调整倍速",
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
            shared.marker_count = accumulator.stats.marker_count();
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
        markers: &[ReplayMarkerPayload],
    ) -> Result<ReplayStatePayload, String> {
        let payload = self.publish_transition(app, session_id, |shared| {
            shared.status = ReplayStatus::Ready;
            shared.complete = summary.complete;
            shared.position_us = 0;
            shared.duration_us = summary.duration_us;
            shared.data_bytes = summary.data_bytes;
            shared.record_count = summary.record_count;
            shared.marker_count = summary.marker_count;
            shared.markers = markers.to_vec();
            shared.message = summary.message.clone();
            Ok(())
        })?;
        emit_markers(
            app,
            ReplayMarkersPayload {
                session_id,
                markers: markers.to_vec(),
            },
        );
        Ok(payload)
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
            shared.timeline_revision = 0;
            shared.path = path;
            shared.header = None;
            shared.format_version = 0;
            shared.complete = false;
            shared.speed = ReplaySpeed::default();
            shared.position_us = 0;
            shared.duration_us = 0;
            shared.data_bytes = 0;
            shared.record_count = 0;
            shared.marker_count = 0;
            shared.markers.clear();
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
    format_version: u16,
    complete: bool,
    duration_us: u64,
    data_bytes: u64,
    record_count: u64,
    marker_count: u64,
    message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReplayCheckpoint {
    position_us: u64,
    file_offset: u64,
    record_count: u64,
    data_bytes: u64,
    marker_count: u64,
}

struct ReplayIndex {
    checkpoints: Vec<ReplayCheckpoint>,
    stride_records: u64,
    checkpoint_scanner: Option<ProtocolBoundaryScanner>,
}

impl ReplayIndex {
    fn new(origin_file_offset: u64, protocol: &str) -> Self {
        let mut checkpoints = Vec::with_capacity(REPLAY_INDEX_MAX_CHECKPOINTS);
        checkpoints.push(ReplayCheckpoint {
            position_us: 0,
            file_offset: origin_file_offset,
            record_count: 0,
            data_bytes: 0,
            marker_count: 0,
        });
        Self {
            checkpoints,
            stride_records: 1,
            checkpoint_scanner: match replay_seek_mode(protocol) {
                Some(mode @ ReplaySeekMode::FireWater) | Some(mode @ ReplaySeekMode::JustFloat) => {
                    Some(ProtocolBoundaryScanner::new(mode, true))
                }
                _ => None,
            },
        }
    }

    fn observe(
        &mut self,
        record: &CaptureRecord,
        file_offset: u64,
        record_count: u64,
        data_bytes: u64,
        marker_count: u64,
    ) {
        if let Some(scanner) = &mut self.checkpoint_scanner {
            if record.direction == CaptureDirection::Rx {
                scanner.find_boundary(&record.payload, false);
            }
            if !scanner.at_boundary() {
                return;
            }
        }
        if !record_count.is_multiple_of(self.stride_records) {
            return;
        }
        if self.checkpoints.len() == REPLAY_INDEX_MAX_CHECKPOINTS {
            self.compact();
        }
        if record_count.is_multiple_of(self.stride_records) {
            self.checkpoints.push(ReplayCheckpoint {
                position_us: record.timestamp_us,
                file_offset,
                record_count,
                data_bytes,
                marker_count,
            });
        }
    }

    fn checkpoint_before(&self, target_us: u64) -> ReplayCheckpoint {
        let checkpoint_count = self.checkpoints.partition_point(|checkpoint| {
            checkpoint.record_count == 0 || checkpoint.position_us < target_us
        });
        self.checkpoints[checkpoint_count.saturating_sub(1)]
    }

    fn compact(&mut self) {
        let previous_len = self.checkpoints.len();
        let mut write_index = 1;
        for read_index in (2..previous_len).step_by(2) {
            self.checkpoints[write_index] = self.checkpoints[read_index];
            write_index += 1;
        }
        self.checkpoints.truncate(write_index);
        self.stride_records = self.stride_records.saturating_mul(2).max(1);
    }
}

#[derive(Default)]
struct ScanAccumulator {
    stats: CaptureRecordStats,
    markers: Vec<ReplayMarkerPayload>,
}

impl ScanAccumulator {
    fn observe(&mut self, record: &CaptureRecord) -> Result<(), String> {
        self.stats.observe(record)
    }

    fn observe_marker(&mut self, marker: &CaptureMarker) -> Result<(), String> {
        self.stats.observe_marker(marker)?;
        self.markers.push(ReplayMarkerPayload {
            index: self.stats.marker_count(),
            timestamp_us: marker.timestamp_us,
            label: marker.label.clone(),
            color: marker.color,
        });
        Ok(())
    }

    fn duration_us(&self) -> u64 {
        self.stats.duration_us()
    }

    fn finish(
        self,
        format_version: u16,
        complete: bool,
        message: Option<String>,
    ) -> (ScanSummary, Vec<ReplayMarkerPayload>) {
        let summary = ScanSummary {
            format_version,
            complete,
            duration_us: self.stats.duration_us(),
            data_bytes: self.stats.data_bytes(),
            record_count: self.stats.record_count(),
            marker_count: self.stats.marker_count(),
            message,
        };
        (summary, self.markers)
    }
}

enum ScanResult {
    Ready {
        summary: ScanSummary,
        index: ReplayIndex,
        markers: Vec<ReplayMarkerPayload>,
    },
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
    format_version: u16,
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

    let (summary, index, markers) = match scan_result {
        ScanResult::Ready {
            summary,
            index,
            markers,
        } => (summary, index, markers),
        ScanResult::Closed => return,
        ScanResult::Failed(message) => {
            core.publish_worker_error(&app, session_id, message);
            return;
        }
    };
    if summary.format_version != format_version {
        core.publish_worker_error(&app, session_id, "回放扫描版本与打开版本不一致".to_owned());
        return;
    }
    if let Err(message) = core.publish_ready(&app, session_id, &summary, &markers) {
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
        index,
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
    let format_version = reader.version();
    let origin_file_offset = match reader.stream_position() {
        Ok(file_offset) => file_offset,
        Err(error) => return ScanResult::Failed(error.to_string()),
    };
    let mut index = ReplayIndex::new(origin_file_offset, &reader.header().protocol);
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
                let file_offset = match reader.stream_position() {
                    Ok(file_offset) => file_offset,
                    Err(error) => return ScanResult::Failed(error.to_string()),
                };
                index.observe(
                    &record,
                    file_offset,
                    accumulator.stats.record_count(),
                    accumulator.stats.data_bytes(),
                    accumulator.stats.marker_count(),
                );
                if last_progress.elapsed() >= SCAN_PROGRESS_INTERVAL {
                    core.publish_scan_progress(app, session_id, &accumulator);
                    last_progress = Instant::now();
                }
            }
            Some(Ok(CaptureItem::Marker(marker))) => {
                if let Err(message) = accumulator.observe_marker(&marker) {
                    return ScanResult::Failed(message);
                }
                if last_progress.elapsed() >= SCAN_PROGRESS_INTERVAL {
                    core.publish_scan_progress(app, session_id, &accumulator);
                    last_progress = Instant::now();
                }
            }
            Some(Ok(CaptureItem::Footer(_))) => {
                let (summary, markers) = accumulator.finish(format_version, true, None);
                return ScanResult::Ready {
                    summary,
                    index,
                    markers,
                };
            }
            Some(Err(error @ CaptureReadError::Truncated(_))) => {
                let message = format!("捕获文件未正常结束，将回放已验证的完整记录前缀（{error}）");
                let (summary, markers) = accumulator.finish(format_version, false, Some(message));
                return ScanResult::Ready {
                    summary,
                    index,
                    markers,
                };
            }
            Some(Err(error)) => return ScanResult::Failed(error.to_string()),
            None => {
                let message = "捕获文件缺少结束标记，将回放已验证的完整记录前缀".to_owned();
                let (summary, markers) = accumulator.finish(format_version, false, Some(message));
                return ScanResult::Ready {
                    summary,
                    index,
                    markers,
                };
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
    markers_read: u64,
    end_verified: bool,
}

enum SeekLocation {
    Positioned {
        cursor: Box<ReplayCursor>,
        position_us: u64,
    },
    Completed {
        position_us: u64,
    },
    Interrupted(RuntimeControl),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReplaySeekMode {
    Record,
    FireWater,
    JustFloat,
}

fn replay_seek_mode(protocol: &str) -> Option<ReplaySeekMode> {
    match protocol {
        "raw" => Some(ReplaySeekMode::Record),
        "firewater" => Some(ReplaySeekMode::FireWater),
        "justfloat" => Some(ReplaySeekMode::JustFloat),
        _ => None,
    }
}

struct ProtocolBoundaryScanner {
    mode: ReplaySeekMode,
    matched_tail_bytes: usize,
    justfloat_bytes_since_boundary: usize,
    justfloat_pending_boundary_at: Option<usize>,
    at_boundary: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JustFloatObservation {
    None,
    PendingCandidate,
    CurrentBoundary,
    PendingBoundary,
}

impl ProtocolBoundaryScanner {
    fn new(mode: ReplaySeekMode, starts_at_stream_origin: bool) -> Self {
        Self {
            mode,
            matched_tail_bytes: 0,
            justfloat_bytes_since_boundary: 0,
            justfloat_pending_boundary_at: None,
            at_boundary: starts_at_stream_origin,
        }
    }

    fn at_boundary(&self) -> bool {
        self.at_boundary
    }

    fn find_boundary(&mut self, payload: &[u8], accept_boundary: bool) -> Option<usize> {
        let mut pending_boundary_offset =
            self.justfloat_pending_boundary_at
                .and_then(|pending_boundary_at| {
                    (pending_boundary_at == self.justfloat_bytes_since_boundary).then_some(0)
                });
        for (index, byte) in payload.iter().copied().enumerate() {
            self.at_boundary = false;
            let boundary_offset = match self.mode {
                ReplaySeekMode::FireWater => (byte == b'\n').then_some(index + 1),
                ReplaySeekMode::JustFloat => match self.observe_justfloat_byte(byte) {
                    JustFloatObservation::None => None,
                    JustFloatObservation::PendingCandidate => {
                        pending_boundary_offset = Some(index + 1);
                        None
                    }
                    JustFloatObservation::CurrentBoundary => {
                        pending_boundary_offset = None;
                        Some(index + 1)
                    }
                    JustFloatObservation::PendingBoundary => {
                        let offset = pending_boundary_offset.unwrap_or(index + 1);
                        pending_boundary_offset = None;
                        Some(offset)
                    }
                },
                ReplaySeekMode::Record => None,
            };
            if let Some(boundary_offset) = boundary_offset {
                self.at_boundary = true;
                if accept_boundary {
                    return Some(boundary_offset);
                }
            }
        }
        None
    }

    fn observe_justfloat_byte(&mut self, byte: u8) -> JustFloatObservation {
        self.justfloat_bytes_since_boundary = self.justfloat_bytes_since_boundary.saturating_add(1);
        while self.matched_tail_bytes > 0 && byte != JUSTFLOAT_TAIL[self.matched_tail_bytes] {
            self.matched_tail_bytes = JUSTFLOAT_TAIL_FAILURE[self.matched_tail_bytes - 1];
        }
        if byte == JUSTFLOAT_TAIL[self.matched_tail_bytes] {
            self.matched_tail_bytes += 1;
        }
        if self.matched_tail_bytes != JUSTFLOAT_TAIL.len() {
            return JustFloatObservation::None;
        }
        self.matched_tail_bytes = 0;
        let current_boundary_at = self.justfloat_bytes_since_boundary;
        let payload_bytes = current_boundary_at.saturating_sub(JUSTFLOAT_TAIL.len());
        if payload_bytes.is_multiple_of(std::mem::size_of::<f32>()) {
            self.justfloat_bytes_since_boundary = 0;
            self.justfloat_pending_boundary_at = None;
            return JustFloatObservation::CurrentBoundary;
        }
        if self
            .justfloat_pending_boundary_at
            .is_some_and(|pending_boundary_at| {
                payload_bytes
                    .saturating_sub(pending_boundary_at)
                    .is_multiple_of(std::mem::size_of::<f32>())
            })
        {
            self.justfloat_bytes_since_boundary = 0;
            self.justfloat_pending_boundary_at = None;
            return JustFloatObservation::PendingBoundary;
        }
        self.justfloat_pending_boundary_at = Some(current_boundary_at);
        JustFloatObservation::PendingCandidate
    }
}

fn locate_replay_cursor<F>(
    path: &Path,
    expected_header: &CaptureHeader,
    summary: &ScanSummary,
    checkpoint: ReplayCheckpoint,
    target_us: u64,
    mut poll_control: F,
) -> Result<SeekLocation, String>
where
    F: FnMut() -> Result<Option<RuntimeControl>, String>,
{
    if let Some(control) = poll_control()? {
        return Ok(SeekLocation::Interrupted(control));
    }

    let mode = replay_seek_mode(&expected_header.protocol)
        .ok_or_else(|| format!("协议 {} 不支持回放定位", expected_header.protocol))?;
    if target_us == 0 && summary.record_count > 0 {
        let mut cursor = ReplayCursor::open(path, expected_header, summary.format_version)?;
        cursor.lookahead = cursor.next_record(summary)?;
        return Ok(SeekLocation::Positioned {
            cursor: Box::new(cursor),
            position_us: 0,
        });
    }

    let mut cursor =
        ReplayCursor::open_at(path, expected_header, summary.format_version, checkpoint)?;
    let at_end = target_us >= summary.duration_us;
    let mut boundary_scanner = ProtocolBoundaryScanner::new(mode, true);
    loop {
        if let Some(control) = poll_control()? {
            return Ok(SeekLocation::Interrupted(control));
        }

        match cursor.next_record(summary)? {
            Some(record) if !at_end && mode == ReplaySeekMode::Record => {
                if record.timestamp_us >= target_us {
                    cursor.lookahead = Some(record);
                    return Ok(SeekLocation::Positioned {
                        cursor: Box::new(cursor),
                        position_us: target_us,
                    });
                }
            }
            Some(mut record) if !at_end => {
                let at_or_after_target = record.timestamp_us >= target_us;
                if at_or_after_target && boundary_scanner.at_boundary() {
                    let position_us = record.timestamp_us;
                    cursor.lookahead = Some(record);
                    return Ok(SeekLocation::Positioned {
                        cursor: Box::new(cursor),
                        position_us,
                    });
                }
                if record.direction == CaptureDirection::Rx {
                    if let Some(payload_offset) =
                        boundary_scanner.find_boundary(&record.payload, at_or_after_target)
                    {
                        let position_us = record.timestamp_us;
                        let remaining_payload = record.payload.split_off(payload_offset);
                        if remaining_payload.is_empty() {
                            if cursor.records_read == summary.record_count
                                && cursor.next_record(summary)?.is_none()
                            {
                                return Ok(SeekLocation::Completed {
                                    position_us: summary.duration_us,
                                });
                            }
                        } else {
                            record.payload = remaining_payload;
                            cursor.lookahead = Some(record);
                        }
                        return Ok(SeekLocation::Positioned {
                            cursor: Box::new(cursor),
                            position_us,
                        });
                    }
                }
            }
            Some(_) => {}
            None => {
                return Ok(SeekLocation::Completed {
                    position_us: summary.duration_us,
                })
            }
        }
    }
}

impl ReplayCursor {
    fn open(
        path: &Path,
        expected_header: &CaptureHeader,
        expected_format_version: u16,
    ) -> Result<Self, String> {
        let file = File::open(path)
            .map_err(|error| format!("重新打开回放文件 {} 失败: {error}", path.display()))?;
        let reader = CaptureReader::new(file).map_err(|error| error.to_string())?;
        if reader.header() != expected_header || reader.version() != expected_format_version {
            return Err("回放文件在扫描后发生变化：文件头或版本不一致".to_owned());
        }
        Ok(Self {
            reader,
            lookahead: None,
            last_timestamp_us: None,
            data_bytes_read: 0,
            records_read: 0,
            markers_read: 0,
            end_verified: false,
        })
    }

    fn open_at(
        path: &Path,
        expected_header: &CaptureHeader,
        expected_format_version: u16,
        checkpoint: ReplayCheckpoint,
    ) -> Result<Self, String> {
        let file = File::open(path)
            .map_err(|error| format!("重新打开回放文件 {} 失败: {error}", path.display()))?;
        let reader = CaptureReader::new(file).map_err(|error| error.to_string())?;
        if reader.header() != expected_header || reader.version() != expected_format_version {
            return Err("回放文件在扫描后发生变化：文件头或版本不一致".to_owned());
        }
        let reader = reader
            .resume_from_verified(
                checkpoint.file_offset,
                checkpoint.data_bytes,
                checkpoint.record_count,
                checkpoint.marker_count,
                (checkpoint.record_count > 0 || checkpoint.marker_count > 0)
                    .then_some(checkpoint.position_us),
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            reader,
            lookahead: None,
            last_timestamp_us: (checkpoint.record_count > 0 || checkpoint.marker_count > 0)
                .then_some(checkpoint.position_us),
            data_bytes_read: checkpoint.data_bytes,
            records_read: checkpoint.record_count,
            markers_read: checkpoint.marker_count,
            end_verified: false,
        })
    }

    fn next_record(&mut self, summary: &ScanSummary) -> Result<Option<CaptureRecord>, String> {
        loop {
            if self.records_read == summary.record_count
                && self.markers_read == summary.marker_count
            {
                self.verify_end(summary)?;
                return Ok(None);
            }
            match self.reader.next() {
                Some(Ok(CaptureItem::Record(record))) => {
                    if self.records_read >= summary.record_count {
                        return Err("回放文件在扫描后发生变化：记录数量增加".to_owned());
                    }
                    self.observe_timestamp(record.timestamp_us)?;
                    self.data_bytes_read = self
                        .data_bytes_read
                        .saturating_add(record.payload.len() as u64);
                    self.records_read = self.records_read.saturating_add(1);
                    return Ok(Some(record));
                }
                Some(Ok(CaptureItem::Marker(marker))) => {
                    if self.markers_read >= summary.marker_count {
                        return Err("回放文件在扫描后发生变化：标记数量增加".to_owned());
                    }
                    self.observe_timestamp(marker.timestamp_us)?;
                    self.markers_read = self.markers_read.saturating_add(1);
                }
                Some(Ok(CaptureItem::Footer(_))) => {
                    return Err("回放文件在扫描后发生变化：时间线提前结束".to_owned())
                }
                Some(Err(error)) => return Err(error.to_string()),
                None => return Err("回放文件在扫描后发生变化：时间线提前结束".to_owned()),
            }
        }
    }

    fn observe_timestamp(&mut self, timestamp_us: u64) -> Result<(), String> {
        if self
            .last_timestamp_us
            .map(|last| timestamp_us < last)
            .unwrap_or(false)
        {
            return Err(format!(
                "回放时间戳从 {} 微秒回退到 {} 微秒",
                self.last_timestamp_us.unwrap_or(0),
                timestamp_us
            ));
        }
        self.last_timestamp_us = Some(timestamp_us);
        Ok(())
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
        if self.records_read != summary.record_count || self.markers_read != summary.marker_count {
            return Err(format!(
                "回放文件在扫描后发生变化：期望 {} 条记录/{} 个标记，实际 {} 条记录/{} 个标记",
                summary.record_count, summary.marker_count, self.records_read, self.markers_read
            ));
        }

        let valid_end = match self.reader.next() {
            Some(Ok(CaptureItem::Footer(_))) => summary.complete,
            Some(Err(CaptureReadError::Truncated(_))) => !summary.complete,
            Some(Ok(CaptureItem::Record(_))) => false,
            Some(Ok(CaptureItem::Marker(_))) => false,
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

fn reanchored_capture_us(
    anchor: &PlaybackAnchor,
    now: Instant,
    speed: ReplaySpeed,
    upper_bound_us: u64,
) -> u64 {
    let wall_elapsed = now
        .checked_duration_since(anchor.instant)
        .unwrap_or_default();
    anchor
        .capture_us
        .saturating_add(scaled_capture_elapsed(wall_elapsed, speed))
        .min(upper_bound_us)
}

fn clear_delivery_for_seek(
    cursor: &mut Option<ReplayCursor>,
    pending_batch: &mut Option<PendingBatch>,
    waiting_start_ack: &mut bool,
    anchor: &mut Option<PlaybackAnchor>,
    next_sequence: &mut u64,
) {
    *cursor = None;
    *pending_batch = None;
    *waiting_start_ack = false;
    *anchor = None;
    *next_sequence = 1;
}

fn clamp_seek_target(target_us: u64, duration_us: u64) -> u64 {
    target_us.min(duration_us)
}

fn seek_protocol_supported(protocol: &str) -> bool {
    replay_seek_mode(protocol).is_some()
}

struct ReplayRuntime {
    app: AppHandle,
    core: Arc<ReplayCore>,
    session_id: u64,
    path: PathBuf,
    header: CaptureHeader,
    summary: ScanSummary,
    index: ReplayIndex,
    control_receiver: mpsc::Receiver<ControlCommand>,
    ack_receiver: mpsc::Receiver<ReplayAck>,
    shutdown: Arc<AtomicBool>,
    mode: ReplayStatus,
    generation: u64,
    timeline_revision: u64,
    next_sequence: u64,
    position_us: u64,
    speed: ReplaySpeed,
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
        index: ReplayIndex,
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
            index,
            control_receiver,
            ack_receiver,
            shutdown,
            mode: ReplayStatus::Ready,
            generation: 0,
            timeline_revision: 0,
            next_sequence: 1,
            position_us: 0,
            speed: ReplaySpeed::default(),
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
            self.cursor = Some(ReplayCursor::open(
                &self.path,
                &self.header,
                self.summary.format_version,
            )?);
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

        loop {
            if self.shutdown.load(Ordering::Acquire) {
                self.publish_closed(None)?;
                return Ok(RuntimeControl::Exit);
            }
            let anchor = self
                .anchor
                .as_ref()
                .ok_or_else(|| "回放时钟尚未启动".to_owned())?;
            let delay_us = batch_end_us
                .checked_sub(anchor.capture_us)
                .ok_or_else(|| "回放批次时间早于当前游标".to_owned())?;
            let target = anchor
                .instant
                .checked_add(scaled_wall_duration(delay_us, self.speed))
                .ok_or_else(|| "回放时间戳超出单调时钟范围".to_owned())?;
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
            ControlKind::Seek { target_us } => self.handle_seek(command, target_us),
            ControlKind::SetSpeed { speed } => self.handle_set_speed(command, speed),
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
            self.timeline_revision = self.timeline_revision.saturating_add(1);
        }

        self.generation = next_generation(self.generation);
        self.next_sequence = 1;
        self.waiting_start_ack = true;
        self.anchor = None;
        self.mode = ReplayStatus::Playing;
        let generation = self.generation;
        let timeline_revision = self.timeline_revision;
        let position_us = self.position_us;
        let message = self.summary.message.clone();
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Playing;
                shared.generation = generation;
                shared.timeline_revision = timeline_revision;
                shared.position_us = position_us;
                shared.message = message;
                Ok(())
            });
        reply_transition(command, result)?;
        Ok(RuntimeControl::Continue)
    }

    fn handle_seek(
        &mut self,
        command: ControlCommand,
        target_us: u64,
    ) -> Result<RuntimeControl, String> {
        if !seek_protocol_supported(&self.header.protocol) {
            reply_control(command, Err("当前协议不支持回放定位".to_owned()));
            return Ok(RuntimeControl::Continue);
        }
        if !matches!(
            self.mode,
            ReplayStatus::Ready | ReplayStatus::Paused | ReplayStatus::Completed
        ) {
            reply_control(
                command,
                Err("当前回放状态无法定位，请先暂停播放".to_owned()),
            );
            return Ok(RuntimeControl::Continue);
        }

        let target_us = clamp_seek_target(target_us, self.summary.duration_us);
        self.generation = next_generation(self.generation);
        clear_delivery_for_seek(
            &mut self.cursor,
            &mut self.pending_batch,
            &mut self.waiting_start_ack,
            &mut self.anchor,
            &mut self.next_sequence,
        );
        self.mode = ReplayStatus::Seeking;
        self.drain_stale_acks();
        let generation = self.generation;
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Seeking;
                shared.generation = generation;
                Ok(())
            });
        reply_transition(command, result)?;
        self.locate_seek(target_us)
    }

    fn locate_seek(&mut self, target_us: u64) -> Result<RuntimeControl, String> {
        let checkpoint = self.index.checkpoint_before(target_us);
        let path = self.path.clone();
        let header = self.header.clone();
        let summary = self.summary.clone();
        let location =
            locate_replay_cursor(&path, &header, &summary, checkpoint, target_us, || {
                self.poll_seek_control()
            })?;
        let (cursor, position_us) = match location {
            SeekLocation::Positioned {
                cursor,
                position_us,
            } => (Some(*cursor), position_us),
            SeekLocation::Completed { position_us } => (None, position_us),
            SeekLocation::Interrupted(control) => return Ok(control),
        };
        if let Some(control) = self.poll_seek_control()? {
            return Ok(control);
        }
        if self.mode != ReplayStatus::Seeking {
            return Ok(RuntimeControl::Continue);
        }

        self.position_us = position_us;
        self.timeline_revision = self.timeline_revision.saturating_add(1);
        self.mode = if cursor.is_none() {
            self.cursor = None;
            ReplayStatus::Completed
        } else {
            self.cursor = cursor;
            ReplayStatus::Paused
        };
        let status = self.mode;
        let position_us = self.position_us;
        let timeline_revision = self.timeline_revision;
        let message = self.summary.message.clone();
        self.core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = status;
                shared.timeline_revision = timeline_revision;
                shared.position_us = position_us;
                shared.message = message;
                Ok(())
            })?;
        Ok(RuntimeControl::Continue)
    }

    fn poll_seek_control(&mut self) -> Result<Option<RuntimeControl>, String> {
        if self.shutdown.load(Ordering::Acquire) {
            self.publish_closed(None)?;
            return Ok(Some(RuntimeControl::Exit));
        }

        loop {
            match self.control_receiver.try_recv() {
                Ok(command) => {
                    let control = self.handle_control(command)?;
                    if control == RuntimeControl::Exit || self.mode != ReplayStatus::Seeking {
                        return Ok(Some(control));
                    }
                }
                Err(mpsc::TryRecvError::Empty) => {
                    self.drain_stale_acks();
                    return Ok(None);
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("回放控制通道意外关闭".to_owned());
                }
            }
        }
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

    fn handle_set_speed(
        &mut self,
        command: ControlCommand,
        speed: ReplaySpeed,
    ) -> Result<RuntimeControl, String> {
        if !matches!(
            self.mode,
            ReplayStatus::Ready
                | ReplayStatus::Playing
                | ReplayStatus::Paused
                | ReplayStatus::Completed
        ) {
            reply_control(command, Err("当前回放状态无法调整倍速".to_owned()));
            return Ok(RuntimeControl::Continue);
        }
        if speed == self.speed {
            let snapshot = self
                .core
                .shared
                .lock()
                .map_err(|_| "回放状态锁已损坏".to_owned())?
                .snapshot();
            reply_control(command, Ok(snapshot));
            return Ok(RuntimeControl::Continue);
        }

        if self.mode == ReplayStatus::Playing {
            if let Some(anchor) = self.anchor.as_ref() {
                let upper_bound_us = self
                    .pending_batch
                    .as_ref()
                    .map(|batch| batch.end_us)
                    .unwrap_or(self.summary.duration_us);
                let now = Instant::now();
                let capture_us = reanchored_capture_us(anchor, now, self.speed, upper_bound_us);
                self.anchor = Some(PlaybackAnchor {
                    instant: now,
                    capture_us,
                });
            }
        }
        self.speed = speed;
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.speed = speed;
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
        self.timeline_revision = self.timeline_revision.saturating_add(1);
        self.mode = ReplayStatus::Ready;
        let timeline_revision = self.timeline_revision;
        let message = self.summary.message.clone();
        let result = self
            .core
            .publish_transition(&self.app, self.session_id, move |shared| {
                shared.status = ReplayStatus::Ready;
                shared.timeline_revision = timeline_revision;
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
                shared.timeline_revision = 0;
                shared.path.clear();
                shared.header = None;
                shared.format_version = 0;
                shared.complete = false;
                shared.speed = ReplaySpeed::default();
                shared.position_us = 0;
                shared.duration_us = 0;
                shared.data_bytes = 0;
                shared.record_count = 0;
                shared.marker_count = 0;
                shared.markers.clear();
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

fn emit_markers(app: &AppHandle, payload: ReplayMarkersPayload) {
    let _ = app.emit("replay://markers", payload);
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
    use std::fs;
    use std::sync::atomic::AtomicU64;

    use super::*;
    use crate::capture::{CAPTURE_MAGIC, CAPTURE_VERSION};
    use crate::serial::SerialConfig;

    static NEXT_TEMP_CAPTURE: AtomicU64 = AtomicU64::new(1);

    struct TempCapture {
        path: PathBuf,
    }

    impl Drop for TempCapture {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    enum TestTimelineItem {
        Record(CaptureDirection, u64, Vec<u8>),
        Marker(CaptureMarkerColor, u64, String),
    }

    fn test_header(protocol: &str) -> CaptureHeader {
        CaptureHeader {
            source: "serial".to_owned(),
            protocol: protocol.to_owned(),
            serial_config: SerialConfig {
                port_name: "COM3".to_owned(),
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

    fn temporary_capture(records: &[(u64, &[u8])], complete: bool) -> TempCapture {
        let directed_records = records
            .iter()
            .map(|(timestamp_us, payload)| (CaptureDirection::Rx, *timestamp_us, *payload))
            .collect::<Vec<_>>();
        temporary_directed_capture("raw", &directed_records, complete)
    }

    fn temporary_directed_capture(
        protocol: &str,
        records: &[(CaptureDirection, u64, &[u8])],
        complete: bool,
    ) -> TempCapture {
        let header_bytes = serde_json::to_vec(&test_header(protocol)).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&CAPTURE_MAGIC);
        bytes.extend_from_slice(&1_u16.to_le_bytes());
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
            data_bytes += payload.len() as u64;
        }
        if complete {
            bytes.push(0xff);
            bytes.extend_from_slice(&[0_u8; 7]);
            bytes.extend_from_slice(&data_bytes.to_le_bytes());
            bytes.extend_from_slice(&(records.len() as u64).to_le_bytes());
        } else {
            bytes.extend_from_slice(&[0x01, 0x00, 0x00]);
        }

        let unique = NEXT_TEMP_CAPTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "vofa-ultra-replay-{}-{unique}.vucap",
            std::process::id()
        ));
        fs::write(&path, bytes).unwrap();
        TempCapture { path }
    }

    fn temporary_v2_capture(
        protocol: &str,
        items: &[TestTimelineItem],
        complete: bool,
    ) -> TempCapture {
        let header_bytes = serde_json::to_vec(&test_header(protocol)).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&CAPTURE_MAGIC);
        bytes.extend_from_slice(&CAPTURE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header_bytes);

        let mut data_bytes = 0_u64;
        let mut record_count = 0_u64;
        let mut marker_count = 0_u64;
        for item in items {
            match item {
                TestTimelineItem::Record(direction, timestamp_us, payload) => {
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
                    record_count = record_count.saturating_add(1);
                }
                TestTimelineItem::Marker(color, timestamp_us, label) => {
                    let label = label.as_bytes();
                    bytes.push(0x02);
                    bytes.push(*color as u8);
                    bytes.extend_from_slice(&0_u16.to_le_bytes());
                    bytes.extend_from_slice(&timestamp_us.to_le_bytes());
                    bytes.extend_from_slice(&(label.len() as u32).to_le_bytes());
                    bytes.extend_from_slice(label);
                    marker_count = marker_count.saturating_add(1);
                }
            }
        }
        if complete {
            bytes.push(0xff);
            bytes.extend_from_slice(&[0_u8; 7]);
            bytes.extend_from_slice(&data_bytes.to_le_bytes());
            bytes.extend_from_slice(&record_count.to_le_bytes());
            bytes.extend_from_slice(&marker_count.to_le_bytes());
        }

        let unique = NEXT_TEMP_CAPTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "vofa-ultra-replay-v2-{}-{unique}.vucap",
            std::process::id()
        ));
        fs::write(&path, bytes).unwrap();
        TempCapture { path }
    }

    fn scan_test_capture_full(
        path: &Path,
    ) -> (
        CaptureHeader,
        ScanSummary,
        ReplayIndex,
        Vec<ReplayMarkerPayload>,
    ) {
        let file = File::open(path).unwrap();
        let mut reader = CaptureReader::new(file).unwrap();
        let header = reader.header().clone();
        let format_version = reader.version();
        let mut index = ReplayIndex::new(reader.stream_position().unwrap(), &header.protocol);
        let mut accumulator = ScanAccumulator::default();
        let complete = loop {
            match reader.next() {
                Some(Ok(CaptureItem::Record(record))) => {
                    accumulator.observe(&record).unwrap();
                    index.observe(
                        &record,
                        reader.stream_position().unwrap(),
                        accumulator.stats.record_count(),
                        accumulator.stats.data_bytes(),
                        accumulator.stats.marker_count(),
                    );
                }
                Some(Ok(CaptureItem::Marker(marker))) => {
                    accumulator.observe_marker(&marker).unwrap();
                }
                Some(Ok(CaptureItem::Footer(_))) => break true,
                Some(Err(CaptureReadError::Truncated(_))) => break false,
                Some(Err(error)) => panic!("unexpected capture error: {error}"),
                None => break false,
            }
        };
        let message = (!complete).then(|| "文件不完整".to_owned());
        let (summary, markers) = accumulator.finish(format_version, complete, message);
        (header, summary, index, markers)
    }

    fn scan_test_capture(path: &Path) -> (CaptureHeader, ScanSummary, ReplayIndex) {
        let (header, summary, index, _) = scan_test_capture_full(path);
        (header, summary, index)
    }

    fn located_record(
        capture: &TempCapture,
        header: &CaptureHeader,
        summary: &ScanSummary,
        index: &ReplayIndex,
        requested_us: u64,
    ) -> Option<CaptureRecord> {
        let target_us = clamp_seek_target(requested_us, summary.duration_us);
        let location = locate_replay_cursor(
            &capture.path,
            header,
            summary,
            index.checkpoint_before(target_us),
            target_us,
            || Ok(None),
        )
        .unwrap();
        match location {
            SeekLocation::Positioned { mut cursor, .. } => cursor.lookahead.take(),
            SeekLocation::Completed { .. } => None,
            SeekLocation::Interrupted(_) => panic!("seek unexpectedly interrupted"),
        }
    }

    fn located_suffix(
        capture: &TempCapture,
        header: &CaptureHeader,
        summary: &ScanSummary,
        index: &ReplayIndex,
        requested_us: u64,
    ) -> Option<(u64, Vec<CaptureRecord>)> {
        let target_us = clamp_seek_target(requested_us, summary.duration_us);
        let location = locate_replay_cursor(
            &capture.path,
            header,
            summary,
            index.checkpoint_before(target_us),
            target_us,
            || Ok(None),
        )
        .unwrap();
        match location {
            SeekLocation::Positioned {
                mut cursor,
                position_us,
            } => {
                let mut records = Vec::new();
                if let Some(record) = cursor.lookahead.take() {
                    records.push(record);
                }
                while let Some(record) = cursor.next_record(summary).unwrap() {
                    records.push(record);
                }
                Some((position_us, records))
            }
            SeekLocation::Completed { .. } => None,
            SeekLocation::Interrupted(_) => panic!("seek unexpectedly interrupted"),
        }
    }

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
        let (summary, _) =
            accumulator.finish(CAPTURE_VERSION, false, Some("文件不完整".to_owned()));

        assert!(!summary.complete);
        assert_eq!(summary.duration_us, 35);
        assert_eq!(summary.data_bytes, 10);
        assert_eq!(summary.record_count, 2);
        assert_eq!(summary.marker_count, 0);
        assert_eq!(summary.message.as_deref(), Some("文件不完整"));
    }

    #[test]
    fn v2_scan_collects_markers_without_putting_them_in_record_batches() {
        let capture = temporary_v2_capture(
            "raw",
            &[
                TestTimelineItem::Record(CaptureDirection::Rx, 0, vec![1]),
                TestTimelineItem::Marker(CaptureMarkerColor::Green, 5, "启动".to_owned()),
                TestTimelineItem::Record(CaptureDirection::Tx, 10, vec![2, 3]),
                TestTimelineItem::Marker(CaptureMarkerColor::Orange, 20, "进入稳态".to_owned()),
            ],
            true,
        );
        let (header, summary, index, markers) = scan_test_capture_full(&capture.path);

        assert_eq!(summary.format_version, CAPTURE_VERSION);
        assert!(summary.complete);
        assert_eq!(summary.duration_us, 20);
        assert_eq!((summary.record_count, summary.marker_count), (2, 2));
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].label, "启动");
        assert_eq!(markers[1].color, CaptureMarkerColor::Orange);

        let (_, records) = located_suffix(&capture, &header, &summary, &index, 0).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].payload, vec![1]);
        assert_eq!(records[1].payload, vec![2, 3]);
    }

    #[test]
    fn marker_only_and_trailing_marker_ranges_complete_without_empty_batches() {
        let capture = temporary_v2_capture(
            "raw",
            &[
                TestTimelineItem::Marker(CaptureMarkerColor::Blue, 5, "A".to_owned()),
                TestTimelineItem::Marker(CaptureMarkerColor::Purple, 10, "B".to_owned()),
            ],
            true,
        );
        let (header, summary, index, markers) = scan_test_capture_full(&capture.path);
        assert_eq!((summary.record_count, summary.marker_count), (0, 2));
        assert_eq!(summary.duration_us, 10);
        assert_eq!(markers.len(), 2);
        assert!(located_record(&capture, &header, &summary, &index, 5).is_none());

        let mut cursor =
            ReplayCursor::open(&capture.path, &header, summary.format_version).unwrap();
        assert!(build_next_batch(&mut cursor, &summary).unwrap().is_none());
    }

    #[test]
    fn seek_checkpoint_restores_marker_count_and_incomplete_v2_prefix() {
        let capture = temporary_v2_capture(
            "raw",
            &[
                TestTimelineItem::Record(CaptureDirection::Rx, 10, vec![1]),
                TestTimelineItem::Marker(CaptureMarkerColor::Yellow, 20, "M".to_owned()),
                TestTimelineItem::Record(CaptureDirection::Rx, 30, vec![2]),
                TestTimelineItem::Marker(CaptureMarkerColor::Red, 40, "尾部".to_owned()),
            ],
            false,
        );
        let (header, summary, index, markers) = scan_test_capture_full(&capture.path);
        assert!(!summary.complete);
        assert_eq!((summary.record_count, summary.marker_count), (2, 2));
        assert_eq!(markers.len(), 2);

        let checkpoint = index.checkpoint_before(35);
        assert_eq!(checkpoint.record_count, 2);
        assert_eq!(checkpoint.marker_count, 1);
        assert!(located_record(&capture, &header, &summary, &index, 35).is_none());
        let next = located_record(&capture, &header, &summary, &index, 25).unwrap();
        assert_eq!(next.timestamp_us, 30);
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
    fn replay_speed_accepts_only_the_bounded_whitelist() {
        let supported = [
            (0.25, ReplaySpeed::Quarter),
            (0.5, ReplaySpeed::Half),
            (1.0, ReplaySpeed::Normal),
            (2.0, ReplaySpeed::Double),
            (4.0, ReplaySpeed::Quadruple),
        ];
        for (value, expected) in supported {
            let parsed = ReplaySpeed::parse(value).unwrap();
            assert_eq!(parsed, expected);
            assert_eq!(parsed.as_f64(), value);
        }

        for value in [0.0, 0.1, 8.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(ReplaySpeed::parse(value).is_err());
        }
    }

    #[test]
    fn replay_speed_scales_wall_time_without_floating_point_drift() {
        let capture_second = 1_000_000;
        assert_eq!(
            scaled_wall_duration(capture_second, ReplaySpeed::Quarter),
            Duration::from_secs(4)
        );
        assert_eq!(
            scaled_wall_duration(capture_second, ReplaySpeed::Half),
            Duration::from_secs(2)
        );
        assert_eq!(
            scaled_wall_duration(capture_second, ReplaySpeed::Normal),
            Duration::from_secs(1)
        );
        assert_eq!(
            scaled_wall_duration(capture_second, ReplaySpeed::Double),
            Duration::from_millis(500)
        );
        assert_eq!(
            scaled_wall_duration(capture_second, ReplaySpeed::Quadruple),
            Duration::from_millis(250)
        );

        let wall_elapsed = Duration::from_millis(250);
        assert_eq!(
            scaled_capture_elapsed(wall_elapsed, ReplaySpeed::Quarter),
            62_500
        );
        assert_eq!(
            scaled_capture_elapsed(wall_elapsed, ReplaySpeed::Half),
            125_000
        );
        assert_eq!(
            scaled_capture_elapsed(wall_elapsed, ReplaySpeed::Normal),
            250_000
        );
        assert_eq!(
            scaled_capture_elapsed(wall_elapsed, ReplaySpeed::Double),
            500_000
        );
        assert_eq!(
            scaled_capture_elapsed(wall_elapsed, ReplaySpeed::Quadruple),
            1_000_000
        );
    }

    #[test]
    fn replay_speed_reanchors_continuously_and_clamps_to_pending_batch() {
        let started_at = Instant::now();
        let anchor = PlaybackAnchor {
            instant: started_at,
            capture_us: 100_000,
        };
        let now = started_at + Duration::from_millis(500);

        assert_eq!(
            reanchored_capture_us(&anchor, now, ReplaySpeed::Normal, 2_000_000),
            600_000
        );
        assert_eq!(
            reanchored_capture_us(&anchor, now, ReplaySpeed::Double, 2_000_000),
            1_100_000
        );
        assert_eq!(
            reanchored_capture_us(&anchor, now, ReplaySpeed::Double, 700_000),
            700_000
        );
    }

    #[test]
    fn sparse_index_is_bounded_and_locates_strictly_before_target() {
        assert_eq!(std::mem::size_of::<ReplayCheckpoint>(), 40);
        let mut index = ReplayIndex::new(64, "raw");
        let records = (REPLAY_INDEX_MAX_CHECKPOINTS as u64) * 4;
        for record_count in 1..=records {
            let current_record = record(record_count, 1);
            index.observe(
                &current_record,
                64 + record_count * 16,
                record_count,
                record_count * 2,
                0,
            );
        }

        assert!(index.checkpoints.len() <= REPLAY_INDEX_MAX_CHECKPOINTS);
        assert!(index.checkpoints.capacity() <= REPLAY_INDEX_MAX_CHECKPOINTS);
        assert!(index.stride_records > 1);
        assert!(
            index.checkpoints.capacity() * std::mem::size_of::<ReplayCheckpoint>()
                <= REPLAY_INDEX_MEMORY_LIMIT_BYTES
        );
        let target_us = records - 17;
        let checkpoint = index.checkpoint_before(target_us);
        assert!(checkpoint.position_us < target_us);
        assert_eq!(
            Some(checkpoint),
            index.checkpoints.iter().copied().rfind(|candidate| {
                candidate.record_count == 0 || candidate.position_us < target_us
            })
        );
    }

    #[test]
    fn duplicate_timestamp_checkpoint_never_skips_exact_target() {
        let mut index = ReplayIndex::new(100, "raw");
        index.observe(&record(10, 1), 120, 1, 1, 0);
        index.observe(&record(10, 1), 140, 2, 2, 0);
        index.observe(&record(10, 1), 160, 3, 3, 0);
        index.observe(&record(20, 1), 180, 4, 4, 0);

        assert_eq!(index.checkpoint_before(10).record_count, 0);
        assert_eq!(index.checkpoint_before(11).record_count, 3);
        assert_eq!(index.checkpoint_before(20).record_count, 3);
        assert_eq!(index.checkpoint_before(21).record_count, 4);
    }

    #[test]
    fn seek_locates_zero_interval_exact_duplicate_duration_and_overflow() {
        let capture = temporary_capture(
            &[
                (0, &[0x00]),
                (10, &[0x0a]),
                (10, &[0x0b]),
                (20, &[0x14]),
                (40, &[0x28]),
            ],
            true,
        );
        let (header, summary, index) = scan_test_capture(&capture.path);

        let zero = located_record(&capture, &header, &summary, &index, 0).unwrap();
        assert_eq!((zero.timestamp_us, zero.payload), (0, vec![0x00]));
        let interval = located_record(&capture, &header, &summary, &index, 5).unwrap();
        assert_eq!((interval.timestamp_us, interval.payload), (10, vec![0x0a]));
        let duplicate = located_record(&capture, &header, &summary, &index, 10).unwrap();
        assert_eq!(
            (duplicate.timestamp_us, duplicate.payload),
            (10, vec![0x0a])
        );
        let exact = located_record(&capture, &header, &summary, &index, 20).unwrap();
        assert_eq!((exact.timestamp_us, exact.payload), (20, vec![0x14]));
        assert!(located_record(&capture, &header, &summary, &index, 40).is_none());
        assert!(located_record(&capture, &header, &summary, &index, u64::MAX).is_none());
    }

    #[test]
    fn firewater_seek_preserves_origin_and_exact_safe_checkpoint() {
        let capture = temporary_directed_capture(
            "firewater",
            &[
                (CaptureDirection::Rx, 0, b"first\n"),
                (CaptureDirection::Rx, 5, b"old\n"),
                (CaptureDirection::Tx, 7, b"command"),
                (CaptureDirection::Rx, 10, b"new\n"),
                (CaptureDirection::Rx, 20, b"later\n"),
            ],
            true,
        );
        let (header, summary, index) = scan_test_capture(&capture.path);

        let (origin_us, origin_records) =
            located_suffix(&capture, &header, &summary, &index, 0).unwrap();
        assert_eq!(origin_us, 0);
        assert_eq!(origin_records[0].payload, b"first\n");

        let checkpoint = index.checkpoint_before(10);
        assert_eq!(checkpoint.position_us, 7);
        let (position_us, records) =
            located_suffix(&capture, &header, &summary, &index, 10).unwrap();
        assert_eq!(position_us, 10);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].direction, CaptureDirection::Rx);
        assert_eq!(records[0].payload, b"new\n");
    }

    #[test]
    fn firewater_seek_discards_partial_unit_and_keeps_record_remainder() {
        let capture = temporary_directed_capture(
            "firewater",
            &[
                (CaptureDirection::Rx, 5, b"old-partial"),
                (CaptureDirection::Tx, 10, b"same-time-command"),
                (CaptureDirection::Rx, 10, b"\nnew\nnext\n"),
                (CaptureDirection::Rx, 20, b"later\n"),
            ],
            true,
        );
        let (header, summary, index) = scan_test_capture(&capture.path);

        let (position_us, records) =
            located_suffix(&capture, &header, &summary, &index, 10).unwrap();
        assert_eq!(position_us, 10);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].direction, CaptureDirection::Rx);
        assert_eq!(records[0].timestamp_us, 10);
        assert_eq!(records[0].payload, b"new\nnext\n");
        assert_eq!(records[1].payload, b"later\n");
    }

    #[test]
    fn justfloat_seek_handles_every_tail_split_with_tx_interleaving() {
        let next_frame = [0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x80, 0x7f];
        let later_frame = [0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x80, 0x7f];

        for split in 0..=JUSTFLOAT_TAIL.len() {
            let mut old_prefix = vec![0x41];
            old_prefix.extend_from_slice(&JUSTFLOAT_TAIL[..split]);
            let mut synchronized_suffix = JUSTFLOAT_TAIL[split..].to_vec();
            synchronized_suffix.extend_from_slice(&next_frame);
            let capture = temporary_directed_capture(
                "justfloat",
                &[
                    (CaptureDirection::Rx, 5, &old_prefix),
                    (CaptureDirection::Tx, 7, b"command"),
                    (CaptureDirection::Rx, 10, &synchronized_suffix),
                    (CaptureDirection::Rx, 20, &later_frame),
                ],
                true,
            );
            let (header, summary, index) = scan_test_capture(&capture.path);

            let (position_us, records) =
                located_suffix(&capture, &header, &summary, &index, 10).unwrap();
            assert_eq!(position_us, 10, "split={split}");
            assert_eq!(records.len(), 2, "split={split}");
            assert_eq!(records[0].payload, next_frame, "split={split}");
            assert_eq!(records[1].payload, later_frame, "split={split}");
        }
    }

    #[test]
    fn justfloat_boundary_scanner_ignores_unaligned_tail_inside_payload() {
        let frame = [
            0x01, 0x00, 0x00, 0x80, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x7f,
        ];
        let mut scanner = ProtocolBoundaryScanner::new(ReplaySeekMode::JustFloat, true);

        assert_eq!(scanner.find_boundary(&frame[..5], true), None);
        assert!(!scanner.at_boundary());
        assert_eq!(scanner.find_boundary(&frame[5..], true), Some(7));
        assert!(scanner.at_boundary());
    }

    #[test]
    fn justfloat_boundary_scanner_does_not_replay_a_partial_cross_record_frame() {
        let first_record = [0x41, 0x00, 0x00, 0x80, 0x7f, 0x00, 0x00];
        let second_record = [0x80, 0x3f, 0x00, 0x00, 0x80, 0x7f];
        let mut scanner = ProtocolBoundaryScanner::new(ReplaySeekMode::JustFloat, true);

        assert_eq!(scanner.find_boundary(&first_record, false), None);
        assert_eq!(
            scanner.find_boundary(&second_record, true),
            Some(second_record.len())
        );
        assert!(scanner.at_boundary());
    }

    #[test]
    fn justfloat_seek_recovers_overlapping_tail_prefix() {
        let next_frame = [0x00, 0x00, 0x40, 0x40, 0x00, 0x00, 0x80, 0x7f];
        let later_frame = [0x00, 0x00, 0x80, 0x40, 0x00, 0x00, 0x80, 0x7f];
        let capture = temporary_directed_capture(
            "justfloat",
            &[
                (CaptureDirection::Rx, 5, &[0x41, 0x00]),
                (CaptureDirection::Rx, 10, &[0x00, 0x00, 0x80, 0x7f]),
                (CaptureDirection::Rx, 10, &next_frame),
                (CaptureDirection::Rx, 20, &later_frame),
            ],
            true,
        );
        let (header, summary, index) = scan_test_capture(&capture.path);

        let (position_us, records) =
            located_suffix(&capture, &header, &summary, &index, 10).unwrap();
        assert_eq!(position_us, 10);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].payload, next_frame);
    }

    #[test]
    fn structured_seek_without_later_sync_completes_at_verified_end() {
        let capture = temporary_directed_capture(
            "firewater",
            &[
                (CaptureDirection::Rx, 5, b"partial"),
                (CaptureDirection::Tx, 20, b"later-command"),
            ],
            true,
        );
        let (header, summary, index) = scan_test_capture(&capture.path);
        let target_us = 10;
        let location = locate_replay_cursor(
            &capture.path,
            &header,
            &summary,
            index.checkpoint_before(target_us),
            target_us,
            || Ok(None),
        )
        .unwrap();

        assert!(matches!(
            location,
            SeekLocation::Completed { position_us: 20 }
        ));
    }

    #[test]
    fn structured_seek_with_final_boundary_completes_without_empty_pause() {
        let capture = temporary_directed_capture(
            "firewater",
            &[
                (CaptureDirection::Rx, 5, b"partial"),
                (CaptureDirection::Rx, 20, b"\n"),
            ],
            true,
        );
        let (header, summary, index) = scan_test_capture(&capture.path);
        let target_us = 10;
        let location = locate_replay_cursor(
            &capture.path,
            &header,
            &summary,
            index.checkpoint_before(target_us),
            target_us,
            || Ok(None),
        )
        .unwrap();

        assert!(matches!(
            location,
            SeekLocation::Completed { position_us: 20 }
        ));
    }

    #[test]
    fn seek_preserves_truncated_verified_prefix() {
        let capture = temporary_capture(&[(5, &[1]), (15, &[2]), (30, &[3])], false);
        let (header, summary, index) = scan_test_capture(&capture.path);

        assert!(!summary.complete);
        let exact = located_record(&capture, &header, &summary, &index, 15).unwrap();
        assert_eq!((exact.timestamp_us, exact.payload), (15, vec![2]));
        assert!(located_record(&capture, &header, &summary, &index, 30).is_none());
    }

    #[test]
    fn seek_clears_pending_delivery_and_rejects_old_ack_generation() {
        let mut cursor = None;
        let mut pending_batch = Some(PendingBatch {
            start_us: 10,
            end_us: 20,
            data_bytes: 1,
            records: vec![ReplayBatchRecordPayload {
                direction: "rx".to_owned(),
                timestamp_us: 20,
                data: vec![1],
            }],
        });
        let mut waiting_start_ack = true;
        let mut anchor = Some(PlaybackAnchor {
            instant: Instant::now(),
            capture_us: 10,
        });
        let mut next_sequence = 9;
        clear_delivery_for_seek(
            &mut cursor,
            &mut pending_batch,
            &mut waiting_start_ack,
            &mut anchor,
            &mut next_sequence,
        );

        assert!(cursor.is_none());
        assert!(pending_batch.is_none());
        assert!(!waiting_start_ack);
        assert!(anchor.is_none());
        assert_eq!(next_sequence, 1);
        let old_generation = 4;
        let new_generation = next_generation(old_generation);
        let old_ack = ReplayAck {
            session_id: 1,
            generation: old_generation,
            sequence: 9,
        };
        assert!(!old_ack.matches(1, new_generation, 1));
    }

    #[test]
    fn seek_location_honors_stop_and_close_interrupts() {
        let capture = temporary_capture(&[(1, &[1]), (2, &[2]), (3, &[3])], true);
        let (header, summary, index) = scan_test_capture(&capture.path);
        let checkpoint = index.checkpoint_before(3);
        let mut stop_polls = 0;
        let stopped = locate_replay_cursor(&capture.path, &header, &summary, checkpoint, 3, || {
            stop_polls += 1;
            Ok((stop_polls == 2).then_some(RuntimeControl::Continue))
        })
        .unwrap();
        assert!(matches!(
            stopped,
            SeekLocation::Interrupted(RuntimeControl::Continue)
        ));

        let closed = locate_replay_cursor(&capture.path, &header, &summary, checkpoint, 3, || {
            Ok(Some(RuntimeControl::Exit))
        })
        .unwrap();
        assert!(matches!(
            closed,
            SeekLocation::Interrupted(RuntimeControl::Exit)
        ));
    }

    #[test]
    fn seek_support_is_explicit_and_target_is_clamped() {
        assert!(seek_protocol_supported("raw"));
        assert!(seek_protocol_supported("firewater"));
        assert!(seek_protocol_supported("justfloat"));
        assert!(!seek_protocol_supported("unknown"));
        assert_eq!(clamp_seek_target(5, 10), 5);
        assert_eq!(clamp_seek_target(10, 10), 10);
        assert_eq!(clamp_seek_target(u64::MAX, 10), 10);
    }

    #[test]
    fn idle_state_omits_optional_payload_fields() {
        let json = serde_json::to_value(SharedReplayState::default().snapshot()).unwrap();

        assert!(json.get("header").is_none());
        assert!(json.get("message").is_none());
        assert_eq!(
            json.get("timelineRevision")
                .and_then(|value| value.as_u64()),
            Some(0)
        );
        assert_eq!(
            json.get("complete").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            json.get("speed").and_then(|value| value.as_f64()),
            Some(1.0)
        );
    }

    #[test]
    fn resetting_replay_state_restores_normal_speed() {
        let mut shared = SharedReplayState {
            speed: ReplaySpeed::Quadruple,
            ..SharedReplayState::default()
        };

        let payload = shared.reset_idle();

        assert_eq!(payload.speed, 1.0);
        assert_eq!(shared.speed, ReplaySpeed::Normal);
    }
}
