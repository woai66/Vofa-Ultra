use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use wasmi::{
    CompilationMode, Config, EnforcedLimits, Engine, Instance, Linker, Memory, Module, StackLimits,
    Store, StoreLimits, StoreLimitsBuilder, TrapCode, TypedFunc,
};

const EXTENSION_FORMAT: &str = "vofa-ultra-extension";
const EXTENSION_SCHEMA_VERSION: u32 = 1;
const EXTENSION_API_VERSION: u32 = 1;
const EXTENSION_KIND: &str = "protocol-parser";
const LIVE_RX_CAPABILITY: &str = "live-rx.read";
const MAX_PACKAGE_BYTES: usize = 1536 * 1024;
const MAX_MODULE_BYTES: usize = 1024 * 1024;
const MAX_MEMORY_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_FRAMES: usize = 64;
const MAX_FRAME_CHANNELS: usize = 16;
const MAX_LABEL_CHARS: usize = 64;
const MAX_LABEL_BYTES: usize = 256;
const MAX_PATH_CHARS: usize = 4096;
const MAX_EXTENSION_ID_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 128;
const MAX_NAME_CHARS: usize = 64;
const MAX_NAME_BYTES: usize = 256;
const MAX_DESCRIPTION_CHARS: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 1024;
const MAX_LICENSE_BYTES: usize = 128;
const MAX_FORMAT_BYTES: usize = 64;
const MAX_KIND_BYTES: usize = 64;
const MAX_EXTENSION_ERROR_CHARS: usize = 512;
const MAX_EXTENSION_ERROR_BYTES: usize = 2048;
const FUEL_PER_CALL: u64 = 2_000_000;
const MAX_WASM_TABLES: usize = 1;
const MAX_WASM_TABLE_ELEMENTS: usize = 1024;
const MAX_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionManifest {
    id: String,
    version: String,
    name: String,
    description: String,
    license: String,
    api_version: u32,
    kind: String,
    capabilities: Vec<String>,
}

