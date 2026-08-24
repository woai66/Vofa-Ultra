use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::serial::SerialConfig;

pub const CAPTURE_MAGIC: [u8; 8] = *b"VUCAP\0\r\n";
pub const CAPTURE_VERSION: u16 = 1;
pub const MAX_CAPTURE_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_CAPTURE_RECORD_BYTES: usize = 64 * 1024;

const FILE_HEADER_SIZE: usize = 16;
const RECORD_TAG: u8 = 0x01;
const FOOTER_TAG: u8 = 0xff;
const RECORD_HEADER_SIZE: usize = 16;
const FOOTER_SIZE: usize = 24;
const WRITER_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const WRITER_QUEUE_RECORDS: usize = 4096;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const WRITER_START_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_FINALIZE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_ABORT_MESSAGE_CHARS: usize = 512;
const WRITER_PHASE_ACTIVE: u8 = 0;
const WRITER_PHASE_FINISH_REQUESTED: u8 = 1;
const WRITER_PHASE_COMMITTING: u8 = 2;
const WRITER_PHASE_ABORTED: u8 = 3;
const WRITER_PHASE_COMPLETED: u8 = 4;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureHeader {
    pub source: String,
    pub protocol: String,
    pub serial_config: SerialConfig,
    pub started_at_unix_ms: u64,
    pub time_unit: String,
}

impl CaptureHeader {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.source.as_str(), "serial" | "simulator") {
            return Err(format!("不支持的录制数据源: {}", self.source));
        }
        if !matches!(self.protocol.as_str(), "firewater" | "justfloat" | "raw") {
            return Err(format!("不支持的录制协议: {}", self.protocol));
        }
        if self.time_unit != "microseconds" {
            return Err(format!("不支持的录制时间单位: {}", self.time_unit));
        }
        self.serial_config.validate(self.source == "serial")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureDirection {
    Rx,
    Tx,
}

impl CaptureDirection {
    fn from_code(code: u8) -> Result<Self, CaptureReadError> {
        match code {
            0 => Ok(Self::Rx),
            1 => Ok(Self::Tx),
            _ => Err(CaptureReadError::InvalidDirection(code)),
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "rx" => Ok(Self::Rx),
            "tx" => Ok(Self::Tx),
            _ => Err(format!("不支持的录制方向: {value}")),
        }
    }

