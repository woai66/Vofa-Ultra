use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::recording_directory::resolve_custom_recording_directory;
use crate::serial::SerialConfig;

pub const CAPTURE_MAGIC: [u8; 8] = *b"VUCAP\0\r\n";
pub const CAPTURE_VERSION: u16 = CAPTURE_VERSION_V3;
pub const MAX_CAPTURE_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_CAPTURE_RECORD_BYTES: usize = 64 * 1024;
pub const MAX_CAPTURE_MARKERS: u64 = 512;
pub const MAX_CAPTURE_MARKER_LABEL_CHARS: usize = 64;
pub const MAX_CAPTURE_MARKER_LABEL_BYTES: usize = 256;

const FILE_HEADER_SIZE: usize = 16;
const CAPTURE_VERSION_V1: u16 = 1;
pub(crate) const CAPTURE_VERSION_V2: u16 = 2;
const CAPTURE_VERSION_V3: u16 = 3;
const CAPTURE_READABLE_VERSIONS: &[u16] =
    &[CAPTURE_VERSION_V1, CAPTURE_VERSION_V2, CAPTURE_VERSION_V3];
const RECORD_TAG: u8 = 0x01;
const MARKER_TAG: u8 = 0x02;
const FOOTER_TAG: u8 = 0xff;
const RECORD_HEADER_SIZE: usize = 16;
const MARKER_HEADER_SIZE: usize = 16;
const V1_FOOTER_SIZE: usize = 24;
const V2_FOOTER_SIZE: usize = 32;
const SHA256_CHECKSUM_SIZE: usize = 32;
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
const SUPPORTED_CAPTURE_PROTOCOLS: &[&str] = &["firewater", "justfloat", "raw"];

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
        if !SUPPORTED_CAPTURE_PROTOCOLS.contains(&self.protocol.as_str()) {
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[repr(u8)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMarkerColor {
    Gray = 0,
    Red = 1,
    Orange = 2,
    Yellow = 3,
    Green = 4,
    Blue = 5,
    Purple = 6,
}

impl CaptureMarkerColor {
    fn from_code(code: u8) -> Result<Self, CaptureReadError> {
        match code {
            0 => Ok(Self::Gray),
            1 => Ok(Self::Red),
            2 => Ok(Self::Orange),
            3 => Ok(Self::Yellow),
            4 => Ok(Self::Green),
            5 => Ok(Self::Blue),
            6 => Ok(Self::Purple),
            _ => Err(CaptureReadError::InvalidMarkerColor(code)),
        }
    }

    fn code(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureMarker {
    pub color: CaptureMarkerColor,
    pub timestamp_us: u64,
    pub label: String,
}

#[derive(Clone, Default)]
pub(crate) struct CaptureRecordStats {
    last_timestamp_us: Option<u64>,
    data_bytes: u64,
    record_count: u64,
    marker_count: u64,
}

impl CaptureRecordStats {
    pub(crate) fn observe(&mut self, record: &CaptureRecord) -> Result<(), String> {
        self.observe_record_parts(record.timestamp_us, record.payload.len())
    }

    pub(crate) fn observe_marker(&mut self, marker: &CaptureMarker) -> Result<(), String> {
        self.observe_marker_timestamp(marker.timestamp_us)
    }

    fn observe_record_parts(
        &mut self,
        timestamp_us: u64,
        payload_size: usize,
    ) -> Result<(), String> {
        self.observe_timestamp(timestamp_us)?;
        self.data_bytes = self.data_bytes.saturating_add(payload_size as u64);
        self.record_count = self.record_count.saturating_add(1);
        Ok(())
    }

    fn observe_marker_timestamp(&mut self, timestamp_us: u64) -> Result<(), String> {
        self.observe_timestamp(timestamp_us)?;
        self.marker_count = self.marker_count.saturating_add(1);
        Ok(())
    }

    fn observe_timestamp(&mut self, timestamp_us: u64) -> Result<(), String> {
        if self
            .last_timestamp_us
            .map(|last| timestamp_us < last)
            .unwrap_or(false)
        {
            return Err(format!(
                "捕获时间戳从 {} 微秒回退到 {} 微秒",
                self.last_timestamp_us.unwrap_or(0),
                timestamp_us
            ));
        }
        self.last_timestamp_us = Some(timestamp_us);
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

    pub(crate) fn marker_count(&self) -> u64 {
        self.marker_count
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureFooter {
    pub data_bytes: u64,
    pub record_count: u64,
    pub marker_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureItem {
    Record(CaptureRecord),
    Marker(CaptureMarker),
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
    MarkerLabelTooLarge(u32),
    InvalidHeader(String),
    InvalidDirection(u8),
    InvalidMarkerColor(u8),
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
            Self::MarkerLabelTooLarge(size) => {
                write!(formatter, "捕获标记标签超过 256 字节: {size} 字节")
            }
            Self::InvalidHeader(message) => write!(formatter, "捕获文件头无效: {message}"),
            Self::InvalidDirection(direction) => write!(formatter, "捕获记录方向无效: {direction}"),
            Self::InvalidMarkerColor(color) => write!(formatter, "捕获标记颜色无效: {color}"),
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
    version: u16,
    header: CaptureHeader,
    stats: CaptureRecordStats,
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
        match version {
            version if CAPTURE_READABLE_VERSIONS.contains(&version) => {}
            version if version > CAPTURE_VERSION => {
                return Err(CaptureReadError::FutureVersion(version))
            }
            version => return Err(CaptureReadError::UnsupportedVersion(version)),
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
        if version >= CAPTURE_VERSION_V3 {
            read_and_verify_sha256(
                &mut reader,
                &[&prefix, &header_bytes],
                "文件头校验值",
                "固定文件头与 JSON 文件头",
            )?;
        }
        let header: CaptureHeader = serde_json::from_slice(&header_bytes)
            .map_err(|error| CaptureReadError::InvalidHeader(error.to_string()))?;
        header.validate().map_err(CaptureReadError::InvalidHeader)?;

        Ok(Self {
            reader,
            version,
            header,
            stats: CaptureRecordStats::default(),
            done: false,
        })
    }

    pub fn version(&self) -> u16 {
        self.version
    }

    pub fn header(&self) -> &CaptureHeader {
        &self.header
    }

    fn read_item(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut tag = [0_u8; 1];
        read_exact_section(&mut self.reader, &mut tag, "正常结束标记")?;

        match tag[0] {
            RECORD_TAG => self.read_record(),
            MARKER_TAG if self.version >= CAPTURE_VERSION_V2 => self.read_marker(),
            FOOTER_TAG => self.read_footer(),
            tag => Err(CaptureReadError::InvalidTag(tag)),
        }
    }

    fn read_record(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut item_header = [0_u8; RECORD_HEADER_SIZE];
        item_header[0] = RECORD_TAG;
        read_exact_section(&mut self.reader, &mut item_header[1..], "记录头")?;
        let header = &item_header[1..];

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
        if self.version >= CAPTURE_VERSION_V3 {
            read_and_verify_sha256(
                &mut self.reader,
                &[&item_header, &payload],
                "记录校验值",
                "数据记录",
            )?;
        }
        let record = CaptureRecord {
            direction,
            timestamp_us,
            payload,
        };
        self.stats
            .observe(&record)
            .map_err(CaptureReadError::Corrupt)?;

        Ok(CaptureItem::Record(record))
    }

    fn read_marker(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut item_header = [0_u8; MARKER_HEADER_SIZE];
        item_header[0] = MARKER_TAG;
        read_exact_section(&mut self.reader, &mut item_header[1..], "标记头")?;
        let header = &item_header[1..];

        let color = CaptureMarkerColor::from_code(header[0])?;
        let reserved = u16::from_le_bytes([header[1], header[2]]);
        if reserved != 0 {
            return Err(CaptureReadError::Corrupt(format!(
                "标记保留字段必须为 0，实际为 {reserved}"
            )));
        }

        let timestamp_us = u64::from_le_bytes(header[3..11].try_into().expect("时间戳长度固定"));
        let label_size = u32::from_le_bytes(header[11..15].try_into().expect("标签长度字段固定"));
        if label_size as usize > MAX_CAPTURE_MARKER_LABEL_BYTES {
            return Err(CaptureReadError::MarkerLabelTooLarge(label_size));
        }

        let mut label_bytes = vec![0_u8; label_size as usize];
        read_exact_section(&mut self.reader, &mut label_bytes, "标记标签")?;
        if self.version >= CAPTURE_VERSION_V3 {
            read_and_verify_sha256(
                &mut self.reader,
                &[&item_header, &label_bytes],
                "标记校验值",
                "时间线标记",
            )?;
        }
        let label = String::from_utf8(label_bytes)
            .map_err(|_| CaptureReadError::Corrupt("标记标签不是有效 UTF-8".to_owned()))?;
        validate_marker_label(&label).map_err(CaptureReadError::Corrupt)?;
        if self.stats.marker_count() >= MAX_CAPTURE_MARKERS {
            return Err(CaptureReadError::Corrupt(format!(
                "捕获标记不能超过 {MAX_CAPTURE_MARKERS} 个"
            )));
        }

        let marker = CaptureMarker {
            color,
            timestamp_us,
            label,
        };
        self.stats
            .observe_marker(&marker)
            .map_err(CaptureReadError::Corrupt)?;

        Ok(CaptureItem::Marker(marker))
    }

    fn read_footer(&mut self) -> Result<CaptureItem, CaptureReadError> {
        let mut footer = [0_u8; V2_FOOTER_SIZE];
        footer[0] = FOOTER_TAG;
        read_exact_section(&mut self.reader, &mut footer[1..V1_FOOTER_SIZE], "结束标记")?;

        if footer[1..8].iter().any(|byte| *byte != 0) {
            return Err(CaptureReadError::Corrupt(
                "结束标记保留字段必须为 0".to_owned(),
            ));
        }
        let data_bytes = u64::from_le_bytes(footer[8..16].try_into().expect("字节计数字段固定"));
        let record_count = u64::from_le_bytes(footer[16..24].try_into().expect("记录计数字段固定"));
        let marker_count = if self.version >= CAPTURE_VERSION_V2 {
            read_exact_section(
                &mut self.reader,
                &mut footer[V1_FOOTER_SIZE..V2_FOOTER_SIZE],
                "标记计数",
            )?;
            u64::from_le_bytes(
                footer[V1_FOOTER_SIZE..V2_FOOTER_SIZE]
                    .try_into()
                    .expect("标记计数字段固定"),
            )
        } else {
            0
        };
        if self.version >= CAPTURE_VERSION_V3 {
            read_and_verify_sha256(&mut self.reader, &[&footer], "结束标记校验值", "结束标记")?;
        }
        if data_bytes != self.stats.data_bytes()
            || record_count != self.stats.record_count()
            || marker_count != self.stats.marker_count()
        {
            return Err(CaptureReadError::Corrupt(format!(
                "结束统计不匹配，期望 {} 字节/{} 条记录/{} 个标记，实际 {data_bytes} 字节/\
                 {record_count} 条记录/{marker_count} 个标记",
                self.stats.data_bytes(),
                self.stats.record_count(),
                self.stats.marker_count()
            )));
        }

        let footer = CaptureFooter {
            data_bytes,
            record_count,
            marker_count,
        };
        loop {
            let mut trailing = [0_u8; 1];
            match self.reader.read(&mut trailing) {
                Ok(0) => return Ok(CaptureItem::Footer(footer)),
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
        marker_count: u64,
        last_timestamp_us: Option<u64>,
    ) -> Result<Self, CaptureReadError> {
        self.reader
            .seek(SeekFrom::Start(file_offset))
            .map_err(CaptureReadError::Io)?;
        self.stats = CaptureRecordStats {
            last_timestamp_us,
            data_bytes,
            record_count,
            marker_count,
        };
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
        if !matches!(result, Ok(CaptureItem::Record(_) | CaptureItem::Marker(_))) {
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
    destination_directory: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatePayload {
    status: String,
    session_id: u64,
    revision: u64,
    format_version: u16,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_unix_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended_at_unix_ms: Option<u64>,
    data_bytes: u64,
    record_count: u64,
    marker_count: u64,
    queue_bytes: usize,
    queue_capacity_bytes: usize,
    queue_records: usize,
    queue_capacity_records: usize,
    queue_peak_bytes: usize,
    queue_peak_records: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    termination_reason: Option<String>,
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

    pub fn append_marker_for_session(
        &self,
        app: &AppHandle,
        session_id: u64,
        color: CaptureMarkerColor,
        label: &str,
    ) -> Result<(), String> {
        self.core
            .append_marker(app, session_id, color, label.trim())
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
    marker_count: u64,
    queue_budget: Option<Arc<ByteBudget>>,
    termination_reason: Option<String>,
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
            marker_count: 0,
            queue_budget: None,
            termination_reason: None,
            message: None,
            worker: None,
            finalizing: None,
        }
    }
}

impl SharedCaptureState {
    fn snapshot(&self) -> CaptureStatePayload {
        let queue = self
            .queue_budget
            .as_ref()
            .map(|budget| budget.snapshot())
            .unwrap_or_default();
        CaptureStatePayload {
            status: self.status.as_str().to_owned(),
            session_id: self.session_id,
            revision: self.revision,
            format_version: CAPTURE_VERSION,
            path: self.path.clone(),
            started_at_unix_ms: self.started_at_unix_ms,
            ended_at_unix_ms: self.ended_at_unix_ms,
            data_bytes: self.data_bytes,
            record_count: self.record_count,
            marker_count: self.marker_count,
            queue_bytes: queue.bytes,
            queue_capacity_bytes: queue.capacity_bytes,
            queue_records: queue.records,
            queue_capacity_records: queue.capacity_records,
            queue_peak_bytes: queue.peak_bytes,
            queue_peak_records: queue.peak_records,
            termination_reason: self.termination_reason.clone(),
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
    accepted_marker_count: u64,
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
    Marker(QueuedMarker),
    Finish,
}

struct QueuedRecord {
    session_id: u64,
    direction: CaptureDirection,
    timestamp_us: u64,
    payload: Vec<u8>,
    _reservation: ByteReservation,
}

struct QueuedMarker {
    session_id: u64,
    color: CaptureMarkerColor,
    timestamp_us: u64,
    label: String,
    _reservation: ByteReservation,
}

struct ByteBudget {
    capacity: usize,
    used: AtomicUsize,
    record_capacity: usize,
    used_records: AtomicUsize,
    peak: AtomicUsize,
    peak_records: AtomicUsize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueReserveError {
    ByteCapacity,
    RecordCapacity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CaptureQueueSnapshot {
    bytes: usize,
    capacity_bytes: usize,
    records: usize,
    capacity_records: usize,
    peak_bytes: usize,
    peak_records: usize,
}

impl Default for CaptureQueueSnapshot {
    fn default() -> Self {
        Self {
            bytes: 0,
            capacity_bytes: WRITER_QUEUE_BYTES,
            records: 0,
            capacity_records: WRITER_QUEUE_RECORDS,
            peak_bytes: 0,
            peak_records: 0,
        }
    }
}

impl ByteBudget {
    fn new(capacity: usize, record_capacity: usize) -> Self {
        Self {
            capacity,
            used: AtomicUsize::new(0),
            record_capacity,
            used_records: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            peak_records: AtomicUsize::new(0),
        }
    }

    fn try_reserve(self: &Arc<Self>, size: usize) -> Result<ByteReservation, QueueReserveError> {
        let mut used_records = self.used_records.load(Ordering::Acquire);
        let reserved_records = loop {
            let next = used_records
                .checked_add(1)
                .ok_or(QueueReserveError::RecordCapacity)?;
            if next > self.record_capacity {
                return Err(QueueReserveError::RecordCapacity);
            }
            match self.used_records.compare_exchange_weak(
                used_records,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    break next;
                }
                Err(actual) => used_records = actual,
            }
        };

        let mut used = self.used.load(Ordering::Acquire);
        loop {
            let Some(next) = used.checked_add(size) else {
                self.used_records.fetch_sub(1, Ordering::AcqRel);
                return Err(QueueReserveError::ByteCapacity);
            };
            if next > self.capacity {
                self.used_records.fetch_sub(1, Ordering::AcqRel);
                return Err(QueueReserveError::ByteCapacity);
            }
            match self
                .used
                .compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    update_peak(&self.peak, next);
                    update_peak(&self.peak_records, reserved_records);
                    return Ok(ByteReservation {
                        budget: Arc::clone(self),
                        size,
                    });
                }
                Err(actual) => used = actual,
            }
        }
    }

    fn snapshot(&self) -> CaptureQueueSnapshot {
        CaptureQueueSnapshot {
            bytes: self.used.load(Ordering::Acquire),
            capacity_bytes: self.capacity,
            records: self.used_records.load(Ordering::Acquire),
            capacity_records: self.record_capacity,
            peak_bytes: self.peak.load(Ordering::Acquire),
            peak_records: self.peak_records.load(Ordering::Acquire),
        }
    }
}

fn update_peak(peak: &AtomicUsize, value: usize) {
    let mut current = peak.load(Ordering::Acquire);
    while value > current {
        match peak.compare_exchange_weak(current, value, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return,
            Err(actual) => current = actual,
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
        self.budget.used_records.fetch_sub(1, Ordering::AcqRel);
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
                        event = Some(fail_active_capture(
                            &mut shared,
                            "record-too-large",
                            message.clone(),
                        ));
                        Err(message)
                    } else if let Some(worker) = shared.worker.as_ref() {
                        let worker_session_id = worker.session_id;
                        let worker_started = worker.started;
                        let worker_budget = Arc::clone(&worker.budget);
                        let worker_sender = worker.sender.clone();

                        if let Some(worker_sender) = worker_sender {
                            match worker_budget.try_reserve(size) {
                                Ok(reservation) => {
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
                                            event = Some(fail_active_capture(
                                                &mut shared,
                                                "queue-record-capacity",
                                                message.clone(),
                                            ));
                                            Err(message)
                                        }
                                        Err(mpsc::TrySendError::Disconnected(_)) => {
                                            let message =
                                                "录制写入线程已停止，录制已中止".to_owned();
                                            event = Some(fail_active_capture(
                                                &mut shared,
                                                "writer-disconnected",
                                                message.clone(),
                                            ));
                                            Err(message)
                                        }
                                    }
                                }
                                Err(reservation_error) => {
                                    let (reason, message) = match reservation_error {
                                        QueueReserveError::RecordCapacity => (
                                            "queue-record-capacity",
                                            format!(
                                                "录制写入队列超过 {WRITER_QUEUE_RECORDS} 条，录制已中止"
                                            ),
                                        ),
                                        QueueReserveError::ByteCapacity => (
                                            "queue-byte-capacity",
                                            format!(
                                                "录制写入队列超过 {} MiB，录制已中止",
                                                WRITER_QUEUE_BYTES / 1024 / 1024
                                            ),
                                        ),
                                    };
                                    event = Some(fail_active_capture(
                                        &mut shared,
                                        reason,
                                        message.clone(),
                                    ));
                                    Err(message)
                                }
                            }
                        } else {
                            let message = "录制写入通道已关闭，录制已中止".to_owned();
                            event = Some(fail_active_capture(
                                &mut shared,
                                "writer-channel-closed",
                                message.clone(),
                            ));
                            Err(message)
                        }
                    } else {
                        let message = "录制状态异常：写入线程不存在".to_owned();
                        event = Some(fail_active_capture(
                            &mut shared,
                            "writer-missing",
                            message.clone(),
                        ));
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

    fn append_marker(
        &self,
        app: &AppHandle,
        expected_session_id: u64,
        color: CaptureMarkerColor,
        label: &str,
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
                    if let Err(message) = validate_marker_label(label) {
                        Err(message)
                    } else {
                        let size = MARKER_HEADER_SIZE.saturating_add(label.len());
                        let enqueue_result = match shared.worker.as_mut() {
                            Some(worker) if worker.accepted_marker_count >= MAX_CAPTURE_MARKERS => {
                                Err((
                                    format!("单次捕获最多添加 {MAX_CAPTURE_MARKERS} 个标记"),
                                    false,
                                    None,
                                ))
                            }
                            Some(worker) => {
                                let timestamp_us = duration_micros(worker.started.elapsed());
                                match worker.sender.clone() {
                                    Some(sender) => match worker.budget.try_reserve(size) {
                                        Ok(reservation) => {
                                            let marker = QueuedMarker {
                                                session_id: worker.session_id,
                                                color,
                                                timestamp_us,
                                                label: label.to_owned(),
                                                _reservation: reservation,
                                            };
                                            match sender.try_send(WriterCommand::Marker(marker)) {
                                                Ok(()) => {
                                                    worker.accepted_marker_count = worker
                                                        .accepted_marker_count
                                                        .saturating_add(1);
                                                    Ok(())
                                                }
                                                Err(mpsc::TrySendError::Full(_)) => Err((
                                                    "录制写入队列已满，录制已中止".to_owned(),
                                                    true,
                                                    Some("queue-record-capacity"),
                                                )),
                                                Err(mpsc::TrySendError::Disconnected(_)) => Err((
                                                    "录制写入线程已停止，录制已中止".to_owned(),
                                                    true,
                                                    Some("writer-disconnected"),
                                                )),
                                            }
                                        }
                                        Err(QueueReserveError::ByteCapacity) => Err((
                                            format!(
                                                "录制写入队列超过 {} MiB，录制已中止",
                                                WRITER_QUEUE_BYTES / 1024 / 1024
                                            ),
                                            true,
                                            Some("queue-byte-capacity"),
                                        )),
                                        Err(QueueReserveError::RecordCapacity) => Err((
                                            format!(
                                                "录制写入队列超过 {WRITER_QUEUE_RECORDS} 条，录制已中止"
                                            ),
                                            true,
                                            Some("queue-record-capacity"),
                                        )),
                                    },
                                    None => Err((
                                        "录制写入通道已关闭，录制已中止".to_owned(),
                                        true,
                                        Some("writer-channel-closed"),
                                    )),
                                }
                            }
                            None => Err((
                                "录制状态异常：写入线程不存在".to_owned(),
                                true,
                                Some("writer-missing"),
                            )),
                        };

                        match enqueue_result {
                            Ok(()) => Ok(()),
                            Err((message, false, _)) => Err(message),
                            Err((message, true, reason)) => {
                                event = Some(fail_active_capture(
                                    &mut shared,
                                    reason.unwrap_or("queue-failed"),
                                    message.clone(),
                                ));
                                Err(message)
                            }
                        }
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
        marker_count: u64,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id
                || (shared.data_bytes == data_bytes
                    && shared.record_count == record_count
                    && shared.marker_count == marker_count)
            {
                return None;
            }
            shared.data_bytes = data_bytes;
            shared.record_count = record_count;
            shared.marker_count = marker_count;
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
        marker_count: u64,
    ) {
        let payload = self.shared.lock().ok().and_then(|mut shared| {
            if shared.session_id != session_id {
                return None;
            }

            shared.data_bytes = data_bytes;
            shared.record_count = record_count;
            shared.marker_count = marker_count;
            shared.ended_at_unix_ms = Some(unix_millis());
            let preserve_error = shared.status == CaptureStatus::Error && shared.message.is_some();
            if !preserve_error {
                match outcome {
                    WriterOutcome::Completed => {
                        shared.status = CaptureStatus::Idle;
                        shared.termination_reason = None;
                        shared.message = None;
                    }
                    WriterOutcome::Aborted => {
                        shared.status = CaptureStatus::Error;
                        shared.termination_reason = Some("writer-aborted".to_owned());
                        shared.message = Some("录制已中止，文件未写入结束标记".to_owned());
                    }
                    WriterOutcome::Failed(message) => {
                        shared.status = CaptureStatus::Error;
                        shared.termination_reason = Some("writer-failed".to_owned());
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
                shared.termination_reason = Some("writer-panic".to_owned());
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
    let CaptureStartRequest {
        source,
        protocol,
        serial_config,
        destination_directory,
    } = request;
    let header = CaptureHeader {
        source,
        protocol,
        serial_config,
        started_at_unix_ms,
        time_unit: "microseconds".to_owned(),
    };
    header.validate()?;
    let header_bytes = encode_header(&header)?;
    let (file, path) = create_capture_file(
        &app,
        destination_directory.as_deref(),
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
    let path_text = path.to_string_lossy().into_owned();

    let (sender, receiver) = mpsc::sync_channel(WRITER_QUEUE_RECORDS);
    let (ready_sender, ready_receiver) = mpsc::channel();
    let control = Arc::new(WriterControl::new());
    let budget = Arc::new(ByteBudget::new(WRITER_QUEUE_BYTES, WRITER_QUEUE_RECORDS));
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
        budget: Arc::clone(&budget),
        started,
        accepted_marker_count: 0,
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
        shared.marker_count = 0;
        shared.queue_budget = Some(Arc::clone(&budget));
        shared.termination_reason = None;
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
            shared.termination_reason = Some("caller-aborted".to_owned());
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

#[tauri::command]
pub fn append_capture_marker(
    app: AppHandle,
    state: State<'_, CaptureState>,
    session_id: u64,
    color: CaptureMarkerColor,
    label: String,
) -> Result<(), String> {
    state
        .recorder_handle()
        .append_marker_for_session(&app, session_id, color, &label)
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
    let mut stats = CaptureRecordStats::default();
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
                let mut next_stats = stats.clone();
                if let Err(message) =
                    next_stats.observe_record_parts(record.timestamp_us, record.payload.len())
                {
                    outcome = Some(WriterOutcome::Failed(message));
                    continue;
                }
                if let Err(error) = write_record(&mut writer, &record) {
                    outcome = Some(WriterOutcome::Failed(format!("写入录制数据失败: {error}")));
                    continue;
                }
                stats = next_stats;
                progress_dirty = true;
            }
            Ok(WriterCommand::Marker(marker)) => {
                if marker.session_id != session_id {
                    outcome = Some(WriterOutcome::Failed("录制会话标识不匹配".to_owned()));
                    continue;
                }
                if stats.marker_count() >= MAX_CAPTURE_MARKERS {
                    outcome = Some(WriterOutcome::Failed(format!(
                        "单次捕获最多添加 {MAX_CAPTURE_MARKERS} 个标记"
                    )));
                    continue;
                }
                let mut next_stats = stats.clone();
                if let Err(message) = next_stats.observe_marker_timestamp(marker.timestamp_us) {
                    outcome = Some(WriterOutcome::Failed(message));
                    continue;
                }
                if let Err(error) = write_marker(&mut writer, &marker) {
                    outcome = Some(WriterOutcome::Failed(format!("写入捕获标记失败: {error}")));
                    continue;
                }
                stats = next_stats;
                progress_dirty = true;
            }
            Ok(WriterCommand::Finish) => {
                outcome = Some(if control.begin_commit() {
                    match write_footer(
                        &mut writer,
                        stats.data_bytes(),
                        stats.record_count(),
                        stats.marker_count(),
                    ) {
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

        match flush_progress_if_due(
            &mut writer,
            &mut progress_dirty,
            &mut last_progress,
            Instant::now(),
        ) {
            Ok(true) => core.publish_progress(
                &app,
                session_id,
                stats.data_bytes(),
                stats.record_count(),
                stats.marker_count(),
            ),
            Ok(false) => {}
            Err(error) => {
                outcome = Some(WriterOutcome::Failed(format!("刷新录制文件失败: {error}")));
            }
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
    core.finish_writer(
        &app,
        session_id,
        outcome,
        stats.data_bytes(),
        stats.record_count(),
        stats.marker_count(),
    );
}

fn flush_progress_if_due<W: Write>(
    writer: &mut W,
    progress_dirty: &mut bool,
    last_progress: &mut Instant,
    now: Instant,
) -> io::Result<bool> {
    if !*progress_dirty || now.saturating_duration_since(*last_progress) < PROGRESS_INTERVAL {
        return Ok(false);
    }

    writer.flush()?;
    *progress_dirty = false;
    *last_progress = now;
    Ok(true)
}

fn write_file_header<W: Write>(writer: &mut W, header_bytes: &[u8]) -> io::Result<()> {
    let header_size = u32::try_from(header_bytes.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "JSON 文件头过长"))?;
    let mut prefix = [0_u8; FILE_HEADER_SIZE];
    prefix[..CAPTURE_MAGIC.len()].copy_from_slice(&CAPTURE_MAGIC);
    prefix[8..10].copy_from_slice(&CAPTURE_VERSION.to_le_bytes());
    prefix[12..16].copy_from_slice(&header_size.to_le_bytes());

    writer.write_all(&prefix)?;
    writer.write_all(header_bytes)?;
    write_sha256(writer, &[&prefix, header_bytes])
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

    let mut header = [0_u8; RECORD_HEADER_SIZE];
    header[0] = RECORD_TAG;
    header[1] = record.direction.code();
    header[4..12].copy_from_slice(&record.timestamp_us.to_le_bytes());
    header[12..16].copy_from_slice(&payload_size.to_le_bytes());

    writer.write_all(&header)?;
    writer.write_all(&record.payload)?;
    write_sha256(writer, &[&header, &record.payload])
}

fn write_marker<W: Write>(writer: &mut W, marker: &QueuedMarker) -> io::Result<()> {
    validate_marker_label(&marker.label)
        .map_err(|message| io::Error::new(ErrorKind::InvalidInput, message))?;
    let label_size = u32::try_from(marker.label.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "捕获标记标签过长"))?;

    let mut header = [0_u8; MARKER_HEADER_SIZE];
    header[0] = MARKER_TAG;
    header[1] = marker.color.code();
    header[4..12].copy_from_slice(&marker.timestamp_us.to_le_bytes());
    header[12..16].copy_from_slice(&label_size.to_le_bytes());

    writer.write_all(&header)?;
    writer.write_all(marker.label.as_bytes())?;
    write_sha256(writer, &[&header, marker.label.as_bytes()])
}

fn write_footer<W: Write>(
    writer: &mut W,
    data_bytes: u64,
    record_count: u64,
    marker_count: u64,
) -> io::Result<()> {
    let mut footer = [0_u8; V2_FOOTER_SIZE];
    footer[0] = FOOTER_TAG;
    footer[8..16].copy_from_slice(&data_bytes.to_le_bytes());
    footer[16..24].copy_from_slice(&record_count.to_le_bytes());
    footer[24..32].copy_from_slice(&marker_count.to_le_bytes());

    writer.write_all(&footer)?;
    write_sha256(writer, &[&footer])
}

fn sha256(parts: &[&[u8]]) -> [u8; SHA256_CHECKSUM_SIZE] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    let digest = hasher.finalize();
    let mut checksum = [0_u8; SHA256_CHECKSUM_SIZE];
    checksum.copy_from_slice(&digest);
    checksum
}

fn write_sha256<W: Write>(writer: &mut W, parts: &[&[u8]]) -> io::Result<()> {
    writer.write_all(&sha256(parts))
}

fn validate_marker_label(label: &str) -> Result<(), String> {
    if label.is_empty() {
        return Err("捕获标记标签不能为空".to_owned());
    }
    if label.len() > MAX_CAPTURE_MARKER_LABEL_BYTES {
        return Err(format!(
            "捕获标记标签不能超过 {MAX_CAPTURE_MARKER_LABEL_BYTES} 个 UTF-8 字节"
        ));
    }

    let mut char_count = 0_usize;
    for character in label.chars() {
        if character.is_control() {
            return Err("捕获标记标签不能包含控制字符".to_owned());
        }
        char_count = char_count.saturating_add(1);
        if char_count > MAX_CAPTURE_MARKER_LABEL_CHARS {
            return Err(format!(
                "捕获标记标签不能超过 {MAX_CAPTURE_MARKER_LABEL_CHARS} 个 Unicode 字符"
            ));
        }
    }
    if label.trim() != label {
        return Err("捕获标记标签不能包含首尾空白".to_owned());
    }
    Ok(())
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
    destination_directory: Option<&str>,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf), String> {
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

    Err(format!("无法创建录制文件：{}", errors.join("；")))
}

fn create_file_in_directory(
    directory: &Path,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("创建目录 {} 失败: {error}", directory.display()))?;

    create_file_in_existing_directory(directory, started_at_unix_ms, session_id)
}

fn create_file_in_existing_directory(
    directory: &Path,
    started_at_unix_ms: u64,
    session_id: u64,
) -> Result<(File, PathBuf), String> {
    if !directory.is_dir() {
        return Err(format!(
            "记录目录不存在或不是文件夹: {}",
            directory.display()
        ));
    }

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

fn read_and_verify_sha256<R: Read>(
    reader: &mut R,
    parts: &[&[u8]],
    checksum_section: &'static str,
    content_name: &'static str,
) -> Result<(), CaptureReadError> {
    let mut actual = [0_u8; SHA256_CHECKSUM_SIZE];
    read_exact_section(reader, &mut actual, checksum_section)?;
    let expected = sha256(parts);
    if actual != expected {
        return Err(CaptureReadError::Corrupt(format!(
            "{content_name} SHA-256 校验不匹配"
        )));
    }
    Ok(())
}

fn fail_active_capture(
    shared: &mut SharedCaptureState,
    reason: &str,
    message: String,
) -> CaptureStatePayload {
    if let Some(worker) = shared.worker.as_ref() {
        worker.control.request_abort();
    }
    shared.status = CaptureStatus::Error;
    shared.ended_at_unix_ms = Some(unix_millis());
    shared.termination_reason = Some(reason.to_owned());
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
        shared.marker_count = 0;
        shared.queue_budget = None;
        shared.termination_reason = Some("start-failed".to_owned());
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
        shared.termination_reason = Some("finalization-failed".to_owned());
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
                "vofa-ultra-capture-{name}-{}-{nonce}",
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

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CompatibilityPolicy {
        schema_version: u16,
        capture: CaptureCompatibility,
        protocols: ProtocolCompatibility,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CaptureCompatibility {
        file_format: String,
        write_version: u16,
        read_versions: Vec<u16>,
        future_version_behavior: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProtocolCompatibility {
        stable_wire_ids: Vec<String>,
        wire_id_evolution: String,
    }

    #[derive(Default)]
    struct FlushProbe {
        flush_count: usize,
        fail_flush: bool,
    }

    impl Write for FlushProbe {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flush_count += 1;
            if self.fail_flush {
                return Err(io::Error::other("forced flush failure"));
            }
            Ok(())
        }
    }

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

    #[test]
    fn start_request_reads_optional_camel_case_directory() {
        let request: CaptureStartRequest = serde_json::from_str(
            r#"{
                "source":"serial",
                "protocol":"raw",
                "serialConfig":{
                    "portName":"COM3",
                    "baudRate":115200,
                    "dataBits":8,
                    "parity":"none",
                    "stopBits":1,
                    "flowControl":"none",
                    "dtr":true,
                    "rts":true
                },
                "destinationDirectory":"/captures"
            }"#,
        )
        .unwrap();

        assert_eq!(request.destination_directory.as_deref(), Some("/captures"));
    }

    #[test]
    fn capture_file_creation_never_overwrites_existing_file() {
        let directory = TestDirectory::new("collision");
        let existing = directory.join("capture-1000-7.vucap");
        fs::write(&existing, b"existing").unwrap();

        let (file, path) = create_file_in_directory(&directory.path, 1000, 7).unwrap();
        drop(file);

        assert_eq!(path, directory.join("capture-1000-7-1.vucap"));
        assert_eq!(fs::read(existing).unwrap(), b"existing");
    }

    #[test]
    fn explicit_capture_directory_is_not_recreated_after_validation() {
        let directory = TestDirectory::new("removed");
        let resolved = resolve_custom_recording_directory(directory.path.to_str())
            .unwrap()
            .unwrap();
        fs::remove_dir_all(&directory.path).unwrap();

        assert!(create_file_in_existing_directory(&resolved, 1000, 7).is_err());
        assert!(!resolved.exists());
    }

    fn file_with_header() -> Vec<u8> {
        let mut bytes = Vec::new();
        write_file_header(&mut bytes, &encode_header(&sample_header()).unwrap()).unwrap();
        bytes
    }

    fn file_with_header_version(version: u16) -> Vec<u8> {
        let header_bytes = encode_header(&sample_header()).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&CAPTURE_MAGIC);
        bytes.extend_from_slice(&version.to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header_bytes);
        bytes
    }

    #[test]
    fn progress_flush_clears_dirty_state_only_after_success() {
        let mut writer = FlushProbe {
            fail_flush: true,
            ..FlushProbe::default()
        };
        let mut progress_dirty = true;
        let mut last_progress = Instant::now();
        let progress_now = last_progress + PROGRESS_INTERVAL;

        let error = flush_progress_if_due(
            &mut writer,
            &mut progress_dirty,
            &mut last_progress,
            progress_now,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "forced flush failure");
        assert!(progress_dirty);
        assert_eq!(writer.flush_count, 1);

        writer.fail_flush = false;
        assert!(flush_progress_if_due(
            &mut writer,
            &mut progress_dirty,
            &mut last_progress,
            progress_now,
        )
        .unwrap());
        assert!(!progress_dirty);
        assert_eq!(last_progress, progress_now);
        assert_eq!(writer.flush_count, 2);
    }

    #[test]
    fn progress_flush_waits_for_dirty_interval() {
        let mut writer = FlushProbe::default();
        let mut progress_dirty = true;
        let mut last_progress = Instant::now();
        let progress_now = last_progress + PROGRESS_INTERVAL / 2;

        assert!(!flush_progress_if_due(
            &mut writer,
            &mut progress_dirty,
            &mut last_progress,
            progress_now,
        )
        .unwrap());
        assert!(progress_dirty);
        assert_eq!(writer.flush_count, 0);
    }

    fn write_v1_footer<W: Write>(
        writer: &mut W,
        data_bytes: u64,
        record_count: u64,
    ) -> io::Result<()> {
        writer.write_all(&[FOOTER_TAG])?;
        writer.write_all(&[0_u8; 7])?;
        writer.write_all(&data_bytes.to_le_bytes())?;
        writer.write_all(&record_count.to_le_bytes())
    }

    #[test]
    fn validates_capture_protocol_whitelist() {
        for protocol in SUPPORTED_CAPTURE_PROTOCOLS {
            let mut header = sample_header();
            header.protocol = (*protocol).to_owned();
            assert!(header.validate().is_ok(), "protocol={protocol}");
        }

        let mut header = sample_header();
        header.protocol = "future-protocol".to_owned();
        assert_eq!(
            header.validate(),
            Err("不支持的录制协议: future-protocol".to_owned())
        );
    }

    #[test]
    fn matches_public_compatibility_policy() {
        let policy: CompatibilityPolicy =
            serde_json::from_str(include_str!("../../compatibility-policy.json")).unwrap();
        let stable_wire_ids = policy
            .protocols
            .stable_wire_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();

        assert_eq!(policy.schema_version, 2);
        assert_eq!(policy.capture.file_format, "VUCAP");
        assert_eq!(policy.capture.write_version, CAPTURE_VERSION);
        assert_eq!(
            policy.capture.read_versions.as_slice(),
            CAPTURE_READABLE_VERSIONS
        );
        assert_eq!(policy.capture.future_version_behavior, "reject");
        assert_eq!(stable_wire_ids, SUPPORTED_CAPTURE_PROTOCOLS);
        assert_eq!(policy.protocols.wire_id_evolution, "append-only");
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

    fn queued_marker(
        budget: &Arc<ByteBudget>,
        color: CaptureMarkerColor,
        timestamp_us: u64,
        label: &str,
    ) -> QueuedMarker {
        let size = MARKER_HEADER_SIZE + label.len();
        QueuedMarker {
            session_id: 1,
            color,
            timestamp_us,
            label: label.to_owned(),
            _reservation: budget.try_reserve(size).unwrap(),
        }
    }

    fn append_raw_marker(
        bytes: &mut Vec<u8>,
        color: u8,
        reserved: u16,
        timestamp_us: u64,
        label_size: u32,
        label: &[u8],
    ) {
        let item_offset = bytes.len();
        append_raw_marker_without_checksum(bytes, color, reserved, timestamp_us, label_size, label);
        let checksum = sha256(&[&bytes[item_offset..]]);
        bytes.extend_from_slice(&checksum);
    }

    fn append_raw_marker_without_checksum(
        bytes: &mut Vec<u8>,
        color: u8,
        reserved: u16,
        timestamp_us: u64,
        label_size: u32,
        label: &[u8],
    ) {
        bytes.push(MARKER_TAG);
        bytes.push(color);
        bytes.extend_from_slice(&reserved.to_le_bytes());
        bytes.extend_from_slice(&timestamp_us.to_le_bytes());
        bytes.extend_from_slice(&label_size.to_le_bytes());
        bytes.extend_from_slice(label);
    }

    #[test]
    fn writer_emits_v3_and_round_trips_mixed_items() {
        let budget = Arc::new(ByteBudget::new(1024, WRITER_QUEUE_RECORDS));
        let first = queued_record(&budget, CaptureDirection::Rx, 0, vec![1, 2]);
        let marker = queued_marker(&budget, CaptureMarkerColor::Blue, 12, "启动");
        let second = queued_record(&budget, CaptureDirection::Tx, 12, vec![3, 4, 5]);
        let mut bytes = file_with_header();
        write_record(&mut bytes, &first).unwrap();
        write_marker(&mut bytes, &marker).unwrap();
        write_record(&mut bytes, &second).unwrap();
        write_footer(&mut bytes, 5, 2, 1).unwrap();

        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), CAPTURE_VERSION);

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.version(), CAPTURE_VERSION);
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
            CaptureItem::Marker(CaptureMarker {
                color: CaptureMarkerColor::Blue,
                timestamp_us: 12,
                label: "启动".to_owned(),
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
            CaptureItem::Footer(CaptureFooter {
                data_bytes: 5,
                record_count: 2,
                marker_count: 1,
            })
        );
        assert!(reader.next().is_none());
    }

    #[test]
    fn v3_rejects_header_item_footer_corruption_and_truncated_checksums() {
        let mut header_corruption = file_with_header();
        let header_size = u32::from_le_bytes(
            header_corruption[12..16]
                .try_into()
                .expect("文件头长度字段固定"),
        ) as usize;
        let header_range = FILE_HEADER_SIZE..FILE_HEADER_SIZE + header_size;
        let port_offset = header_corruption[header_range.clone()]
            .windows(4)
            .position(|window| window == b"COM3")
            .expect("测试文件头包含串口名");
        header_corruption[header_range.start + port_offset + 3] = b'4';
        assert!(matches!(
            CaptureReader::new(Cursor::new(header_corruption)),
            Err(CaptureReadError::Corrupt(message)) if message.contains("文件头")
        ));

        let budget = Arc::new(ByteBudget::new(1024, WRITER_QUEUE_RECORDS));
        let record = queued_record(&budget, CaptureDirection::Rx, 1, vec![0xaa, 0xbb]);
        let mut record_corruption = file_with_header();
        let record_offset = record_corruption.len();
        write_record(&mut record_corruption, &record).unwrap();
        record_corruption[record_offset + RECORD_HEADER_SIZE] ^= 0x01;
        let mut reader = CaptureReader::new(Cursor::new(record_corruption)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("数据记录")
        ));

        let marker = queued_marker(&budget, CaptureMarkerColor::Blue, 2, "检查");
        let mut marker_corruption = file_with_header();
        let marker_offset = marker_corruption.len();
        write_marker(&mut marker_corruption, &marker).unwrap();
        marker_corruption[marker_offset + MARKER_HEADER_SIZE] ^= 0x01;
        let mut reader = CaptureReader::new(Cursor::new(marker_corruption)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("时间线标记")
        ));

        let mut footer_corruption = file_with_header();
        let footer_offset = footer_corruption.len();
        write_footer(&mut footer_corruption, 0, 0, 0).unwrap();
        footer_corruption[footer_offset + V2_FOOTER_SIZE] ^= 0x01;
        let mut reader = CaptureReader::new(Cursor::new(footer_corruption)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("结束标记")
        ));

        let mut truncated_header_checksum = file_with_header();
        truncated_header_checksum.pop();
        assert!(matches!(
            CaptureReader::new(Cursor::new(truncated_header_checksum)),
            Err(CaptureReadError::Truncated("文件头校验值"))
        ));

        let mut truncated_record_checksum = file_with_header();
        write_record(&mut truncated_record_checksum, &record).unwrap();
        truncated_record_checksum.pop();
        let mut reader = CaptureReader::new(Cursor::new(truncated_record_checksum)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Truncated("记录校验值")))
        ));
    }

    #[test]
    fn reads_v1_fixture_without_changing_record_layout() {
        let mut bytes = file_with_header_version(CAPTURE_VERSION_V1);
        bytes.extend_from_slice(&[
            RECORD_TAG, 1, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0xaa, 0xbb, 0xcc,
        ]);
        write_v1_footer(&mut bytes, 3, 1).unwrap();

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.version(), CAPTURE_VERSION_V1);
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Record(CaptureRecord {
                direction: CaptureDirection::Tx,
                timestamp_us: 9,
                payload: vec![0xaa, 0xbb, 0xcc],
            })
        );
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Footer(CaptureFooter {
                data_bytes: 3,
                record_count: 1,
                marker_count: 0,
            })
        );
    }

    #[test]
    fn reads_v2_fixture_without_checksums() {
        let mut bytes = file_with_header_version(CAPTURE_VERSION_V2);
        bytes.extend_from_slice(&[
            RECORD_TAG, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0xaa, 0xbb,
        ]);
        append_raw_marker_without_checksum(
            &mut bytes,
            CaptureMarkerColor::Green.code(),
            0,
            10,
            3,
            b"tag",
        );
        write_v1_footer(&mut bytes, 2, 1).unwrap();
        bytes.extend_from_slice(&1_u64.to_le_bytes());

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.version(), CAPTURE_VERSION_V2);
        assert!(matches!(reader.next(), Some(Ok(CaptureItem::Record(_)))));
        assert!(matches!(reader.next(), Some(Ok(CaptureItem::Marker(_)))));
        assert_eq!(
            reader.next().unwrap().unwrap(),
            CaptureItem::Footer(CaptureFooter {
                data_bytes: 2,
                record_count: 1,
                marker_count: 1,
            })
        );
    }

    #[test]
    fn capture_stats_include_markers_in_global_duration() {
        let mut stats = CaptureRecordStats::default();
        stats
            .observe_marker(&CaptureMarker {
                color: CaptureMarkerColor::Gray,
                timestamp_us: 4,
                label: "开始".to_owned(),
            })
            .unwrap();
        stats
            .observe(&CaptureRecord {
                direction: CaptureDirection::Rx,
                timestamp_us: 4,
                payload: vec![1, 2],
            })
            .unwrap();
        stats
            .observe_marker(&CaptureMarker {
                color: CaptureMarkerColor::Green,
                timestamp_us: 9,
                label: "完成".to_owned(),
            })
            .unwrap();

        assert_eq!(stats.duration_us(), 9);
        assert_eq!(stats.data_bytes(), 2);
        assert_eq!(stats.record_count(), 1);
        assert_eq!(stats.marker_count(), 2);
    }

    #[test]
    fn rejects_timestamp_regression_across_record_and_marker() {
        let budget = Arc::new(ByteBudget::new(1024, WRITER_QUEUE_RECORDS));
        let record = queued_record(&budget, CaptureDirection::Rx, 10, vec![1]);
        let marker = queued_marker(&budget, CaptureMarkerColor::Yellow, 9, "回退");
        let mut bytes = file_with_header();
        write_record(&mut bytes, &record).unwrap();
        write_marker(&mut bytes, &marker).unwrap();

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        assert!(matches!(reader.next(), Some(Ok(CaptureItem::Record(_)))));
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("时间戳")
        ));

        let marker = queued_marker(&budget, CaptureMarkerColor::Yellow, 10, "先标记");
        let record = queued_record(&budget, CaptureDirection::Rx, 9, vec![1]);
        let mut bytes = file_with_header();
        write_marker(&mut bytes, &marker).unwrap();
        write_record(&mut bytes, &record).unwrap();

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        assert!(matches!(reader.next(), Some(Ok(CaptureItem::Marker(_)))));
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("时间戳")
        ));
    }

    #[test]
    fn resumes_from_verified_offset_with_footer_statistics() {
        let budget = Arc::new(ByteBudget::new(1024, WRITER_QUEUE_RECORDS));
        let first = queued_record(&budget, CaptureDirection::Rx, 5, vec![1, 2]);
        let marker = queued_marker(&budget, CaptureMarkerColor::Red, 6, "检查点");
        let second = queued_record(&budget, CaptureDirection::Tx, 8, vec![3, 4, 5]);
        let mut bytes = file_with_header();
        write_record(&mut bytes, &first).unwrap();
        write_marker(&mut bytes, &marker).unwrap();
        write_record(&mut bytes, &second).unwrap();
        write_footer(&mut bytes, 5, 2, 1).unwrap();

        let mut scanned = CaptureReader::new(Cursor::new(bytes.clone())).unwrap();
        assert!(matches!(scanned.next(), Some(Ok(CaptureItem::Record(_)))));
        assert!(matches!(scanned.next(), Some(Ok(CaptureItem::Marker(_)))));
        let checkpoint_offset = scanned.stream_position().unwrap();

        let mut regressed = CaptureReader::new(Cursor::new(bytes.clone()))
            .unwrap()
            .resume_from_verified(checkpoint_offset, 2, 1, 1, Some(9))
            .unwrap();
        assert!(matches!(
            regressed.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("时间戳")
        ));

        let mut resumed = CaptureReader::new(Cursor::new(bytes))
            .unwrap()
            .resume_from_verified(checkpoint_offset, 2, 1, 1, Some(6))
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
                marker_count: 1,
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
            Err(CaptureReadError::FutureVersion(version)) if version == CAPTURE_VERSION + 1
        ));

        let unsupported = file_with_header_version(0);
        assert!(matches!(
            CaptureReader::new(Cursor::new(unsupported)),
            Err(CaptureReadError::UnsupportedVersion(0))
        ));
    }

    #[test]
    fn validates_marker_label_unicode_limits_and_controls() {
        assert!(validate_marker_label("标记").is_ok());
        assert!(validate_marker_label(&"😀".repeat(MAX_CAPTURE_MARKER_LABEL_CHARS)).is_ok());
        assert!(validate_marker_label("").is_err());
        assert!(validate_marker_label("   ").is_err());
        assert!(validate_marker_label(" 标记").is_err());
        assert!(validate_marker_label("标记 ").is_err());
        assert!(validate_marker_label("换行\n标记").is_err());
        assert!(validate_marker_label(&"a".repeat(MAX_CAPTURE_MARKER_LABEL_CHARS + 1)).is_err());
        assert!(validate_marker_label(&"😀".repeat(MAX_CAPTURE_MARKER_LABEL_CHARS + 1)).is_err());
    }

    #[test]
    fn rejects_unknown_tags_colors_and_nonzero_reserved_fields() {
        let mut unknown = file_with_header();
        unknown.push(0x03);
        let mut reader = CaptureReader::new(Cursor::new(unknown)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::InvalidTag(0x03)))
        ));

        let mut v1_marker = file_with_header_version(CAPTURE_VERSION_V1);
        v1_marker.push(MARKER_TAG);
        let mut reader = CaptureReader::new(Cursor::new(v1_marker)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::InvalidTag(MARKER_TAG)))
        ));

        let mut invalid_color = file_with_header();
        append_raw_marker(&mut invalid_color, 0xfe, 0, 0, 1, b"x");
        let mut reader = CaptureReader::new(Cursor::new(invalid_color)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::InvalidMarkerColor(0xfe)))
        ));

        let mut marker_reserved = file_with_header();
        append_raw_marker(
            &mut marker_reserved,
            CaptureMarkerColor::Red.code(),
            1,
            0,
            1,
            b"x",
        );
        let mut reader = CaptureReader::new(Cursor::new(marker_reserved)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("标记保留字段")
        ));

        let mut record_reserved = file_with_header();
        record_reserved.push(RECORD_TAG);
        record_reserved.push(CaptureDirection::Rx.code());
        record_reserved.extend_from_slice(&1_u16.to_le_bytes());
        record_reserved.extend_from_slice(&0_u64.to_le_bytes());
        record_reserved.extend_from_slice(&0_u32.to_le_bytes());
        let mut reader = CaptureReader::new(Cursor::new(record_reserved)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("记录保留字段")
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
        assert_eq!(
            json.get("formatVersion"),
            Some(&serde_json::json!(CAPTURE_VERSION))
        );
        assert_eq!(json.get("markerCount"), Some(&serde_json::json!(0)));
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
    fn rejects_oversized_header_record_and_marker_before_allocating_payload() {
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

        let mut oversized_marker = file_with_header();
        append_raw_marker(
            &mut oversized_marker,
            CaptureMarkerColor::Gray.code(),
            0,
            0,
            (MAX_CAPTURE_MARKER_LABEL_BYTES + 1) as u32,
            &[],
        );
        let mut reader = CaptureReader::new(Cursor::new(oversized_marker)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::MarkerLabelTooLarge(size)))
                if size == (MAX_CAPTURE_MARKER_LABEL_BYTES + 1) as u32
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
    fn rejects_invalid_utf8_and_truncated_marker_sections() {
        let mut invalid_utf8 = file_with_header();
        append_raw_marker(
            &mut invalid_utf8,
            CaptureMarkerColor::Purple.code(),
            0,
            1,
            1,
            &[0xff],
        );
        let mut reader = CaptureReader::new(Cursor::new(invalid_utf8)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("UTF-8")
        ));

        let mut too_many_chars = file_with_header();
        let label = "a".repeat(MAX_CAPTURE_MARKER_LABEL_CHARS + 1);
        append_raw_marker(
            &mut too_many_chars,
            CaptureMarkerColor::Green.code(),
            0,
            1,
            label.len() as u32,
            label.as_bytes(),
        );
        let mut reader = CaptureReader::new(Cursor::new(too_many_chars)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("Unicode")
        ));

        let mut empty_label = file_with_header();
        append_raw_marker(
            &mut empty_label,
            CaptureMarkerColor::Gray.code(),
            0,
            1,
            0,
            b"",
        );
        let mut reader = CaptureReader::new(Cursor::new(empty_label)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("不能为空")
        ));

        let mut control_character = file_with_header();
        append_raw_marker(
            &mut control_character,
            CaptureMarkerColor::Gray.code(),
            0,
            1,
            1,
            b"\n",
        );
        let mut reader = CaptureReader::new(Cursor::new(control_character)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("控制字符")
        ));

        let mut truncated_header = file_with_header();
        truncated_header.push(MARKER_TAG);
        let mut reader = CaptureReader::new(Cursor::new(truncated_header)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Truncated("标记头")))
        ));

        let mut truncated_label = file_with_header();
        append_raw_marker_without_checksum(
            &mut truncated_label,
            CaptureMarkerColor::Orange.code(),
            0,
            1,
            2,
            b"x",
        );
        let mut reader = CaptureReader::new(Cursor::new(truncated_label)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Truncated("标记标签")))
        ));

        let mut truncated_footer = file_with_header();
        write_v1_footer(&mut truncated_footer, 0, 0).unwrap();
        let mut reader = CaptureReader::new(Cursor::new(truncated_footer)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Truncated("标记计数")))
        ));
    }

    #[test]
    fn validates_footer_statistics_and_trailing_data() {
        let mut wrong_stats = file_with_header();
        write_footer(&mut wrong_stats, 1, 0, 0).unwrap();
        let mut reader = CaptureReader::new(Cursor::new(wrong_stats)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(_)))
        ));

        let mut wrong_marker_count = file_with_header();
        write_footer(&mut wrong_marker_count, 0, 0, 1).unwrap();
        let mut reader = CaptureReader::new(Cursor::new(wrong_marker_count)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("标记")
        ));

        let mut trailing = file_with_header();
        write_footer(&mut trailing, 0, 0, 0).unwrap();
        trailing.push(0);
        let mut reader = CaptureReader::new(Cursor::new(trailing)).unwrap();
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(_)))
        ));
    }

    #[test]
    fn rejects_more_than_maximum_marker_count() {
        let budget = Arc::new(ByteBudget::new(1024, WRITER_QUEUE_RECORDS));
        let mut bytes = file_with_header();
        for timestamp_us in 0..=MAX_CAPTURE_MARKERS {
            let marker = queued_marker(&budget, CaptureMarkerColor::Gray, timestamp_us, "x");
            write_marker(&mut bytes, &marker).unwrap();
        }

        let mut reader = CaptureReader::new(Cursor::new(bytes)).unwrap();
        for _ in 0..MAX_CAPTURE_MARKERS {
            assert!(matches!(reader.next(), Some(Ok(CaptureItem::Marker(_)))));
        }
        assert!(matches!(
            reader.next(),
            Some(Err(CaptureReadError::Corrupt(message))) if message.contains("512")
        ));
    }

    #[test]
    fn byte_budget_rejection_does_not_wait_for_release() {
        let budget = Arc::new(ByteBudget::new(8, 2));
        let reservation = budget.try_reserve(8).unwrap();
        let worker_budget = Arc::clone(&budget);
        let (sender, receiver) = mpsc::channel();

        let join_handle = thread::spawn(move || {
            sender
                .send(matches!(
                    worker_budget.try_reserve(1),
                    Err(QueueReserveError::ByteCapacity)
                ))
                .unwrap();
        });
        assert_eq!(receiver.recv_timeout(Duration::from_secs(1)), Ok(true));
        join_handle.join().unwrap();

        drop(reservation);
        assert!(budget.try_reserve(8).is_ok());
    }

    #[test]
    fn record_budget_rejects_a_stalled_full_queue() {
        let budget = Arc::new(ByteBudget::new(32, 1));
        let reservation = budget.try_reserve(1).unwrap();

        assert!(matches!(
            budget.try_reserve(1),
            Err(QueueReserveError::RecordCapacity)
        ));
        assert_eq!(budget.snapshot().peak_records, 1);

        drop(reservation);
        assert!(budget.try_reserve(1).is_ok());
    }

    #[test]
    fn stalled_writer_queue_reports_current_and_peak_watermarks() {
        let budget = Arc::new(ByteBudget::new(16, 3));
        let first = budget.try_reserve(6).unwrap();
        let second = budget.try_reserve(8).unwrap();

        assert_eq!(
            budget.snapshot(),
            CaptureQueueSnapshot {
                bytes: 14,
                capacity_bytes: 16,
                records: 2,
                capacity_records: 3,
                peak_bytes: 14,
                peak_records: 2,
            }
        );
        assert!(matches!(
            budget.try_reserve(3),
            Err(QueueReserveError::ByteCapacity)
        ));

        drop(first);
        drop(second);
        assert_eq!(
            budget.snapshot(),
            CaptureQueueSnapshot {
                bytes: 0,
                capacity_bytes: 16,
                records: 0,
                capacity_records: 3,
                peak_bytes: 14,
                peak_records: 2,
            }
        );
    }
}