impl ExtensionManifest {
    fn validate(&self) -> Result<(), String> {
        validate_extension_id(&self.id)?;
        if self.version.is_empty()
            || self.version.len() > MAX_VERSION_BYTES
            || !self.version.is_ascii()
        {
            return Err(format!(
                "扩展版本必须是 1 到 {MAX_VERSION_BYTES} 字节的 ASCII SemVer"
            ));
        }
        Version::parse(&self.version)
            .map_err(|error| format!("扩展版本不是有效 SemVer: {error}"))?;
        validate_display_text(
            "扩展名称",
            &self.name,
            MAX_NAME_CHARS,
            MAX_NAME_BYTES,
            false,
        )?;
        validate_display_text(
            "扩展描述",
            &self.description,
            MAX_DESCRIPTION_CHARS,
            MAX_DESCRIPTION_BYTES,
            true,
        )?;
        validate_license_declaration(&self.license)?;
        if self.api_version != EXTENSION_API_VERSION {
            return Err(format!(
                "不支持的扩展 API 版本: {}，当前仅支持 {}",
                self.api_version, EXTENSION_API_VERSION
            ));
        }
        if self.kind.len() > MAX_KIND_BYTES || !self.kind.is_ascii() || self.kind != EXTENSION_KIND
        {
            return Err("不支持的扩展类型".to_owned());
        }
        if self.capabilities != [LIVE_RX_CAPABILITY] {
            return Err(format!(
                "协议解析扩展必须且只能声明能力 {LIVE_RX_CAPABILITY}"
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionPackage {
    format: String,
    schema_version: u32,
    manifest: ExtensionManifest,
    module_sha256: String,
    module_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInspectionPayload {
    format: String,
    schema_version: u32,
    manifest: ExtensionManifest,
    package_sha256: String,
    module_sha256: String,
    package_bytes: usize,
    module_bytes: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatePayload {
    status: String,
    session_id: u64,
    generation: u64,
    revision: u64,
    next_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<ExtensionManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    module_sha256: Option<String>,
    authorized_capabilities: Vec<String>,
    processed_bytes: u64,
    emitted_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    fault_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionFramePayload {
    values: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    labels: Option<Vec<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionBatchPayload {
    session_id: u64,
    generation: u64,
    sequence: u64,
    received_at: u64,
    accepted_bytes: usize,
    frames: Vec<ExtensionFramePayload>,
}

pub struct ExtensionState {
    compilation_in_flight: Arc<AtomicBool>,
    push_in_flight: Arc<AtomicBool>,
    shared: Arc<Mutex<SharedExtensionState>>,
}

impl Default for ExtensionState {
    fn default() -> Self {
        Self {
            compilation_in_flight: Arc::new(AtomicBool::new(false)),
            push_in_flight: Arc::new(AtomicBool::new(false)),
            shared: Arc::new(Mutex::new(SharedExtensionState::default())),
        }
    }
}

impl ExtensionState {
    fn handle(&self) -> Arc<Mutex<SharedExtensionState>> {
        Arc::clone(&self.shared)
    }

    fn try_compilation_permit(&self) -> Result<OperationPermit, String> {
        OperationPermit::try_acquire(
            Arc::clone(&self.compilation_in_flight),
            "另一个扩展检查或启用任务正在运行，请稍后重试",
        )
    }

    fn try_begin_activation(&self) -> Result<(OperationPermit, u64), String> {
        let permit = self.try_compilation_permit()?;
        let activation_request = self
            .shared
            .lock()
            .map_err(|_| "扩展状态锁已损坏".to_owned())?
            .begin_activation();
        Ok((permit, activation_request))
    }

    fn try_push_permit(&self) -> Result<OperationPermit, String> {
        OperationPermit::try_acquire(Arc::clone(&self.push_in_flight), "已有扩展批次正在执行")
    }
}

struct OperationPermit {
    flag: Arc<AtomicBool>,
}

impl OperationPermit {
    fn try_acquire(flag: Arc<AtomicBool>, busy_message: &str) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| busy_message.to_owned())?;
        Ok(Self { flag })
    }
}

impl Drop for OperationPermit {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExtensionStatus {
    Idle,
    Active,
    Error,
}

impl ExtensionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Active => "active",
            Self::Error => "error",
        }
    }
}

struct SharedExtensionState {
    status: ExtensionStatus,
    session_id: u64,
    generation: u64,
    revision: u64,
    activation_request: u64,
    next_sequence: u64,
    manifest: Option<ExtensionManifest>,
    package_sha256: Option<String>,
    module_sha256: Option<String>,
    authorized_capabilities: Vec<String>,
    processed_bytes: u64,
    emitted_frames: u64,
    fault_code: Option<String>,
    message: Option<String>,
    runtime: Option<ExtensionRuntime>,
}

impl Default for SharedExtensionState {
    fn default() -> Self {
        Self {
            status: ExtensionStatus::Idle,
            session_id: 0,
            generation: 0,
            revision: 0,
            activation_request: 0,
            next_sequence: 1,
            manifest: None,
            package_sha256: None,
            module_sha256: None,
            authorized_capabilities: Vec::new(),
            processed_bytes: 0,
            emitted_frames: 0,
            fault_code: None,
            message: None,
            runtime: None,
        }
    }
}

impl SharedExtensionState {
    fn snapshot(&self) -> ExtensionStatePayload {
        ExtensionStatePayload {
            status: self.status.as_str().to_owned(),
            session_id: self.session_id,
            generation: self.generation,
            revision: self.revision,
            next_sequence: self.next_sequence,
            manifest: self.manifest.clone(),
            package_sha256: self.package_sha256.clone(),
            module_sha256: self.module_sha256.clone(),
            authorized_capabilities: self.authorized_capabilities.clone(),
            processed_bytes: self.processed_bytes,
            emitted_frames: self.emitted_frames,
            fault_code: self.fault_code.clone(),
            message: self.message.clone(),
        }
    }

    fn activate(
        &mut self,
        prepared: PreparedExtension,
        runtime: ExtensionRuntime,
    ) -> ExtensionStatePayload {
        self.status = ExtensionStatus::Active;
        self.session_id = next_nonzero(self.session_id);
        self.generation = 1;
        self.revision = self.revision.saturating_add(1);
        self.next_sequence = 1;
        self.manifest = Some(prepared.manifest);
        self.package_sha256 = Some(prepared.package_sha256);
        self.module_sha256 = Some(prepared.module_sha256);
        self.authorized_capabilities = vec![LIVE_RX_CAPABILITY.to_owned()];
        self.processed_bytes = 0;
        self.emitted_frames = 0;
        self.fault_code = None;
        self.message = Some("扩展已在当前会话启用".to_owned());
        self.runtime = Some(runtime);
        self.snapshot()
    }

    fn begin_activation(&mut self) -> u64 {
        self.activation_request = next_nonzero(self.activation_request);
        self.activation_request
    }

    fn deactivate(&mut self) -> ExtensionStatePayload {
        let session_id = self.session_id;
        let generation = self.generation;
        let revision = self.revision;
        let activation_request = self.activation_request;
        *self = Self::default();
        self.session_id = session_id;
        self.generation = next_nonzero(generation);
        self.revision = revision.saturating_add(1);
        self.activation_request = next_nonzero(activation_request);
        self.message = Some("扩展已停用，会话授权已清除".to_owned());
        self.snapshot()
    }

    fn fail(&mut self, fault: &RuntimeFault) -> ExtensionStatePayload {
        self.status = ExtensionStatus::Error;
        self.generation = next_nonzero(self.generation);
        self.revision = self.revision.saturating_add(1);
        self.next_sequence = 1;
        self.authorized_capabilities.clear();
        self.fault_code = Some(fault.code.as_str().to_owned());
        self.message = Some(limit_extension_error(fault.message.clone()));
        self.runtime = None;
        self.snapshot()
    }
}

struct WasmStoreState {
    limits: StoreLimits,
}

struct InstantiatedExtension {
    store: Store<WasmStoreState>,
    memory: Memory,
    abi_version: TypedFunc<(), i32>,
    input_ptr: TypedFunc<(), i32>,
    reset: TypedFunc<(), i32>,
    push: TypedFunc<(i32, f64), i64>,
}

struct ExtensionRuntime {
    store: Store<WasmStoreState>,
    memory: Memory,
    reset: TypedFunc<(), i32>,
    push: TypedFunc<(i32, f64), i64>,
    input_offset: usize,
}

impl ExtensionRuntime {
    fn new(mut instance: InstantiatedExtension) -> Result<Self, RuntimeFault> {
        set_call_fuel(&mut instance.store)?;
        let abi_version = instance
            .abi_version
            .call(&mut instance.store, ())
            .map_err(classify_wasm_error)?;
        if abi_version != EXTENSION_API_VERSION as i32 {
            return Err(RuntimeFault::abi(format!(
                "扩展 ABI 版本为 {abi_version}，当前仅支持 {EXTENSION_API_VERSION}"
            )));
        }

        set_call_fuel(&mut instance.store)?;
        let input_ptr = instance
            .input_ptr
            .call(&mut instance.store, ())
            .map_err(classify_wasm_error)?;
        let input_offset = usize::try_from(input_ptr)
            .map_err(|_| RuntimeFault::abi("扩展返回了负的输入缓冲区地址"))?;
        validate_memory_range(
            &instance.memory,
            &instance.store,
            input_offset,
            MAX_INPUT_BYTES,
            "输入缓冲区",
        )?;

        set_call_fuel(&mut instance.store)?;
        let reset_code = instance
            .reset
            .call(&mut instance.store, ())
            .map_err(classify_wasm_error)?;
        if reset_code != 0 {
            return Err(RuntimeFault::abi(format!(
                "扩展重置函数返回错误码 {reset_code}"
            )));
        }

        Ok(Self {
            store: instance.store,
            memory: instance.memory,
            reset: instance.reset,
            push: instance.push,
            input_offset,
        })
    }

    fn reset(&mut self) -> Result<(), RuntimeFault> {
        set_call_fuel(&mut self.store)?;
        let reset_code = self
            .reset
            .call(&mut self.store, ())
            .map_err(classify_wasm_error)?;
        if reset_code != 0 {
            return Err(RuntimeFault::abi(format!(
                "扩展重置函数返回错误码 {reset_code}"
            )));
        }
        Ok(())
    }

    fn push(
        &mut self,
        bytes: &[u8],
        received_at: u64,
    ) -> Result<Vec<ExtensionFramePayload>, RuntimeFault> {
        self.memory
            .write(&mut self.store, self.input_offset, bytes)
            .map_err(|error| RuntimeFault::abi(format!("写入扩展输入缓冲区失败: {error}")))?;
        set_call_fuel(&mut self.store)?;
        let input_length = i32::try_from(bytes.len())
            .map_err(|_| RuntimeFault::abi("扩展输入长度超出 ABI 表示范围"))?;
        let packed_output = self
            .push
            .call(&mut self.store, (input_length, received_at as f64))
            .map_err(classify_wasm_error)?;
        if packed_output < 0 {
            return Err(RuntimeFault::abi(format!(
                "扩展解析函数返回错误码 {packed_output}"
            )));
        }

        let packed_output = packed_output as u64;
        let output_offset = (packed_output >> 32) as usize;
        let output_length = (packed_output & u64::from(u32::MAX)) as usize;
        if output_length == 0 {
            return Ok(Vec::new());
        }
        if output_length > MAX_OUTPUT_BYTES {
            return Err(RuntimeFault::output(format!(
                "扩展输出为 {output_length} 字节，超过 {MAX_OUTPUT_BYTES} 字节上限"
            )));
        }
        validate_memory_range(
            &self.memory,
            &self.store,
            output_offset,
            output_length,
            "输出缓冲区",
        )?;

        let mut output = vec![0_u8; output_length];
        self.memory
            .read(&self.store, output_offset, &mut output)
            .map_err(|error| RuntimeFault::abi(format!("读取扩展输出缓冲区失败: {error}")))?;
        parse_extension_output(&output)
    }
}

struct PreparedExtension {
    manifest: ExtensionManifest,
    package_sha256: String,
    module_sha256: String,
    package_bytes: usize,
    module_bytes: Vec<u8>,
    engine: Engine,
    module: Module,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionOutput {
    frames: Vec<ExtensionFramePayload>,
}

#[derive(Clone, Copy, Debug)]
enum RuntimeFaultCode {
    FuelExhausted,
    MemoryLimit,
    RuntimeTrap,
    AbiViolation,
    OutputInvalid,
    InternalError,
}

impl RuntimeFaultCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::FuelExhausted => "fuel-exhausted",
            Self::MemoryLimit => "memory-limit",
            Self::RuntimeTrap => "runtime-trap",
            Self::AbiViolation => "abi-violation",
            Self::OutputInvalid => "output-invalid",
            Self::InternalError => "internal-error",
        }
    }
}

#[derive(Debug)]
struct RuntimeFault {
    code: RuntimeFaultCode,
    message: String,
}

impl RuntimeFault {
    fn new(code: RuntimeFaultCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: limit_extension_error(message.into()),
        }
    }

    fn abi(message: impl Into<String>) -> Self {
        Self::new(RuntimeFaultCode::AbiViolation, message)
    }

    fn output(message: impl Into<String>) -> Self {
        Self::new(RuntimeFaultCode::OutputInvalid, message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(RuntimeFaultCode::InternalError, message)
    }
}

#[tauri::command]
pub async fn inspect_extension(
    state: State<'_, ExtensionState>,
    path: String,
) -> Result<ExtensionInspectionPayload, String> {
    let compilation_permit = state.try_compilation_permit()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _compilation_permit = compilation_permit;
        guard_untrusted(|| {
            let prepared = load_prepared_extension(&path)?;
            let _instance = instantiate_extension(&prepared.engine, &prepared.module)?;
            Ok(ExtensionInspectionPayload {
                format: EXTENSION_FORMAT.to_owned(),
                schema_version: EXTENSION_SCHEMA_VERSION,
                manifest: prepared.manifest,
                package_sha256: prepared.package_sha256,
                module_sha256: prepared.module_sha256,
                package_bytes: prepared.package_bytes,
                module_bytes: prepared.module_bytes.len(),
            })
        })
    })
    .await
    .map_err(|_| "检查扩展的后台任务异常退出".to_owned())?
}

#[tauri::command]
pub async fn activate_extension(
    state: State<'_, ExtensionState>,
    path: String,
    expected_package_sha256: String,
    authorized_capabilities: Vec<String>,
) -> Result<ExtensionStatePayload, String> {
    if authorized_capabilities != [LIVE_RX_CAPABILITY] {
        return Err(format!(
            "启用协议扩展前必须明确授权能力 {LIVE_RX_CAPABILITY}"
        ));
    }
    validate_sha256(&expected_package_sha256, "预期扩展包哈希")?;
    let (compilation_permit, activation_request) = state.try_begin_activation()?;
    let shared = state.handle();
    tauri::async_runtime::spawn_blocking(move || {
        let _compilation_permit = compilation_permit;
        {
            let shared = shared.lock().map_err(|_| "扩展状态锁已损坏".to_owned())?;
            if shared.activation_request != activation_request {
                return Err("扩展启用请求已过期".to_owned());
            }
        }
        let (prepared, runtime) = guard_untrusted(|| {
            let prepared = load_prepared_extension(&path)?;
            if prepared.package_sha256 != expected_package_sha256 {
                return Err("扩展包自检查后已发生变化，请重新选择并检查".to_owned());
            }
            let instance = instantiate_extension(&prepared.engine, &prepared.module)?;
            let runtime = ExtensionRuntime::new(instance).map_err(format_runtime_fault)?;
            Ok((prepared, runtime))
        })?;
        let mut shared = shared.lock().map_err(|_| "扩展状态锁已损坏".to_owned())?;
        if shared.activation_request != activation_request {
            return Err("扩展启用请求已过期".to_owned());
        }
        Ok(shared.activate(prepared, runtime))
    })
    .await
    .map_err(|_| "启用扩展的后台任务异常退出".to_owned())?
}

#[tauri::command]
pub fn get_extension_state(
    state: State<'_, ExtensionState>,
) -> Result<ExtensionStatePayload, String> {
    state
        .shared
        .lock()
        .map_err(|_| "扩展状态锁已损坏".to_owned())
        .map(|shared| shared.snapshot())
}

#[tauri::command]
pub fn deactivate_extension(
    state: State<'_, ExtensionState>,
    session_id: u64,
) -> Result<ExtensionStatePayload, String> {
    let mut shared = state
        .shared
        .lock()
        .map_err(|_| "扩展状态锁已损坏".to_owned())?;
    deactivate_session(&mut shared, session_id)
}

fn deactivate_session(
    shared: &mut SharedExtensionState,
    session_id: u64,
) -> Result<ExtensionStatePayload, String> {
    if shared.status == ExtensionStatus::Idle {
        if session_id != 0 && session_id != shared.session_id {
            return Err("扩展会话已过期".to_owned());
        }
        shared.begin_activation();
        shared.revision = shared.revision.saturating_add(1);
        shared.message = Some("扩展启用已取消".to_owned());
        return Ok(shared.snapshot());
    }
    require_known_session(shared, session_id)?;
    Ok(shared.deactivate())
}

#[tauri::command]
pub async fn reset_extension(
    state: State<'_, ExtensionState>,
    session_id: u64,
    generation: u64,
) -> Result<ExtensionStatePayload, String> {
    let push_permit = state.try_push_permit()?;
    let shared = state.handle();
    tauri::async_runtime::spawn_blocking(move || {
        let _push_permit = push_permit;
        let mut shared = shared.lock().map_err(|_| "扩展状态锁已损坏".to_owned())?;
        require_current_session(&shared, session_id, Some(generation))?;
        let result = guard_runtime_operation(|| {
            shared
                .runtime
                .as_mut()
                .ok_or_else(|| RuntimeFault::internal("扩展运行时不可用"))?
                .reset()
        });
        if let Err(fault) = result {
            shared.fail(&fault);
            return Err(format_runtime_fault(fault));
        }
        shared.generation = next_nonzero(shared.generation);
        shared.revision = shared.revision.saturating_add(1);
        shared.next_sequence = 1;
        shared.processed_bytes = 0;
        shared.emitted_frames = 0;
        shared.message = Some("扩展解析状态已重置".to_owned());
        Ok(shared.snapshot())
    })
    .await
    .map_err(|_| "重置扩展的后台任务异常退出".to_owned())?
}

#[tauri::command]
pub async fn push_extension_batch(
    state: State<'_, ExtensionState>,
    session_id: u64,
    generation: u64,
    sequence: u64,
    received_at: u64,
    data: Vec<u8>,
) -> Result<ExtensionBatchPayload, String> {
    if data.is_empty() {
        return Err("扩展输入批次不能为空".to_owned());
    }
    if data.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "扩展输入批次为 {} 字节，超过 {} 字节上限",
            data.len(),
            MAX_INPUT_BYTES
        ));
    }
    if received_at > MAX_SAFE_JAVASCRIPT_INTEGER {
        return Err(format!(
            "扩展接收时间超过 JavaScript 安全整数上限 {MAX_SAFE_JAVASCRIPT_INTEGER}"
        ));
    }
    let push_permit = state.try_push_permit()?;
    let shared = state.handle();
    tauri::async_runtime::spawn_blocking(move || {
        let _push_permit = push_permit;
        let mut shared = shared.lock().map_err(|_| "扩展状态锁已损坏".to_owned())?;
        require_current_session(&shared, session_id, Some(generation))?;
        if sequence != shared.next_sequence {
            return Err(format!(
                "扩展批次序号无效: 预期 {}，收到 {sequence}",
                shared.next_sequence
            ));
        }
        let accepted_bytes = data.len();
        let result = guard_runtime_operation(|| {
            shared
                .runtime
                .as_mut()
                .ok_or_else(|| RuntimeFault::internal("扩展运行时不可用"))?
                .push(&data, received_at)
        });
        let frames = match result {
            Ok(frames) => frames,
            Err(fault) => {
                shared.fail(&fault);
                return Err(format_runtime_fault(fault));
            }
        };
        shared.next_sequence = next_nonzero(shared.next_sequence);
        shared.processed_bytes = shared.processed_bytes.saturating_add(accepted_bytes as u64);
        shared.emitted_frames = shared.emitted_frames.saturating_add(frames.len() as u64);
        Ok(ExtensionBatchPayload {
            session_id,
            generation,
            sequence,
            received_at,
            accepted_bytes,
            frames,
        })
    })
    .await
    .map_err(|_| "执行扩展的后台任务异常退出".to_owned())?
}