    fn code(self) -> u8 {
        match self {
            Self::Rx => 0,
            Self::Tx => 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureRecord {
    pub direction: CaptureDirection,
    pub timestamp_us: u64,
    pub payload: Vec<u8>,
}

#[derive(Default)]
pub(crate) struct CaptureRecordStats {
    last_timestamp_us: Option<u64>,
    data_bytes: u64,
    record_count: u64,
}

impl CaptureRecordStats {
    pub(crate) fn observe(&mut self, record: &CaptureRecord) -> Result<(), String> {
        if self
            .last_timestamp_us
            .map(|last| record.timestamp_us < last)
            .unwrap_or(false)
        {
            return Err(format!(
                "捕获记录时间戳从 {} 微秒回退到 {} 微秒",
                self.last_timestamp_us.unwrap_or(0),
                record.timestamp_us
            ));
        }
        self.last_timestamp_us = Some(record.timestamp_us);
        self.data_bytes = self.data_bytes.saturating_add(record.payload.len() as u64);
        self.record_count = self.record_count.saturating_add(1);
        Ok(())
    }

    pub(crate) fn duration_us(&self) -> u64 {
        self.last_timestamp_us.unwrap_or(0)
    }

    pub(crate) fn data_bytes(&self) -> u64 {
        self.data_bytes
    }

    pub(crate) fn record_count(&self) -> u64 {
        self.record_count
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureFooter {
    pub data_bytes: u64,
    pub record_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureItem {
    Record(CaptureRecord),
    Footer(CaptureFooter),
}

#[derive(Debug)]
pub enum CaptureReadError {
    Io(io::Error),
    InvalidMagic,
    FutureVersion(u16),
    UnsupportedVersion(u16),
    HeaderTooLarge(u32),
    RecordTooLarge(u32),
    InvalidHeader(String),
    InvalidDirection(u8),
    InvalidTag(u8),
    Truncated(&'static str),
    Corrupt(String),
}

impl std::fmt::Display for CaptureReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "读取捕获文件失败: {error}"),
            Self::InvalidMagic => formatter.write_str("捕获文件 magic 不匹配"),
            Self::FutureVersion(version) => {
                write!(formatter, "捕获文件版本 {version} 高于当前支持版本")
            }
            Self::UnsupportedVersion(version) => {
                write!(formatter, "不支持的捕获文件版本: {version}")
            }
            Self::HeaderTooLarge(size) => write!(formatter, "捕获文件头超过 64 KiB: {size} 字节"),
            Self::RecordTooLarge(size) => write!(formatter, "捕获记录超过 64 KiB: {size} 字节"),
            Self::InvalidHeader(message) => write!(formatter, "捕获文件头无效: {message}"),
            Self::InvalidDirection(direction) => write!(formatter, "捕获记录方向无效: {direction}"),
            Self::InvalidTag(tag) => write!(formatter, "捕获记录类型无效: 0x{tag:02x}"),
            Self::Truncated(section) => write!(formatter, "捕获文件在{section}处被截断"),
            Self::Corrupt(message) => write!(formatter, "捕获文件已损坏: {message}"),
        }
    }
}

impl std::error::Error for CaptureReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

pub struct CaptureReader<R: Read> {
    reader: R,
    header: CaptureHeader,
    data_bytes: u64,
    record_count: u64,
    done: bool,
}

impl<R: Read> CaptureReader<R> {
    pub fn new(mut reader: R) -> Result<Self, CaptureReadError> {
        let mut prefix = [0_u8; FILE_HEADER_SIZE];
        read_exact_section(&mut reader, &mut prefix, "固定文件头")?;

        if prefix[..CAPTURE_MAGIC.len()] != CAPTURE_MAGIC {
            return Err(CaptureReadError::InvalidMagic);
        }

        let version = u16::from_le_bytes([prefix[8], prefix[9]]);
        if version > CAPTURE_VERSION {
            return Err(CaptureReadError::FutureVersion(version));
        }
        if version != CAPTURE_VERSION {
            return Err(CaptureReadError::UnsupportedVersion(version));
        }

        let flags = u16::from_le_bytes([prefix[10], prefix[11]]);
        if flags != 0 {
            return Err(CaptureReadError::Corrupt(format!(
                "文件头保留字段必须为 0，实际为 {flags}"
            )));
        }

        let header_size = u32::from_le_bytes([prefix[12], prefix[13], prefix[14], prefix[15]]);
        if header_size as usize > MAX_CAPTURE_HEADER_BYTES {
            return Err(CaptureReadError::HeaderTooLarge(header_size));
        }

        let mut header_bytes = vec![0_u8; header_size as usize];
        read_exact_section(&mut reader, &mut header_bytes, "JSON 文件头")?;
        let header: CaptureHeader = serde_json::from_slice(&header_bytes)
            .map_err(|error| CaptureReadError::InvalidHeader(error.to_string()))?;
        header.validate().map_err(CaptureReadError::InvalidHeader)?;

        Ok(Self {
            reader,
            header,
            data_bytes: 0,
            record_count: 0,
            done: false,
        })
    }

    pub fn header(&self) -> &CaptureHeader {
        &self.header
    }

    fn read_item(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut tag = [0_u8; 1];
        read_exact_section(&mut self.reader, &mut tag, "正常结束标记")?;

        match tag[0] {
            RECORD_TAG => self.read_record(),
            FOOTER_TAG => self.read_footer(),
            tag => Err(CaptureReadError::InvalidTag(tag)),
        }
    }

    fn read_record(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut header = [0_u8; RECORD_HEADER_SIZE - 1];
        read_exact_section(&mut self.reader, &mut header, "记录头")?;

        let direction = CaptureDirection::from_code(header[0])?;
        let reserved = u16::from_le_bytes([header[1], header[2]]);
        if reserved != 0 {
            return Err(CaptureReadError::Corrupt(format!(
                "记录保留字段必须为 0，实际为 {reserved}"
            )));
        }

        let timestamp_us = u64::from_le_bytes(header[3..11].try_into().expect("时间戳长度固定"));
        let payload_size = u32::from_le_bytes(header[11..15].try_into().expect("记录长度字段固定"));
        if payload_size as usize > MAX_CAPTURE_RECORD_BYTES {
            return Err(CaptureReadError::RecordTooLarge(payload_size));
        }

        let mut payload = vec![0_u8; payload_size as usize];
        read_exact_section(&mut self.reader, &mut payload, "记录数据")?;
        self.data_bytes = self.data_bytes.saturating_add(payload_size as u64);
        self.record_count = self.record_count.saturating_add(1);

        Ok(CaptureItem::Record(CaptureRecord {
            direction,
            timestamp_us,
            payload,
        }))
    }

    fn read_footer(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut footer = [0_u8; FOOTER_SIZE - 1];
        read_exact_section(&mut self.reader, &mut footer, "结束标记")?;

        if footer[..7].iter().any(|byte| *byte != 0) {
            return Err(CaptureReadError::Corrupt(
                "结束标记保留字段必须为 0".to_owned(),
            ));
        }
        let data_bytes = u64::from_le_bytes(footer[7..15].try_into().expect("字节计数字段固定"));
        let record_count = u64::from_le_bytes(footer[15..23].try_into().expect("记录计数字段固定"));
        if data_bytes != self.data_bytes || record_count != self.record_count {
            return Err(CaptureReadError::Corrupt(format!(
                "结束统计不匹配，期望 {} 字节/{} 条，实际 {data_bytes} 字节/{record_count} 条",
                self.data_bytes, self.record_count
            )));
        }

        let mut trailing = [0_u8; 1];
        match self.reader.read(&mut trailing) {
            Ok(0) => {}
            Ok(_) => return Err(CaptureReadError::Corrupt("结束标记后仍有数据".to_owned())),
            Err(error) if error.kind() == ErrorKind::Interrupted => {
                return self.read_footer_trailing(data_bytes, record_count)
            }
            Err(error) => return Err(CaptureReadError::Io(error)),
        }

        Ok(CaptureItem::Footer(CaptureFooter {
            data_bytes,
            record_count,
        }))
    }

    fn read_footer_trailing(
        &mut self,
        data_bytes: u64,
        record_count: u64,
    ) -> Result<CaptureItem, CaptureReadError> {
        loop {
            let mut trailing = [0_u8; 1];
            match self.reader.read(&mut trailing) {
                Ok(0) => {
                    return Ok(CaptureItem::Footer(CaptureFooter {
                        data_bytes,
                        record_count,
                    }))
                }
                Ok(_) => return Err(CaptureReadError::Corrupt("结束标记后仍有数据".to_owned())),
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(CaptureReadError::Io(error)),
            }
        }
    }
}

impl<R: Read + Seek> CaptureReader<R> {
    pub(crate) fn stream_position(&mut self) -> Result<u64, CaptureReadError> {
        self.reader.stream_position().map_err(CaptureReadError::Io)
    }

    pub(crate) fn resume_from_verified(
        mut self,
        file_offset: u64,
        data_bytes: u64,
        record_count: u64,
    ) -> Result<Self, CaptureReadError> {
        self.reader
            .seek(SeekFrom::Start(file_offset))
            .map_err(CaptureReadError::Io)?;
        self.data_bytes = data_bytes;
        self.record_count = record_count;
        self.done = false;
        Ok(self)
    }
}

impl<R: Read> Iterator for CaptureReader<R> {
    type Item = Result<CaptureItem, CaptureReadError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }

        let result = self.read_item();
        if !matches!(result, Ok(CaptureItem::Record(_))) {
            self.done = true;
        }
        Some(result)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStartRequest {
    source: String,
    protocol: String,
    serial_config: SerialConfig,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatePayload {
    status: String,
    session_id: u64,
    revision: u64,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at_unix_ms: Option<u64>,
    data_bytes: u64,
    record_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub struct CaptureState {
    transition: Arc<Mutex<()>>,
    core: Arc<CaptureCore>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            transition: Arc::new(Mutex::new(())),
            core: Arc::new(CaptureCore {
                shared: Mutex::new(SharedCaptureState::default()),
            }),
        }
    }
}

impl CaptureState {
    pub fn recorder_handle(&self) -> CaptureRecorderHandle {
        CaptureRecorderHandle {
            core: Arc::clone(&self.core),
        }
    }

    fn lifecycle_handle(&self) -> CaptureLifecycleHandle {
        CaptureLifecycleHandle {
            transition: Arc::clone(&self.transition),
            core: Arc::clone(&self.core),
        }
    }

    pub(crate) fn has_active_capture(&self) -> Result<bool, String> {
        let _transition = self
            .transition
            .lock()
            .map_err(|_| "录制生命周期锁已损坏".to_owned())?;
        self.core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())
            .map(|shared| {
                matches!(
                    shared.status,
                    CaptureStatus::Recording | CaptureStatus::Stopping
                ) || shared.worker.is_some()
                    || shared.finalizing.is_some()
            })
    }
}

#[derive(Clone)]
struct CaptureLifecycleHandle {
    transition: Arc<Mutex<()>>,
    core: Arc<CaptureCore>,
}

impl Drop for CaptureState {
    fn drop(&mut self) {
        let _transition = self
            .transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (worker, should_finish, finalizing) = {
            let mut shared = self
                .core
                .shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let should_finish = matches!(
                shared.status,
                CaptureStatus::Recording | CaptureStatus::Stopping
            );
            (
                shared.worker.take(),
                should_finish,
                shared.finalizing.take(),
            )
        };

        if let Some(finalizing) = finalizing {
            if finalizing
                .done_receiver
                .recv_timeout(SHUTDOWN_FINALIZE_TIMEOUT)
                .is_err()
            {
                finalizing.control.request_abort();
            }
        }

        if let Some(worker) = worker {
            let control = Arc::clone(&worker.control);
            let (done_sender, done_receiver) = mpsc::channel();
            let spawn_result = thread::Builder::new()
                .name("vofa-capture-shutdown".to_owned())
                .spawn(move || {
                    if should_finish {
                        let _ = worker.finish_and_join();
                    } else {
                        let _ = worker.abort_and_join();
                    }
                    let _ = done_sender.send(());
                });
            if spawn_result.is_err()
                || done_receiver
                    .recv_timeout(SHUTDOWN_FINALIZE_TIMEOUT)
                    .is_err()
            {
                control.request_abort();
            }
        }
    }
}

#[derive(Clone)]
pub struct CaptureRecorderHandle {
    core: Arc<CaptureCore>,
}

impl CaptureRecorderHandle {
    pub fn active_session_id(&self) -> Option<u64> {
        self.core.shared.lock().ok().and_then(|shared| {
            let worker_session_id = shared.worker.as_ref().map(|worker| worker.session_id);
            if shared.status == CaptureStatus::Recording
                && worker_session_id == Some(shared.session_id)
            {
                Some(shared.session_id)
            } else {
                None
            }
        })
    }

    pub fn append_for_session(
        &self,
        app: &AppHandle,
        session_id: u64,
        direction: CaptureDirection,
        payload: &[u8],
    ) -> Result<(), String> {
        self.core.append(app, session_id, direction, payload)
    }
}

struct CaptureCore {
    shared: Mutex<SharedCaptureState>,
}

struct SharedCaptureState {
    revision: u64,
    session_id: u64,
    status: CaptureStatus,
    path: String,
    started_at_unix_ms: Option<u64>,
    ended_at_unix_ms: Option<u64>,
    data_bytes: u64,
    record_count: u64,
    message: Option<String>,
    worker: Option<CaptureWorker>,
    finalizing: Option<FinalizingCapture>,
}

impl Default for SharedCaptureState {
    fn default() -> Self {
        Self {
            revision: 0,
            session_id: 0,
            status: CaptureStatus::Idle,
            path: String::new(),
            started_at_unix_ms: None,
            ended_at_unix_ms: None,
            data_bytes: 0,
            record_count: 0,
            message: None,
            worker: None,
            finalizing: None,
        }
    }
}

impl SharedCaptureState {
    fn snapshot(&self) -> CaptureStatePayload {
        CaptureStatePayload {
            status: self.status.as_str().to_owned(),
            session_id: self.session_id,
            revision: self.revision,
            path: self.path.clone(),
            started_at_unix_ms: self.started_at_unix_ms,
            ended_at_unix_ms: self.ended_at_unix_ms,
            data_bytes: self.data_bytes,
            record_count: self.record_count,
            message: self.message.clone(),
        }
    }

    fn touch(&mut self) -> CaptureStatePayload {
        self.revision = self.revision.saturating_add(1);
        self.snapshot()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CaptureStatus {
    Idle,
    Recording,
    Stopping,
    Error,
}

impl CaptureStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Recording => "recording",
            Self::Stopping => "stopping",
            Self::Error => "error",
        }
    }
}

struct CaptureWorker {
    session_id: u64,
    sender: Option<mpsc::SyncSender<WriterCommand>>,
    control: Arc<WriterControl>,
    budget: Arc<ByteBudget>,
    started: Instant,
    join_handle: Option<JoinHandle<()>>,
}

struct FinalizingCapture {
    session_id: u64,
    control: Arc<WriterControl>,
    done_receiver: mpsc::Receiver<()>,
    worker_slot: Arc<Mutex<Option<CaptureWorker>>>,
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

fn clear_finalizing_state(shared: &mut SharedCaptureState, session_id: u64) {
    let matches_session = shared
        .finalizing
        .as_ref()
        .is_some_and(|finalizing| finalizing.session_id == session_id);
    if matches_session {
        shared.finalizing = None;
    }
}

fn clear_finalizing_capture(core: &Arc<CaptureCore>, session_id: u64) {
    if let Ok(mut shared) = core.shared.lock() {
        clear_finalizing_state(&mut shared, session_id);
    }
}

fn take_finished_finalizer_worker(shared: &mut SharedCaptureState) -> Option<CaptureWorker> {
    let (session_id, worker) = {
        let finalizing = shared.finalizing.as_ref()?;
        let mut slot = finalizing
            .worker_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let is_finished = match slot.as_ref() {
            Some(worker) => worker.is_finished(),
            None => false,
        };
        if !is_finished {
            return None;
        }
        (finalizing.session_id, slot.take())
    };
    clear_finalizing_state(shared, session_id);
    worker
}

impl CaptureWorker {
    fn finish_and_join(mut self) -> Result<(), String> {
        let sender = self.sender.take();
        let send_result = if self.control.request_finish() {
            match sender {
                Some(sender) => sender
                    .send(WriterCommand::Finish)
                    .map_err(|_| "录制写入线程已停止".to_owned()),
                None => Err("录制写入通道已关闭".to_owned()),
            }
        } else if self.control.is_aborted() {
            drop(sender);
            Ok(())
        } else {
            drop(sender);
            Err("录制文件已经进入提交阶段".to_owned())
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

    fn is_finished(&self) -> bool {
        match self.join_handle.as_ref() {
            Some(join_handle) => join_handle.is_finished(),
            None => true,
        }
    }

    fn join(&mut self) -> Result<(), String> {
        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|panic| format!("录制写入线程异常退出: {}", panic_message(panic)))?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum WorkerFinalization {
    Finish,
    Abort,
}

fn finalize_worker_in_background(
    app: AppHandle,
    core: Arc<CaptureCore>,
    worker: CaptureWorker,
    finalization: WorkerFinalization,
) {
    let session_id = worker.session_id;
    let control = Arc::clone(&worker.control);
    let worker_slot = Arc::new(Mutex::new(Some(worker)));
    let (done_sender, done_receiver) = mpsc::channel();
    let gate_installed = if let Ok(mut shared) = core.shared.lock() {
        if shared.finalizing.is_some() {
            false
        } else {
            shared.finalizing = Some(FinalizingCapture {
                session_id,
                control: Arc::clone(&control),
                done_receiver,
                worker_slot: Arc::clone(&worker_slot),
            });
            true
        }
    } else {
        false
    };
    if !gate_installed {
        control.request_abort();
        let mut slot = worker_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(worker) = slot.as_mut() {
            worker.begin_abort();
        }
        return;
    }

    let failure_app = app.clone();
    let failure_core = Arc::clone(&core);
    let finalizer_worker_slot = Arc::clone(&worker_slot);
    let thread_name = match finalization {
        WorkerFinalization::Finish => "vofa-capture-finish",
        WorkerFinalization::Abort => "vofa-capture-abort",
    };
    let spawn_result = thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            let worker = finalizer_worker_slot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let result = worker
                .ok_or_else(|| "录制收尾线程未取得 writer".to_owned())
                .and_then(|worker| {
                    catch_unwind(AssertUnwindSafe(|| match finalization {
                        WorkerFinalization::Finish => worker.finish_and_join(),
                        WorkerFinalization::Abort => worker.abort_and_join(),
                    }))
                    .map_err(|panic| format!("录制收尾线程异常退出: {}", panic_message(panic)))
                    .and_then(|result| result)
                });
            if let Err(message) = result {
                publish_worker_finalization_error(&app, &core, session_id, message);
            }
            clear_finalizing_capture(&core, session_id);
            let _ = done_sender.send(());
        });

    if let Err(error) = spawn_result {
        control.request_abort();
        let mut slot = worker_slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(worker) = slot.as_mut() {
            worker.begin_abort();
        }
        drop(slot);
        publish_worker_finalization_error(
            &failure_app,
            &failure_core,
            session_id,
            format!("创建录制收尾线程失败: {error}"),
        );
    }
}

enum WriterCommand {
    Record(QueuedRecord),
    Finish,
}

struct QueuedRecord {
    session_id: u64,
    direction: CaptureDirection,
    timestamp_us: u64,
    payload: Vec<u8>,
    _reservation: ByteReservation,
}

struct ByteBudget {
    capacity: usize,
    used: AtomicUsize,
}

impl ByteBudget {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            used: AtomicUsize::new(0),
        }
    }