fn require_current_session(
    shared: &SharedExtensionState,
    session_id: u64,
    generation: Option<u64>,
) -> Result<(), String> {
    if shared.status != ExtensionStatus::Active || shared.runtime.is_none() {
        return Err("当前没有已启用的扩展".to_owned());
    }
    if session_id == 0 || shared.session_id != session_id {
        return Err("扩展会话已过期".to_owned());
    }
    if generation.is_some_and(|value| value == 0 || shared.generation != value) {
        return Err("扩展运行代次已过期".to_owned());
    }
    Ok(())
}

fn require_known_session(shared: &SharedExtensionState, session_id: u64) -> Result<(), String> {
    if shared.status == ExtensionStatus::Idle || shared.session_id == 0 {
        return Err("当前没有可停用的扩展会话".to_owned());
    }
    if shared.session_id != session_id {
        return Err("扩展会话已过期".to_owned());
    }
    Ok(())
}

fn load_prepared_extension(path: &str) -> Result<PreparedExtension, String> {
    validate_extension_path(path)?;
    let package_bytes = read_bounded_file(path, MAX_PACKAGE_BYTES)?;
    prepare_extension(&package_bytes)
}

fn prepare_extension(package_bytes: &[u8]) -> Result<PreparedExtension, String> {
    if package_bytes.is_empty() {
        return Err("扩展包不能为空".to_owned());
    }
    if package_bytes.len() > MAX_PACKAGE_BYTES {
        return Err(format!(
            "扩展包为 {} 字节，超过 {} 字节上限",
            package_bytes.len(),
            MAX_PACKAGE_BYTES
        ));
    }
    let package: ExtensionPackage = serde_json::from_slice(package_bytes)
        .map_err(|error| format!("扩展包 JSON 无效: {error}"))?;
    if package.format.len() > MAX_FORMAT_BYTES
        || !package.format.is_ascii()
        || package.format != EXTENSION_FORMAT
    {
        return Err("不支持的扩展包格式".to_owned());
    }
    if package.schema_version != EXTENSION_SCHEMA_VERSION {
        return Err(format!(
            "不支持的扩展包 schema 版本: {}",
            package.schema_version
        ));
    }
    package.manifest.validate()?;
    validate_sha256(&package.module_sha256, "Wasm 模块哈希")?;
    if package.module_base64.len() > max_module_base64_length() {
        return Err("扩展 Wasm 模块的 Base64 数据超过上限".to_owned());
    }
    let module_bytes = BASE64_STANDARD
        .decode(package.module_base64.as_bytes())
        .map_err(|error| format!("扩展 Wasm 模块 Base64 无效: {error}"))?;
    if module_bytes.is_empty() {
        return Err("扩展 Wasm 模块不能为空".to_owned());
    }
    if module_bytes.len() > MAX_MODULE_BYTES {
        return Err(format!(
            "扩展 Wasm 模块为 {} 字节，超过 {} 字节上限",
            module_bytes.len(),
            MAX_MODULE_BYTES
        ));
    }
    let actual_module_sha256 = sha256_hex(&module_bytes);
    if actual_module_sha256 != package.module_sha256 {
        return Err("扩展 Wasm 模块哈希不匹配".to_owned());
    }

    let engine = create_wasm_engine()?;
    let module = Module::new(&engine, module_bytes.as_slice())
        .map_err(|_| "扩展 Wasm 模块无效或超过编译限制".to_owned())?;
    if module.imports().next().is_some() {
        return Err("扩展不得导入宿主能力".to_owned());
    }

    Ok(PreparedExtension {
        manifest: package.manifest,
        package_sha256: sha256_hex(package_bytes),
        module_sha256: actual_module_sha256,
        package_bytes: package_bytes.len(),
        module_bytes,
        engine,
        module,
    })
}

fn create_wasm_engine() -> Result<Engine, String> {
    let stack_limits = StackLimits::new(128, 8192, 256)
        .map_err(|error| format!("配置扩展执行栈限制失败: {error}"))?;
    let mut config = Config::default();
    config
        .consume_fuel(true)
        .compilation_mode(CompilationMode::Eager)
        .wasm_memory64(false)
        .wasm_multi_memory(false)
        .wasm_custom_page_sizes(false)
        .wasm_reference_types(false)
        .wasm_tail_call(false)
        .wasm_wide_arithmetic(false)
        .ignore_custom_sections(true)
        .enforced_limits(EnforcedLimits::strict())
        .set_stack_limits(stack_limits)
        .set_cached_stacks(0);
    Ok(Engine::new(&config))
}

#[allow(deprecated)]
fn instantiate_extension(
    engine: &Engine,
    module: &Module,
) -> Result<InstantiatedExtension, String> {
    let limits = StoreLimitsBuilder::new()
        .memory_size(MAX_MEMORY_BYTES)
        .memories(1)
        .instances(1)
        .tables(MAX_WASM_TABLES)
        .table_elements(MAX_WASM_TABLE_ELEMENTS)
        .trap_on_grow_failure(true)
        .build();
    let mut store = Store::new(engine, WasmStoreState { limits });
    store.limiter(|state| &mut state.limits);
    let linker = Linker::<WasmStoreState>::new(engine);
    let instance = linker
        .instantiate(&mut store, module)
        .map_err(|error| format!("实例化扩展失败: {error}"))?
        .ensure_no_start(&mut store)
        .map_err(|error| format!("扩展不得声明 start 函数: {error}"))?;
    validate_memory_export(module, &instance, &store)?;

    let memory = instance
        .get_memory(&store, "memory")
        .ok_or_else(|| "扩展必须导出名为 memory 的线性内存".to_owned())?;
    let abi_version = typed_export::<(), i32>(&instance, &store, "vofa_abi_version")?;
    let input_ptr = typed_export::<(), i32>(&instance, &store, "vofa_input_ptr")?;
    let reset = typed_export::<(), i32>(&instance, &store, "vofa_reset")?;
    let push = typed_export::<(i32, f64), i64>(&instance, &store, "vofa_push")?;
    Ok(InstantiatedExtension {
        store,
        memory,
        abi_version,
        input_ptr,
        reset,
        push,
    })
}