    fn try_reserve(self: &Arc<Self>, size: usize) -> Option<ByteReservation> {
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
                    return Some(ByteReservation {
                        budget: Arc::clone(self),
                        size,
                    })
                }
                Err(actual) => used = actual,
            }
        }
    }
}

struct ByteReservation {
    budget: Arc<ByteBudget>,
    size: usize,
}

impl Drop for ByteReservation {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.size, Ordering::AcqRel);
    }
}

enum WriterOutcome {
    Completed,
    Aborted,
    Failed(String),
}

impl CaptureCore {
    fn append(
        &self,
        app: &AppHandle,
        expected_session_id: u64,
        direction: CaptureDirection,
        payload: &[u8],
    ) -> Result<(), String> {
        let mut event = None;
        let result = {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| "录制状态锁已损坏".to_owned())?;

            let worker_session_id = shared.worker.as_ref().map(|worker| worker.session_id);
            if shared.session_id != expected_session_id
                || worker_session_id != Some(expected_session_id)
            {
                return Ok(());
            }

            match shared.status {
                CaptureStatus::Idle | CaptureStatus::Stopping => Ok(()),
                CaptureStatus::Error => Err(shared
                    .message
                    .clone()
                    .unwrap_or_else(|| "录制已经终止".to_owned())),
                CaptureStatus::Recording => {
                    let size = RECORD_HEADER_SIZE.saturating_add(payload.len());
                    if payload.len() > MAX_CAPTURE_RECORD_BYTES {
                        let message = format!(
                            "单条录制数据不能超过 {} KiB，录制已中止",
                            MAX_CAPTURE_RECORD_BYTES / 1024
                        );
                        event = Some(fail_active_capture(&mut shared, message.clone()));
                        Err(message)
                    } else if let Some(worker) = shared.worker.as_ref() {
                        let worker_session_id = worker.session_id;
                        let worker_started = worker.started;
                        let worker_budget = Arc::clone(&worker.budget);
                        let worker_sender = worker.sender.clone();

                        if let Some(worker_sender) = worker_sender {
                            let reservation = worker_budget.try_reserve(size);
                            if let Some(reservation) = reservation {
                                let record = QueuedRecord {
                                    session_id: worker_session_id,
                                    direction,
                                    timestamp_us: duration_micros(worker_started.elapsed()),
                                    payload: payload.to_vec(),
                                    _reservation: reservation,
                                };
                                match worker_sender.try_send(WriterCommand::Record(record)) {
                                    Ok(()) => Ok(()),
                                    Err(mpsc::TrySendError::Full(_)) => {
                                        let message = "录制写入队列已满，录制已中止".to_owned();
                                        event =
                                            Some(fail_active_capture(&mut shared, message.clone()));
                                        Err(message)
                                    }
                                    Err(mpsc::TrySendError::Disconnected(_)) => {
                                        let message = "录制写入线程已停止，录制已中止".to_owned();
                                        event =
                                            Some(fail_active_capture(&mut shared, message.clone()));
                                        Err(message)
                                    }
                                }
                            } else {
                                let message = format!(
                                    "录制写入队列超过 {} MiB，录制已中止",
                                    WRITER_QUEUE_BYTES / 1024 / 1024
                                );
                                event = Some(fail_active_capture(&mut shared, message.clone()));
                                Err(message)
                            }
                        } else {
                            let message = "录制写入通道已关闭，录制已中止".to_owned();
                            event = Some(fail_active_capture(&mut shared, message.clone()));
                            Err(message)
                        }
                    } else {
                        let message = "录制状态异常：写入线程不存在".to_owned();
                        event = Some(fail_active_capture(&mut shared, message.clone()));
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
        data_bytes: u64,
        record_count: u64,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id
                || (shared.data_bytes == data_bytes && shared.record_count == record_count)
            {
                return None;
            }
            shared.data_bytes = data_bytes;
            shared.record_count = record_count;
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn finish_writer(
        &self,
        app: &AppHandle,
        session_id: u64,
        outcome: WriterOutcome,
        data_bytes: u64,
        record_count: u64,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id {
                return None;
            }

            shared.data_bytes = data_bytes;
            shared.record_count = record_count;
            shared.ended_at_unix_ms = Some(unix_millis());
            let preserve_error = shared.status == CaptureStatus::Error && shared.message.is_some();
            if !preserve_error {
                match outcome {
                    WriterOutcome::Completed => {
                        shared.status = CaptureStatus::Idle;
                        shared.message = None;
                    }
                    WriterOutcome::Aborted => {
                        shared.status = CaptureStatus::Error;
                        shared.message = Some("录制已中止，文件未写入结束标记".to_owned());
                    }
                    WriterOutcome::Failed(message) => {
                        shared.status = CaptureStatus::Error;
                        shared.message = Some(message);
                    }
                }
            }
            clear_finalizing_state(&mut shared, session_id);
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }

    fn publish_writer_panic(&self, app: &AppHandle, session_id: u64, message: String) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id {
                return None;
            }
            if shared.status != CaptureStatus::Error || shared.message.is_none() {
                shared.status = CaptureStatus::Error;
                shared.message = Some(message);
            }
            shared.ended_at_unix_ms = Some(unix_millis());
            clear_finalizing_state(&mut shared, session_id);
            Some(shared.touch())
        });
        if let Some(payload) = payload {
            emit_state(app, payload);
        }
    }
}

#[tauri::command]
pub fn get_capture_state(state: State<'_, CaptureState>) -> Result<CaptureStatePayload, String> {
    snapshot_capture_state(&state)
}

fn snapshot_capture_state(state: &CaptureState) -> Result<CaptureStatePayload, String> {
    state
        .core
        .shared
        .lock()
        .map_err(|_| "录制状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    state: State<'_, CaptureState>,
    request: CaptureStartRequest,
) -> Result<CaptureStatePayload, String> {
    let lifecycle = state.lifecycle_handle();
    tauri::async_runtime::spawn_blocking(move || start_capture_blocking(app, lifecycle, request))
        .await
        .map_err(|error| format!("启动录制任务失败: {error}"))?
}

fn start_capture_blocking(
    app: AppHandle,
    state: CaptureLifecycleHandle,
    request: CaptureStartRequest,
) -> Result<CaptureStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "录制生命周期锁已损坏".to_owned())?;

    let finished_finalizer_worker = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())?;
        if matches!(
            shared.status,
            CaptureStatus::Recording | CaptureStatus::Stopping
        ) {
            return Err("已有录制任务正在进行".to_owned());
        }
        if shared.finalizing.is_some() {
            match take_finished_finalizer_worker(&mut shared) {
                Some(worker) => Some(worker),
                None => return Err("上一录制任务仍在收尾，请稍后重试".to_owned()),
            }
        } else {
            None
        }
    };
    if let Some(mut worker) = finished_finalizer_worker {
        worker
            .join()
            .map_err(|message| format!("清理上一录制任务失败: {message}"))?;
    }

    let stale_worker = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())?;
        if matches!(
            shared.status,
            CaptureStatus::Recording | CaptureStatus::Stopping
        ) {
            return Err("已有录制任务正在进行".to_owned());
        }
        shared.worker.take()
    };
    if let Some(worker) = stale_worker {
        finalize_worker_in_background(
            app.clone(),
            Arc::clone(&state.core),
            worker,
            WorkerFinalization::Abort,
        );
        return Err("正在清理上一录制任务，请稍后重试".to_owned());
    }

    let started = Instant::now();
    let started_at_unix_ms = unix_millis();
    let session_id = {
        let shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())?;
        shared.session_id.wrapping_add(1).max(1)
    };
    let header = CaptureHeader {
        source: request.source,
        protocol: request.protocol,
        serial_config: request.serial_config,
        started_at_unix_ms,
        time_unit: "microseconds".to_owned(),
    };
    header.validate()?;
    let header_bytes = encode_header(&header)?;
    let (file, path) =
        create_capture_file(&app, started_at_unix_ms, session_id).inspect_err(|message| {
            publish_start_error(
                &app,
                &state.core,
                session_id,
                started_at_unix_ms,
                String::new(),
                message.clone(),
            );
        })?;
    let path_text = path.to_string_lossy().into_owned();

    let (sender, receiver) = mpsc::sync_channel(WRITER_QUEUE_RECORDS);
    let (ready_sender, ready_receiver) = mpsc::channel();
    let control = Arc::new(WriterControl::new());
    let budget = Arc::new(ByteBudget::new(WRITER_QUEUE_BYTES));
    let worker_control = Arc::clone(&control);
    let worker_core = Arc::clone(&state.core);
    let worker_app = app.clone();
    let join_handle = thread::Builder::new()
        .name("vofa-capture-writer".to_owned())
        .spawn(move || {
            let panic_app = worker_app.clone();
            let panic_core = Arc::clone(&worker_core);
            let result = catch_unwind(AssertUnwindSafe(|| {
                run_capture_writer(
                    worker_app,
                    worker_core,
                    session_id,
                    file,
                    header_bytes,
                    receiver,
                    worker_control,
                    ready_sender,
                );
            }));
            if let Err(panic) = result {
                panic_core.publish_writer_panic(
                    &panic_app,
                    session_id,
                    format!("录制写入线程异常退出: {}", panic_message(panic)),
                );
            }
        })
        .map_err(|error| {
            let message = format!("创建录制写入线程失败: {error}");
            publish_start_error(
                &app,
                &state.core,
                session_id,
                started_at_unix_ms,
                path_text.clone(),
                message.clone(),
            );
            message
        })?;

    let worker = CaptureWorker {
        session_id,
        sender: Some(sender),
        control,
        budget,
        started,
        join_handle: Some(join_handle),
    };
    let ready_error = match ready_receiver.recv_timeout(WRITER_START_TIMEOUT) {
        Ok(Ok(())) => None,
        Ok(Err(message)) => Some(message),
        Err(mpsc::RecvTimeoutError::Timeout) => Some("录制文件初始化超时".to_owned()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Some("录制写入线程在初始化时意外停止".to_owned())
        }
    };
    if let Some(message) = ready_error {
        finalize_worker_in_background(
            app.clone(),
            Arc::clone(&state.core),
            worker,
            WorkerFinalization::Abort,
        );
        publish_start_error(
            &app,
            &state.core,
            session_id,
            started_at_unix_ms,
            path_text,
            message.clone(),
        );
        return Err(message);
    }

    let payload = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())?;
        shared.session_id = session_id;
        shared.status = CaptureStatus::Recording;
        shared.path = path_text;
        shared.started_at_unix_ms = Some(started_at_unix_ms);
        shared.ended_at_unix_ms = None;
        shared.data_bytes = 0;
        shared.record_count = 0;
        shared.message = None;
        shared.worker = Some(worker);
        shared.touch()
    };
    emit_state(&app, payload.clone());

    Ok(payload)
}