fn validate_memory_export(
    module: &Module,
    instance: &Instance,
    store: &Store<WasmStoreState>,
) -> Result<(), String> {
    let memory_type = module
        .exports()
        .find(|export| export.name() == "memory")
        .and_then(|export| export.ty().memory().copied())
        .ok_or_else(|| "扩展必须导出名为 memory 的 32 位线性内存".to_owned())?;
    if memory_type.is_64() {
        return Err("扩展不得使用 memory64".to_owned());
    }
    let maximum_pages = (MAX_MEMORY_BYTES / 65_536) as u64;
    if memory_type.minimum() > maximum_pages {
        return Err(format!(
            "扩展初始内存为 {} 页，超过 {} 页上限",
            memory_type.minimum(),
            maximum_pages
        ));
    }
    if instance.get_memory(store, "memory").is_none() {
        return Err("扩展 memory 导出类型无效".to_owned());
    }
    Ok(())
}

fn typed_export<Params, Results>(
    instance: &Instance,
    store: &Store<WasmStoreState>,
    name: &str,
) -> Result<TypedFunc<Params, Results>, String>
where
    Params: wasmi::WasmParams,
    Results: wasmi::WasmResults,
{
    instance
        .get_typed_func::<Params, Results>(store, name)
        .map_err(|_| format!("扩展导出 {name} 缺失或 ABI 签名不匹配"))
}

fn set_call_fuel(store: &mut Store<WasmStoreState>) -> Result<(), RuntimeFault> {
    store
        .set_fuel(FUEL_PER_CALL)
        .map_err(|_| RuntimeFault::internal("Wasm fuel 配置不可用"))
}

fn classify_wasm_error(error: wasmi::Error) -> RuntimeFault {
    match error.as_trap_code() {
        Some(TrapCode::OutOfFuel) => RuntimeFault::new(
            RuntimeFaultCode::FuelExhausted,
            "扩展超过单批执行预算，已停用",
        ),
        Some(TrapCode::GrowthOperationLimited) => RuntimeFault::new(
            RuntimeFaultCode::MemoryLimit,
            "扩展尝试超过内存或表资源上限，已停用",
        ),
        Some(_) | None => RuntimeFault::new(
            RuntimeFaultCode::RuntimeTrap,
            format!("扩展执行异常，已停用: {error}"),
        ),
    }
}

fn validate_memory_range(
    memory: &Memory,
    store: &Store<WasmStoreState>,
    offset: usize,
    length: usize,
    label: &str,
) -> Result<(), RuntimeFault> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| RuntimeFault::abi(format!("扩展{label}范围溢出")))?;
    if end > memory.data_size(store) {
        return Err(RuntimeFault::abi(format!(
            "扩展{label}越界: {offset}..{end}，内存大小为 {}",
            memory.data_size(store)
        )));
    }
    Ok(())
}

fn parse_extension_output(output: &[u8]) -> Result<Vec<ExtensionFramePayload>, RuntimeFault> {
    let output: ExtensionOutput = serde_json::from_slice(output)
        .map_err(|error| RuntimeFault::output(format!("扩展输出 JSON 无效: {error}")))?;
    if output.frames.len() > MAX_OUTPUT_FRAMES {
        return Err(RuntimeFault::output(format!(
            "扩展单批输出 {} 帧，超过 {} 帧上限",
            output.frames.len(),
            MAX_OUTPUT_FRAMES
        )));
    }
    for (frame_index, frame) in output.frames.iter().enumerate() {
        if frame.values.is_empty() || frame.values.len() > MAX_FRAME_CHANNELS {
            return Err(RuntimeFault::output(format!(
                "扩展第 {} 帧必须包含 1 到 {} 个通道",
                frame_index + 1,
                MAX_FRAME_CHANNELS
            )));
        }
        if frame.values.iter().any(|value| !value.is_finite()) {
            return Err(RuntimeFault::output(format!(
                "扩展第 {} 帧包含非有限数值",
                frame_index + 1
            )));
        }
        if let Some(labels) = &frame.labels {
            if labels.len() != frame.values.len() {
                return Err(RuntimeFault::output(format!(
                    "扩展第 {} 帧的标签数量与通道数量不一致",
                    frame_index + 1
                )));
            }
            let mut unique_labels = HashSet::with_capacity(labels.len());
            for label in labels {
                validate_output_label(label)?;
                if !unique_labels.insert(label) {
                    return Err(RuntimeFault::output(format!(
                        "扩展第 {} 帧包含重复标签 {label}",
                        frame_index + 1
                    )));
                }
            }
        }
    }
    Ok(output.frames)
}

fn validate_output_label(label: &str) -> Result<(), RuntimeFault> {
    if label.trim() != label || label.is_empty() {
        return Err(RuntimeFault::output("扩展通道标签不能为空或包含首尾空白"));
    }
    if label.len() > MAX_LABEL_BYTES || label.chars().count() > MAX_LABEL_CHARS {
        return Err(RuntimeFault::output(format!(
            "扩展通道标签超过 {MAX_LABEL_CHARS} 字符或 {MAX_LABEL_BYTES} 字节上限"
        )));
    }
    if label.chars().any(is_forbidden_display_character) {
        return Err(RuntimeFault::output(
            "扩展通道标签包含控制字符、双向覆盖符或不可见格式字符",
        ));
    }
    Ok(())
}

fn validate_extension_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS {
        return Err("扩展包路径为空或过长".to_owned());
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("vux") {
        return Err("扩展包必须使用 .vux 后缀".to_owned());
    }
    Ok(())
}

fn read_bounded_file(path: &str, maximum: usize) -> Result<Vec<u8>, String> {
    let path_metadata =
        std::fs::metadata(path).map_err(|error| format!("读取扩展包元数据失败: {error}"))?;
    if !path_metadata.is_file() {
        return Err("扩展包必须是普通文件".to_owned());
    }
    let file = File::open(path).map_err(|error| format!("打开扩展包失败: {error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("读取已打开扩展包元数据失败: {error}"))?;
    if !opened_metadata.is_file() {
        return Err("扩展包必须是普通文件".to_owned());
    }
    let mut reader = file.take((maximum + 1) as u64);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取扩展包失败: {error}"))?;
    if bytes.len() > maximum {
        return Err(format!("扩展包超过 {maximum} 字节上限"));
    }
    Ok(bytes)
}

fn validate_extension_id(id: &str) -> Result<(), String> {
    if id.len() < 3 || id.len() > MAX_EXTENSION_ID_BYTES || !id.is_ascii() {
        return Err("扩展 ID 必须是 3 到 128 字节的 ASCII 反向域名".to_owned());
    }
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2
        || segments.iter().any(|segment| {
            segment.is_empty()
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                || !segment
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                || !segment
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
        })
    {
        return Err("扩展 ID 必须由小写字母、数字和连字符组成的反向域名段构成".to_owned());
    }
    Ok(())
}

fn validate_display_text(
    field: &str,
    value: &str,
    max_chars: usize,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<(), String> {
    if value.trim() != value || (!allow_empty && value.is_empty()) {
        return Err(format!("{field}不能为空或包含首尾空白"));
    }
    if value.chars().count() > max_chars || value.len() > max_bytes {
        return Err(format!(
            "{field}超过 {max_chars} 字符或 {max_bytes} 字节上限"
        ));
    }
    if value.chars().any(is_forbidden_display_character) {
        return Err(format!("{field}包含控制字符、双向覆盖符或不可见格式字符"));
    }
    Ok(())
}

fn validate_license_declaration(value: &str) -> Result<(), String> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > MAX_LICENSE_BYTES
        || !value.is_ascii()
    {
        return Err("扩展许可证声明必须是无首尾空白的 1 到 128 字节 ASCII 文本".to_owned());
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'+' | b'(' | b')' | b':' | b'/' | b' ')
    }) {
        return Err("扩展许可证声明包含不允许的字符".to_owned());
    }
    Ok(())
}