#[tauri::command]
pub fn stop_capture(
    app: AppHandle,
    state: State<'_, CaptureState>,
) -> Result<CaptureStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "录制生命周期锁已损坏".to_owned())?;

    let (worker, should_finish, transition_payload) = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())?;
        let should_finish = shared.status == CaptureStatus::Recording;
        let worker = shared.worker.take();
        let payload = if should_finish {
            shared.status = CaptureStatus::Stopping;
            shared.message = Some("正在完成捕获文件".to_owned());
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
        let finalization = if should_finish {
            WorkerFinalization::Finish
        } else {
            WorkerFinalization::Abort
        };
        finalize_worker_in_background(app.clone(), Arc::clone(&state.core), worker, finalization);
    }

    snapshot_capture_state(&state)
}

#[tauri::command]
pub fn abort_capture(
    app: AppHandle,
    state: State<'_, CaptureState>,
    message: String,
) -> Result<CaptureStatePayload, String> {
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "录制生命周期锁已损坏".to_owned())?;
    let message = sanitize_abort_message(message);

    let (worker, payload) = {
        let mut shared = state
            .core
            .shared
            .lock()
            .map_err(|_| "录制状态锁已损坏".to_owned())?;
        let finalizing_control = shared
            .finalizing
            .as_ref()
            .map(|finalizing| Arc::clone(&finalizing.control));
        let has_finalizing = finalizing_control.is_some();
        let finalizing_aborted = finalizing_control
            .as_ref()
            .is_some_and(|control| control.request_abort());
        let mut worker = None;
        let mut worker_aborted = false;
        if !has_finalizing {
            if let Some(mut current_worker) = shared.worker.take() {
                if current_worker.begin_abort() {
                    worker_aborted = true;
                    worker = Some(current_worker);
                } else {
                    shared.worker = Some(current_worker);
                }
            }
        }
        let inconsistent_active = !has_finalizing
            && !worker_aborted
            && matches!(
                shared.status,
                CaptureStatus::Recording | CaptureStatus::Stopping
            );
        let should_abort = finalizing_aborted || worker_aborted || inconsistent_active;
        let payload = if should_abort {
            shared.status = CaptureStatus::Error;
            shared.ended_at_unix_ms = Some(unix_millis());
            shared.message = Some(message);
            Some(shared.touch())
        } else {
            None
        };
        (worker, payload)
    };
    if let Some(payload) = payload {
        emit_state(&app, payload);
    }
    if let Some(worker) = worker {
        finalize_worker_in_background(
            app.clone(),
            Arc::clone(&state.core),
            worker,
            WorkerFinalization::Abort,
        );
    }

    snapshot_capture_state(&state)
}

#[tauri::command]
pub fn append_simulator_capture(
    app: AppHandle,
    state: State<'_, CaptureState>,
    session_id: u64,
    direction: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let direction = CaptureDirection::parse(&direction)?;
    state
        .recorder_handle()
        .append_for_session(&app, session_id, direction, &data)
}

#[allow(clippy::too_many_arguments)]
fn run_capture_writer(
    app: AppHandle,
    core: Arc<CaptureCore>,
    session_id: u64,
    file: File,
    header_bytes: Vec<u8>,
    receiver: mpsc::Receiver<WriterCommand>,
    control: Arc<WriterControl>,
    ready_sender: mpsc::Sender<Result<(), String>>,
) {
    let mut writer = BufWriter::new(file);
    let mut data_bytes = 0_u64;
    let mut record_count = 0_u64;
    let mut last_progress = Instant::now();
    let mut progress_dirty = false;

    let initialize_result = write_file_header(&mut writer, &header_bytes)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("初始化录制文件失败: {error}"));
    let mut outcome = match initialize_result {
        Ok(()) => {
            if ready_sender.send(Ok(())).is_ok() {
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
            Ok(WriterCommand::Record(record)) => {
                if record.session_id != session_id {
                    outcome = Some(WriterOutcome::Failed("录制会话标识不匹配".to_owned()));
                    continue;
                }
                if let Err(error) = write_record(&mut writer, &record) {
                    outcome = Some(WriterOutcome::Failed(format!("写入录制数据失败: {error}")));
                    continue;
                }
                data_bytes = data_bytes.saturating_add(record.payload.len() as u64);
                record_count = record_count.saturating_add(1);
                progress_dirty = true;
            }
            Ok(WriterCommand::Finish) => {
                outcome = Some(if control.begin_commit() {
                    match write_footer(&mut writer, data_bytes, record_count) {
                        Ok(()) => WriterOutcome::Completed,
                        Err(error) => {
                            WriterOutcome::Failed(format!("写入录制结束标记失败: {error}"))
                        }
                    }
                } else if control.is_aborted() {
                    WriterOutcome::Aborted
                } else {
                    WriterOutcome::Failed("录制提交阶段状态无效".to_owned())
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                outcome = Some(if control.is_aborted() {
                    WriterOutcome::Aborted
                } else {
                    WriterOutcome::Failed("录制写入通道意外关闭".to_owned())
                });
            }
        }

        if progress_dirty && last_progress.elapsed() >= PROGRESS_INTERVAL {
            core.publish_progress(&app, session_id, data_bytes, record_count);
            progress_dirty = false;
            last_progress = Instant::now();
        }
    }

    let mut outcome = outcome.unwrap_or(WriterOutcome::Aborted);
    if let Err(error) = writer.flush() {
        outcome = WriterOutcome::Failed(format!("刷新录制文件失败: {error}"));
    } else if let Err(error) = writer.get_ref().sync_data() {
        outcome = WriterOutcome::Failed(format!("同步录制文件失败: {error}"));
    }
    if let WriterOutcome::Completed = &outcome {
        control.mark_completed();
    }
    core.finish_writer(&app, session_id, outcome, data_bytes, record_count);
}

fn write_file_header<W: Write>(writer: &mut W, header_bytes: &[u8]) -> io::Result<()> {
    let header_size = u32::try_from(header_bytes.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "JSON 文件头过长"))?;
    writer.write_all(&CAPTURE_MAGIC)?;
    writer.write_all(&CAPTURE_VERSION.to_le_bytes())?;
    writer.write_all(&0_u16.to_le_bytes())?;
    writer.write_all(&header_size.to_le_bytes())?;
    writer.write_all(header_bytes)
}

fn write_record<W: Write>(writer: &mut W, record: &QueuedRecord) -> io::Result<()> {
    let payload_size = u32::try_from(record.payload.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "录制数据过长"))?;
    if record.payload.len() > MAX_CAPTURE_RECORD_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "录制数据超过 64 KiB",
        ));
    }

    writer.write_all(&[RECORD_TAG, record.direction.code()])?;
    writer.write_all(&0_u16.to_le_bytes())?;
    writer.write_all(&record.timestamp_us.to_le_bytes())?;
    writer.write_all(&payload_size.to_le_bytes())?;
    writer.write_all(&record.payload)
}