fn is_forbidden_display_character(character: char) -> bool {
    character.is_control()
        || (character.is_whitespace() && character != ' ')
        || matches!(
            character,
            '\u{00ad}'
                | '\u{034f}'
                | '\u{061c}'
                | '\u{180e}'
                | '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{206f}'
                | '\u{feff}'
                | '\u{fff9}'..='\u{fffb}'
                | '\u{e0001}'
                | '\u{e0020}'..='\u{e007f}'
        )
}

fn validate_sha256(value: &str, field: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{field}必须是 64 位小写十六进制 SHA-256"));
    }
    Ok(())
}

fn max_module_base64_length() -> usize {
    MAX_MODULE_BYTES.div_ceil(3) * 4
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn next_nonzero(value: u64) -> u64 {
    value.checked_add(1).filter(|next| *next != 0).unwrap_or(1)
}

fn guard_untrusted<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(operation))
        .map_err(|_| "扩展检查或初始化触发运行时内部异常".to_owned())?
        .map_err(limit_extension_error)
}

fn guard_runtime_operation<T>(
    operation: impl FnOnce() -> Result<T, RuntimeFault>,
) -> Result<T, RuntimeFault> {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| {
        Err(RuntimeFault::internal(
            "扩展触发 Wasm 运行时内部异常，已停用",
        ))
    })
}

fn format_runtime_fault(fault: RuntimeFault) -> String {
    limit_extension_error(format!(
        "扩展已停用 [{}]: {}",
        fault.code.as_str(),
        fault.message
    ))
}