fn write_footer<W: Write>(writer: &mut W, data_bytes: u64, record_count: u64) -> io::Result<()> {
    writer.write_all(&[FOOTER_TAG])?;
    writer.write_all(&[0_u8; 7])?;
    writer.write_all(&data_bytes.to_le_bytes())?;
    writer.write_all(&record_count.to_le_bytes())
}

fn encode_header(header: &CaptureHeader) -> Result<Vec<u8>, String> {
    let bytes =
        serde_json::to_vec(header).map_err(|error| format!("序列化录制文件头失败: {error}"))?;
    if bytes.len() > MAX_CAPTURE_HEADER_BYTES {
        return Err(format!(
            "录制文件头不能超过 {} KiB",
            MAX_CAPTURE_HEADER_BYTES / 1024
        ));
    }
    Ok(bytes)
}

fn create_capture_file(
    app: &AppHandle,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf), String> {
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

    Err(format!("无法创建录制文件：{}", errors.join("；")))
}

fn create_file_in_directory(
    directory: &Path,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("创建目录 {} 失败: {error}", directory.display()))?;

    for suffix in 0..100_u16 {
        let filename = if suffix == 0 {
            format!("capture-{started_at_unix_ms}-{session_id}.vucap")
        } else {
            format!("capture-{started_at_unix_ms}-{session_id}-{suffix}.vucap")
        };
        let path = directory.join(filename);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("创建 {} 失败: {error}", path.display())),
        }
    }

    Err("同名录制文件过多，请稍后重试".to_owned())
}

fn read_exact_section<R: Read>(
    reader: &mut R,
    buffer: &mut [u8],
    section: &'static str,
) -> Result<(), CaptureReadError> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == ErrorKind::UnexpectedEof {
            CaptureReadError::Truncated(section)
        } else {
            CaptureReadError::Io(error)
        }
    })
}

fn fail_active_capture(shared: &mut SharedCaptureState, message: String) -> CaptureStatePayload {
    if let Some(worker) = shared.worker.as_ref() {
        worker.control.request_abort();
    }
    shared.status = CaptureStatus::Error;
    shared.ended_at_unix_ms = Some(unix_millis());
    shared.message = Some(message);
    shared.touch()
}

fn publish_start_error(
    app: &AppHandle,
    core: &Arc<CaptureCore>,
    session_id: u64,
    started_at_unix_ms: u64,
    path: String,
    message: String,
) {
    let payload = core.shared.lock().ok().map(|mut shared| {
        shared.session_id = session_id;
        shared.status = CaptureStatus::Error;
        shared.path = path;
        shared.started_at_unix_ms = Some(started_at_unix_ms);
        shared.ended_at_unix_ms = Some(unix_millis());
        shared.data_bytes = 0;
        shared.record_count = 0;
        shared.message = Some(message);
        shared.touch()
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
}

fn publish_worker_finalization_error(
    app: &AppHandle,
    core: &Arc<CaptureCore>,
    session_id: u64,
    message: String,
) {
    let payload = core.shared.lock().ok().and_then(|mut shared| {
        if shared.session_id != session_id || shared.status != CaptureStatus::Stopping {
            return None;
        }
        shared.status = CaptureStatus::Error;
        shared.ended_at_unix_ms = Some(unix_millis());
        shared.message = Some(message);
        Some(shared.touch())
    });
    if let Some(payload) = payload {
        emit_state(app, payload);
    }
}

fn sanitize_abort_message(message: String) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "录制已由调用方中止".to_owned();
    }
    trimmed.chars().take(MAX_ABORT_MESSAGE_CHARS).collect()
}

fn emit_state(app: &AppHandle, payload: CaptureStatePayload) {
    let _ = app.emit("capture://state", payload);
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
    use std::io::Cursor;

    use super::*;

    fn sample_header() -> CaptureHeader {
        CaptureHeader {
            source: "serial".to_owned(),
            protocol: "raw".to_owned(),
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

    fn file_with_header() -> Vec<u8> {
        let mut bytes = Vec::new();
        write_file_header(&mut bytes, &encode_header(&sample_header()).unwrap()).unwrap();
        bytes
    }

    fn queued_record(
        budget: &Arc<ByteBudget>,
        direction: CaptureDirection,
        timestamp_us: u64,
        payload: Vec<u8>,
    ) -> QueuedRecord {
        let size = RECORD_HEADER_SIZE + payload.len();
        QueuedRecord {
            session_id: 1,
            direction,
            timestamp_us,
            payload,
            _reservation: budget.try_reserve(size).unwrap(),
        }
    }

    #[test]
    fn round_trips_mixed_records_and_footer() {
        let budget = Arc::new(ByteBudget::new(1024));
        let records = [
            queued_record(&budget, CaptureDirection::Rx, 0, vec![1, 2]),
            queued_record(&budget, CaptureDirection::Tx, 12, vec![3, 4, 5]),
            queued_record(&budget, CaptureDirection::Rx, 19, Vec::new()),
        ];
        let mut bytes = file_with_header();
        for record in &records {
            write_record(&mut bytes, record).unwrap();
        }
        write_footer(&mut bytes, 5, 3).unwrap();

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.header(), &sample_header());
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Record(CaptureRecord {
                direction: CaptureDirection::Rx,
                timestamp_us: 0,
                payload: vec![1, 2],
            })
        );
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Record(CaptureRecord {
                direction: CaptureDirection::Tx,
                timestamp_us: 12,
                payload: vec![3, 4, 5],
            })
        );
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Record(CaptureRecord {
                direction: CaptureDirection::Rx,
                timestamp_us: 19,
                payload: Vec::new(),
            })
        );
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Footer(CaptureFooter {
                data_bytes: 5,
                record_count: 3,
            })
        );
        assert!(reader.next().is_none());
    }

    #[test]
    fn resumes_from_verified_offset_with_footer_statistics() {
        let budget = Arc::new(ByteBudget::new(1024));
        let first = queued_record(&budget, CaptureDirection::Rx, 5, vec![1, 2]);
        let second = queued_record(&budget, CaptureDirection::Tx, 8, vec![3, 4, 5]);
        let mut bytes = file_with_header();
        write_record(&mut bytes, &first).unwrap();
        write_record(&mut bytes, &second).unwrap();
        write_footer(&mut bytes, 5, 2).unwrap();

        let mut scanned = CaptureReader::new(Cursor::new(bytes.clone())).unwrap();
        assert!(matches!(scanned.next(), Some(Ok(CaptureItem::Record(_)))));
        let checkpoint_offset = scanned.stream_position().unwrap();

        let mut resumed = CaptureReader::new(Cursor::new(bytes))
            .unwrap()
            .resume_from_verified(checkpoint_offset, 2, 1)
            .unwrap();
        assert_eq!(
            resumed.next().unwrap().unwrap(),
            CaptureItem::Record(CaptureRecord {
                direction: CaptureDirection::Tx,
                timestamp_us: 8,
                payload: vec![3, 4, 5],
            })
        );
        assert_eq!(
            resumed.next().unwrap().unwrap(),
            CaptureItem::Footer(CaptureFooter {
                data_bytes: 5,
                record_count: 2,
            })
        );
    }

    #[test]
    fn rejects_invalid_magic_and_future_version() {
        let mut invalid_magic = file_with_header();
        invalid_magic[0] = b'X';
        assert!(matches!(
            CaptureReader::new(Cursor::new(invalid_magic)),
            Err(CaptureReadError::InvalidMagic)
        ));

        let mut future = file_with_header();
        future[8..10].copy_from_slice(&(CAPTURE_VERSION + 1).to_le_bytes());
        assert!(matches!(
            CaptureReader::new(Cursor::new(future)),
            Err(CaptureReadError::FutureVersion(2))
        ));
    }

    #[test]
    fn rejects_invalid_serial_metadata() {
        let mut header = sample_header();
        header.serial_config.data_bits = 9;
        let mut bytes = Vec::new();
        write_file_header(&mut bytes, &serde_json::to_vec(&header).unwrap()).unwrap();

        assert!(matches!(
            CaptureReader::new(Cursor::new(bytes)),
            Err(CaptureReadError::InvalidHeader(_))
        ));
    }

    #[test]
    fn state_payload_omits_absent_optional_values() {
        let payload = SharedCaptureState::default().snapshot();
        let json = serde_json::to_value(payload).unwrap();

        assert!(json.get("startedAtUnixMs").is_none());
        assert!(json.get("endedAtUnixMs").is_none());
        assert!(json.get("message").is_none());
    }

    #[test]
    fn clears_only_the_matching_finalizing_gate() {
        let mut shared = SharedCaptureState::default();
        let (_done_sender, done_receiver) = mpsc::channel();
        shared.finalizing = Some(FinalizingCapture {
            session_id: 7,
            control: Arc::new(WriterControl::new()),
            done_receiver,
            worker_slot: Arc::new(Mutex::new(None)),
        });

        clear_finalizing_state(&mut shared, 6);
        assert_eq!(
            shared
                .finalizing
                .as_ref()
                .map(|finalizing| finalizing.session_id),
            Some(7)
        );

        clear_finalizing_state(&mut shared, 7);
        assert!(shared.finalizing.is_none());
    }

    #[test]
    fn abort_wins_before_footer_commit() {
        let control = WriterControl::new();

        assert!(control.request_finish());
        assert!(control.request_abort());
        assert!(control.is_aborted());
        assert!(!control.begin_commit());
    }

    #[test]
    fn abort_is_rejected_after_footer_commit_begins() {
        let control = WriterControl::new();

        assert!(control.request_finish());
        assert!(control.begin_commit());
        assert!(!control.request_abort());
        control.mark_completed();
        assert!(!control.request_abort());
    }

    #[test]
    fn rejects_oversized_header_and_record_before_allocating_payload() {
        let mut oversized_header = Vec::new();
        oversized_header.extend_from_slice(&CAPTURE_MAGIC);
        oversized_header.extend_from_slice(&CAPTURE_VERSION.to_le_bytes());
        oversized_header.extend_from_slice(&0_u16.to_le_bytes());
        oversized_header.extend_from_slice(&((MAX_CAPTURE_HEADER_BYTES + 1) as u32).to_le_bytes());
        assert!(matches!(
            CaptureReader::new(Cursor::new(oversized_header)),
            Err(CaptureReadError::HeaderTooLarge(_))
        ));

        let mut oversized_record = file_with_header();
        oversized_record.push(RECORD_TAG);
        oversized_record.push(CaptureDirection::Rx.code());
        oversized_record.extend_from_slice(&0_u16.to_le_bytes());
        oversized_record.extend_from_slice(&0_u64.to_le_bytes());
        oversized_record.extend_from_slice(&((MAX_CAPTURE_RECORD_BYTES + 1) as u32).to_le_bytes());
        let mut reader = CaptureReader::new(Cursor::new(oversized_record)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::RecordTooLarge(_)))
        ));
    }

    #[test]
    fn reports_truncated_record_and_missing_footer() {
        let mut truncated_record = file_with_header();
        truncated_record.push(RECORD_TAG);
        truncated_record.push(CaptureDirection::Rx.code());
        truncated_record.extend_from_slice(&0_u16.to_le_bytes());
        truncated_record.extend_from_slice(&3_u64.to_le_bytes());
        truncated_record.extend_from_slice(&2_u32.to_le_bytes());
        truncated_record.push(0xaa);
        let mut reader = CaptureReader::new(Cursor::new(truncated_record)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Truncated("记录数据")))
        ));

        let mut reader = CaptureReader::new(Cursor::new(file_with_header())).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Truncated("正常结束标记")))
        ));
    }

    #[test]
    fn validates_footer_statistics_and_trailing_data() {
        let mut wrong_stats = file_with_header();
        write_footer(&mut wrong_stats, 1, 0).unwrap();
        let mut reader = CaptureReader::new(Cursor::new(wrong_stats)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(_)))
        ));

        let mut trailing = file_with_header();
        write_footer(&mut trailing, 0, 0).unwrap();
        trailing.push(0);
        let mut reader = CaptureReader::new(Cursor::new(trailing)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(_)))
        ));
    }

    #[test]
    fn byte_budget_rejection_does_not_wait_for_release() {
        let budget = Arc::new(ByteBudget::new(8));
        let reservation = budget.try_reserve(8).unwrap();
        let worker_budget = Arc::clone(&budget);
        let (sender, receiver) = mpsc::channel();

        let join_handle = thread::spawn(move || {
            sender.send(worker_budget.try_reserve(1).is_none()).unwrap();
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)), Ok(true));
        join_handle.join().unwrap();

        drop(reservation);
        assert!(budget.try_reserve(8).is_some());
    }
}