fn limit_extension_error(message: String) -> String {
    let mut output = String::with_capacity(message.len().min(MAX_EXTENSION_ERROR_BYTES));
    let body_char_limit = MAX_EXTENSION_ERROR_CHARS.saturating_sub(3);
    let body_byte_limit = MAX_EXTENSION_ERROR_BYTES.saturating_sub(3);
    let mut truncated = false;
    for (index, character) in message.chars().enumerate() {
        if index >= body_char_limit || output.len() + character.len_utf8() > body_byte_limit {
            truncated = true;
            break;
        }
        output.push(character);
    }
    if truncated {
        output.push_str("...");
    }
    output
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use serde_json::{json, Value};

    use super::*;

    const OUTPUT_OFFSET: usize = 65_536;

    fn manifest_value() -> Value {
        json!({
            "id": "io.vofa.example-parser",
            "version": "1.2.3",
            "name": "示例解析器",
            "description": "测试扩展",
            "license": "MIT",
            "apiVersion": 1,
            "kind": "protocol-parser",
            "capabilities": ["live-rx.read"]
        })
    }

    fn package_value(module_bytes: &[u8]) -> Value {
        json!({
            "format": "vofa-ultra-extension",
            "schemaVersion": 1,
            "manifest": manifest_value(),
            "moduleSha256": sha256_hex(module_bytes),
            "moduleBase64": BASE64_STANDARD.encode(module_bytes)
        })
    }

    fn package_bytes(module_bytes: &[u8]) -> Vec<u8> {
        serde_json::to_vec(&package_value(module_bytes)).unwrap()
    }

    fn wat_bytes_literal(bytes: &[u8]) -> String {
        let mut output = String::with_capacity(bytes.len() * 3);
        for byte in bytes {
            write!(&mut output, "\\{byte:02x}").unwrap();
        }
        output
    }

    fn module_with_output(output: &[u8]) -> Vec<u8> {
        let output_literal = wat_bytes_literal(output);
        let packed_output = ((OUTPUT_OFFSET as u64) << 32) | output.len() as u64;
        wat::parse_str(format!(
            r#"(module
                (memory (export "memory") 2 64)
                (data (i32.const {OUTPUT_OFFSET}) "{output_literal}")
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64)
                    i64.const {packed_output})
            )"#
        ))
        .unwrap()
    }

    fn valid_output() -> &'static [u8] {
        br#"{"frames":[{"values":[1.5,2.5],"labels":["temp","volt"]}]}"#
    }

    fn prepared_runtime(module_bytes: &[u8]) -> Result<ExtensionRuntime, String> {
        let prepared = prepare_extension(&package_bytes(module_bytes))?;
        let instance = instantiate_extension(&prepared.engine, &prepared.module)?;
        ExtensionRuntime::new(instance).map_err(format_runtime_fault)
    }

    fn expect_string_error<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("操作应当失败"),
            Err(error) => error,
        }
    }

    #[test]
    fn accepts_strict_package_and_parses_bounded_output() {
        let module_bytes = module_with_output(valid_output());
        let package = package_bytes(&module_bytes);
        let prepared = prepare_extension(&package).unwrap();

        assert_eq!(prepared.manifest.id, "io.vofa.example-parser");
        assert_eq!(prepared.module_sha256, sha256_hex(&module_bytes));
        assert_eq!(prepared.package_sha256, sha256_hex(&package));

        let mut runtime = prepared_runtime(&module_bytes).unwrap();
        let frames = runtime.push(b"input", 1234).unwrap();
        assert_eq!(
            frames,
            vec![ExtensionFramePayload {
                values: vec![1.5, 2.5],
                labels: Some(vec!["temp".to_owned(), "volt".to_owned()]),
            }]
        );
    }

    #[test]
    fn repository_example_matches_manifest_and_runtime_contract() {
        let module_bytes = wat::parse_str(include_str!(
            "../../examples/extensions/constant-parser/parser.wat"
        ))
        .unwrap();
        let manifest: Value = serde_json::from_str(include_str!(
            "../../examples/extensions/constant-parser/manifest.json"
        ))
        .unwrap();
        let package = serde_json::to_vec(&json!({
            "format": EXTENSION_FORMAT,
            "schemaVersion": EXTENSION_SCHEMA_VERSION,
            "manifest": manifest,
            "moduleSha256": sha256_hex(&module_bytes),
            "moduleBase64": BASE64_STANDARD.encode(&module_bytes)
        }))
        .unwrap();
        let prepared = prepare_extension(&package).unwrap();

        assert_eq!(prepared.manifest.id, "io.vofa.constant-parser");
        let instance = instantiate_extension(&prepared.engine, &prepared.module).unwrap();
        let mut runtime = ExtensionRuntime::new(instance).unwrap();
        assert_eq!(
            runtime.push(b"ignored", 1_000).unwrap(),
            vec![ExtensionFramePayload {
                values: vec![1.0],
                labels: Some(vec!["example".to_owned()]),
            }]
        );
    }

    #[test]
    fn repeatedly_processes_maximum_size_batches_and_remains_reusable_after_reset() {
        const BATCH_COUNT: u64 = 128;

        let module_bytes = module_with_output(valid_output());
        let mut runtime = prepared_runtime(&module_bytes).unwrap();
        let input = vec![0x5a; MAX_INPUT_BYTES];

        for batch_index in 0..BATCH_COUNT {
            let frames = runtime.push(&input, 1_000 + batch_index).unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].values, [1.5, 2.5]);
        }
        runtime.reset().unwrap();
        assert_eq!(runtime.push(&input, 2_000).unwrap().len(), 1);
    }

    #[test]
    fn compatibility_policy_matches_runtime_abi_constants() {
        let policy: Value =
            serde_json::from_str(include_str!("../../compatibility-policy.json")).unwrap();
        let abi = &policy["protocols"]["runtimePluginAbi"];

        assert_eq!(policy["schemaVersion"], json!(2));
        assert_eq!(abi["identifier"], json!("vux-wasm-v1-experimental"));
        assert_eq!(abi["status"], json!("experimental"));
        assert_eq!(abi["packageFormat"], json!(EXTENSION_FORMAT));
        assert_eq!(abi["schemaVersion"], json!(EXTENSION_SCHEMA_VERSION));
        assert_eq!(abi["apiVersion"], json!(EXTENSION_API_VERSION));
        assert_eq!(abi["futureVersionBehavior"], json!("reject"));
    }

    #[test]
    fn rejects_unknown_duplicate_and_oversized_package_data() {
        let module_bytes = module_with_output(valid_output());
        let mut unknown = package_value(&module_bytes);
        unknown["unexpected"] = json!(true);
        let error = expect_string_error(prepare_extension(&serde_json::to_vec(&unknown).unwrap()));
        assert!(error.contains("unknown field"));

        let duplicate = format!(
            r#"{{"format":"vofa-ultra-extension","format":"vofa-ultra-extension",
                "schemaVersion":1,"manifest":{},"moduleSha256":"{}","moduleBase64":"{}"}}"#,
            manifest_value(),
            sha256_hex(&module_bytes),
            BASE64_STANDARD.encode(&module_bytes)
        );
        let error = expect_string_error(prepare_extension(duplicate.as_bytes()));
        assert!(error.contains("duplicate field"));

        let error = expect_string_error(prepare_extension(&vec![b' '; MAX_PACKAGE_BYTES + 1]));
        assert!(error.contains("超过"));

        let error = read_bounded_file(".", MAX_PACKAGE_BYTES).unwrap_err();
        assert!(error.contains("普通文件"));
    }

    #[test]
    fn rejects_hash_mismatch_invalid_manifest_and_base64_overflow() {
        let module_bytes = module_with_output(valid_output());
        let mut wrong_hash = package_value(&module_bytes);
        wrong_hash["moduleSha256"] = json!("0".repeat(64));
        let error =
            expect_string_error(prepare_extension(&serde_json::to_vec(&wrong_hash).unwrap()));
        assert!(error.contains("哈希不匹配"));

        let mut invalid_manifest = package_value(&module_bytes);
        invalid_manifest["manifest"]["capabilities"] = json!(["live-rx.read", "network"]);
        let error = expect_string_error(prepare_extension(
            &serde_json::to_vec(&invalid_manifest).unwrap(),
        ));
        assert!(error.contains("必须且只能声明"));

        let mut padded_license = package_value(&module_bytes);
        padded_license["manifest"]["license"] = json!("   ");
        let error = expect_string_error(prepare_extension(
            &serde_json::to_vec(&padded_license).unwrap(),
        ));
        assert!(error.contains("许可证声明"));

        let mut oversized_base64 = package_value(&module_bytes);
        oversized_base64["moduleBase64"] = json!("A".repeat(max_module_base64_length() + 1));
        let error = expect_string_error(prepare_extension(
            &serde_json::to_vec(&oversized_base64).unwrap(),
        ));
        assert!(error.contains("Base64 数据超过上限"));
    }

    #[test]
    fn rejects_imports_start_functions_and_wrong_abi() {
        let imported = wat::parse_str(
            r#"(module
                (import "host" "read" (func))
                (memory (export "memory") 1)
            )"#,
        )
        .unwrap();
        let error = expect_string_error(prepare_extension(&package_bytes(&imported)));
        assert_eq!(error, "扩展不得导入宿主能力");

        let with_start = wat::parse_str(
            r#"(module
                (memory (export "memory") 1 64)
                (func $start)
                (start $start)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64) i64.const 0)
            )"#,
        )
        .unwrap();
        let prepared = prepare_extension(&package_bytes(&with_start)).unwrap();
        let error = expect_string_error(instantiate_extension(&prepared.engine, &prepared.module));
        assert!(error.contains("不得声明 start"));

        let wrong_abi = wat::parse_str(
            r#"(module
                (memory (export "memory") 1 64)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32) (result i64) i64.const 0)
            )"#,
        )
        .unwrap();
        let prepared = prepare_extension(&package_bytes(&wrong_abi)).unwrap();
        let error = expect_string_error(instantiate_extension(&prepared.engine, &prepared.module));
        assert!(error.contains("ABI 签名不匹配"));
    }

    #[test]
    fn inspection_does_not_call_guest_exports() {
        let trapping_exports = wat::parse_str(
            r#"(module
                (memory (export "memory") 1 64)
                (func (export "vofa_abi_version") (result i32) unreachable)
                (func (export "vofa_input_ptr") (result i32) unreachable)
                (func (export "vofa_reset") (result i32) unreachable)
                (func (export "vofa_push") (param i32 f64) (result i64) unreachable)
            )"#,
        )
        .unwrap();
        let prepared = prepare_extension(&package_bytes(&trapping_exports)).unwrap();

        assert!(instantiate_extension(&prepared.engine, &prepared.module).is_ok());
    }

    #[test]
    fn enforces_initial_memory_and_input_buffer_bounds() {
        let oversized_memory = wat::parse_str(
            r#"(module
                (memory (export "memory") 65 65)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64) i64.const 0)
            )"#,
        )
        .unwrap();
        let prepared = prepare_extension(&package_bytes(&oversized_memory)).unwrap();
        let error = expect_string_error(instantiate_extension(&prepared.engine, &prepared.module));
        assert!(error.contains("实例化扩展失败") || error.contains("初始内存"));

        let short_input = wat::parse_str(
            r#"(module
                (memory (export "memory") 1 64)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 1)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64) i64.const 0)
            )"#,
        )
        .unwrap();
        let error = expect_string_error(prepared_runtime(&short_input));
        assert!(error.contains("输入缓冲区越界"));
    }

    #[test]
    fn fuel_exhaustion_is_classified_and_runtime_is_not_reused_by_state() {
        let infinite = wat::parse_str(
            r#"(module
                (memory (export "memory") 1 64)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64)
                    (loop $forever (br $forever))
                    i64.const 0)
            )"#,
        )
        .unwrap();
        let mut runtime = prepared_runtime(&infinite).unwrap();
        let fault = runtime.push(b"x", 1).unwrap_err();

        assert_eq!(fault.code.as_str(), "fuel-exhausted");
        let mut shared = SharedExtensionState {
            status: ExtensionStatus::Active,
            session_id: 3,
            generation: 4,
            runtime: Some(runtime),
            authorized_capabilities: vec![LIVE_RX_CAPABILITY.to_owned()],
            ..SharedExtensionState::default()
        };
        let payload = shared.fail(&fault);
        assert_eq!(payload.status, "error");
        assert_eq!(payload.generation, 5);
        assert!(shared.runtime.is_none());
        assert!(payload.authorized_capabilities.is_empty());
        assert!(require_known_session(&shared, 3).is_ok());
        assert!(require_current_session(&shared, 3, Some(5)).is_err());
    }

    #[test]
    fn rejects_output_size_pointer_json_and_schema_violations() {
        let oversized_packed = ((OUTPUT_OFFSET as u64) << 32) | (MAX_OUTPUT_BYTES + 1) as u64;
        let oversized = wat::parse_str(format!(
            r#"(module
                (memory (export "memory") 2 64)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64)
                    i64.const {oversized_packed})
            )"#
        ))
        .unwrap();
        let mut runtime = prepared_runtime(&oversized).unwrap();
        let fault = runtime.push(b"x", 1).unwrap_err();
        assert_eq!(fault.code.as_str(), "output-invalid");

        let invalid_pointer = ((MAX_MEMORY_BYTES as u64) << 32) | 1;
        let pointer_module = wat::parse_str(format!(
            r#"(module
                (memory (export "memory") 1 64)
                (func (export "vofa_abi_version") (result i32) i32.const 1)
                (func (export "vofa_input_ptr") (result i32) i32.const 0)
                (func (export "vofa_reset") (result i32) i32.const 0)
                (func (export "vofa_push") (param i32 f64) (result i64)
                    i64.const {invalid_pointer})
            )"#
        ))
        .unwrap();
        let mut runtime = prepared_runtime(&pointer_module).unwrap();
        let fault = runtime.push(b"x", 1).unwrap_err();
        assert_eq!(fault.code.as_str(), "abi-violation");

        let invalid_json = module_with_output(b"not json");
        let mut runtime = prepared_runtime(&invalid_json).unwrap();
        let fault = runtime.push(b"x", 1).unwrap_err();
        assert_eq!(fault.code.as_str(), "output-invalid");

        let duplicate_labels = br#"{"frames":[{"values":[1,2],"labels":["same","same"]}]}"#;
        let fault = parse_extension_output(duplicate_labels).unwrap_err();
        assert_eq!(fault.code.as_str(), "output-invalid");

        let too_many_frames = json!({
            "frames": (0..=MAX_OUTPUT_FRAMES)
                .map(|_| json!({"values": [1]}))
                .collect::<Vec<_>>()
        });
        let fault =
            parse_extension_output(&serde_json::to_vec(&too_many_frames).unwrap()).unwrap_err();
        assert_eq!(fault.code.as_str(), "output-invalid");
    }

    #[test]
    fn reset_and_deactivate_advance_generation_and_clear_authority() {
        let module_bytes = module_with_output(valid_output());
        let prepared = prepare_extension(&package_bytes(&module_bytes)).unwrap();
        let instance = instantiate_extension(&prepared.engine, &prepared.module).unwrap();
        let runtime = ExtensionRuntime::new(instance).unwrap();
        let mut shared = SharedExtensionState::default();
        let active = shared.activate(prepared, runtime);
        assert_eq!(active.session_id, 1);
        assert_eq!(active.generation, 1);
        assert!(require_current_session(&shared, 1, Some(1)).is_ok());

        let deactivated = shared.deactivate();
        assert_eq!(deactivated.status, "idle");
        assert_eq!(deactivated.generation, 2);
        assert!(deactivated.authorized_capabilities.is_empty());
        assert!(require_current_session(&shared, 1, Some(1)).is_err());

        let pending_request = shared.begin_activation();
        let cancelled = deactivate_session(&mut shared, 1).unwrap();
        assert_eq!(cancelled.status, "idle");
        assert_ne!(shared.activation_request, pending_request);
        assert!(deactivate_session(&mut shared, 99).is_err());
    }

    #[test]
    fn later_activation_or_deactivation_invalidates_older_request() {
        let mut shared = SharedExtensionState::default();
        let first = shared.begin_activation();
        let second = shared.begin_activation();

        assert_ne!(first, second);
        assert_eq!(shared.activation_request, second);

        shared.status = ExtensionStatus::Error;
        shared.session_id = 8;
        let before_deactivation = shared.activation_request;
        let payload = shared.deactivate();
        assert_eq!(payload.status, "idle");
        assert_ne!(shared.activation_request, before_deactivation);
    }

    #[test]
    fn operation_permits_reject_concurrent_compilation_and_push() {
        let state = ExtensionState::default();
        let compilation = state.try_compilation_permit().unwrap();
        assert!(state.try_compilation_permit().is_err());
        drop(compilation);
        assert!(state.try_compilation_permit().is_ok());

        let push = state.try_push_permit().unwrap();
        assert!(state.try_push_permit().is_err());
        drop(push);
        assert!(state.try_push_permit().is_ok());
    }

    #[test]
    fn rejected_activation_does_not_invalidate_accepted_request() {
        let state = ExtensionState::default();
        let (accepted_permit, accepted_request) = state.try_begin_activation().unwrap();

        assert!(state.try_begin_activation().is_err());
        assert_eq!(
            state.shared.lock().unwrap().activation_request,
            accepted_request
        );

        drop(accepted_permit);
    }

    #[test]
    fn rejects_bidi_and_invisible_format_characters() {
        let error =
            validate_display_text("扩展名称", "可信\u{202e}伪装", 64, 256, false).unwrap_err();
        assert!(error.contains("双向覆盖符"));

        let bidi_isolate = char::from_u32(0x2066).unwrap();
        let output = json!({
            "frames": [{"values": [1], "labels": [format!("safe{bidi_isolate}spoof")]}]
        });
        let fault = parse_extension_output(&serde_json::to_vec(&output).unwrap()).unwrap_err();
        assert_eq!(fault.code.as_str(), "output-invalid");
        assert!(fault.message.contains("不可见格式字符"));
    }

    #[test]
    fn bounds_untrusted_error_text_before_it_reaches_the_ui() {
        let module_bytes = module_with_output(valid_output());
        let mut invalid_format = package_value(&module_bytes);
        invalid_format["format"] = json!("x".repeat(MAX_PACKAGE_BYTES / 2));
        let error = expect_string_error(prepare_extension(
            &serde_json::to_vec(&invalid_format).unwrap(),
        ));
        assert_eq!(error, "不支持的扩展包格式");

        let mut invalid_kind = package_value(&module_bytes);
        invalid_kind["manifest"]["kind"] = json!("x".repeat(MAX_PACKAGE_BYTES / 2));
        let error = expect_string_error(prepare_extension(
            &serde_json::to_vec(&invalid_kind).unwrap(),
        ));
        assert_eq!(error, "不支持的扩展类型");

        let error =
            guard_untrusted::<()>(|| Err("界".repeat(MAX_EXTENSION_ERROR_CHARS * 4))).unwrap_err();
        assert!(error.ends_with("..."));
        assert!(error.chars().count() <= MAX_EXTENSION_ERROR_CHARS);
        assert!(error.len() <= MAX_EXTENSION_ERROR_BYTES);

        let fault = RuntimeFault::new(
            RuntimeFaultCode::RuntimeTrap,
            "x".repeat(MAX_EXTENSION_ERROR_BYTES * 2),
        );
        assert!(fault.message.ends_with("..."));
        assert!(fault.message.chars().count() <= MAX_EXTENSION_ERROR_CHARS);
        assert!(fault.message.len() <= MAX_EXTENSION_ERROR_BYTES);

        let mut shared = SharedExtensionState::default();
        let snapshot = shared.fail(&RuntimeFault {
            code: RuntimeFaultCode::RuntimeTrap,
            message: "界".repeat(MAX_EXTENSION_ERROR_CHARS * 4),
        });
        let snapshot_message = snapshot.message.unwrap();
        assert!(snapshot_message.chars().count() <= MAX_EXTENSION_ERROR_CHARS);
        assert!(snapshot_message.len() <= MAX_EXTENSION_ERROR_BYTES);
    }
}
