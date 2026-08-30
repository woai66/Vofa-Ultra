import { create, type StoreApi } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { APP_BUILD_ID, APP_VERSION } from "../core/appMetadata";
import {
  AutoResponderRuntime,
  CommandSendArbiter,
  cloneAutoResponderRules,
  createInitialAutoResponderSnapshot,
  isAutoResponderActive,
  parseAutoResponderRules,
  type AutoResponderStopReason,
  type CommandSendOrigin,
} from "../core/autoResponder";
import { decodeBase64, formatHex } from "../core/codec";
import { isTextEncodingLoaded, loadTextEncoding } from "../core/textEncoding";
import {
  cloneChannelPresentations,
  updateChannelPresentation,
} from "../core/channelPresentation";
import {
  extractLatestAttitudeSample,
  parseAttitudeConfig,
} from "../core/attitude";
import {
  compileCommandTemplate,
  MAX_COMMAND_BYTES,
  renderCommandTemplate,
  type CommandTemplateContext,
  type CompiledCommandTemplate,
} from "../core/commandTemplate";
import {
  parseCommandChecksumMode,
  type CommandChecksumMode,
} from "../core/checksum";
import {
  cloneSimulatorConfig,
  parseSimulatorConfig,
} from "../core/simulator";
import {
  cloneQuickCommands,
  parseQuickCommands,
} from "../core/quickCommands";
import {
  appendCommandHistory,
  CommandScheduler,
  commandHistoryPayloadBytes,
  createInitialCommandTaskSnapshot,
  type CommandTaskStopReason,
  type PreparedCommand,
} from "../core/commandWorkflow";
import { ExtensionCoordinator } from "../core/extensionCoordinator";
import {
  createInitialModbusPollSnapshot,
  isModbusPollActive,
  ModbusPoller,
  type ModbusPollSnapshot,
} from "../core/modbusPoller";
import {
  buildModbusRtuRequest,
  cloneModbusRtuRequest,
  createInitialModbusRtuTransactionSnapshot,
  formatModbusRtuFrame,
  MAX_MODBUS_TRANSACTION_HISTORY,
  MAX_MODBUS_TRANSACTION_TIMEOUT_MS,
  MIN_MODBUS_TRANSACTION_TIMEOUT_MS,
  parseModbusRtuResponse,
  simulateModbusRtuResponse,
  type ModbusRtuReadRequest,
  type ModbusRtuRequest,
  type ModbusRtuTransactionRecord,
  type ModbusRtuTransactionSnapshot,
} from "../core/modbusRtu";
import {
  createProtocolParser,
  getProtocolDefinition,
  MAX_PROTOCOL_CHANNELS,
  protocolSupportsReplaySeek,
  type ProtocolParser,
} from "../core/protocols";
import {
  cloneProcessingGraph,
  parseProcessingGraphConfig,
  ProcessingGraphRuntime,
  processingOutputChannelId,
} from "../core/processingGraph";
import { RingBuffer } from "../core/ringBuffer";
import { sortSerialPorts } from "../core/serialPorts";
import {
  MAX_TERMINAL_LINE_ENDING_BYTES,
  MAX_TERMINAL_UNTERMINATED_LINE_BYTES,
  TerminalLineAssembler,
  type AssembledTerminalLine,
} from "../core/terminalLineAssembler";
import {
  advanceWaveformTrigger,
  createArmedWaveformTriggerState,
  createIdleWaveformTriggerState,
  isWaveformTriggerConfigValid,
  type WaveformTriggerAdvanceResult,
  type WaveformTriggerConfig,
  type WaveformTriggerObservation,
  type WaveformTriggerState,
} from "../core/waveformTrigger";
import {
  isRecoveryActivePhase,
  SERIAL_RECOVERY_DELAYS_MS,
  SerialReconnectCoordinator,
} from "../core/serialRecovery";
import {
  areWorkspaceConfigsEqual,
  assertWorkspaceNameAvailable,
  captureWorkspaceConfig,
  cloneWorkspaceConfig,
  createDefaultWorkspaceConfig,
  createWorkspaceProfile,
  DEFAULT_WORKSPACE_ID,
  makeUniqueWorkspaceName,
  MAX_WORKSPACE_COUNT,
  pruneAttitudeConfigForGraph,
  restoreWorkspaceConfig,
  restoreWorkspaceProfiles,
  validateWorkspaceName,
} from "../core/workspaces";
import {
  abortCapture as abortCaptureClient,
  enqueueCaptureMarker,
  enqueueSimulatorCapture,
  resetSimulatorCaptureQueue,
  startCapture as startCaptureClient,
  stopCapture as stopCaptureClient,
} from "../services/captureClient";
import {
  cancelCaptureExport as cancelCaptureExportClient,
  clearCaptureExport as clearCaptureExportClient,
  selectCaptureExportDestinationPath,
  selectCaptureExportSourcePath,
  startCaptureExport as startCaptureExportClient,
} from "../services/captureExportClient";
import {
  abortNumericLog as abortNumericLogClient,
  enqueueNumericLogSamples,
  resetNumericLogQueue,
  startNumericLog as startNumericLogClient,
  stopNumericLog as stopNumericLogClient,
} from "../services/numericLogClient";
import { selectRecordingDirectoryPath } from "../services/recordingDirectoryClient";
import {
  cancelSerialFileSend as cancelSerialFileSendClient,
  cancelSerialModbusTransaction,
  cancelSerialConnect,
  connectSerial,
  disconnectSerial,
  getSerialState,
  isTauriRuntime,
  listSerialPorts,
  sendSerial,
  setSerialControlLine as setSerialControlLineClient,
  startSerialFileSend as startSerialFileSendClient,
  startSerialModbusTransaction,
} from "../services/serialClient";
import {
  activateExtension as activateExtensionClient,
  deactivateExtension as deactivateExtensionClient,
  getExtensionState as getExtensionStateClient,
  inspectExtension as inspectExtensionClient,
  pushExtensionBatch,
  resetExtension as resetExtensionClient,
  selectExtensionPackagePath,
} from "../services/extensionClient";
import {
  ackReplayBatch as ackReplayBatchClient,
  closeReplay as closeReplayClient,
  openReplay as openReplayClient,
  pauseReplay as pauseReplayClient,
  playReplay as playReplayClient,
  selectReplayFilePath,
  seekReplay as seekReplayClient,
  setReplaySpeed as setReplaySpeedClient,
  stopReplay as stopReplayClient,
} from "../services/replayClient";
import {
  MAX_CAPTURE_MARKERS,
  type CaptureMarkerColor,
  type CaptureStatePayload,
  type CaptureUiStatus,
} from "../types/capture";
import type {
  CaptureExportDirection,
  CaptureExportFormat,
  CaptureExportStatePayload,
  CaptureExportUiStatus,
} from "../types/captureExport";
import type {
  ReplayBatchPayload,
  ReplayCaptureHeader,
  ReplayMarkersPayload,
  ReplayMarkerPayload,
  ReplaySpeed,
  ReplayStatePayload,
  ReplayUiStatus,
} from "../types/replay";
import { REPLAY_SPEEDS } from "../types/replay";
import type {
  NumericLogSample,
  NumericLogStatePayload,
  NumericLogUiStatus,
} from "../types/numericLog";
import type {
  ConnectionStatus,
  DataSource,
  DisplayMode,
  LineEnding,
  ProtocolKind,
  SerialConfig,
  SerialControlLine,
  SerialDataPayload,
  SerialDiagnosticsReport,
  SerialFileSendPayload,
  SerialModemStatusPayload,
  SerialModbusTransactionPayload,
  SerialPortInfo,
  SerialRecoverySnapshot,
  SerialStatePayload,
  SerialTxPayload,
} from "../types/serial";
import type { SimulatorConfig } from "../types/simulator";
import { LEGACY_LINE_ENDINGS, LINE_ENDINGS } from "../types/serial";
import type {
  AttitudeChannelValue,
  AttitudeConfig,
  AttitudeSample,
} from "../types/attitude";
import type {
  ChannelSeries,
  CommandHistoryEntry,
  CommandTaskSnapshot,
  DataPoint,
  ParsedFrame,
  ProtocolHealthSnapshot,
  QuickCommand,
  TerminalEntry,
  TerminalRxLineEnding,
  TerminalRxRecordMode,
  TerminalRxTextEncoding,
  TerminalTextEncoding,
  TransferStats,
} from "../types/workbench";
import type {
  ProcessingGraphConfig,
  ProcessingGraphSnapshot,
  ProcessingOutputSample,
} from "../types/processingGraph";
import type {
  BaseChannelId,
  ChannelPresentationOverride,
  ChannelPresentationProtocol,
  ChannelPresentations,
  ChartWindowSeconds,
  WorkspaceExportV13,
  WorkspaceProfile,
} from "../types/workspace";
import type { AutoResponderRule, AutoResponderSnapshot } from "../types/automation";
import {
  LIVE_RX_CAPABILITY,
  type ExtensionBatchPayload,
  type ExtensionInspectionPayload,
  type ExtensionOperation,
  type ExtensionQueueSnapshot,
  type ExtensionStatePayload,
} from "../types/extensions";

// 覆盖内置模拟器 200 Hz 采样率下的完整 60 秒最大时间窗。
export const MAX_POINTS_PER_CHANNEL = 12_000;
const MAX_TERMINAL_ENTRIES = 800;
const MAX_TERMINAL_BYTES_PER_ENTRY =
  MAX_TERMINAL_UNTERMINATED_LINE_BYTES + MAX_TERMINAL_LINE_ENDING_BYTES;

type TerminalPresentationContext =
  | "live:justfloat"
  | `replay:${number}:justfloat`;

interface TerminalPresentationOverride {
  context: TerminalPresentationContext;
  displayMode: DisplayMode;
  recordMode: TerminalRxRecordMode;
}

export const WORKBENCH_STORAGE_KEY = "vofa-ultra-workbench";
export const WORKBENCH_STORAGE_VERSION = 13;
export const WORKBENCH_MIGRATABLE_STORAGE_VERSIONS = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
] as const;
const INITIAL_SERIAL_RECOVERY: SerialRecoverySnapshot = {
  enabled: false,
  phase: "off",
  attempt: 0,
  maxAttempts: SERIAL_RECOVERY_DELAYS_MS.length,
  message: "自动重连未启用",
  diagnosticEventCount: 0,
  diagnosticDroppedEvents: 0,
};

function createUnavailableSerialModemStatus(generation = 0): SerialModemStatusPayload {
  return {
    generation,
    revision: 0,
    cts: null,
    dsr: null,
    ri: null,
    dcd: null,
  };
}
const INITIAL_NATIVE_RUNTIME = isTauriRuntime();
const INITIAL_WORKSPACE_CONFIG = createDefaultWorkspaceConfig(
  INITIAL_NATIVE_RUNTIME ? "serial" : "simulator",
);
const INITIAL_WORKSPACE = createWorkspaceProfile(
  "默认工作区",
  INITIAL_WORKSPACE_CONFIG,
  DEFAULT_WORKSPACE_ID,
);
const CHANNEL_COLORS = [
  "#46d89c",
  "#55bde8",
  "#f0b35a",
  "#f06d76",
  "#b69cf6",
  "#8bd450",
  "#ed8bca",
  "#72d5cf",
];

let parserProtocol: ProtocolKind = "firewater";
let protocolParser: ProtocolParser = createProtocolParser(parserProtocol);
let terminalDecoderEncoding = INITIAL_WORKSPACE_CONFIG.terminalRxTextEncoding;
let terminalDecoder = createTerminalTextDecoder(terminalDecoderEncoding);
const terminalLineAssembler = new TerminalLineAssembler();
let terminalEntryId = 0;
let chartFrameSequence = 0;
const channelBuffers = new Map<string, RingBuffer<DataPoint>>();
const processingChannelBuffers = new Map<string, RingBuffer<DataPoint>>();
const extensionChannelBuffers = new Map<string, RingBuffer<DataPoint>>();
let liveProcessingRuntime = new ProcessingGraphRuntime(
  INITIAL_WORKSPACE_CONFIG.processingGraph,
);
let replayParserProtocol: ProtocolKind = "raw";
let replayProtocolParser: ProtocolParser = createProtocolParser(replayParserProtocol);
let replayRxDecoderEncoding = INITIAL_WORKSPACE_CONFIG.terminalRxTextEncoding;
let replayRxDecoder = createTerminalTextDecoder(replayRxDecoderEncoding);
let replayTxDecoder = new TextDecoder();
const replayRxLineAssembler = new TerminalLineAssembler();
const replayChannelBuffers = new Map<string, RingBuffer<DataPoint>>();
const replayProcessingChannelBuffers = new Map<string, RingBuffer<DataPoint>>();
let replayProcessingRuntime = new ProcessingGraphRuntime(
  INITIAL_WORKSPACE_CONFIG.processingGraph,
);
let captureStopPromise: Promise<boolean> | null = null;
let numericLogStopPromise: Promise<boolean> | null = null;
let appClosePromise: Promise<void> | null = null;
let serialRecoveryCoordinator: SerialReconnectCoordinator | null = null;
let serialConnectOperation = 0;
let serialPortRefreshOperation = 0;
let serialControlLineOperation = 0;
let serialRecoverySettingOperation = 0;
let commandScheduler: CommandScheduler | null = null;
let autoResponderRuntime: AutoResponderRuntime | null = null;
let modbusPoller: ModbusPoller | null = null;
const commandSendArbiter = new CommandSendArbiter();
let captureExportDialogOperation = 0;
let extensionOperation = 0;
let extensionCoordinator: ExtensionCoordinator | null = null;
let modbusTransactionSequence = Date.now() * 1_000;
let simulatorModbusTimer: ReturnType<typeof setTimeout> | null = null;

type RuntimeTransitionStatus =
  | "idle"
  | "switching-source"
  | "connecting"
  | "disconnecting"
  | "starting-capture"
  | "stopping-capture"
  | "starting-numeric-log"
  | "stopping-numeric-log"
  | "selecting-replay"
  | "opening-replay"
  | "controlling-replay"
  | "switching-workspace"
  | "closing-app";

type SerialPortDiscoveryStatus = "idle" | "ready" | "empty" | "error";

export interface WorkbenchStore {
  isNativeRuntime: boolean;
  source: DataSource;
  protocol: ProtocolKind;
  connectionStatus: ConnectionStatus;
  serialGeneration: number;
  serialStateRevision: number;
  serialRuntimeError: string;
  connectionActionError: string;
  connectionMessage: string;
  statusMessage: string;
  ports: SerialPortInfo[];
  isRefreshingPorts: boolean;
  serialPortDiscoveryStatus: SerialPortDiscoveryStatus;
  serialPortDiscoveryMessage: string;
  serialConfig: SerialConfig;
  simulatorConfig: SimulatorConfig;
  serialControlLineOperation: "idle" | SerialControlLine;
  serialModemStatus: SerialModemStatusPayload;
  serialRecovery: SerialRecoverySnapshot;
  isCancellingSerialConnection: boolean;
  channels: ChannelSeries[];
  processedChannels: ChannelSeries[];
  chartFrozenChannels: ChannelSeries[] | null;
  chartFrozenProcessedChannels: ChannelSeries[] | null;
  channelVisibility: Record<string, boolean>;
  channelPresentations: ChannelPresentations;
  extensionChannels: ChannelSeries[];
  chartFrozenExtensionChannels: ChannelSeries[] | null;
  extensionChannelVisibility: Record<string, boolean>;
  extensionInspection: ExtensionInspectionPayload | null;
  extensionPackagePath: string;
  extensionAuthorizationRevision: number;
  extensionState: ExtensionStatePayload;
  extensionOperation: ExtensionOperation;
  extensionMessage: string;
  extensionQueue: ExtensionQueueSnapshot;
  processingGraph: ProcessingGraphConfig;
  processingStatus: Readonly<ProcessingGraphSnapshot>;
  attitudeConfig: AttitudeConfig;
  attitudeSample: (AttitudeSample & { readonly receivedAt: number }) | null;
  terminalEntries: TerminalEntry[];
  displayMode: DisplayMode;
  terminalPresentationOverride: TerminalPresentationOverride | null;
  sendMode: DisplayMode;
  lineEnding: LineEnding;
  commandChecksum: CommandChecksumMode;
  terminalRxRecordMode: TerminalRxRecordMode;
  terminalRxLineEnding: TerminalRxLineEnding;
  terminalRxTextEncoding: TerminalRxTextEncoding;
  terminalTxTextEncoding: TerminalTextEncoding;
  commandHistory: CommandHistoryEntry[];
  quickCommands: QuickCommand[];
  commandTask: CommandTaskSnapshot;
  autoResponderRules: AutoResponderRule[];
  autoResponder: AutoResponderSnapshot;
  modbusPoll: ModbusPollSnapshot;
  modbusTransaction: ModbusRtuTransactionSnapshot;
  modbusTransactions: ModbusRtuTransactionRecord[];
  serialFileSend: SerialFileSendPayload;
  isSendingCommand: boolean;
  commandSendOrigin: CommandSendOrigin | null;
  terminalPaused: boolean;
  terminalAutoScroll: boolean;
  chartPaused: boolean;
  chartWindowSeconds: ChartWindowSeconds;
  chartDataRevision: number;
  waveformTrigger: WaveformTriggerState;
  stats: TransferStats;
  protocolHealth: ProtocolHealthSnapshot;
  replayProtocolHealth: ProtocolHealthSnapshot;
  workspaces: WorkspaceProfile[];
  activeWorkspaceId: string;
  workspaceTransitionStatus: "idle" | "switching" | "deleting";
  runtimeTransitionStatus: RuntimeTransitionStatus;
  recordingDirectoryStatus: "idle" | "selecting";
  recordingDirectory: string;
  recordingDirectoryMessage: string;
  workspaceStorageStatus: "writable" | "newer-version";
  incompatibleStorageVersion: number | null;
  captureStatus: CaptureUiStatus;
  captureSessionId: number;
  captureRevision: number;
  captureFormatVersion: number;
  capturePath: string;
  captureStartedAt?: number;
  captureEndedAt?: number;
  captureDataBytes: number;
  captureRecordCount: number;
  captureMarkerCount: number;
  captureMessage: string;
  numericLogStatus: NumericLogUiStatus;
  numericLogSessionId: number;
  numericLogRevision: number;
  numericLogPath: string;
  numericLogStartedAt?: number;
  numericLogEndedAt?: number;
  numericLogOutputBytes: number;
  numericLogSampleCount: number;
  numericLogMessage: string;
  captureExportStatus: CaptureExportUiStatus;
  captureExportPhase: CaptureExportStatePayload["phase"];
  captureExportJobId: number;
  captureExportRevision: number;
  captureExportSourcePath: string;
  captureExportDestinationPath: string;
  captureExportFormat: CaptureExportFormat;
  captureExportDirection: CaptureExportDirection;
  captureExportAllowIncomplete: boolean;
  captureExportTotalInputBytes: number;
  captureExportProcessedInputBytes: number;
  captureExportProcessedDataBytes: number;
  captureExportProcessedRecords: number;
  captureExportExportedDataBytes: number;
  captureExportExportedRecords: number;
  captureExportOutputBytes: number;
  captureExportSourceComplete: boolean;
  captureExportStartedAt?: number;
  captureExportEndedAt?: number;
  captureExportMessage: string;
  replayStatus: ReplayUiStatus;
  replaySessionId: number;
  replayGeneration: number;
  replayTimelineRevision: number;
  replayRevision: number;
  replayPath: string;
  replayHeader?: ReplayCaptureHeader;
  replayFormatVersion: number;
  replayComplete: boolean;
  replaySpeed: ReplaySpeed;
  replayPositionUs: number;
  replayDurationUs: number;
  replayDataBytes: number;
  replayRecordCount: number;
  replayMarkerCount: number;
  replayMarkers: ReplayMarkerPayload[];
  replayNextSequence: number;
  replayMessage: string;
  setRuntimeAvailability(nativeRuntime: boolean): void;
  setSerialRuntimeError(message: string): void;
  reportSerialRuntimeWarning(message: string): void;
  setSource(source: DataSource): Promise<void>;
  setProtocol(protocol: ProtocolKind): void;
  updateSerialConfig<K extends keyof SerialConfig>(key: K, value: SerialConfig[K]): void;
  updateSimulatorConfig<K extends keyof SimulatorConfig>(
    key: K,
    value: SimulatorConfig[K],
  ): void;
  setSerialControlLine(line: SerialControlLine, asserted: boolean): Promise<boolean>;
  refreshPorts(mode?: "manual" | "background"): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<boolean>;
  setSerialRecoveryEnabled(enabled: boolean): Promise<void>;
  cancelSerialConnection(): Promise<void>;
  clearSerialDiagnostics(): void;
  getSerialDiagnostics(): SerialDiagnosticsReport;
  send(value: string, mode: DisplayMode, lineEnding: LineEnding): Promise<void>;
  startFileSend(path: string): Promise<boolean>;
  cancelFileSend(): Promise<boolean>;
  startPeriodicSend(
    value: string,
    mode: DisplayMode,
    lineEnding: LineEnding,
    intervalMs: number,
    repeatCount: number | null,
  ): void | Promise<void>;
  stopPeriodicSend(): void;
  setAutoResponderRules(rules: readonly AutoResponderRule[]): void;
  startAutoResponder(): void | Promise<void>;
  stopAutoResponder(): void;
  startModbusPolling(
    request: ModbusRtuReadRequest,
    timeoutMs: number,
    intervalMs: number,
  ): void;
  stopModbusPolling(): void;
  startModbusTransaction(request: ModbusRtuRequest, timeoutMs: number): Promise<boolean>;
  cancelModbusTransaction(): Promise<boolean>;
  clearModbusTransactions(): void;
  clearCommandHistory(): void;
  setQuickCommands(commands: readonly QuickCommand[]): void;
  ingestBytes(bytes: Uint8Array, timestamp?: number): void;
  handleSerialData(payload: SerialDataPayload): void;
  handleSerialState(payload: SerialStatePayload): void;
  handleSerialModemStatus(payload: SerialModemStatusPayload): void;
  handleSerialTx(payload: SerialTxPayload): void;
  handleSerialFileSend(payload: SerialFileSendPayload): void;
  handleModbusTransaction(payload: SerialModbusTransactionPayload): void;
  setDisplayMode(mode: DisplayMode): void;
  setSendMode(mode: DisplayMode): void;
  setLineEnding(lineEnding: LineEnding): void;
  setCommandChecksum(mode: CommandChecksumMode): void;
  setTerminalRxRecordMode(mode: TerminalRxRecordMode): void;
  setTerminalRxLineEnding(lineEnding: TerminalRxLineEnding): void;
  setTerminalRxTextEncoding(encoding: TerminalRxTextEncoding): void;
  setTerminalTxTextEncoding(encoding: TerminalTextEncoding): void;
  setTerminalPaused(paused: boolean): void;
  setTerminalAutoScroll(enabled: boolean): void;
  setChartPaused(paused: boolean): void;
  setChartWindowSeconds(seconds: ChartWindowSeconds): void;
  armWaveformTrigger(config: WaveformTriggerConfig): boolean;
  disarmWaveformTrigger(): void;
  setProcessingGraph(config: ProcessingGraphConfig): void;
  retryProcessingGraph(): void;
  setAttitudeConfig(config: AttitudeConfig): void;
  toggleChannel(channelId: string): void;
  setChannelPresentation(
    protocol: ChannelPresentationProtocol,
    channelId: BaseChannelId,
    value: ChannelPresentationOverride | null,
  ): void;
  clearTerminal(): void;
  clearChart(): void;
  resetStats(): void;
  clearProtocolHealth(): void;
  initializeExtensionRuntime(): Promise<void>;
  inspectExtensionPackage(): Promise<boolean>;
  activateInspectedExtension(authorized: boolean): Promise<boolean>;
  deactivateExtension(): Promise<boolean>;
  resetExtension(): Promise<boolean>;
  toggleExtensionChannel(channelId: string): void;
  selectRecordingDirectory(): Promise<boolean>;
  resetRecordingDirectory(): boolean;
  startCapture(): Promise<boolean>;
  stopCapture(): Promise<boolean>;
  addCaptureMarker(label: string, color: CaptureMarkerColor): boolean;
  handleCaptureState(payload: CaptureStatePayload): void;
  startNumericLog(): Promise<boolean>;
  stopNumericLog(): Promise<boolean>;
  handleNumericLogState(payload: NumericLogStatePayload): void;
  selectCaptureExportSource(): Promise<boolean>;
  useRecentCaptureForExport(): boolean;
  setCaptureExportFormat(format: CaptureExportFormat): void;
  setCaptureExportDirection(direction: CaptureExportDirection): void;
  setCaptureExportAllowIncomplete(allow: boolean): void;
  startCaptureExport(): Promise<boolean>;
  cancelCaptureExport(): Promise<boolean>;
  clearCaptureExport(): Promise<boolean>;
  handleCaptureExportState(payload: CaptureExportStatePayload): void;
  openReplayFile(): Promise<boolean>;
  openRecentCapture(): Promise<boolean>;
  playReplay(): Promise<boolean>;
  pauseReplay(): Promise<boolean>;
  seekReplay(targetUs: number): Promise<boolean>;
  setReplaySpeed(speed: ReplaySpeed): Promise<boolean>;
  stopReplay(): Promise<boolean>;
  closeReplay(): Promise<boolean>;
  handleReplayState(payload: ReplayStatePayload): void;
  handleReplayBatch(payload: ReplayBatchPayload): void;
  handleReplayMarkers(payload: ReplayMarkersPayload): void;
  createActiveWorkspaceExport(name: string): WorkspaceProfile;
  saveActiveWorkspace(name: string): void;
  saveWorkspaceAs(name: string): string;
  switchWorkspace(id: string): Promise<boolean>;
  deleteWorkspace(id: string): Promise<boolean>;
  importWorkspace(workspace: WorkspaceExportV13): string;
}

type PersistedWorkbenchState = Pick<
  WorkbenchStore,
  | "source"
  | "protocol"
  | "serialConfig"
  | "simulatorConfig"
  | "displayMode"
  | "sendMode"
  | "lineEnding"
  | "commandChecksum"
  | "terminalRxRecordMode"
  | "terminalRxLineEnding"
  | "terminalRxTextEncoding"
  | "terminalTxTextEncoding"
  | "quickCommands"
  | "terminalAutoScroll"
  | "chartWindowSeconds"
  | "channelVisibility"
  | "channelPresentations"
  | "processingGraph"
  | "attitudeConfig"
  | "autoResponderRules"
  | "workspaces"
  | "activeWorkspaceId"
>;

export const useWorkbenchStore = create<WorkbenchStore>()(
  persist<WorkbenchStore, [], [], PersistedWorkbenchState>(
    (set, get) => ({
      isNativeRuntime: INITIAL_NATIVE_RUNTIME,
      source: INITIAL_WORKSPACE_CONFIG.source,
      protocol: INITIAL_WORKSPACE_CONFIG.protocol,
      connectionStatus: "disconnected",
      serialGeneration: 0,
      serialStateRevision: 0,
      serialRuntimeError: "",
      connectionActionError: "",
      connectionMessage: "等待连接",
      statusMessage: "等待连接",
      ports: [],
      isRefreshingPorts: false,
      serialPortDiscoveryStatus: "idle",
      serialPortDiscoveryMessage: "",
      serialConfig: { ...INITIAL_WORKSPACE_CONFIG.serialConfig },
      simulatorConfig: cloneSimulatorConfig(INITIAL_WORKSPACE_CONFIG.simulatorConfig),
      serialControlLineOperation: "idle",
      serialModemStatus: createUnavailableSerialModemStatus(),
      serialRecovery: { ...INITIAL_SERIAL_RECOVERY },
      isCancellingSerialConnection: false,
      channels: [],
      processedChannels: [],
      chartFrozenChannels: null,
      chartFrozenProcessedChannels: null,
      channelVisibility: {},
      channelPresentations: cloneChannelPresentations(
        INITIAL_WORKSPACE_CONFIG.channelPresentations,
      ),
      extensionChannels: [],
      chartFrozenExtensionChannels: null,
      extensionChannelVisibility: {},
      extensionInspection: null,
      extensionPackagePath: "",
      extensionAuthorizationRevision: 0,
      extensionState: createIdleExtensionState(),
      extensionOperation: "idle",
      extensionMessage: "选择 .vux 扩展包后检查",
      extensionQueue: createIdleExtensionQueue(),
      processingGraph: cloneProcessingGraph(INITIAL_WORKSPACE_CONFIG.processingGraph),
      processingStatus: liveProcessingRuntime.getSnapshot(),
      attitudeConfig: parseAttitudeConfig(INITIAL_WORKSPACE_CONFIG.attitudeConfig),
      attitudeSample: null,
      terminalEntries: [],
      displayMode: INITIAL_WORKSPACE_CONFIG.displayMode,
      terminalPresentationOverride: null,
      sendMode: INITIAL_WORKSPACE_CONFIG.sendMode,
      lineEnding: INITIAL_WORKSPACE_CONFIG.lineEnding,
      commandChecksum: INITIAL_WORKSPACE_CONFIG.commandChecksum,
      terminalRxRecordMode: INITIAL_WORKSPACE_CONFIG.terminalRxRecordMode,
      terminalRxLineEnding: INITIAL_WORKSPACE_CONFIG.terminalRxLineEnding,
      terminalRxTextEncoding: INITIAL_WORKSPACE_CONFIG.terminalRxTextEncoding,
      terminalTxTextEncoding: INITIAL_WORKSPACE_CONFIG.terminalTxTextEncoding,
      commandHistory: [],
      quickCommands: cloneQuickCommands(INITIAL_WORKSPACE_CONFIG.quickCommands),
      commandTask: createInitialCommandTaskSnapshot(),
      autoResponderRules: cloneAutoResponderRules(INITIAL_WORKSPACE_CONFIG.autoResponderRules),
      autoResponder: createInitialAutoResponderSnapshot(),
      modbusPoll: createInitialModbusPollSnapshot(),
      modbusTransaction: createInitialModbusRtuTransactionSnapshot(),
      modbusTransactions: [],
      serialFileSend: createIdleSerialFileSendPayload(),
      isSendingCommand: false,
      commandSendOrigin: null,
      terminalPaused: false,
      terminalAutoScroll: INITIAL_WORKSPACE_CONFIG.terminalAutoScroll,
      chartPaused: false,
      chartWindowSeconds: INITIAL_WORKSPACE_CONFIG.chartWindowSeconds,
      chartDataRevision: 0,
      waveformTrigger: createIdleWaveformTriggerState(),
      stats: emptyStats(),
      protocolHealth: protocolParser.getHealthSnapshot(),
      replayProtocolHealth: replayProtocolParser.getHealthSnapshot(),
      workspaces: [INITIAL_WORKSPACE],
      activeWorkspaceId: INITIAL_WORKSPACE.id,
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      recordingDirectoryStatus: "idle",
      recordingDirectory: "",
      recordingDirectoryMessage: "",
      workspaceStorageStatus: "writable",
      incompatibleStorageVersion: null,
      captureStatus: "idle",
      captureSessionId: 0,
      captureRevision: 0,
      captureFormatVersion: 2,
      capturePath: "",
      captureDataBytes: 0,
      captureRecordCount: 0,
      captureMarkerCount: 0,
      captureMessage: "",
      numericLogStatus: "idle",
      numericLogSessionId: 0,
      numericLogRevision: 0,
      numericLogPath: "",
      numericLogOutputBytes: 0,
      numericLogSampleCount: 0,
      numericLogMessage: "",
      captureExportStatus: "idle",
      captureExportPhase: "idle",
      captureExportJobId: 0,
      captureExportRevision: 0,
      captureExportSourcePath: "",
      captureExportDestinationPath: "",
      captureExportFormat: "csv",
      captureExportDirection: "both",
      captureExportAllowIncomplete: false,
      captureExportTotalInputBytes: 0,
      captureExportProcessedInputBytes: 0,
      captureExportProcessedDataBytes: 0,
      captureExportProcessedRecords: 0,
      captureExportExportedDataBytes: 0,
      captureExportExportedRecords: 0,
      captureExportOutputBytes: 0,
      captureExportSourceComplete: false,
      captureExportMessage: "",
      replayStatus: "idle",
      replaySessionId: 0,
      replayGeneration: 0,
      replayTimelineRevision: 0,
      replayRevision: 0,
      replayPath: "",
      replayFormatVersion: 0,
      replayComplete: false,
      replaySpeed: 1,
      replayPositionUs: 0,
      replayDurationUs: 0,
      replayDataBytes: 0,
      replayRecordCount: 0,
      replayMarkerCount: 0,
      replayMarkers: [],
      replayNextSequence: 1,
      replayMessage: "",

      initializeExtensionRuntime: async () => {
        if (!get().isNativeRuntime) {
          return;
        }
        const operation = ++extensionOperation;
        set({ extensionOperation: "initializing", extensionMessage: "正在校准扩展运行时" });
        try {
          const snapshot = await getExtensionStateClient();
          if (operation !== extensionOperation) {
            if (snapshot.sessionId > 0 && snapshot.status !== "idle") {
              void deactivateExtensionClient(snapshot.sessionId).catch(() => undefined);
            }
            return;
          }
          let settled = snapshot;
          if (snapshot.sessionId > 0 && snapshot.status !== "idle") {
            settled = await deactivateExtensionClient(snapshot.sessionId);
          }
          if (operation !== extensionOperation) {
            return;
          }
          getExtensionCoordinator().deactivate();
          set({
            extensionState: settled,
            extensionOperation: "idle",
            extensionMessage: "扩展运行时已就绪",
            extensionChannels: [],
            chartFrozenExtensionChannels: null,
            extensionChannelVisibility: {},
            extensionQueue: createIdleExtensionQueue(),
          });
        } catch (error) {
          if (operation === extensionOperation) {
            set({
              extensionOperation: "idle",
              extensionMessage: `初始化扩展运行时失败：${getErrorMessage(error)}`,
            });
          }
        }
      },
      inspectExtensionPackage: async () => {
        const state = get();
        if (!state.isNativeRuntime) {
          set({ extensionMessage: "浏览器预览不支持协议扩展" });
          return false;
        }
        if (state.extensionOperation !== "idle" || state.extensionState.status === "active") {
          return false;
        }
        const operation = ++extensionOperation;
        set({ extensionOperation: "selecting", extensionMessage: "正在选择扩展包" });
        try {
          const path = await selectExtensionPackagePath();
          if (operation !== extensionOperation) {
            return false;
          }
          if (!path) {
            set({ extensionOperation: "idle", extensionMessage: state.extensionMessage });
            return false;
          }
          set({
            extensionOperation: "inspecting",
            extensionPackagePath: path,
            extensionInspection: null,
            extensionMessage: "正在校验扩展包格式与模块",
          });
          const inspection = await inspectExtensionClient(path);
          if (operation !== extensionOperation) {
            return false;
          }
          set({
            extensionInspection: inspection,
            extensionOperation: "idle",
            extensionMessage: "格式与运行时校验通过，等待授权",
          });
          return true;
        } catch (error) {
          if (operation === extensionOperation) {
            set({
              extensionInspection: null,
              extensionPackagePath: "",
              extensionOperation: "idle",
              extensionMessage: `检查扩展包失败：${getErrorMessage(error)}`,
            });
          }
          return false;
        }
      },
      activateInspectedExtension: async (authorized) => {
        const state = get();
        if (!authorized) {
          set({ extensionMessage: "启用前需要授权读取实时接收数据" });
          return false;
        }
        if (
          !state.isNativeRuntime ||
          state.extensionOperation !== "idle" ||
          state.extensionState.status === "active" ||
          !state.extensionInspection ||
          !state.extensionPackagePath ||
          state.connectionStatus !== "connected" ||
          hasReplaySession(state)
        ) {
          return false;
        }
        const operation = ++extensionOperation;
        const inspection = state.extensionInspection;
        const path = state.extensionPackagePath;
        let activatedSessionId = 0;
        set({ extensionOperation: "activating", extensionMessage: "正在启用协议扩展" });
        try {
          const payload = await activateExtensionClient(
            path,
            inspection.packageSha256,
            [LIVE_RX_CAPABILITY],
          );
          activatedSessionId = payload.sessionId;
          if (operation !== extensionOperation) {
            if (payload.sessionId > 0) {
              void deactivateExtensionClient(payload.sessionId).catch(() => undefined);
            }
            return false;
          }
          if (
            payload.status !== "active" ||
            payload.packageSha256 !== inspection.packageSha256 ||
            payload.manifest?.id !== inspection.manifest.id
          ) {
            throw new Error("扩展启用结果与已检查的扩展包不一致");
          }
          extensionChannelBuffers.clear();
          getExtensionCoordinator().activate(payload);
          set({
            extensionState: payload,
            extensionOperation: "idle",
            extensionMessage: payload.message ?? "协议扩展已启用",
            extensionChannels: [],
            chartFrozenExtensionChannels: null,
            extensionChannelVisibility: {},
          });
          return true;
        } catch (error) {
          if (operation === extensionOperation) {
            getExtensionCoordinator().deactivate();
            if (activatedSessionId > 0) {
              void deactivateExtensionClient(activatedSessionId).catch(() => undefined);
            }
            set({
              extensionOperation: "idle",
              extensionMessage: `启用扩展失败：${getErrorMessage(error)}`,
            });
          }
          return false;
        }
      },
      deactivateExtension: async () => {
        const state = get();
        if (state.extensionOperation !== "idle") {
          return false;
        }
        if (state.extensionState.status === "idle" && state.extensionState.sessionId === 0) {
          return true;
        }
        const operation = ++extensionOperation;
        const sessionId = state.extensionState.sessionId;
        set({ extensionOperation: "deactivating", extensionMessage: "正在停用协议扩展" });
        try {
          await getExtensionCoordinator().suspend();
          const payload = sessionId > 0
            ? await deactivateExtensionClient(sessionId)
            : createIdleExtensionState(state.extensionState.revision + 1);
          if (operation !== extensionOperation) {
            return false;
          }
          extensionChannelBuffers.clear();
          set({
            extensionState: payload,
            extensionOperation: "idle",
            extensionMessage: payload.message ?? "协议扩展已停用",
            extensionChannels: [],
            chartFrozenExtensionChannels: null,
            extensionChannelVisibility: {},
          });
          return payload.status === "idle";
        } catch (error) {
          if (operation === extensionOperation) {
            getExtensionCoordinator().deactivate();
            set({
              extensionState: createExtensionFrontendFault(
                state.extensionState,
                "deactivation-failed",
                getErrorMessage(error),
              ),
              extensionOperation: "idle",
              extensionMessage: `停用扩展失败：${getErrorMessage(error)}`,
            });
          }
          return false;
        }
      },
      resetExtension: async () => {
        const state = get();
        if (state.extensionOperation !== "idle" || state.extensionState.status !== "active") {
          return false;
        }
        const operation = ++extensionOperation;
        const sessionId = state.extensionState.sessionId;
        const generation = state.extensionState.generation;
        set({ extensionOperation: "resetting", extensionMessage: "正在重置扩展解析状态" });
        try {
          await getExtensionCoordinator().suspend();
          if (operation !== extensionOperation) {
            return false;
          }
          const payload = await resetExtensionClient(sessionId, generation);
          if (operation !== extensionOperation) {
            return false;
          }
          extensionChannelBuffers.clear();
          getExtensionCoordinator().activate(payload);
          set({
            extensionState: payload,
            extensionOperation: "idle",
            extensionMessage: payload.message ?? "扩展解析状态已重置",
            extensionChannels: [],
            chartFrozenExtensionChannels: null,
          });
          return payload.status === "active";
        } catch (error) {
          if (operation === extensionOperation) {
            getExtensionCoordinator().deactivate();
            const message = getErrorMessage(error);
            set({
              extensionState: createExtensionFrontendFault(
                state.extensionState,
                "reset-failed",
                message,
              ),
              extensionOperation: "idle",
              extensionMessage: `重置扩展失败：${message}`,
            });
            if (sessionId > 0) {
              void deactivateExtensionClient(sessionId).catch(() => undefined);
            }
          }
          return false;
        }
      },
      toggleExtensionChannel: (channelId) => {
        if (!channelId.startsWith("extension:") || get().workspaceTransitionStatus !== "idle") {
          return;
        }
        set((state) => {
          const channel = state.extensionChannels.find((candidate) => candidate.id === channelId);
          if (!channel) {
            return state;
          }
          const visible = !channel.visible;
          const visibility = { ...state.extensionChannelVisibility };
          if (visible) {
            delete visibility[channelId];
          } else {
            visibility[channelId] = false;
          }
          return {
            extensionChannelVisibility: visibility,
            extensionChannels: state.extensionChannels.map((candidate) =>
              candidate.id === channelId ? { ...candidate, visible } : candidate,
            ),
            chartFrozenExtensionChannels: state.chartFrozenExtensionChannels
              ? state.chartFrozenExtensionChannels.map((candidate) =>
                  candidate.id === channelId ? { ...candidate, visible } : candidate,
                )
              : null,
          };
        });
      },

      setRuntimeAvailability: (nativeRuntime) => {
        const state = get();
        const availabilityChanged = nativeRuntime !== state.isNativeRuntime;
        const switchedToBrowserSimulator = !nativeRuntime && state.source !== "simulator";
        const terminalEntries = switchedToBrowserSimulator
          ? settleTerminalPresentation(state, terminalLineAssembler)
          : state.terminalEntries;
        if (!nativeRuntime && state.isNativeRuntime) {
          stopCurrentModbusPolling("source-change");
          stopCurrentCommandWorkflows("source-change");
          revokeExtensionForBoundary(get, set, "运行环境已切换，扩展会话已撤销");
        }
        if (switchedToBrowserSimulator) {
          resetLiveStreamBoundary(state.protocol);
        }
        if (availabilityChanged) {
          invalidateSerialPortRefresh(set);
        }
        set((latest) => ({
          isNativeRuntime: nativeRuntime,
          source: nativeRuntime ? latest.source : "simulator",
          chartDataRevision:
            switchedToBrowserSimulator
              ? latest.chartDataRevision + 1
              : latest.chartDataRevision,
          attitudeSample:
            switchedToBrowserSimulator ? null : latest.attitudeSample,
          processingStatus: switchedToBrowserSimulator
            ? liveProcessingRuntime.getSnapshot()
            : latest.processingStatus,
          protocolHealth: switchedToBrowserSimulator
            ? protocolParser.getHealthSnapshot()
            : latest.protocolHealth,
          waveformTrigger: availabilityChanged
            ? createIdleWaveformTriggerState()
            : latest.waveformTrigger,
          serialModemStatus: availabilityChanged
            ? createUnavailableSerialModemStatus(latest.serialGeneration)
            : latest.serialModemStatus,
          serialRuntimeError: nativeRuntime ? latest.serialRuntimeError : "",
          connectionActionError: availabilityChanged ? "" : latest.connectionActionError,
          connectionMessage: nativeRuntime
            ? latest.connectionMessage
            : "浏览器预览模式，仅使用模拟数据",
          terminalEntries,
          statusMessage: nativeRuntime
            ? latest.statusMessage
            : "浏览器预览模式，仅使用模拟数据",
        }));
      },

      setSerialRuntimeError: (message) => {
        set((state) => ({
          serialRuntimeError: message,
          connectionMessage: message || state.connectionMessage,
          statusMessage: message || state.statusMessage,
        }));
      },

      reportSerialRuntimeWarning: (message) => {
        set((state) =>
          state.serialRuntimeError
            ? state
            : { connectionMessage: message, statusMessage: message },
        );
      },

      setSource: async (source) => {
        if (
          get().workspaceTransitionStatus !== "idle" ||
          get().runtimeTransitionStatus !== "idle" ||
          isCaptureActive(get().captureStatus) ||
          isNumericLogActive(get().numericLogStatus) ||
          hasReplaySession(get())
        ) {
          return;
        }
        if (source === "serial" && !get().isNativeRuntime) {
          set({
            connectionActionError: "",
            connectionMessage: "浏览器预览无法使用本机串口",
            statusMessage: "浏览器预览无法使用本机串口",
          });
          return;
        }
        if (source === get().source) {
          return;
        }
        stopCurrentCommandWorkflows("source-change");
        if (!beginRuntimeTransition(get, set, "switching-source")) {
          return;
        }
        invalidateSerialPortRefresh(set);
        stopCurrentModbusPolling("source-change", false);
        try {
          await getSerialRecoveryCoordinator().cancel("source-change", true);
          if (get().connectionStatus === "connected" || get().connectionStatus === "connecting") {
            const disconnected = await disconnectCurrentSource(get, set);
            if (!disconnected) {
              return;
            }
          }
          revokeExtensionForBoundary(get, set, "数据源已切换，扩展会话已撤销");
          const latest = get();
          const terminalEntries = appendTerminalSessionBoundary(
            settleTerminalPresentation(latest, terminalLineAssembler),
            `数据源：${dataSourceDisplayName(latest.source)} → ${dataSourceDisplayName(source)}`,
          );
          resetProtocolState(get().protocol);
          set({
            source,
            terminalPresentationOverride: null,
            channels: [],
            processedChannels: [],
            chartFrozenChannels: latest.chartPaused ? [] : null,
            chartFrozenProcessedChannels: latest.chartPaused ? [] : null,
            chartFrozenExtensionChannels: latest.chartPaused ? [] : null,
            attitudeSample: null,
            chartDataRevision: latest.chartDataRevision + 1,
            waveformTrigger: createIdleWaveformTriggerState(),
            processingStatus: liveProcessingRuntime.getSnapshot(),
            protocolHealth: protocolParser.getHealthSnapshot(),
            terminalEntries,
            connectionStatus: "disconnected",
            connectionActionError: "",
            serialModemStatus: createUnavailableSerialModemStatus(latest.serialGeneration),
            connectionMessage:
              source === "serial" ? "选择设备后连接" : "模拟数据源已就绪",
            statusMessage: source === "serial" ? "选择设备后连接" : "模拟数据源已就绪",
          });
        } finally {
          endRuntimeTransition(get, set, "switching-source");
        }
      },

      setProtocol: (protocol) => {
        if (
          get().workspaceTransitionStatus !== "idle" ||
          get().runtimeTransitionStatus !== "idle" ||
          isSerialFileSendActive(get().serialFileSend.status) ||
          isModbusPollActive(get().modbusPoll) ||
          isModbusTransactionActive(get().modbusTransaction) ||
          isRecoveryActivePhase(get().serialRecovery.phase) ||
          isCaptureActive(get().captureStatus) ||
          isNumericLogActive(get().numericLogStatus) ||
          hasReplaySession(get())
        ) {
          return;
        }
        const currentState = get();
        if (protocol === currentState.protocol) {
          return;
        }
        getAutoResponderRuntime().stop("protocol-change");
        revokeExtensionForBoundary(get, set, "基础协议已切换，扩展会话已撤销");
        const terminalEntries = appendTerminalSessionBoundary(
          settleTerminalPresentation(currentState, terminalLineAssembler),
          `协议：${protocolDisplayName(currentState.protocol)} → ${protocolDisplayName(protocol)}`,
        );
        resetProtocolState(protocol);
        set({
          protocol,
          terminalPresentationOverride: null,
          channels: [],
          processedChannels: [],
          chartFrozenChannels: currentState.chartPaused ? [] : null,
          chartFrozenProcessedChannels: currentState.chartPaused ? [] : null,
          chartFrozenExtensionChannels: currentState.chartPaused ? [] : null,
          attitudeSample: null,
          chartDataRevision: currentState.chartDataRevision + 1,
          waveformTrigger: createIdleWaveformTriggerState(),
          processingStatus: liveProcessingRuntime.getSnapshot(),
          protocolHealth: protocolParser.getHealthSnapshot(),
          terminalEntries,
          statusMessage: protocolDisplayName(protocol) + " 已启用",
        });
      },

      updateSerialConfig: (key, value) => {
        if (
          get().workspaceTransitionStatus !== "idle" ||
          get().runtimeTransitionStatus !== "idle" ||
          isSerialFileSendActive(get().serialFileSend.status) ||
          isModbusPollActive(get().modbusPoll) ||
          isModbusTransactionActive(get().modbusTransaction) ||
          isRecoveryActivePhase(get().serialRecovery.phase) ||
          isCaptureActive(get().captureStatus) ||
          isNumericLogActive(get().numericLogStatus) ||
          hasReplaySession(get())
        ) {
          return;
        }
        set((state) => ({
          serialConfig: { ...state.serialConfig, [key]: value },
          connectionMessage:
            key === "portName" && state.connectionStatus === "disconnected"
              ? value
                ? `${String(value)} 已就绪`
                : "选择设备后连接"
              : state.connectionMessage,
        }));
      },

      updateSimulatorConfig: (key, value) => {
        const state = get();
        if (
          state.connectionStatus !== "disconnected" ||
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          isSerialFileSendActive(state.serialFileSend.status) ||
          isModbusPollActive(state.modbusPoll) ||
          isModbusTransactionActive(state.modbusTransaction) ||
          isRecoveryActivePhase(state.serialRecovery.phase) ||
          isCaptureActive(state.captureStatus) ||
          isNumericLogActive(state.numericLogStatus) ||
          hasReplaySession(state)
        ) {
          return;
        }
        const simulatorConfig = parseSimulatorConfig({
          ...state.simulatorConfig,
          [key]: value,
        });
        set({ simulatorConfig });
      },

      setSerialControlLine: async (line, asserted) => {
        const state = get();
        if (!isSerialControlLineContextAvailable(state)) {
          return false;
        }
        if (line === "rts" && state.serialConfig.flowControl === "hardware") {
          set({
            connectionMessage: "硬件流控已接管 RTS，无法手动设置",
            statusMessage: "硬件流控已接管 RTS，无法手动设置",
          });
          return false;
        }

        const operation = ++serialControlLineOperation;
        const generation = state.serialGeneration;
        const label = line.toUpperCase();
        set({
          serialControlLineOperation: line,
          connectionMessage: `正在设置 ${label}`,
          statusMessage: `正在设置 ${label}`,
        });
        try {
          await setSerialControlLineClient(generation, line, asserted);
          const latest = get();
          if (
            operation !== serialControlLineOperation ||
            latest.source !== "serial" ||
            latest.connectionStatus !== "connected" ||
            latest.serialGeneration !== generation
          ) {
            return false;
          }
          const serialConfig = { ...latest.serialConfig, [line]: asserted };
          set({
            serialConfig,
            connectionMessage: `${label} 已设为${asserted ? "有效" : "无效"}`,
            statusMessage: `${label} 已设为${asserted ? "有效" : "无效"}`,
          });
          getSerialRecoveryCoordinator().updateConfig(serialConfig);
          return true;
        } catch (error) {
          const payload = isRecord(error) ? error : undefined;
          const payloadMessage = payload?.message;
          const payloadErrorCode = payload?.errorCode;
          const message =
            typeof payloadMessage === "string" && payloadMessage.trim()
              ? payloadMessage
              : getErrorMessage(error);
          const errorCode =
            typeof payloadErrorCode === "string" && /^[a-z-]{1,32}$/.test(payloadErrorCode)
              ? payloadErrorCode
              : "unknown";
          getSerialRecoveryCoordinator().recordControlLineFailure(
            line,
            generation,
            errorCode,
          );
          const latest = get();
          if (
            operation === serialControlLineOperation &&
            latest.source === "serial" &&
            latest.serialGeneration === generation
          ) {
            set({
              connectionMessage: `设置 ${label} 失败：${message}`,
              statusMessage: `设置 ${label} 失败：${message}`,
            });
          }
          return false;
        } finally {
          if (operation === serialControlLineOperation) {
            set({ serialControlLineOperation: "idle" });
          }
        }
      },

      refreshPorts: async (mode = "manual") => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.isRefreshingPorts ||
          isRecoveryActivePhase(state.serialRecovery.phase) ||
          hasReplaySession(state)
        ) {
          return;
        }
        if (!state.isNativeRuntime) {
          if (mode === "manual") {
            set({
              connectionMessage: "浏览器预览无法枚举本机串口",
              statusMessage: "浏览器预览无法枚举本机串口",
            });
          }
          return;
        }
        if (!isSerialPortRefreshContext(state)) {
          return;
        }
        const operation = ++serialPortRefreshOperation;
        const context = state;

        set({
          isRefreshingPorts: true,
          serialPortDiscoveryStatus: "idle",
          serialPortDiscoveryMessage: "",
        });
        try {
          const ports = sortSerialPorts(await listSerialPorts());
          if (!ownsSerialPortRefresh(operation, context, get())) {
            return;
          }
          const currentPort = get().serialConfig.portName;
          const currentPortAvailable = ports.some((port) => port.name === currentPort);
          const selectedPort = currentPort || ports[0]?.name || "";
          const discoveryMessage =
            ports.length > 0 ? `发现 ${ports.length} 个串口设备` : "未发现串口设备";
          set((state) => ({
            ports,
            serialPortDiscoveryStatus:
              ports.length > 0 ? (mode === "manual" ? "ready" : "idle") : "empty",
            serialPortDiscoveryMessage:
              ports.length > 0 && mode === "background" ? "" : discoveryMessage,
            serialConfig: { ...state.serialConfig, portName: selectedPort },
            connectionMessage:
              state.connectionStatus === "error"
                ? state.connectionMessage
                : currentPort && !currentPortAvailable
                  ? `${currentPort} 当前不可用`
                  : mode === "background"
                    ? selectedPort
                      ? `${selectedPort} 已就绪`
                      : "未发现串口设备"
                    : ports.length > 0
                      ? `发现 ${ports.length} 个串口设备`
                      : "未发现串口设备",
            statusMessage:
              mode === "background"
                ? state.statusMessage
                : currentPort && !currentPortAvailable
                  ? `${currentPort} 当前不可用`
                  : ports.length > 0
                    ? `发现 ${ports.length} 个串口设备`
                    : "未发现串口设备",
          }));
        } catch (error) {
          if (!ownsSerialPortRefresh(operation, context, get())) {
            return;
          }
          getSerialRecoveryCoordinator().recordPortDiscoveryFailure(mode);
          const message = getErrorMessage(error);
          const discoveryMessage = `扫描串口失败：${message}`;
          if (mode === "manual") {
            set((state) => ({
              connectionMessage:
                state.connectionStatus === "error"
                  ? state.connectionMessage
                  : discoveryMessage,
              serialPortDiscoveryStatus: "error",
              serialPortDiscoveryMessage: discoveryMessage,
              statusMessage: discoveryMessage,
              serialModemStatus: createUnavailableSerialModemStatus(
                state.serialGeneration,
              ),
              waveformTrigger: createIdleWaveformTriggerState(),
            }));
          } else {
            const latest = get();
            if (
              latest.connectionStatus === "disconnected" &&
              latest.ports.length === 0 &&
              (latest.connectionMessage === "" ||
                latest.connectionMessage === "等待连接" ||
                latest.connectionMessage === "未发现串口设备")
            ) {
              set({
                serialPortDiscoveryStatus: "error",
                serialPortDiscoveryMessage: discoveryMessage,
              });
            }
          }
        } finally {
          if (operation === serialPortRefreshOperation) {
            set({ isRefreshingPorts: false });
          }
        }
      },

      connect: async () => {
        if (get().isCancellingSerialConnection) {
          return;
        }
        set({ connectionActionError: "" });
        const currentState = get();
        if (currentState.source === "simulator" && currentState.protocol === "raw") {
          const message = "Raw Data 不提供模拟，请选择串口或回放";
          set({
            connectionStatus: "disconnected",
            connectionMessage: message,
            statusMessage: message,
          });
          return;
        }
        const runtimeError = currentState.serialRuntimeError;
        if (currentState.source === "serial" && runtimeError) {
          set({ connectionMessage: runtimeError, statusMessage: runtimeError });
          return;
        }
        if (!beginRuntimeTransition(get, set, "connecting")) {
          return;
        }
        invalidateSerialPortRefresh(set);
        stopCurrentModbusPolling("connection-change", false);
        await cancelActiveSerialFileSend(get);
        await cancelActiveModbusTransaction(get);
        stopCurrentCommandWorkflows("connection-change");
        const operation = ++serialConnectOperation;
        try {
          await getSerialRecoveryCoordinator().cancel("manual-connect", true);
          if (operation !== serialConnectOperation) {
            return;
          }
          const hadReplaySession = hasReplaySession(get());
          if (!(await closeCurrentReplay(get, set))) {
            const message = "关闭回放失败，未连接数据源";
            set({
              connectionActionError: message,
              connectionMessage: message,
              statusMessage: message,
            });
            return;
          }
          if (operation !== serialConnectOperation) {
            return;
          }
          if (hadReplaySession) {
            resetLiveView(get().protocol, set);
          }
          if (!(await stopCurrentRecordings(get, set))) {
            const message = "结束录制失败，未连接数据源";
            set({
              connectionActionError: message,
              connectionMessage: message,
              statusMessage: message,
            });
            return;
          }
          if (operation !== serialConnectOperation) {
            return;
          }
          const state = get();
          if (state.workspaceTransitionStatus !== "idle") {
            return;
          }
          const terminalEntries = settleTerminalPresentation(state, terminalLineAssembler);
          if (state.source === "simulator") {
            revokeExtensionForBoundary(get, set, "连接边界已变化，扩展会话已撤销");
            resetProtocolState(state.protocol);
            set({
              connectionStatus: "connected",
              connectionMessage: "模拟数据正在运行",
              statusMessage: "模拟数据正在运行",
              serialModemStatus: createUnavailableSerialModemStatus(state.serialGeneration),
              stats: { ...emptyStats(), startedAt: Date.now() },
              protocolHealth: protocolParser.getHealthSnapshot(),
              waveformTrigger: createIdleWaveformTriggerState(),
              terminalEntries,
            });
            return;
          }
          if (!state.serialConfig.portName) {
            set({
              connectionStatus: "error",
              connectionMessage: "请先选择串口设备",
              statusMessage: "请先选择串口设备",
              serialModemStatus: createUnavailableSerialModemStatus(state.serialGeneration),
              waveformTrigger: createIdleWaveformTriggerState(),
            });
            return;
          }

          revokeExtensionForBoundary(get, set, "连接边界已变化，扩展会话已撤销");
          const selectedPort = state.ports.find(
            (port) => port.name === state.serialConfig.portName,
          );
          resetLiveStreamBoundary(state.protocol);
          getSerialRecoveryCoordinator().prepareManualConnection(
            state.serialConfig,
            selectedPort,
          );
          set({
            connectionStatus: "connecting",
            connectionMessage: `正在打开 ${state.serialConfig.portName}`,
            statusMessage: `正在打开 ${state.serialConfig.portName}`,
            serialModemStatus: createUnavailableSerialModemStatus(state.serialGeneration),
            protocolHealth: protocolParser.getHealthSnapshot(),
            waveformTrigger: createIdleWaveformTriggerState(),
            terminalEntries,
          });
          try {
            const payload = await connectSerial(state.serialConfig);
            if (operation !== serialConnectOperation) {
              return;
            }
            get().handleSerialState(payload);
            set({ stats: { ...emptyStats(), startedAt: Date.now() } });
          } catch (error) {
            if (operation !== serialConnectOperation) {
              return;
            }
            let failureSnapshot: SerialStatePayload | undefined;
            if (get().connectionStatus === "connecting") {
              try {
                const snapshot = await getSerialState();
                if (snapshot.status === "error") {
                  failureSnapshot = snapshot;
                }
                if (
                  operation === serialConnectOperation &&
                  get().connectionStatus === "connecting"
                ) {
                  get().handleSerialState(snapshot);
                }
              } catch {
                // 保留原始连接错误作为面向用户的原因。
              }
            }
            if (
              operation === serialConnectOperation &&
              get().connectionStatus === "connecting"
            ) {
              const latest = get();
              getSerialRecoveryCoordinator().recordManualConnectionFailure({
                generation: failureSnapshot?.generation ?? latest.serialGeneration,
                revision: failureSnapshot?.revision ?? latest.serialStateRevision,
                errorCode: failureSnapshot?.errorCode ?? "unknown",
              });
              set({
                connectionStatus: "error",
                connectionMessage: failureSnapshot?.message ?? getErrorMessage(error),
                statusMessage: failureSnapshot?.message ?? getErrorMessage(error),
                serialModemStatus: createUnavailableSerialModemStatus(
                  get().serialGeneration,
                ),
                waveformTrigger: createIdleWaveformTriggerState(),
              });
            }
          }
        } finally {
          if (operation === serialConnectOperation) {
            endRuntimeTransition(get, set, "connecting");
          }
        }
      },

      disconnect: async () => {
        if (!beginRuntimeTransition(get, set, "disconnecting")) {
          return false;
        }
        set({ connectionActionError: "" });
        stopCurrentCommandWorkflows("connection-change");
        try {
          await getSerialRecoveryCoordinator().cancel("manual-disconnect", true);
          if (!(await stopCurrentRecordings(get, set))) {
            const message = "结束录制失败，当前仍保持连接";
            set({
              connectionActionError: message,
              connectionMessage: message,
              statusMessage: message,
            });
            return false;
          }
          const disconnected = await disconnectCurrentSource(get, set);
          if (disconnected) {
            revokeExtensionForBoundary(get, set, "连接已断开，扩展会话已撤销");
          }
          return disconnected;
        } finally {
          endRuntimeTransition(get, set, "disconnecting");
        }
      },

      setSerialRecoveryEnabled: async (enabled) => {
        const operation = ++serialRecoverySettingOperation;
        set({ connectionActionError: "" });
        const state = get();
        if (enabled && (!state.isNativeRuntime || state.source !== "serial")) {
          set({
            connectionMessage: "自动重连仅适用于桌面串口数据源",
            statusMessage: "自动重连仅适用于桌面串口数据源",
          });
          return;
        }
        const selectedPort = state.ports.find(
          (port) => port.name === state.serialConfig.portName,
        );
        try {
          await getSerialRecoveryCoordinator().setEnabled(enabled, {
            status: state.connectionStatus,
            generation: state.serialGeneration,
            config: state.serialConfig,
            port: selectedPort,
          });
        } catch (error) {
          if (operation === serialRecoverySettingOperation) {
            const message = `取消串口连接失败：${getErrorMessage(error)}`;
            set({
              connectionActionError: message,
              connectionMessage: message,
              statusMessage: message,
            });
          }
        }
      },

      cancelSerialConnection: async () => {
        const state = get();
        const recoveryActive = isRecoveryActivePhase(state.serialRecovery.phase);
        const manualConnecting =
          state.source === "serial" && state.connectionStatus === "connecting";
        if (state.isCancellingSerialConnection || (!recoveryActive && !manualConnecting)) {
          return;
        }

        const recoveryWasConnecting = state.serialRecovery.phase === "connecting";
        serialConnectOperation += 1;
        set({
          isCancellingSerialConnection: true,
          connectionActionError: "",
          runtimeTransitionStatus:
            state.runtimeTransitionStatus === "connecting"
              ? "idle"
              : state.runtimeTransitionStatus,
          connectionMessage: recoveryActive ? "正在取消自动重连" : "正在取消串口连接",
          statusMessage: recoveryActive ? "正在取消自动重连" : "正在取消串口连接",
        });
        try {
          await getSerialRecoveryCoordinator().cancel("user-cancelled", true);
          if (manualConnecting && !recoveryWasConnecting) {
            await cancelPendingSerialConnection();
          } else if (!recoveryWasConnecting) {
            set({ connectionMessage: "自动重连已取消", statusMessage: "自动重连已取消" });
          }
        } catch (error) {
          const message = `取消串口连接失败：${getErrorMessage(error)}`;
          set({
            connectionActionError: message,
            connectionMessage: message,
            statusMessage: message,
          });
        } finally {
          set({ isCancellingSerialConnection: false });
        }
      },

      clearSerialDiagnostics: () => {
        getSerialRecoveryCoordinator().clearDiagnostics();
      },

      getSerialDiagnostics: () => {
        const state = get();
        return getSerialRecoveryCoordinator().exportDiagnostics({
          appVersion: APP_VERSION,
          buildId: APP_BUILD_ID,
          connectionStatus: state.connectionStatus,
          generation: state.serialGeneration,
          revision: state.serialStateRevision,
          serialConfig: state.serialConfig,
        });
      },

      send: async (value, mode, lineEnding) => {
        const textEncoding = get().terminalTxTextEncoding;
        if (mode === "text" && !isTextEncodingLoaded(textEncoding)) {
          await loadTextEncoding(textEncoding);
        }
        const template = compileCommandTemplate(value, mode, textEncoding);
        const nowMs = Date.now();
        const command = prepareCommandTemplate(
          template,
          lineEnding,
          get().commandChecksum,
          {
            sequence: 1,
            nowMs,
            taskStartedAtMs: nowMs,
          },
        );
        if (command.bytes.length === 0) {
          return;
        }
        await executePreparedCommand(command, "manual", get, set);
      },

      startFileSend: async (path) => {
        const state = get();
        assertSerialFileSendCanStart(state, path);
        const payload = await startSerialFileSendClient(path);
        get().handleSerialFileSend(payload);
        return isSerialFileSendActive(payload.status) || payload.status === "completed";
      },

      cancelFileSend: async () => {
        const active = get().serialFileSend;
        if (!isSerialFileSendActive(active.status) || active.jobId <= 0) {
          return false;
        }
        if (active.status === "cancelling") {
          return true;
        }
        set({
          serialFileSend: {
            ...active,
            status: "cancelling",
            message: "正在取消文件发送",
          },
        });
        try {
          const accepted = await cancelSerialFileSendClient(active.jobId);
          if (!accepted) {
            set((latest) =>
              latest.serialFileSend.jobId === active.jobId &&
              latest.serialFileSend.revision === active.revision
                ? { serialFileSend: active }
                : {},
            );
          }
          return accepted;
        } catch (error) {
          set((latest) =>
            latest.serialFileSend.jobId === active.jobId &&
            latest.serialFileSend.revision === active.revision
              ? {
                  serialFileSend: {
                    ...latest.serialFileSend,
                    status: active.status,
                    message: `取消失败：${getErrorMessage(error)}`,
                  },
                }
              : {},
          );
          return false;
        }
      },

      startPeriodicSend: (value, mode, lineEnding, intervalMs, repeatCount) => {
        const initialState = get();
        assertCommandCanStart(initialState);
        const textEncoding = initialState.terminalTxTextEncoding;
        const checksumMode = initialState.commandChecksum;
        const start = () => {
          assertCommandCanStart(get());
          const template = compileCommandTemplate(value, mode, textEncoding);
          getCommandScheduler().start({
            template,
            lineEnding,
            checksumMode,
            intervalMs,
            repeatCount,
          });
        };
        if (mode === "text" && !isTextEncodingLoaded(textEncoding)) {
          return loadTextEncoding(textEncoding).then(start);
        }
        start();
      },

      stopPeriodicSend: () => {
        stopCurrentCommandTask("user");
      },

      setAutoResponderRules: (rules) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        const parsedRules = parseAutoResponderRules(rules);
        getAutoResponderRuntime().stop("rule-change");
        set({ autoResponderRules: parsedRules });
      },

      startAutoResponder: () => {
        const initialState = get();
        assertAutoResponderCanStart(initialState);
        const enabledRules = initialState.autoResponderRules.filter((rule) => rule.enabled);
        const encodings = new Set<TerminalTextEncoding>();
        if (enabledRules.some((rule) => rule.triggerMode === "text")) {
          encodings.add(initialState.terminalRxTextEncoding);
        }
        if (enabledRules.some((rule) => rule.responseMode === "text")) {
          encodings.add(initialState.terminalTxTextEncoding);
        }
        const start = () => {
          const state = get();
          assertAutoResponderCanStart(state);
          if (
            state.autoResponderRules !== initialState.autoResponderRules ||
            state.terminalRxTextEncoding !== initialState.terminalRxTextEncoding ||
            state.terminalTxTextEncoding !== initialState.terminalTxTextEncoding
          ) {
            throw new Error("自动应答配置已变更，请重新启用");
          }
          getAutoResponderRuntime().start(
            initialState.autoResponderRules,
            initialState.terminalRxTextEncoding,
            initialState.terminalTxTextEncoding,
          );
        };
        const unloaded = Array.from(encodings).filter(
          (encoding) => !isTextEncodingLoaded(encoding),
        );
        if (unloaded.length > 0) {
          return Promise.all(unloaded.map((encoding) => loadTextEncoding(encoding))).then(start);
        }
        start();
      },

      stopAutoResponder: () => {
        getAutoResponderRuntime().stop("user");
      },

      startModbusPolling: (request, timeoutMs, intervalMs) => {
        assertModbusPollingCanStart(get(), timeoutMs);
        getModbusPoller().start(request, timeoutMs, intervalMs);
      },

      stopModbusPolling: () => {
        getModbusPoller().stop("user");
      },

      startModbusTransaction: async (request, timeoutMs) => {
        return beginModbusTransaction(request, timeoutMs, false, get, set).completion;
      },

      cancelModbusTransaction: async () => {
        const active = get().modbusTransaction;
        if (active.status === "idle" || active.transactionId === 0) {
          return false;
        }
        if (active.status === "cancelling") {
          return true;
        }
        set({
          modbusTransaction: {
            ...active,
            status: "cancelling",
            message: "正在取消 Modbus RTU 事务",
          },
        });
        if (get().source === "simulator") {
          clearSimulatorModbusTimer();
          const endedAt = Date.now();
          get().handleModbusTransaction({
            transactionId: active.transactionId,
            status: "cancelled",
            request: bytesToBase64(active.requestFrame),
            startedAt: active.startedAt ?? active.queuedAt ?? endedAt,
            endedAt,
            durationMs: Math.max(0, endedAt - (active.startedAt ?? active.queuedAt ?? endedAt)),
            generation: active.generation,
            errorCode: active.startedAt ? "cancelled-after-transmit" : "cancelled",
            message: active.startedAt
              ? "事务已取消，但请求已经发出，写操作可能已被设备执行"
              : "Modbus RTU 事务已取消，请求尚未发送",
          });
          return true;
        }
        try {
          const accepted = await cancelSerialModbusTransaction(active.transactionId);
          if (!accepted && get().modbusTransaction.transactionId === active.transactionId) {
            set({ modbusTransaction: active });
          }
          return accepted;
        } catch (error) {
          if (get().modbusTransaction.transactionId === active.transactionId) {
            set({
              modbusTransaction: {
                ...active,
                message: `取消失败：${getErrorMessage(error)}`,
              },
            });
          }
          return false;
        }
      },

      clearModbusTransactions: () => {
        set({ modbusTransactions: [] });
      },

      clearCommandHistory: () => {
        set({ commandHistory: [] });
      },

      setQuickCommands: (commands) => {
        const state = get();
        if (state.workspaceTransitionStatus !== "idle") {
          return;
        }
        assertWorkspaceStorageWritable(state);
        const parsedCommands = parseQuickCommands(commands);
        set({ quickCommands: parsedCommands });
      },

      ingestBytes: (bytes, timestamp = Date.now()) => {
        const state = get();
        if (state.source === "simulator" && state.captureStatus === "recording") {
          enqueueSimulatorCapture(
            state.captureSessionId,
            "rx",
            bytes,
            handleCaptureQueueError,
          );
        }
        ensureParser(state.protocol, state.terminalRxTextEncoding);
        const frames = protocolParser.push(bytes, timestamp);
        const protocolHealth = protocolParser.getHealthSnapshot();
        const processedSamples = liveProcessingRuntime.process(frames);
        const processingStatus = liveProcessingRuntime.getSnapshot();
        const derivedTriggerSuspended =
          (state.waveformTrigger.phase === "armed" ||
            state.waveformTrigger.phase === "triggered") &&
          state.waveformTrigger.config?.channelId.startsWith("derived:") === true &&
          processingStatus.status === "suspended";
        const waveformTriggerAdvance = derivedTriggerSuspended
          ? {
              state: createIdleWaveformTriggerState(),
              shouldFreeze: false,
            }
          : advanceLiveWaveformTrigger(
              state.waveformTrigger,
              frames,
              processedSamples,
            );
        const attitudeSample = extractRuntimeAttitudeSample(
          state.attitudeConfig,
          frames,
          processedSamples,
        );
        if (state.numericLogStatus === "recording" && frames.length > 0) {
          enqueueNumericLogSamples(
            state.numericLogSessionId,
            createNumericLogSamples(frames, processedSamples, state.channels),
            handleNumericLogQueueError,
          );
        }
        const chartFrameTimestamps = createChartFrameTimestamps(
          frames,
          state.channels[0]?.points.at(-1)?.x,
        );
        const chartFrameSequences = createChartFrameSequences(frames.length);
        const nextChannels = appendFrames(
          state.channels,
          frames,
          state.channelVisibility,
          channelBuffers,
          chartFrameTimestamps,
          chartFrameSequences,
        );
        const nextProcessedChannels = appendProcessedSamples(
          state.processedChannels,
          processedSamples,
          state.channelVisibility,
          processingChannelBuffers,
          chartFrameTimestamps,
          chartFrameSequences,
        );
        const terminalEntries = state.terminalPaused
          ? []
          : createRxTerminalEntries(
              bytes,
              timestamp,
              selectEffectiveTerminalRxRecordMode(state),
              state.terminalRxLineEnding,
              terminalLineAssembler,
              terminalDecoder,
            );

        set({
          channels: nextChannels,
          processedChannels: nextProcessedChannels,
          chartFrozenChannels: state.chartPaused
            ? (state.chartFrozenChannels ?? state.channels)
            : waveformTriggerAdvance.shouldFreeze
              ? nextChannels
              : null,
          chartFrozenProcessedChannels: state.chartPaused
            ? (state.chartFrozenProcessedChannels ?? state.processedChannels)
            : waveformTriggerAdvance.shouldFreeze
              ? nextProcessedChannels
              : null,
          chartFrozenExtensionChannels: state.chartPaused
            ? (state.chartFrozenExtensionChannels ?? state.extensionChannels)
            : waveformTriggerAdvance.shouldFreeze
              ? state.extensionChannels
              : null,
          processingStatus,
          attitudeSample: attitudeSample ?? state.attitudeSample,
          chartPaused: state.chartPaused || waveformTriggerAdvance.shouldFreeze,
          waveformTrigger: waveformTriggerAdvance.state,
          terminalEntries: terminalEntries.length > 0
            ? appendManyBounded(
                state.terminalEntries,
                terminalEntries,
                MAX_TERMINAL_ENTRIES,
              )
            : state.terminalEntries,
          stats: {
            ...state.stats,
            rxBytes: state.stats.rxBytes + bytes.length,
            rxFrames: state.stats.rxFrames + frames.length,
            startedAt: state.stats.startedAt ?? timestamp,
          },
          protocolHealth,
        });
        const latest = get();
        if (
          latest.connectionStatus === "connected" &&
          !hasReplaySession(latest)
        ) {
          getAutoResponderRuntime().ingest(bytes, timestamp);
        }
        if (latest.extensionState.status === "active" && !hasReplaySession(latest)) {
          getExtensionCoordinator().enqueue(bytes, timestamp);
        }
      },

      handleSerialData: (payload) => {
        const state = get();
        if (
          hasReplaySession(state) ||
          state.source !== "serial" ||
          state.connectionStatus !== "connected" ||
          payload.generation !== state.serialGeneration
        ) {
          return;
        }
        get().ingestBytes(decodeBase64(payload.data), payload.receivedAt);
      },

      handleSerialState: (payload) => {
        let state = get();
        let terminalEntries: TerminalEntry[] | null = null;
        if (
          hasReplaySession(state) ||
          state.source !== "serial" ||
          payload.revision <= state.serialStateRevision
        ) {
          return;
        }
        if (payload.status === "connecting" || payload.status === "connected") {
          invalidateSerialPortRefresh(set);
          state = get();
        } else if (payload.status === "error" && !state.isRefreshingPorts) {
          clearSerialPortDiscovery(set);
          state = get();
        }
        const serialModemStatus =
          payload.status === "connected" &&
          payload.generation === state.serialModemStatus.generation
            ? state.serialModemStatus
            : createUnavailableSerialModemStatus(payload.generation);
        if (payload.status !== "connected") {
          serialControlLineOperation += 1;
          stopCurrentModbusPolling("connection-lost", false);
          if (
            isModbusTransactionActive(state.modbusTransaction) &&
            state.modbusTransaction.generation === state.serialGeneration
          ) {
            const active = state.modbusTransaction;
            const endedAt = Date.now();
            finalizeModbusTransaction(
              active,
              {
                transactionId: active.transactionId,
                status: "error",
                request: bytesToBase64(active.requestFrame),
                startedAt: active.startedAt ?? active.queuedAt ?? endedAt,
                endedAt,
                durationMs: Math.max(
                  0,
                  endedAt - (active.startedAt ?? active.queuedAt ?? endedAt),
                ),
                generation: active.generation,
                errorCode: "connection-lost",
                message: payload.message ?? "串口连接已结束，Modbus RTU 事务未完成",
              },
              null,
              set,
            );
            state = get();
          }
          stopCurrentCommandWorkflows("connection-lost");
          revokeExtensionForBoundary(get, set, "实时连接已结束，扩展会话已撤销");
          terminalEntries = settleTerminalPresentation(state, terminalLineAssembler);
          resetLiveTerminalPresentationState();
        }
        const previousStatus = state.connectionStatus;
        if (payload.status === "error") {
          set({
            connectionStatus: "error",
            connectionActionError: "",
            serialGeneration: payload.generation,
            serialStateRevision: payload.revision,
            connectionMessage: payload.message ?? "串口发生未知错误",
            statusMessage: payload.message ?? "串口发生未知错误",
            serialControlLineOperation: "idle",
            serialModemStatus,
            waveformTrigger: createIdleWaveformTriggerState(),
            terminalEntries: terminalEntries ?? state.terminalEntries,
          });
          const recoveryOwnsCaptureBoundary = getSerialRecoveryCoordinator().observeState(
            payload,
            previousStatus,
          );
          if (!recoveryOwnsCaptureBoundary && hasRecordingToStop(state)) {
            void stopCurrentRecordings(get, set);
          }
          return;
        }
        set({
          connectionStatus: payload.status,
          connectionActionError: "",
          serialGeneration: payload.generation,
          serialStateRevision: payload.revision,
          serialConfig:
            payload.portName &&
            (payload.status === "connecting" || payload.status === "connected")
              ? { ...state.serialConfig, portName: payload.portName }
              : state.serialConfig,
          connectionMessage:
            payload.message ?? serialStatusMessage(payload.status, payload.portName),
          statusMessage:
            payload.message ?? serialStatusMessage(payload.status, payload.portName),
          serialControlLineOperation:
            payload.status === "connected" ? state.serialControlLineOperation : "idle",
          serialModemStatus,
          waveformTrigger:
            payload.status === state.connectionStatus &&
            payload.generation === state.serialGeneration
              ? state.waveformTrigger
              : createIdleWaveformTriggerState(),
          terminalEntries: terminalEntries ?? state.terminalEntries,
        });
        getSerialRecoveryCoordinator().observeState(payload, previousStatus);
        if (payload.status === "disconnected" && hasRecordingToStop(state)) {
          void stopCurrentRecordings(get, set);
        }
      },

      handleSerialModemStatus: (payload) => {
        set((state) => {
          if (
            hasReplaySession(state) ||
            state.source !== "serial" ||
            state.connectionStatus !== "connected" ||
            payload.generation !== state.serialGeneration ||
            payload.generation !== state.serialModemStatus.generation ||
            payload.revision <= state.serialModemStatus.revision
          ) {
            return state;
          }
          return { serialModemStatus: payload };
        });
      },

      handleSerialTx: (payload) => {
        const state = get();
        if (
          hasReplaySession(state) ||
          (state.source === "serial" && payload.generation !== state.serialGeneration)
        ) {
          return;
        }
        const bytes = decodeBase64(payload.data);
        if (state.source === "simulator" && state.captureStatus === "recording") {
          enqueueSimulatorCapture(
            state.captureSessionId,
            "tx",
            bytes,
            handleCaptureQueueError,
          );
        }
        const entry = state.terminalPaused
          ? null
          : createTerminalEntry(
              "tx",
              bytes,
              payload.transmittedAt,
              new TextDecoder(payload.textEncoding).decode(bytes),
            );
        set({
          terminalEntries: entry
            ? appendBounded(state.terminalEntries, entry, MAX_TERMINAL_ENTRIES)
            : state.terminalEntries,
          stats: { ...state.stats, txBytes: state.stats.txBytes + payload.byteCount },
        });
      },

      handleSerialFileSend: (payload) => {
        const state = get();
        if (
          payload.revision <= state.serialFileSend.revision ||
          (isSerialFileSendActive(payload.status) &&
            (state.source !== "serial" ||
              hasReplaySession(state) ||
              payload.generation !== state.serialGeneration))
        ) {
          return;
        }
        if (isSerialFileSendActive(payload.status)) {
          stopCurrentModbusPolling("source-change");
          stopCurrentCommandWorkflows("source-change");
        }
        set({ serialFileSend: payload });
      },

      handleModbusTransaction: (payload) => {
        const state = get();
        const active = state.modbusTransaction;
        if (
          active.status === "idle" ||
          active.transactionId !== payload.transactionId ||
          active.generation !== payload.generation ||
          !active.request
        ) {
          return;
        }
        const eventRequest = decodeBase64(payload.request);
        if (!equalByteArrays(eventRequest, active.requestFrame)) {
          finalizeModbusTransaction(
            active,
            {
              ...payload,
              status: "error",
              errorCode: "request-mismatch",
              message: "后端返回的 Modbus RTU 请求标识与当前事务不一致",
            },
            null,
            set,
          );
          return;
        }
        if (payload.status === "waiting") {
          set({
            modbusTransaction: {
              ...active,
              status: active.status === "cancelling" ? "cancelling" : "waiting",
              startedAt: payload.startedAt,
              message: payload.message,
            },
          });
          return;
        }

        let result = null;
        let terminalPayload = payload;
        if (payload.status === "completed" || payload.status === "exception") {
          try {
            const response = payload.response ? decodeBase64(payload.response) : new Uint8Array();
            result = parseModbusRtuResponse(active.request, response);
            if (payload.status === "exception" && result.kind !== "exception") {
              throw new Error("Modbus RTU 异常状态缺少异常响应帧");
            }
          } catch (error) {
            terminalPayload = {
              ...payload,
              status: "error",
              errorCode: "frontend-validation-failed",
              message: getErrorMessage(error),
            };
            result = null;
          }
        }
        finalizeModbusTransaction(active, terminalPayload, result, set);
      },

      setDisplayMode: (displayMode) => {
        const state = get();
        if (state.workspaceTransitionStatus !== "idle") {
          return;
        }
        const context = terminalPresentationContext(state);
        if (!context) {
          set({ displayMode });
          return;
        }
        set({
          terminalPresentationOverride: {
            context,
            displayMode,
            recordMode: selectEffectiveTerminalRxRecordMode(state),
          },
        });
      },
      setSendMode: (sendMode) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ sendMode });
        }
      },
      setLineEnding: (lineEnding) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ lineEnding });
        }
      },
      setCommandChecksum: (commandChecksum) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ commandChecksum: parseCommandChecksumMode(commandChecksum) });
        }
      },
      setTerminalRxRecordMode: (terminalRxRecordMode) => {
        const state = get();
        const effectiveRecordMode = selectEffectiveTerminalRxRecordMode(state);
        if (
          state.workspaceTransitionStatus !== "idle" ||
          terminalRxRecordMode === effectiveRecordMode
        ) {
          return;
        }
        const terminalEntries = settleActiveTerminalPresentation(state);
        resetRxTerminalPresentationState();
        const context = terminalPresentationContext(state);
        set(
          context
            ? {
                terminalPresentationOverride: {
                  context,
                  displayMode: selectEffectiveTerminalDisplayMode(state),
                  recordMode: terminalRxRecordMode,
                },
                terminalEntries,
              }
            : { terminalRxRecordMode, terminalEntries },
        );
      },
      setTerminalRxLineEnding: (terminalRxLineEnding) => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          terminalRxLineEnding === state.terminalRxLineEnding
        ) {
          return;
        }
        const terminalEntries = settleActiveTerminalPresentation(state);
        resetRxTerminalPresentationState();
        set({
          terminalRxLineEnding,
          terminalEntries,
        });
      },
      setTerminalRxTextEncoding: (terminalRxTextEncoding) => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          isAutoResponderActive(state.autoResponder) ||
          terminalRxTextEncoding === state.terminalRxTextEncoding
        ) {
          return;
        }
        const terminalEntries = settleActiveTerminalPresentation(state);
        resetRxTerminalPresentationState(terminalRxTextEncoding);
        set({
          terminalRxTextEncoding,
          terminalEntries,
        });
      },
      setTerminalTxTextEncoding: (terminalTxTextEncoding) => {
        const state = get();
        if (
          state.workspaceTransitionStatus === "idle" &&
          !isAutoResponderActive(state.autoResponder)
        ) {
          set({ terminalTxTextEncoding });
        }
      },
      setTerminalPaused: (terminalPaused) => {
        const state = get();
        if (terminalPaused === state.terminalPaused) {
          return;
        }
        const terminalEntries = terminalPaused
          ? settleActiveTerminalPresentation(state)
          : state.terminalEntries;
        resetTerminalPresentationState();
        set({
          terminalPaused,
          terminalEntries,
        });
      },
      setTerminalAutoScroll: (terminalAutoScroll) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ terminalAutoScroll });
        }
      },
      setChartPaused: (chartPaused) => {
        const state = get();
        if (chartPaused === state.chartPaused) {
          return;
        }
        set({
          chartPaused,
          chartFrozenChannels: chartPaused ? state.channels : null,
          chartFrozenProcessedChannels: chartPaused ? state.processedChannels : null,
          chartFrozenExtensionChannels: chartPaused ? state.extensionChannels : null,
          waveformTrigger: createIdleWaveformTriggerState(),
        });
      },
      setChartWindowSeconds: (chartWindowSeconds) => {
        const state = get();
        if (
          state.workspaceTransitionStatus === "idle" &&
          chartWindowSeconds !== state.chartWindowSeconds
        ) {
          set({ chartWindowSeconds, waveformTrigger: createIdleWaveformTriggerState() });
        }
      },
      armWaveformTrigger: (config) => {
        const state = get();
        const channel = [...state.channels, ...state.processedChannels].find(
          (channel) => channel.id === config.channelId,
        );
        const rearmingFrozenCapture = state.waveformTrigger.phase === "frozen";
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.connectionStatus !== "connected" ||
          hasReplaySession(state) ||
          !channel ||
          !isWaveformTriggerConfigValid(config) ||
          (state.chartPaused && !rearmingFrozenCapture) ||
          state.waveformTrigger.phase === "armed" ||
          state.waveformTrigger.phase === "triggered"
        ) {
          return false;
        }
        const armedState = createArmedWaveformTriggerState(
          config,
          state.chartWindowSeconds,
        );
        set({
          chartPaused: false,
          chartFrozenChannels: null,
          chartFrozenProcessedChannels: null,
          chartFrozenExtensionChannels: null,
          waveformTrigger: armedState,
        });
        return true;
      },
      disarmWaveformTrigger: () => {
        if (get().waveformTrigger.phase !== "idle") {
          set({ waveformTrigger: createIdleWaveformTriggerState() });
        }
      },
      setProcessingGraph: (processingGraph) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        const configuredGraph = configureProcessingGraph(processingGraph);
        set((state) => ({
          processingGraph: configuredGraph,
          processingStatus: activeProcessingRuntime(state).getSnapshot(),
          processedChannels: [],
          chartFrozenProcessedChannels: state.chartPaused ? [] : null,
          attitudeConfig: pruneAttitudeConfigForGraph(state.attitudeConfig, configuredGraph),
          attitudeSample: null,
          chartDataRevision: state.chartDataRevision + 1,
          waveformTrigger: createIdleWaveformTriggerState(),
          channelVisibility: pruneDerivedChannelVisibility(
            state.channelVisibility,
            configuredGraph,
          ),
        }));
      },
      retryProcessingGraph: () => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        liveProcessingRuntime.reset();
        replayProcessingRuntime.reset();
        processingChannelBuffers.clear();
        replayProcessingChannelBuffers.clear();
        set((state) => ({
          processedChannels: [],
          chartFrozenProcessedChannels: state.chartPaused ? [] : null,
          attitudeSample: null,
          chartDataRevision: state.chartDataRevision + 1,
          waveformTrigger: createIdleWaveformTriggerState(),
          processingStatus: activeProcessingRuntime(state).getSnapshot(),
        }));
      },
      setAttitudeConfig: (attitudeConfig) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        const parsed = parseAttitudeConfig(attitudeConfig);
        set((state) => ({
          attitudeConfig: pruneAttitudeConfigForGraph(parsed, state.processingGraph),
          attitudeSample: null,
        }));
      },
      toggleChannel: (channelId) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        set((state) => {
          const channel = [...state.channels, ...state.processedChannels].find(
            (candidate) => candidate.id === channelId,
          );
          const currentlyVisible = channel?.visible ?? state.channelVisibility[channelId] ?? true;
          const nextVisible = !currentlyVisible;
          const channelVisibility = { ...state.channelVisibility };
          if (nextVisible) {
            delete channelVisibility[channelId];
          } else {
            channelVisibility[channelId] = false;
          }
          return {
            channelVisibility,
            channels: state.channels.map((candidate) =>
              candidate.id === channelId ? { ...candidate, visible: nextVisible } : candidate,
            ),
            processedChannels: state.processedChannels.map((candidate) =>
              candidate.id === channelId ? { ...candidate, visible: nextVisible } : candidate,
            ),
            chartFrozenChannels: state.chartFrozenChannels
              ? state.chartFrozenChannels.map((candidate) =>
                  candidate.id === channelId
                    ? { ...candidate, visible: nextVisible }
                    : candidate,
                )
              : null,
            chartFrozenProcessedChannels: state.chartFrozenProcessedChannels
              ? state.chartFrozenProcessedChannels.map((candidate) =>
                  candidate.id === channelId
                    ? { ...candidate, visible: nextVisible }
                    : candidate,
                )
              : null,
          };
        });
      },
      setChannelPresentation: (protocol, channelId, value) => {
        const state = get();
        if (state.workspaceTransitionStatus !== "idle") {
          return;
        }
        assertWorkspaceStorageWritable(state);
        const channelPresentations = updateChannelPresentation(
          state.channelPresentations,
          protocol,
          channelId,
          value,
        );
        if (channelPresentations !== state.channelPresentations) {
          set({ channelPresentations });
        }
      },
      clearTerminal: () => {
        resetTerminalPresentationState();
        set({ terminalEntries: [] });
      },
      clearChart: () => {
        channelBuffers.clear();
        replayChannelBuffers.clear();
        processingChannelBuffers.clear();
        replayProcessingChannelBuffers.clear();
        extensionChannelBuffers.clear();
        getExtensionCoordinator().discardPendingOutputs();
        set((state) => ({
          channels: [],
          processedChannels: [],
          extensionChannels: [],
          chartFrozenChannels: state.chartPaused ? [] : null,
          chartFrozenProcessedChannels: state.chartPaused ? [] : null,
          chartFrozenExtensionChannels: state.chartPaused ? [] : null,
          chartDataRevision: state.chartDataRevision + 1,
          waveformTrigger: createIdleWaveformTriggerState(),
        }));
      },
      resetStats: () => set({ stats: emptyStats() }),
      clearProtocolHealth: () => {
        if (hasReplaySession(get())) {
          replayProtocolParser.clearHealth();
          set({ replayProtocolHealth: replayProtocolParser.getHealthSnapshot() });
          return;
        }
        protocolParser.clearHealth();
        set({ protocolHealth: protocolParser.getHealthSnapshot() });
      },
      selectRecordingDirectory: async () => {
        const state = get();
        if (!state.isNativeRuntime) {
          set({
            recordingDirectoryMessage: "浏览器预览不支持选择记录目录",
          });
          return false;
        }
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.recordingDirectoryStatus !== "idle" ||
          isCaptureActive(state.captureStatus) ||
          isNumericLogActive(state.numericLogStatus)
        ) {
          return false;
        }
        set({ recordingDirectoryStatus: "selecting" });
        try {
          const directory = await selectRecordingDirectoryPath();
          if (directory === null) {
            return false;
          }
          set({ recordingDirectory: directory, recordingDirectoryMessage: "" });
          return true;
        } catch (error) {
          set({ recordingDirectoryMessage: getErrorMessage(error) });
          return false;
        } finally {
          set({ recordingDirectoryStatus: "idle" });
        }
      },
      resetRecordingDirectory: () => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.recordingDirectoryStatus !== "idle" ||
          isCaptureActive(state.captureStatus) ||
          isNumericLogActive(state.numericLogStatus)
        ) {
          return false;
        }
        set({ recordingDirectory: "", recordingDirectoryMessage: "" });
        return true;
      },
      startCapture: async () => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.recordingDirectoryStatus !== "idle" ||
          state.serialControlLineOperation !== "idle" ||
          isCaptureActive(state.captureStatus) ||
          hasReplaySession(state)
        ) {
          return false;
        }
        if (!state.isNativeRuntime) {
          set({ captureStatus: "error", captureMessage: "浏览器预览不支持文件录制" });
          return false;
        }
        if (state.connectionStatus !== "connected") {
          set({ captureStatus: "error", captureMessage: "请先连接数据源再开始录制" });
          return false;
        }

        if (!beginRuntimeTransition(get, set, "starting-capture")) {
          return false;
        }
        set({ captureStatus: "starting", captureMessage: "正在创建捕获文件" });
        try {
          const payload = await startCaptureClient({
            source: state.source,
            protocol: state.protocol,
            serialConfig: state.serialConfig,
            ...(state.recordingDirectory
              ? { destinationDirectory: state.recordingDirectory }
              : {}),
          });
          get().handleCaptureState(payload);
          return payload.status === "recording";
        } catch (error) {
          set({ captureStatus: "error", captureMessage: getErrorMessage(error) });
          return false;
        } finally {
          endRuntimeTransition(get, set, "starting-capture");
        }
      },
      stopCapture: async () => {
        if (!hasCaptureToStop(get())) {
          return true;
        }
        if (captureStopPromise) {
          return captureStopPromise;
        }
        if (!beginRuntimeTransition(get, set, "stopping-capture")) {
          return false;
        }
        try {
          return await stopCurrentCapture(get, set);
        } finally {
          endRuntimeTransition(get, set, "stopping-capture");
        }
      },
      addCaptureMarker: (label, color) => {
        const state = get();
        if (
          !state.isNativeRuntime ||
          state.captureStatus !== "recording" ||
          state.runtimeTransitionStatus !== "idle"
        ) {
          return false;
        }
        const normalizedLabel = label.trim();
        if (!normalizedLabel) {
          return false;
        }
        if (state.captureMarkerCount >= MAX_CAPTURE_MARKERS) {
          set({ captureMessage: `单次捕获最多添加 ${MAX_CAPTURE_MARKERS} 个标记` });
          return false;
        }
        return enqueueCaptureMarker(
          state.captureSessionId,
          color,
          normalizedLabel,
          handleCaptureMarkerError,
          handleCaptureQueueError,
        );
      },
      handleCaptureState: (payload) => {
        const state = get();
        if (payload.revision < state.captureRevision) {
          return;
        }
        const preserveLocalStatus =
          payload.sessionId === state.captureSessionId &&
          ((state.captureStatus === "stopping" && payload.status === "recording") ||
            (state.captureStatus === "error" &&
              (payload.status === "recording" || payload.status === "stopping")));
        if (payload.status === "idle" || payload.status === "error") {
          resetSimulatorCaptureQueue();
        }
        set({
          captureStatus: preserveLocalStatus ? state.captureStatus : payload.status,
          captureSessionId: payload.sessionId,
          captureRevision: payload.revision,
          captureFormatVersion: payload.formatVersion,
          capturePath: payload.path,
          captureStartedAt: payload.startedAtUnixMs,
          captureEndedAt: payload.endedAtUnixMs,
          captureDataBytes: payload.dataBytes,
          captureRecordCount: payload.recordCount,
          captureMarkerCount: payload.markerCount,
          captureMessage: preserveLocalStatus
            ? state.captureMessage
            : (payload.message ?? ""),
        });
      },
      startNumericLog: async () => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.recordingDirectoryStatus !== "idle" ||
          state.serialControlLineOperation !== "idle" ||
          isNumericLogActive(state.numericLogStatus) ||
          hasReplaySession(state)
        ) {
          return false;
        }
        if (!state.isNativeRuntime) {
          set({
            numericLogStatus: "error",
            numericLogMessage: "浏览器预览不支持数值文件记录",
          });
          return false;
        }
        if (state.connectionStatus !== "connected") {
          set({
            numericLogStatus: "error",
            numericLogMessage: "请先连接数据源再开始数值记录",
          });
          return false;
        }
        if (state.protocol === "raw") {
          set({
            numericLogStatus: "error",
            numericLogMessage: "Raw Data 不产生数值通道，请选择结构化协议",
          });
          return false;
        }

        if (!beginRuntimeTransition(get, set, "starting-numeric-log")) {
          return false;
        }
        set({
          numericLogStatus: "starting",
          numericLogMessage: "正在创建数值 CSV",
        });
        try {
          const payload = await startNumericLogClient({
            source: state.source,
            protocol: state.protocol,
            ...(state.recordingDirectory
              ? { destinationDirectory: state.recordingDirectory }
              : {}),
          });
          get().handleNumericLogState(payload);
          return payload.status === "recording";
        } catch (error) {
          set({
            numericLogStatus: "error",
            numericLogMessage: getErrorMessage(error),
          });
          return false;
        } finally {
          endRuntimeTransition(get, set, "starting-numeric-log");
        }
      },
      stopNumericLog: async () => {
        if (!hasNumericLogToStop(get())) {
          return true;
        }
        if (numericLogStopPromise) {
          return numericLogStopPromise;
        }
        if (!beginRuntimeTransition(get, set, "stopping-numeric-log")) {
          return false;
        }
        try {
          return await stopCurrentNumericLog(get, set);
        } finally {
          endRuntimeTransition(get, set, "stopping-numeric-log");
        }
      },
      handleNumericLogState: (payload) => {
        const state = get();
        if (payload.revision < state.numericLogRevision) {
          return;
        }
        const preserveLocalStatus =
          payload.sessionId === state.numericLogSessionId &&
          ((state.numericLogStatus === "stopping" && payload.status === "recording") ||
            (state.numericLogStatus === "error" &&
              (payload.status === "recording" || payload.status === "stopping")));
        if (payload.status === "idle" || payload.status === "error") {
          resetNumericLogQueue();
        }
        set({
          numericLogStatus: preserveLocalStatus ? state.numericLogStatus : payload.status,
          numericLogSessionId: payload.sessionId,
          numericLogRevision: payload.revision,
          numericLogPath: payload.path,
          numericLogStartedAt: payload.startedAtUnixMs,
          numericLogEndedAt: payload.endedAtUnixMs,
          numericLogOutputBytes: payload.outputBytes,
          numericLogSampleCount: payload.sampleCount,
          numericLogMessage: preserveLocalStatus
            ? state.numericLogMessage
            : (payload.message ?? ""),
        });
      },
      selectCaptureExportSource: async () => {
        const state = get();
        if (!state.isNativeRuntime) {
          set({
            captureExportStatus: "error",
            captureExportPhase: "done",
            captureExportMessage: "浏览器预览不支持捕获文件导出",
          });
          return false;
        }
        if (isCaptureActive(state.captureStatus)) {
          set({ captureExportMessage: "录制进行中，请先完成当前捕获文件" });
          return false;
        }
        if (isCaptureExportBusy(state.captureExportStatus)) {
          return false;
        }

        const operation = ++captureExportDialogOperation;
        const fallbackStatus = state.captureExportStatus;
        const fallbackPhase = state.captureExportPhase;
        const fallbackMessage = state.captureExportMessage;
        set({
          captureExportStatus: "selecting-source",
          captureExportMessage: "正在选择源捕获文件",
        });
        try {
          const path = await selectCaptureExportSourcePath();
          if (operation !== captureExportDialogOperation) {
            return false;
          }
          if (!path) {
            set({
              captureExportStatus: fallbackStatus,
              captureExportPhase: fallbackPhase,
              captureExportMessage: fallbackMessage,
            });
            return false;
          }
          set({
            ...captureExportDraft(path),
            captureExportMessage: "已选择源捕获文件",
          });
          return true;
        } catch (error) {
          if (operation === captureExportDialogOperation) {
            set({
              captureExportStatus: "error",
              captureExportPhase: "done",
              captureExportMessage: getErrorMessage(error),
            });
          }
          return false;
        }
      },
      useRecentCaptureForExport: () => {
        const state = get();
        if (
          !state.capturePath ||
          isCaptureActive(state.captureStatus) ||
          isCaptureExportBusy(state.captureExportStatus)
        ) {
          return false;
        }
        captureExportDialogOperation += 1;
        set({
          ...captureExportDraft(state.capturePath),
          captureExportMessage: "已选用最近录制",
        });
        return true;
      },
      setCaptureExportFormat: (format) => {
        const state = get();
        if (isCaptureExportBusy(state.captureExportStatus)) {
          return;
        }
        set({
          ...(isCaptureExportTerminal(state.captureExportStatus)
            ? captureExportDraft(state.captureExportSourcePath)
            : {}),
          captureExportFormat: format,
          captureExportDirection:
            format === "binary" && state.captureExportDirection === "both"
              ? "rx"
              : state.captureExportDirection,
          captureExportDestinationPath: "",
        });
      },
      setCaptureExportDirection: (direction) => {
        const state = get();
        if (
          isCaptureExportBusy(state.captureExportStatus) ||
          (state.captureExportFormat === "binary" && direction === "both")
        ) {
          return;
        }
        set({
          ...(isCaptureExportTerminal(state.captureExportStatus)
            ? captureExportDraft(state.captureExportSourcePath)
            : {}),
          captureExportDirection: direction,
          captureExportDestinationPath: "",
        });
      },
      setCaptureExportAllowIncomplete: (allow) => {
        const state = get();
        if (isCaptureExportBusy(state.captureExportStatus)) {
          return;
        }
        set({
          ...(isCaptureExportTerminal(state.captureExportStatus)
            ? captureExportDraft(state.captureExportSourcePath)
            : {}),
          captureExportAllowIncomplete: allow,
        });
      },
      startCaptureExport: async () => {
        const state = get();
        if (!state.isNativeRuntime) {
          set({
            captureExportStatus: "error",
            captureExportPhase: "done",
            captureExportMessage: "浏览器预览不支持捕获文件导出",
          });
          return false;
        }
        if (!state.captureExportSourcePath) {
          set({ captureExportMessage: "请先选择要导出的捕获文件" });
          return false;
        }
        if (isCaptureActive(state.captureStatus)) {
          set({ captureExportMessage: "录制进行中，请先完成当前捕获文件" });
          return false;
        }
        if (isCaptureExportBusy(state.captureExportStatus)) {
          return false;
        }

        const operation = ++captureExportDialogOperation;
        const fallbackStatus = state.captureExportStatus;
        const fallbackPhase = state.captureExportPhase;
        const fallbackMessage = state.captureExportMessage;
        const sourcePath = state.captureExportSourcePath;
        const format = state.captureExportFormat;
        const direction = state.captureExportDirection;
        const allowIncomplete = state.captureExportAllowIncomplete;
        set({
          captureExportStatus: "selecting-destination",
          captureExportMessage: "正在选择导出位置",
        });
        try {
          const destinationPath = await selectCaptureExportDestinationPath(
            sourcePath,
            format,
          );
          if (operation !== captureExportDialogOperation) {
            return false;
          }
          if (!destinationPath) {
            set({
              captureExportStatus: fallbackStatus,
              captureExportPhase: fallbackPhase,
              captureExportMessage: fallbackMessage,
            });
            return false;
          }
          set({
            captureExportStatus: "starting",
            captureExportPhase: "preparing",
            captureExportDestinationPath: destinationPath,
            captureExportMessage: "正在启动流式导出",
          });
          const payload = await startCaptureExportClient({
            sourcePath,
            destinationPath,
            format,
            direction,
            allowIncomplete,
          });
          if (operation !== captureExportDialogOperation) {
            return false;
          }
          get().handleCaptureExportState(payload);
          return payload.status === "running";
        } catch (error) {
          if (operation === captureExportDialogOperation) {
            set({
              captureExportStatus: "error",
              captureExportPhase: "done",
              captureExportMessage: getErrorMessage(error),
            });
          }
          return false;
        }
      },
      cancelCaptureExport: async () => {
        const state = get();
        if (state.captureExportStatus !== "running" || state.captureExportJobId === 0) {
          return state.captureExportStatus === "cancelled";
        }
        const jobId = state.captureExportJobId;
        set({
          captureExportStatus: "cancelling",
          captureExportMessage: "正在取消导出",
        });
        try {
          const payload = await cancelCaptureExportClient(jobId);
          get().handleCaptureExportState(payload);
          return payload.status === "cancelling" || payload.status === "cancelled";
        } catch (error) {
          if (get().captureExportJobId === jobId) {
            set({
              captureExportStatus: "running",
              captureExportMessage: `取消导出失败：${getErrorMessage(error)}`,
            });
          }
          return false;
        }
      },
      clearCaptureExport: async () => {
        if (isCaptureExportBusy(get().captureExportStatus) || !get().isNativeRuntime) {
          return false;
        }
        captureExportDialogOperation += 1;
        try {
          const payload = await clearCaptureExportClient();
          get().handleCaptureExportState(payload);
          return payload.status === "idle";
        } catch (error) {
          set({ captureExportMessage: getErrorMessage(error) });
          return false;
        }
      },
      handleCaptureExportState: (payload) => {
        const state = get();
        if (
          payload.jobId < state.captureExportJobId ||
          (payload.jobId === state.captureExportJobId &&
            payload.revision <= state.captureExportRevision)
        ) {
          return;
        }
        set({
          captureExportStatus: payload.status,
          captureExportPhase: payload.phase,
          captureExportJobId: payload.jobId,
          captureExportRevision: payload.revision,
          captureExportSourcePath: payload.sourcePath,
          captureExportDestinationPath: payload.destinationPath,
          captureExportFormat: payload.format || state.captureExportFormat,
          captureExportDirection: payload.direction || state.captureExportDirection,
          captureExportAllowIncomplete: payload.allowIncomplete,
          captureExportTotalInputBytes: payload.totalInputBytes,
          captureExportProcessedInputBytes: payload.processedInputBytes,
          captureExportProcessedDataBytes: payload.processedDataBytes,
          captureExportProcessedRecords: payload.processedRecords,
          captureExportExportedDataBytes: payload.exportedDataBytes,
          captureExportExportedRecords: payload.exportedRecords,
          captureExportOutputBytes: payload.outputBytes,
          captureExportSourceComplete: payload.sourceComplete,
          captureExportStartedAt: payload.startedAtUnixMs,
          captureExportEndedAt: payload.endedAtUnixMs,
          captureExportMessage: payload.message ?? "",
        });
      },
      openReplayFile: async () => {
        const state = get();
        if (!state.isNativeRuntime) {
          set({ replayStatus: "error", replayMessage: "浏览器预览不支持捕获文件回放" });
          return false;
        }
        if (!beginRuntimeTransition(get, set, "selecting-replay")) {
          return false;
        }
        stopCurrentCommandWorkflows("replay-open");

        try {
          await getSerialRecoveryCoordinator().cancel("replay-open", true);
          set({ replayStatus: state.replayStatus === "idle" ? "selecting" : state.replayStatus });
          const path = await selectReplayFilePath();
          if (!path) {
            if (get().replayStatus === "selecting") {
              set({ replayStatus: "idle" });
            }
            return false;
          }
          set({ runtimeTransitionStatus: "opening-replay" });
          return await prepareAndOpenReplay(path, get, set);
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set);
        }
      },
      openRecentCapture: async () => {
        const state = get();
        if (!state.isNativeRuntime) {
          set({ replayStatus: "error", replayMessage: "浏览器预览不支持捕获文件回放" });
          return false;
        }
        if (!state.capturePath) {
          set({ replayMessage: "还没有可回放的捕获文件" });
          return false;
        }
        if (!beginRuntimeTransition(get, set, "opening-replay")) {
          return false;
        }
        stopCurrentCommandWorkflows("replay-open");

        try {
          await getSerialRecoveryCoordinator().cancel("replay-open", true);
          if (!(await stopCurrentRecordings(get, set))) {
            set({ replayMessage: "捕获文件尚未完成，无法开始回放" });
            return false;
          }
          return await prepareAndOpenReplay(get().capturePath, get, set);
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set, "opening-replay");
        }
      },
      playReplay: async () => {
        const state = get();
        if (
          !state.replayHeader ||
          !["ready", "paused", "completed"].includes(state.replayStatus) ||
          !beginRuntimeTransition(get, set, "controlling-replay")
        ) {
          return false;
        }

        const shouldResetView = state.replayStatus === "ready";
        const previousGeneration = state.replayGeneration;
        const previousNextSequence = state.replayNextSequence;
        set({
          replayStatus: "starting",
          replayMessage: `正在启动 ${formatReplaySpeed(state.replaySpeed)} 回放`,
        });
        try {
          const payload = await playReplayClient(
            state.replaySessionId,
            state.replayGeneration,
          );
          get().handleReplayState(payload);
          if (shouldResetView) {
            resetReplayView(payload.header?.protocol ?? state.replayHeader.protocol, set);
          }
          set({
            replayNextSequence:
              payload.generation === previousGeneration ? previousNextSequence : 1,
          });
          try {
            await ackReplayBatchClient(payload.sessionId, payload.generation, 0);
          } catch (error) {
            await recoverReplayAfterAckFailure(
              payload.sessionId,
              payload.generation,
              error,
              get,
              set,
            );
            return false;
          }
          return payload.status === "playing";
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set, "controlling-replay");
        }
      },
      pauseReplay: async () => {
        const state = get();
        if (
          state.replayStatus !== "playing" ||
          !beginRuntimeTransition(get, set, "controlling-replay")
        ) {
          return false;
        }
        set({ replayStatus: "pausing", replayMessage: "正在暂停回放" });
        try {
          const payload = await pauseReplayClient(state.replaySessionId, state.replayGeneration);
          get().handleReplayState(payload);
          return payload.status === "paused";
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set, "controlling-replay");
        }
      },
      seekReplay: async (targetUs) => {
        const state = get();
        if (
          !state.replayHeader ||
          !protocolSupportsReplaySeek(state.replayHeader.protocol) ||
          !["ready", "paused", "completed"].includes(state.replayStatus) ||
          !Number.isFinite(targetUs) ||
          !beginRuntimeTransition(get, set, "controlling-replay")
        ) {
          return false;
        }

        const clampedTargetUs = Math.min(
          state.replayDurationUs,
          Math.max(0, Math.trunc(targetUs)),
        );
        if (clampedTargetUs === state.replayPositionUs) {
          endRuntimeTransition(get, set, "controlling-replay");
          return true;
        }

        set({
          replayStatus: "seeking",
          replayNextSequence: 1,
          replayMessage: "正在定位回放",
        });
        try {
          const payload = await seekReplayClient(
            state.replaySessionId,
            state.replayGeneration,
            clampedTargetUs,
          );
          get().handleReplayState(payload);
          return ["seeking", "paused", "completed"].includes(payload.status);
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set, "controlling-replay");
        }
      },
      setReplaySpeed: async (speed) => {
        const state = get();
        if (
          !state.replayHeader ||
          !REPLAY_SPEEDS.includes(speed) ||
          !["ready", "playing", "paused", "completed"].includes(state.replayStatus)
        ) {
          return false;
        }
        if (speed === state.replaySpeed) {
          return true;
        }
        if (!beginRuntimeTransition(get, set, "controlling-replay")) {
          return false;
        }

        try {
          const payload = await setReplaySpeedClient(
            state.replaySessionId,
            state.replayGeneration,
            speed,
          );
          get().handleReplayState(payload);
          return payload.speed === speed;
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set, "controlling-replay");
        }
      },
      stopReplay: async () => {
        const state = get();
        if (
          !isReplayRunning(state.replayStatus) ||
          !beginRuntimeTransition(get, set, "controlling-replay")
        ) {
          return state.replayStatus === "ready";
        }
        set({ replayStatus: "stopping", replayMessage: "正在停止回放" });
        try {
          const payload = await stopReplayClient(state.replaySessionId, state.replayGeneration);
          get().handleReplayState(payload);
          return payload.status === "ready";
        } catch (error) {
          setReplayActionError(set, error, state.replayStatus);
          return false;
        } finally {
          endRuntimeTransition(get, set, "controlling-replay");
        }
      },
      closeReplay: async () => {
        if (!hasReplaySession(get())) {
          return true;
        }
        if (!beginRuntimeTransition(get, set, "controlling-replay")) {
          return false;
        }
        try {
          return await closeCurrentReplay(get, set);
        } finally {
          endRuntimeTransition(get, set, "controlling-replay");
        }
      },
      handleReplayState: (payload) => {
        const state = get();
        if (payload.revision < state.replayRevision) {
          return;
        }
        if (
          ["pausing", "seeking", "stopping", "closing"].includes(
            state.replayStatus,
          ) &&
          payload.status === "playing" &&
          payload.sessionId === state.replaySessionId &&
          payload.generation === state.replayGeneration
        ) {
          return;
        }
        const keepLatestRunPosition =
          payload.sessionId === state.replaySessionId &&
          payload.generation === state.replayGeneration &&
          payload.status === "playing";
        const timelineChanged =
          payload.sessionId === state.replaySessionId &&
          payload.timelineRevision > state.replayTimelineRevision;
        const replaySessionChanged = payload.sessionId !== state.replaySessionId;
        const resetReplayTimeline =
          (timelineChanged || replaySessionChanged) && payload.header !== undefined;
        const replayEnded = ["completed", "ready", "idle", "error"].includes(
          payload.status,
        );
        const terminalEntries =
          replayEnded && !resetReplayTimeline
            ? settleTerminalPresentation(state, replayRxLineAssembler)
            : null;
        if (resetReplayTimeline && payload.header) {
          resetReplayView(payload.header.protocol, set);
        } else if (replaySessionChanged || payload.status === "idle") {
          replayProtocolParser.reset();
          resetReplayTerminalPresentationState();
        } else if (replayEnded) {
          resetReplayTerminalPresentationState();
        }
        set((latest) => ({
          replayStatus: payload.status,
          replaySessionId: payload.sessionId,
          replayGeneration: payload.generation,
          replayTimelineRevision: payload.timelineRevision,
          replayRevision: payload.revision,
          replayPath: payload.path,
          replayHeader: payload.header,
          replayFormatVersion: payload.formatVersion,
          replayComplete: payload.complete,
          replaySpeed: payload.speed,
          replayPositionUs: keepLatestRunPosition
            ? Math.max(state.replayPositionUs, payload.positionUs)
            : payload.positionUs,
          replayDurationUs: payload.durationUs,
          replayDataBytes: payload.dataBytes,
          replayRecordCount: payload.recordCount,
          replayMarkerCount: payload.markerCount,
          replayMarkers:
            replaySessionChanged || payload.status === "idle" ? [] : latest.replayMarkers,
          terminalPresentationOverride:
            replaySessionChanged || payload.status === "idle"
              ? null
              : latest.terminalPresentationOverride,
          replayProtocolHealth:
            replaySessionChanged || timelineChanged || payload.status === "idle"
              ? replayProtocolParser.getHealthSnapshot()
              : latest.replayProtocolHealth,
          replayNextSequence: timelineChanged ? 1 : state.replayNextSequence,
          attitudeSample:
            replaySessionChanged || timelineChanged || payload.status === "idle"
              ? null
              : latest.attitudeSample,
          waveformTrigger:
            replaySessionChanged || timelineChanged || payload.status !== "idle"
              ? createIdleWaveformTriggerState()
              : latest.waveformTrigger,
          replayMessage: payload.message ?? "",
          statusMessage: replayStatusMessage(payload),
          terminalEntries: terminalEntries ?? latest.terminalEntries,
          chartDataRevision:
            (replaySessionChanged || timelineChanged) && !resetReplayTimeline
              ? latest.chartDataRevision + 1
              : latest.chartDataRevision,
        }));
      },
      handleReplayBatch: (payload) => {
        let accepted = false;
        set((state) => {
          if (
            !isReplayReceiving(state.replayStatus) ||
            payload.sessionId !== state.replaySessionId ||
            payload.generation !== state.replayGeneration ||
            payload.sequence !== state.replayNextSequence ||
            !state.replayHeader
          ) {
            return state;
          }
          accepted = true;
          return ingestReplayBatch(state, payload);
        });
        if (accepted) {
          void ackReplayBatchClient(
            payload.sessionId,
            payload.generation,
            payload.sequence,
          ).catch(async (error: unknown) => {
            const state = get();
            if (
              state.replaySessionId !== payload.sessionId ||
              state.replayGeneration !== payload.generation ||
              state.replayNextSequence !== payload.sequence + 1 ||
              !beginRuntimeTransition(get, set, "controlling-replay")
            ) {
              return;
            }
            try {
              await recoverReplayAfterAckFailure(
                payload.sessionId,
                payload.generation,
                error,
                get,
                set,
              );
            } finally {
              endRuntimeTransition(get, set, "controlling-replay");
            }
          });
        }
      },
      handleReplayMarkers: (payload) => {
        const state = get();
        if (
          payload.sessionId !== state.replaySessionId ||
          state.replayStatus === "idle"
        ) {
          return;
        }
        set({ replayMarkers: payload.markers });
      },
      createActiveWorkspaceExport: (name) => {
        const state = get();
        assertWorkspaceIdle(state);
        const activeWorkspace = state.workspaces.find(
          (workspace) => workspace.id === state.activeWorkspaceId,
        );
        if (!activeWorkspace) {
          throw new Error("当前工作区不存在");
        }
        return {
          ...activeWorkspace,
          name: validateWorkspaceName(name),
          config: captureWorkspaceConfigForSave(state),
        };
      },
      saveActiveWorkspace: (name) => {
        const state = get();
        assertWorkspaceIdle(state);
        assertWorkspaceStorageWritable(state);
        const activeWorkspace = state.workspaces.find(
          (workspace) => workspace.id === state.activeWorkspaceId,
        );
        if (!activeWorkspace) {
          throw new Error("当前工作区不存在");
        }
        const validatedName = assertWorkspaceNameAvailable(
          name,
          state.workspaces,
          activeWorkspace.id,
        );
        const updatedAt = Math.max(Date.now(), activeWorkspace.updatedAt);
        set({
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === activeWorkspace.id
              ? {
                  ...workspace,
                  name: validatedName,
                  updatedAt,
                  config: captureWorkspaceConfigForSave(state),
                }
              : workspace,
          ),
          statusMessage: `工作区“${validatedName}”已保存`,
        });
      },
      saveWorkspaceAs: (name) => {
        const state = get();
        assertWorkspaceIdle(state);
        assertWorkspaceStorageWritable(state);
        if (state.workspaces.length >= MAX_WORKSPACE_COUNT) {
          throw new Error(`最多只能保存 ${MAX_WORKSPACE_COUNT} 个工作区`);
        }
        const validatedName = assertWorkspaceNameAvailable(name, state.workspaces);
        const workspace = createWorkspaceProfile(
          validatedName,
          captureWorkspaceConfigForSave(state),
        );
        set({
          workspaces: [...state.workspaces, workspace],
          activeWorkspaceId: workspace.id,
          statusMessage: `工作区“${workspace.name}”已创建`,
        });
        return workspace.id;
      },
      switchWorkspace: async (id) => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.isRefreshingPorts ||
          isCaptureTransitioning(state.captureStatus) ||
          isNumericLogTransitioning(state.numericLogStatus)
        ) {
          return false;
        }
        const target = state.workspaces.find((workspace) => workspace.id === id);
        if (!target) {
          throw new Error("要应用的工作区不存在");
        }
        if (!beginRuntimeTransition(get, set, "switching-workspace")) {
          return false;
        }
        set({ workspaceTransitionStatus: "switching" });
        try {
          return await applyWorkspaceSnapshot(id, get, set);
        } finally {
          set({ workspaceTransitionStatus: "idle" });
          endRuntimeTransition(get, set, "switching-workspace");
        }
      },
      deleteWorkspace: async (id) => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
          state.isRefreshingPorts ||
          isCaptureTransitioning(state.captureStatus) ||
          isNumericLogTransitioning(state.numericLogStatus)
        ) {
          return false;
        }
        assertWorkspaceStorageWritable(state);
        if (state.workspaces.length <= 1) {
          throw new Error("至少需要保留一个工作区");
        }
        const index = state.workspaces.findIndex((workspace) => workspace.id === id);
        if (index < 0) {
          throw new Error("要删除的工作区不存在");
        }
        const deletedName = state.workspaces[index]?.name ?? "";
        const nextWorkspace = state.workspaces[index + 1] ?? state.workspaces[index - 1];
        if (!beginRuntimeTransition(get, set, "switching-workspace")) {
          return false;
        }
        set({ workspaceTransitionStatus: "deleting" });
        try {
          if (
            id === state.activeWorkspaceId &&
            (!nextWorkspace || !(await applyWorkspaceSnapshot(nextWorkspace.id, get, set)))
          ) {
            return false;
          }
          set((latest) => ({
            workspaces: latest.workspaces.filter((workspace) => workspace.id !== id),
            statusMessage: `工作区“${deletedName}”已删除`,
          }));
          return true;
        } finally {
          set({ workspaceTransitionStatus: "idle" });
          endRuntimeTransition(get, set, "switching-workspace");
        }
      },
      importWorkspace: (imported) => {
        const state = get();
        assertWorkspaceIdle(state);
        assertWorkspaceStorageWritable(state);
        if (state.workspaces.length >= MAX_WORKSPACE_COUNT) {
          throw new Error(`最多只能保存 ${MAX_WORKSPACE_COUNT} 个工作区`);
        }
        const name = makeUniqueWorkspaceName(imported.name, state.workspaces);
        const workspace = createWorkspaceProfile(name, imported.config);
        set({
          workspaces: [...state.workspaces, workspace],
          statusMessage: `工作区“${workspace.name}”已导入`,
        });
        return workspace.id;
      },
    }),
    {
      name: WORKBENCH_STORAGE_KEY,
      version: WORKBENCH_STORAGE_VERSION,
      storage: createDeduplicatingStorage<PersistedWorkbenchState>(
        WORKBENCH_STORAGE_VERSION,
      ),
      partialize: (state) => ({
        source: state.source,
        protocol: state.protocol,
        serialConfig: state.serialConfig,
        simulatorConfig: state.simulatorConfig,
        displayMode: state.displayMode,
        sendMode: state.sendMode,
        lineEnding: state.lineEnding,
        commandChecksum: state.commandChecksum,
        terminalRxRecordMode: state.terminalRxRecordMode,
        terminalRxLineEnding: state.terminalRxLineEnding,
        terminalRxTextEncoding: state.terminalRxTextEncoding,
        terminalTxTextEncoding: state.terminalTxTextEncoding,
        quickCommands: state.quickCommands,
        terminalAutoScroll: state.terminalAutoScroll,
        chartWindowSeconds: state.chartWindowSeconds,
        channelVisibility: state.channelVisibility,
        channelPresentations: state.channelPresentations,
        processingGraph: state.processingGraph,
        attitudeConfig: state.attitudeConfig,
        autoResponderRules: state.autoResponderRules,
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
      }),
      migrate: (persistedState, version) => {
        if (version > WORKBENCH_STORAGE_VERSION) {
          return {
            workspaceStorageStatus: "newer-version",
            incompatibleStorageVersion: version,
          } as unknown as PersistedWorkbenchState;
        }
        if (!WORKBENCH_MIGRATABLE_STORAGE_VERSIONS.some((candidate) => candidate === version)) {
          throw new Error(`不支持从持久化版本 ${version} 降级到 ${WORKBENCH_STORAGE_VERSION}`);
        }
        const processingGraphSchema = version >= 9 ? "current" : "legacy";
        const config = restoreWorkspaceConfig(
          persistedState,
          INITIAL_WORKSPACE_CONFIG,
          version >= 6 ? LINE_ENDINGS : LEGACY_LINE_ENDINGS,
          processingGraphSchema,
        );
        const restoredWorkspaces = restoreWorkspaceProfiles(
          isRecord(persistedState) ? persistedState.workspaces : undefined,
          version >= 6 ? LINE_ENDINGS : LEGACY_LINE_ENDINGS,
          processingGraphSchema,
        );
        const workspaces =
          version >= 1 && restoredWorkspaces.length > 0
            ? restoredWorkspaces
            : [
                createWorkspaceProfile(
                  "默认工作区",
                  config,
                  DEFAULT_WORKSPACE_ID,
                ),
              ];
        return {
          ...(isRecord(persistedState) ? persistedState : {}),
          ...config,
          workspaces,
          activeWorkspaceId:
            isRecord(persistedState) && typeof persistedState.activeWorkspaceId === "string"
              ? persistedState.activeWorkspaceId
              : workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID,
        } as PersistedWorkbenchState;
      },
      merge: (persistedState, currentState) =>
        restorePersistedWorkbenchState(persistedState, currentState),
    },
  ),
);

export function disposeWorkbenchRuntime(): void {
  invalidateSerialPortRefresh(useWorkbenchStore.setState);
  serialControlLineOperation += 1;
  stopCurrentModbusPolling("runtime-dispose", false);
  stopCurrentCommandWorkflows("runtime-dispose");
  void useWorkbenchStore.getState().cancelFileSend();
  cancelModbusTransactionForRuntimeDispose();
  const state = useWorkbenchStore.getState();
  revokeExtensionForBoundary(
    useWorkbenchStore.getState,
    useWorkbenchStore.setState,
    "运行环境已卸载，扩展会话已撤销",
    true,
  );
  resetLiveStreamBoundary(state.protocol);
  useWorkbenchStore.setState({
    attitudeSample: null,
    serialControlLineOperation: "idle",
    serialModemStatus: createUnavailableSerialModemStatus(state.serialGeneration),
    waveformTrigger: createIdleWaveformTriggerState(),
    processingStatus: liveProcessingRuntime.getSnapshot(),
    protocolHealth: protocolParser.getHealthSnapshot(),
  });
  if (!serialRecoveryCoordinator) {
    return;
  }
  const recoveryWasConnecting = state.serialRecovery.phase === "connecting";
  const manualConnecting =
    state.source === "serial" &&
    state.connectionStatus === "connecting" &&
    !recoveryWasConnecting;
  serialConnectOperation += 1;
  void (async () => {
    await serialRecoveryCoordinator?.cancel("runtime-dispose", true);
    if (manualConnecting) {
      await cancelPendingSerialConnection();
    }
  })().catch(() => undefined);
}

export function prepareWorkbenchForAppClose(): Promise<void> {
  if (appClosePromise) {
    return appClosePromise;
  }

  let resolveClose!: () => void;
  let rejectClose!: (reason?: unknown) => void;
  const pending = new Promise<void>((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });
  appClosePromise = pending;
  void prepareWorkbenchForAppCloseOnce().then(resolveClose, rejectClose);
  void pending.then(
    () => {
      if (appClosePromise === pending) {
        appClosePromise = null;
      }
    },
    () => {
      if (appClosePromise === pending) {
        appClosePromise = null;
      }
    },
  );
  return pending;
}

async function prepareWorkbenchForAppCloseOnce(): Promise<void> {
  const state = useWorkbenchStore.getState();
  const manualConnectionPending =
    state.source === "serial" &&
    state.connectionStatus === "connecting" &&
    state.serialRecovery.phase !== "connecting";
  const failures: string[] = [];

  invalidateSerialPortRefresh(useWorkbenchStore.setState);
  serialConnectOperation += 1;
  serialControlLineOperation += 1;
  serialRecoverySettingOperation += 1;
  stopCurrentModbusPolling("runtime-dispose", false);
  const modbusCancellation = cancelActiveModbusTransaction(useWorkbenchStore.getState).catch(
    (error: unknown) => {
      failures.push(`取消 Modbus RTU 事务失败：${getErrorMessage(error)}`);
    },
  );
  stopCurrentCommandWorkflows("runtime-dispose");
  useWorkbenchStore.setState({
    runtimeTransitionStatus: "closing-app",
    statusMessage: "正在完成记录并关闭应用",
    serialControlLineOperation: "idle",
    waveformTrigger: createIdleWaveformTriggerState(),
  });

  try {
    await serialRecoveryCoordinator?.cancel("runtime-dispose", true);
    if (manualConnectionPending) {
      await cancelPendingSerialConnection();
    }
  } catch (error) {
    failures.push(`取消串口连接失败：${getErrorMessage(error)}`);
  }

  if (state.isNativeRuntime) {
    try {
      const payload = await disconnectSerial();
      useWorkbenchStore.getState().handleSerialState(payload);
      if (payload.status !== "disconnected") {
        failures.push(`串口未正常断开：${serialStatusMessage(payload.status, payload.portName)}`);
      }
    } catch (error) {
      failures.push(`断开串口失败：${getErrorMessage(error)}`);
    }
  }

  await modbusCancellation;
  useWorkbenchStore.setState({ statusMessage: "正在完成记录并关闭应用" });

  try {
    const recordingsStopped = await stopCurrentRecordings(
      useWorkbenchStore.getState,
      useWorkbenchStore.setState,
    );
    if (!recordingsStopped) {
      failures.push("记录任务未能在应用关闭前正常完成");
    }
  } catch (error) {
    failures.push(`记录任务未能在应用关闭前正常完成：${getErrorMessage(error)}`);
  }

  if (failures.length > 0) {
    const message = `应用关闭收尾失败：${failures.join("；")}`;
    useWorkbenchStore.setState({ statusMessage: message });
    throw new Error(message);
  }
}

function cancelModbusTransactionForRuntimeDispose(): void {
  const state = useWorkbenchStore.getState();
  const active = state.modbusTransaction;
  if (!isModbusTransactionActive(active) || !active.request) {
    return;
  }

  const endedAt = Date.now();
  const requestMayHaveBeenTransmitted =
    state.source === "serial" || active.startedAt !== undefined;
  const startedAt = active.startedAt ?? active.queuedAt ?? endedAt;
  finalizeModbusTransaction(
    active,
    {
      transactionId: active.transactionId,
      status: "cancelled",
      request: bytesToBase64(active.requestFrame),
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      generation: active.generation,
      errorCode: requestMayHaveBeenTransmitted ? "cancelled-after-transmit" : "cancelled",
      message: requestMayHaveBeenTransmitted
        ? "运行环境已卸载，事务已取消；请求可能已经发出，写操作可能已被设备执行"
        : "运行环境已卸载，Modbus RTU 事务已取消，请求尚未发送",
    },
    null,
    useWorkbenchStore.setState,
  );

  if (state.source === "serial") {
    void cancelSerialModbusTransaction(active.transactionId).catch(() => undefined);
  }
}

function getSerialRecoveryCoordinator(): SerialReconnectCoordinator {
  if (serialRecoveryCoordinator) {
    return serialRecoveryCoordinator;
  }

  serialRecoveryCoordinator = new SerialReconnectCoordinator({
    now: Date.now,
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer),
    listPorts: listSerialPorts,
    connect: connectSerial,
    cancelPendingConnection: async () => {
      await cancelPendingSerialConnection();
    },
    prepareCaptureBoundary: () =>
      stopCurrentRecordings(useWorkbenchStore.getState, useWorkbenchStore.setState),
    applyBackendState: (payload) => {
      useWorkbenchStore.getState().handleSerialState(payload);
    },
    updatePorts: (ports) => {
      useWorkbenchStore.setState({ ports });
    },
    updatePortName: (portName) => {
      useWorkbenchStore.setState((state) => ({
        serialConfig: { ...state.serialConfig, portName },
      }));
    },
    resetStreamAfterReconnect: () => {
      const state = useWorkbenchStore.getState();
      getAutoResponderRuntime().stop("stream-reset");
      revokeExtensionForBoundary(
        useWorkbenchStore.getState,
        useWorkbenchStore.setState,
        "串口已重新连接，扩展会话已撤销",
      );
      resetLiveStreamBoundary(state.protocol);
      useWorkbenchStore.setState({
        processingStatus: liveProcessingRuntime.getSnapshot(),
        attitudeSample: null,
        waveformTrigger: createIdleWaveformTriggerState(),
        stats: { ...emptyStats(), startedAt: Date.now() },
        protocolHealth: protocolParser.getHealthSnapshot(),
      });
    },
    onSnapshot: (serialRecovery) => {
      useWorkbenchStore.setState({ serialRecovery });
    },
  });
  return serialRecoveryCoordinator;
}

export function selectActiveWorkspace(state: WorkbenchStore): WorkspaceProfile | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
}

export function selectActiveProtocol(state: WorkbenchStore): ProtocolKind {
  return hasReplaySession(state) && state.replayHeader
    ? state.replayHeader.protocol
    : state.protocol;
}

export function selectEffectiveTerminalDisplayMode(state: WorkbenchStore): DisplayMode {
  const context = terminalPresentationContext(state);
  if (!context) {
    return state.displayMode;
  }
  return state.terminalPresentationOverride?.context === context
    ? state.terminalPresentationOverride.displayMode
    : "hex";
}

export function selectEffectiveTerminalRxRecordMode(
  state: WorkbenchStore,
): TerminalRxRecordMode {
  const context = terminalPresentationContext(state);
  if (!context) {
    return state.terminalRxRecordMode;
  }
  return state.terminalPresentationOverride?.context === context
    ? state.terminalPresentationOverride.recordMode
    : "chunk";
}

export function selectUsesBinaryTerminalDefaults(state: WorkbenchStore): boolean {
  return terminalPresentationContext(state) !== null;
}

function terminalPresentationContext(
  state: WorkbenchStore,
): TerminalPresentationContext | null {
  if (hasReplaySession(state) && state.replayHeader?.protocol === "justfloat") {
    return `replay:${state.replaySessionId}:justfloat`;
  }
  if (hasReplaySession(state)) {
    return null;
  }
  if (state.protocol === "justfloat") {
    return "live:justfloat";
  }
  return null;
}

export function selectActiveProtocolHealth(state: WorkbenchStore): ProtocolHealthSnapshot {
  return hasReplaySession(state) ? state.replayProtocolHealth : state.protocolHealth;
}

export function selectIsWorkspaceDirty(state: WorkbenchStore): boolean {
  const activeWorkspace = selectActiveWorkspace(state);
  if (!activeWorkspace) {
    return true;
  }
  const savedConfig = cloneWorkspaceConfig(activeWorkspace.config);
  if (!state.isNativeRuntime && savedConfig.source === "serial") {
    savedConfig.source = "simulator";
  }
  return !areWorkspaceConfigsEqual(captureWorkbenchWorkspaceConfig(state), savedConfig);
}

function captureWorkspaceConfigForSave(state: WorkbenchStore) {
  const config = captureWorkbenchWorkspaceConfig(state);
  const activeWorkspace = selectActiveWorkspace(state);
  if (
    !state.isNativeRuntime &&
    state.source === "simulator" &&
    activeWorkspace?.config.source === "serial"
  ) {
    config.source = "serial";
  }
  return config;
}

function captureWorkbenchWorkspaceConfig(state: WorkbenchStore) {
  return captureWorkspaceConfig(state);
}

function assertWorkspaceIdle(state: WorkbenchStore): void {
  if (state.workspaceTransitionStatus !== "idle") {
    throw new Error("工作区操作正在进行，请稍后重试");
  }
}

function assertWorkspaceStorageWritable(state: WorkbenchStore): void {
  if (state.workspaceStorageStatus === "newer-version") {
    throw new Error(
      `检测到版本 ${state.incompatibleStorageVersion ?? "未知"} 的较新配置，当前版本不能保存工作区`,
    );
  }
}

type WorkbenchGet = StoreApi<WorkbenchStore>["getState"];
type WorkbenchSet = StoreApi<WorkbenchStore>["setState"];

function getExtensionCoordinator(): ExtensionCoordinator {
  if (extensionCoordinator) {
    return extensionCoordinator;
  }
  extensionCoordinator = new ExtensionCoordinator({
    pushBatch: pushExtensionBatch,
    onBatch: handleExtensionBatch,
    onFault: handleExtensionCoordinatorFault,
    onQueueChange: (extensionQueue) => {
      useWorkbenchStore.setState({ extensionQueue });
    },
  });
  return extensionCoordinator;
}

function revokeExtensionForBoundary(
  get: WorkbenchGet,
  set: WorkbenchSet,
  message: string,
  clearInspection = false,
): void {
  const state = get();
  const hasRuntimeState =
    state.extensionState.status !== "idle" ||
    state.extensionState.sessionId > 0 ||
    state.extensionOperation !== "idle" ||
    state.extensionChannels.length > 0 ||
    state.extensionQueue.active ||
    state.extensionQueue.inFlight;
  const hasAuthorizationContext = state.extensionInspection !== null;
  if (!hasRuntimeState && !hasAuthorizationContext && !clearInspection) {
    return;
  }

  const extensionAuthorizationRevision = state.extensionAuthorizationRevision + 1;
  if (!hasRuntimeState && !clearInspection) {
    set({
      extensionAuthorizationRevision,
      extensionMessage: message,
    });
    return;
  }

  const sessionId = state.extensionState.sessionId;
  extensionOperation += 1;
  extensionChannelBuffers.clear();
  getExtensionCoordinator().deactivate();
  set({
    extensionState: createIdleExtensionState(state.extensionState.revision + 1, message),
    extensionAuthorizationRevision,
    extensionOperation: "idle",
    extensionMessage: message,
    extensionChannels: [],
    chartFrozenExtensionChannels: null,
    extensionChannelVisibility: {},
    extensionQueue: createIdleExtensionQueue(),
    ...(clearInspection
      ? { extensionInspection: null, extensionPackagePath: "" }
      : {}),
  });

  if (state.isNativeRuntime && sessionId > 0) {
    void deactivateExtensionClient(sessionId).catch((error: unknown) => {
      if (get().extensionState.status === "idle") {
        set({ extensionMessage: `${message}；后端撤销失败：${getErrorMessage(error)}` });
      }
    });
  }
}

function handleExtensionBatch(payload: ExtensionBatchPayload, appendFrames: boolean): void {
  useWorkbenchStore.setState((state) => {
    if (
      state.extensionState.status !== "active" ||
      state.extensionState.sessionId !== payload.sessionId ||
      state.extensionState.generation !== payload.generation ||
      state.extensionState.nextSequence !== payload.sequence ||
      hasReplaySession(state)
    ) {
      return state;
    }
    const manifest = state.extensionState.manifest;
    const extensionChannels = !manifest || !appendFrames
      ? state.extensionChannels
      : appendExtensionFrames(
          state.extensionChannels,
          payload,
          manifest.id,
          state.extensionChannelVisibility,
        );
    return {
      extensionChannels,
      chartFrozenExtensionChannels: state.chartPaused
        ? (state.chartFrozenExtensionChannels ?? state.extensionChannels)
        : null,
      extensionState: {
        ...state.extensionState,
        nextSequence: payload.sequence + 1,
        processedBytes: state.extensionState.processedBytes + payload.acceptedBytes,
        emittedFrames: state.extensionState.emittedFrames + payload.frames.length,
      },
    };
  });
}

function handleExtensionCoordinatorFault(error: Error, sessionId: number): void {
  const state = useWorkbenchStore.getState();
  if (state.extensionState.status !== "active" || state.extensionState.sessionId !== sessionId) {
    return;
  }
  const message = error.message;
  useWorkbenchStore.setState({
    extensionState: createExtensionFrontendFault(
      state.extensionState,
      message.includes("队列已满") ? "frontend-queue-overflow" : "frontend-runtime-fault",
      message,
    ),
    extensionOperation: "idle",
    extensionMessage: message,
  });
  if (state.isNativeRuntime && sessionId > 0) {
    void deactivateExtensionClient(sessionId).catch(() => undefined);
  }
}

function createIdleExtensionState(revision = 0, message?: string): ExtensionStatePayload {
  return {
    status: "idle",
    sessionId: 0,
    generation: 0,
    revision,
    nextSequence: 1,
    authorizedCapabilities: [],
    processedBytes: 0,
    emittedFrames: 0,
    message,
  };
}

function createExtensionFrontendFault(
  state: ExtensionStatePayload,
  faultCode: string,
  message: string,
): ExtensionStatePayload {
  return {
    ...state,
    status: "error",
    generation: state.generation + 1,
    nextSequence: 1,
    authorizedCapabilities: [],
    faultCode,
    message,
  };
}

function createIdleExtensionQueue(): ExtensionQueueSnapshot {
  return {
    active: false,
    inFlight: false,
    queuedBatches: 0,
    queuedBytes: 0,
  };
}

function getCommandScheduler(): CommandScheduler {
  if (commandScheduler) {
    return commandScheduler;
  }

  commandScheduler = new CommandScheduler({
    now: () => Date.now(),
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    prepare: prepareCommandTemplate,
    send: (command) =>
      executePreparedCommand(
        command,
        "scheduler",
        useWorkbenchStore.getState,
        useWorkbenchStore.setState,
      ),
    onSnapshot: (commandTask) => {
      useWorkbenchStore.setState({ commandTask });
    },
  });
  return commandScheduler;
}

function getAutoResponderRuntime(): AutoResponderRuntime {
  if (autoResponderRuntime) {
    return autoResponderRuntime;
  }

  autoResponderRuntime = new AutoResponderRuntime({
    now: Date.now,
    send: (dispatch, signal) =>
      executePreparedCommand(
        dispatch.command,
        "auto-responder",
        useWorkbenchStore.getState,
        useWorkbenchStore.setState,
        signal,
      ),
    onSnapshot: (autoResponder) => {
      useWorkbenchStore.setState({ autoResponder });
    },
  });
  return autoResponderRuntime;
}

function getModbusPoller(): ModbusPoller {
  if (modbusPoller) {
    return modbusPoller;
  }

  modbusPoller = new ModbusPoller({
    now: Date.now,
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    dispatch: (request, timeoutMs) => {
      const pending = beginModbusTransaction(
        request,
        timeoutMs,
        true,
        useWorkbenchStore.getState,
        useWorkbenchStore.setState,
      );
      void pending.completion.catch((error) => {
        getModbusPoller().handleDispatchError(pending.transactionId, error);
      });
      return pending.transactionId;
    },
    cancel: async (transactionId) => {
      const state = useWorkbenchStore.getState();
      if (state.modbusTransaction.transactionId !== transactionId) {
        return false;
      }
      return state.cancelModbusTransaction();
    },
    onSnapshot: (modbusPoll) => {
      useWorkbenchStore.setState({ modbusPoll });
    },
  });
  return modbusPoller;
}

function stopCurrentCommandTask(reason: CommandTaskStopReason): boolean {
  return commandScheduler?.stop(reason) ?? false;
}

function stopCurrentModbusPolling(
  reason: CommandTaskStopReason,
  cancelInFlight = true,
): boolean {
  return modbusPoller?.stop(reason, cancelInFlight) ?? false;
}

function stopCurrentCommandWorkflows(reason: CommandTaskStopReason): void {
  stopCurrentCommandTask(reason);
  getAutoResponderRuntime().stop(reason as AutoResponderStopReason);
  commandSendArbiter.cancelPending();
}

function isModbusTransactionActive(transaction: ModbusRtuTransactionSnapshot): boolean {
  return transaction.status !== "idle";
}

function isSerialFileSendActive(status: SerialFileSendPayload["status"]): boolean {
  return status === "queued" || status === "sending" || status === "cancelling";
}

function createIdleSerialFileSendPayload(
  revision = 0,
  generation = 0,
): SerialFileSendPayload {
  return {
    jobId: 0,
    revision,
    generation,
    status: "idle",
    fileName: "",
    totalBytes: 0,
    transmittedBytes: 0,
    message: "",
  };
}

async function cancelActiveSerialFileSend(get: WorkbenchGet): Promise<void> {
  if (isSerialFileSendActive(get().serialFileSend.status)) {
    await get().cancelFileSend();
  }
}

function nextModbusTransactionId(): number {
  modbusTransactionSequence += 1;
  if (!Number.isSafeInteger(modbusTransactionSequence) || modbusTransactionSequence <= 0) {
    modbusTransactionSequence = Date.now() * 1_000;
  }
  return modbusTransactionSequence;
}

function clearSimulatorModbusTimer(): void {
  if (simulatorModbusTimer !== null) {
    globalThis.clearTimeout(simulatorModbusTimer);
    simulatorModbusTimer = null;
  }
}

function beginModbusTransaction(
  request: ModbusRtuRequest,
  timeoutMs: number,
  allowActivePoller: boolean,
  get: WorkbenchGet,
  set: WorkbenchSet,
): { transactionId: number; completion: Promise<boolean> } {
  const state = get();
  assertModbusTransactionCanStart(state, timeoutMs, allowActivePoller);
  const requestCopy = cloneModbusRtuRequest(request);
  const requestFrame = buildModbusRtuRequest(requestCopy);
  const transactionId = nextModbusTransactionId();
  const queuedAt = Date.now();
  set({
    modbusTransaction: {
      transactionId,
      generation: state.serialGeneration,
      status: "queued",
      request: requestCopy,
      requestFrame,
      timeoutMs,
      queuedAt,
      message: "等待 Modbus RTU 总线静默",
    },
  });

  const completion = (async () => {
    try {
      if (state.source === "serial") {
        await startSerialModbusTransaction(transactionId, requestFrame, timeoutMs);
        return true;
      }

      const transmittedAt = Date.now();
      get().handleSerialTx({
        data: bytesToBase64(requestFrame),
        byteCount: requestFrame.length,
        transmittedAt,
        generation: state.serialGeneration,
      });
      get().handleModbusTransaction({
        transactionId,
        status: "waiting",
        request: bytesToBase64(requestFrame),
        startedAt: transmittedAt,
        durationMs: 0,
        generation: state.serialGeneration,
        message: requestCopy.unitId === 0 ? "广播写入已完成" : "等待模拟设备响应",
      });
      if (requestCopy.unitId === 0) {
        get().handleModbusTransaction({
          transactionId,
          status: "completed",
          request: bytesToBase64(requestFrame),
          startedAt: transmittedAt,
          endedAt: transmittedAt,
          durationMs: 0,
          generation: state.serialGeneration,
          message: "Modbus RTU 广播写入已完成，不等待响应",
        });
        return true;
      }

      simulatorModbusTimer = globalThis.setTimeout(() => {
        simulatorModbusTimer = null;
        const active = useWorkbenchStore.getState().modbusTransaction;
        if (
          active.transactionId !== transactionId ||
          active.status === "idle" ||
          !active.request
        ) {
          return;
        }
        const response = simulateModbusRtuResponse(active.request);
        if (!response) {
          return;
        }
        const endedAt = Date.now();
        useWorkbenchStore.getState().ingestBytes(response, endedAt);
        useWorkbenchStore.getState().handleModbusTransaction({
          transactionId,
          status: "completed",
          request: bytesToBase64(active.requestFrame),
          response: bytesToBase64(response),
          startedAt: active.startedAt ?? transmittedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - (active.startedAt ?? transmittedAt)),
          generation: active.generation,
          message: "Modbus RTU 模拟事务已完成",
        });
      }, Math.min(60, timeoutMs));
      return true;
    } catch (error) {
      if (get().modbusTransaction.transactionId === transactionId) {
        set({ modbusTransaction: createInitialModbusRtuTransactionSnapshot() });
      }
      throw error;
    }
  })();

  return { transactionId, completion };
}

async function cancelActiveModbusTransaction(get: WorkbenchGet): Promise<void> {
  if (isModbusTransactionActive(get().modbusTransaction)) {
    await get().cancelModbusTransaction();
  }
}

function assertModbusPollingCanStart(state: WorkbenchStore, timeoutMs: number): void {
  if (isModbusPollActive(state.modbusPoll)) {
    throw new Error("已有 Modbus RTU 轮询任务正在运行或停止中");
  }
  assertModbusTransactionCanStart(state, timeoutMs, true);
}

function assertModbusTransactionCanStart(
  state: WorkbenchStore,
  timeoutMs: number,
  allowActivePoller = false,
): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_MODBUS_TRANSACTION_TIMEOUT_MS ||
    timeoutMs > MAX_MODBUS_TRANSACTION_TIMEOUT_MS
  ) {
    throw new Error(
      `响应超时必须是 ${MIN_MODBUS_TRANSACTION_TIMEOUT_MS}-${MAX_MODBUS_TRANSACTION_TIMEOUT_MS} ms`,
    );
  }
  assertCommandCanSend(state, allowActivePoller);
  if (isModbusTransactionActive(state.modbusTransaction)) {
    throw new Error("已有 Modbus RTU 事务正在运行");
  }
  if (commandSendArbiter.isBusy() || state.isSendingCommand) {
    throw new Error("请等待当前发送完成后再执行 Modbus RTU 事务");
  }
  if (getCommandScheduler().isActive()) {
    throw new Error("周期发送运行中，请先停止任务");
  }
  if (getAutoResponderRuntime().isActive()) {
    throw new Error("自动应答运行中，请先停止自动应答");
  }
}

function assertSerialFileSendCanStart(state: WorkbenchStore, path: string): void {
  if (path.trim().length === 0) {
    throw new Error("请先选择要发送的文件");
  }
  if (!state.isNativeRuntime || state.source !== "serial") {
    throw new Error("原始文件发送仅支持桌面串口数据源");
  }
  assertCommandCanSend(state);
  if (isSerialFileSendActive(state.serialFileSend.status)) {
    throw new Error("已有文件发送任务正在运行");
  }
  if (commandSendArbiter.isBusy() || state.isSendingCommand) {
    throw new Error("请等待当前发送完成后再发送文件");
  }
  if (getCommandScheduler().isActive()) {
    throw new Error("周期发送运行中，请先停止任务");
  }
  if (getAutoResponderRuntime().isActive()) {
    throw new Error("自动应答运行中，请先停止自动应答");
  }
}

function finalizeModbusTransaction(
  active: ModbusRtuTransactionSnapshot,
  payload: SerialModbusTransactionPayload,
  result: ModbusRtuTransactionRecord["result"],
  set: WorkbenchSet,
): void {
  if (payload.status === "waiting" || !active.request) {
    return;
  }
  clearSimulatorModbusTimer();
  const endedAt = payload.endedAt ?? Date.now();
  const startedAt = payload.startedAt || active.startedAt || active.queuedAt || endedAt;
  const responseHex = payload.response
    ? formatModbusRtuFrame(decodeBase64(payload.response))
    : "";
  const record: ModbusRtuTransactionRecord = {
    transactionId: active.transactionId,
    generation: active.generation,
    status: payload.status,
    request: cloneModbusRtuRequest(active.request),
    requestHex: formatModbusRtuFrame(active.requestFrame),
    responseHex,
    result,
    startedAt,
    endedAt,
    durationMs: payload.durationMs,
    errorCode: payload.errorCode,
    message: payload.message,
  };
  let finalized = false;
  set((latest) => {
    if (latest.modbusTransaction.transactionId !== active.transactionId) {
      return {};
    }
    finalized = true;
    return {
      modbusTransaction: createInitialModbusRtuTransactionSnapshot(),
      modbusTransactions: [record, ...latest.modbusTransactions].slice(
        0,
        MAX_MODBUS_TRANSACTION_HISTORY,
      ),
    };
  });
  if (finalized) {
    modbusPoller?.handleTerminal({
      transactionId: active.transactionId,
      status: payload.status,
      result,
      endedAt,
      message: payload.message,
    });
  }
}

function equalByteArrays(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCommandCanStart(state: WorkbenchStore): void {
  assertCommandCanSend(state);
  if (commandSendArbiter.isBusy() || state.isSendingCommand) {
    throw new Error("请等待当前发送完成后再启动周期任务");
  }
  if (getAutoResponderRuntime().isActive()) {
    throw new Error("自动应答运行中，请先停止自动应答");
  }
  if (getCommandScheduler().isActive()) {
    throw new Error("已有发送任务正在运行或停止中");
  }
}

function assertAutoResponderCanStart(state: WorkbenchStore): void {
  assertCommandCanSend(state);
  if (getCommandScheduler().isActive()) {
    throw new Error("周期发送运行中，请先停止任务");
  }
  if (commandSendArbiter.isBusy() || state.isSendingCommand) {
    throw new Error("请等待当前发送完成后再启用自动应答");
  }
}

function assertCommandCanSend(state: WorkbenchStore, allowActivePoller = false): void {
  if (
    state.workspaceTransitionStatus !== "idle" ||
    state.runtimeTransitionStatus !== "idle" ||
    hasReplaySession(state)
  ) {
    throw new Error("当前运行事务中无法发送数据");
  }
  if (state.connectionStatus !== "connected") {
    throw new Error("请先连接数据源");
  }
  if (state.serialControlLineOperation !== "idle") {
    throw new Error("串口控制线操作进行中，请稍后重试");
  }
  if (!allowActivePoller && isModbusPollActive(state.modbusPoll)) {
    throw new Error("Modbus RTU 轮询运行中，暂不能发送其他数据");
  }
  if (isModbusTransactionActive(state.modbusTransaction)) {
    throw new Error("Modbus RTU 事务进行中，暂不能发送其他数据");
  }
  if (isSerialFileSendActive(state.serialFileSend.status)) {
    throw new Error("文件发送进行中，暂不能发送其他数据");
  }
}

function assertCommandSize(bytes: Uint8Array): void {
  if (bytes.length > MAX_COMMAND_BYTES) {
    throw new Error(`单次发送不能超过 ${MAX_COMMAND_BYTES / 1024} KiB，请拆分后重试`);
  }
}

function prepareCommandTemplate(
  template: CompiledCommandTemplate,
  lineEnding: LineEnding,
  checksumMode: CommandChecksumMode,
  context: CommandTemplateContext,
): PreparedCommand {
  const rendered = renderCommandTemplate(template, context, lineEnding, checksumMode);
  return {
    value: template.source,
    mode: template.mode,
    lineEnding,
    checksumMode,
    textEncoding: template.textEncoding,
    bytes: rendered.bytes,
    variableCount: rendered.variableCount,
  };
}

function executePreparedCommand(
  command: PreparedCommand,
  origin: CommandSendOrigin,
  get: WorkbenchGet,
  set: WorkbenchSet,
  signal?: AbortSignal,
): Promise<void> {
  assertCommandSize(command.bytes);
  if (origin === "manual" && getCommandScheduler().isActive()) {
    throw new Error("周期发送运行中，请先停止任务");
  }
  return commandSendArbiter.run(origin, signal, async () => {
    const state = get();
    assertCommandCanSend(state);
    if (origin === "auto-responder" && getCommandScheduler().isActive()) {
      throw new Error("周期发送运行中，自动应答已停止");
    }

    set({ isSendingCommand: true, commandSendOrigin: origin });
    try {
      if (state.source === "serial") {
        await sendSerial(
          command.bytes,
          command.mode === "text" ? command.textEncoding : undefined,
        );
      } else {
        get().handleSerialTx({
          data: bytesToBase64(command.bytes),
          byteCount: command.bytes.length,
          transmittedAt: Date.now(),
          generation: get().serialGeneration,
          textEncoding: command.mode === "text" ? command.textEncoding : undefined,
        });
      }
      const sentAt = Date.now();
      set((latest) => ({
        isSendingCommand: false,
        commandSendOrigin: null,
        commandHistory:
          origin === "auto-responder"
            ? latest.commandHistory
            : appendCommandHistory(latest.commandHistory, {
                value: command.value,
                mode: command.mode,
                lineEnding: command.lineEnding,
                checksumMode: command.checksumMode,
                textEncoding: command.textEncoding,
                payloadBytes: commandHistoryPayloadBytes(command.value),
                encodedBytes: command.bytes.length,
                variableCount: command.variableCount,
                sentAt,
              }),
      }));
    } catch (error) {
      set({ isSendingCommand: false, commandSendOrigin: null });
      const latest = get();
      if (state.source === "serial") {
        getSerialRecoveryCoordinator().recordSerialSendFailure({
          origin,
          generation: latest.serialGeneration,
          revision: latest.serialStateRevision,
        });
      }
      throw error;
    }
  });
}

function isCaptureTransitioning(status: CaptureUiStatus): boolean {
  return status === "starting" || status === "stopping";
}

function isCaptureActive(status: CaptureUiStatus): boolean {
  return status === "starting" || status === "recording" || status === "stopping";
}

function isNumericLogTransitioning(status: NumericLogUiStatus): boolean {
  return status === "starting" || status === "stopping";
}

function isNumericLogActive(status: NumericLogUiStatus): boolean {
  return status === "starting" || status === "recording" || status === "stopping";
}

function isSerialControlLineContextAvailable(state: WorkbenchStore): boolean {
  return (
    state.isNativeRuntime &&
    state.source === "serial" &&
    state.connectionStatus === "connected" &&
    state.serialControlLineOperation === "idle" &&
    state.workspaceTransitionStatus === "idle" &&
    state.runtimeTransitionStatus === "idle" &&
    !state.isCancellingSerialConnection &&
    !isRecoveryActivePhase(state.serialRecovery.phase) &&
    !isCaptureActive(state.captureStatus) &&
    !isNumericLogActive(state.numericLogStatus) &&
    !isSerialFileSendActive(state.serialFileSend.status) &&
    !isModbusPollActive(state.modbusPoll) &&
    !isModbusTransactionActive(state.modbusTransaction) &&
    !hasReplaySession(state)
  );
}

function isSerialPortRefreshContext(state: WorkbenchStore): boolean {
  return (
    state.isNativeRuntime &&
    state.source === "serial" &&
    (state.connectionStatus === "disconnected" || state.connectionStatus === "error") &&
    state.workspaceTransitionStatus === "idle" &&
    state.runtimeTransitionStatus === "idle" &&
    !state.isCancellingSerialConnection &&
    !isRecoveryActivePhase(state.serialRecovery.phase) &&
    !isCaptureActive(state.captureStatus) &&
    !isNumericLogActive(state.numericLogStatus) &&
    !isSerialFileSendActive(state.serialFileSend.status) &&
    !isModbusPollActive(state.modbusPoll) &&
    !isModbusTransactionActive(state.modbusTransaction) &&
    !hasReplaySession(state)
  );
}

function isSameSerialPortRefreshContext(
  initial: WorkbenchStore,
  current: WorkbenchStore,
): boolean {
  return (
    isSerialPortRefreshContext(current) &&
    current.source === initial.source &&
    current.serialRecovery.enabled === initial.serialRecovery.enabled &&
    current.serialRecovery.phase === initial.serialRecovery.phase &&
    current.activeWorkspaceId === initial.activeWorkspaceId &&
    current.chartDataRevision === initial.chartDataRevision &&
    current.captureRevision === initial.captureRevision &&
    current.numericLogRevision === initial.numericLogRevision &&
    current.serialFileSend.revision === initial.serialFileSend.revision &&
    current.replayRevision === initial.replayRevision
  );
}

function ownsSerialPortRefresh(
  operation: number,
  initial: WorkbenchStore,
  current: WorkbenchStore,
): boolean {
  return (
    operation === serialPortRefreshOperation &&
    isSameSerialPortRefreshContext(initial, current)
  );
}

function clearSerialPortDiscovery(set: WorkbenchSet): void {
  set({
    serialPortDiscoveryStatus: "idle",
    serialPortDiscoveryMessage: "",
  });
}

function invalidateSerialPortRefresh(set: WorkbenchSet): void {
  serialPortRefreshOperation += 1;
  set({
    isRefreshingPorts: false,
    serialPortDiscoveryStatus: "idle",
    serialPortDiscoveryMessage: "",
  });
}

function isCaptureExportBusy(status: CaptureExportUiStatus): boolean {
  return [
    "selecting-source",
    "selecting-destination",
    "starting",
    "running",
    "cancelling",
  ].includes(status);
}

function isCaptureExportTerminal(status: CaptureExportUiStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "error";
}

function captureExportDraft(sourcePath: string): Partial<WorkbenchStore> {
  return {
    captureExportStatus: "idle",
    captureExportPhase: "idle",
    captureExportSourcePath: sourcePath,
    captureExportDestinationPath: "",
    captureExportTotalInputBytes: 0,
    captureExportProcessedInputBytes: 0,
    captureExportProcessedDataBytes: 0,
    captureExportProcessedRecords: 0,
    captureExportExportedDataBytes: 0,
    captureExportExportedRecords: 0,
    captureExportOutputBytes: 0,
    captureExportSourceComplete: false,
    captureExportStartedAt: undefined,
    captureExportEndedAt: undefined,
    captureExportMessage: "",
  };
}

function hasCaptureToStop(state: WorkbenchStore): boolean {
  return (
    isCaptureActive(state.captureStatus) ||
    (state.captureStatus === "error" && state.captureSessionId > 0)
  );
}

function hasNumericLogToStop(state: WorkbenchStore): boolean {
  return (
    isNumericLogActive(state.numericLogStatus) ||
    (state.numericLogStatus === "error" && state.numericLogSessionId > 0)
  );
}

function hasRecordingToStop(state: WorkbenchStore): boolean {
  return hasCaptureToStop(state) || hasNumericLogToStop(state);
}

function hasReplaySession(state: WorkbenchStore): boolean {
  return state.replaySessionId > 0 && state.replayStatus !== "idle";
}

function isReplayRunning(status: ReplayUiStatus): boolean {
  return ["starting", "playing", "pausing", "paused", "seeking", "stopping"].includes(
    status,
  );
}

function isReplayReceiving(status: ReplayUiStatus): boolean {
  return status === "playing";
}

function beginRuntimeTransition(
  get: WorkbenchGet,
  set: WorkbenchSet,
  status: Exclude<RuntimeTransitionStatus, "idle">,
): boolean {
  if (
    get().runtimeTransitionStatus !== "idle" ||
    get().workspaceTransitionStatus !== "idle"
  ) {
    return false;
  }
  set({ runtimeTransitionStatus: status });
  return true;
}

function endRuntimeTransition(
  get: WorkbenchGet,
  set: WorkbenchSet,
  expected?: Exclude<RuntimeTransitionStatus, "idle">,
): void {
  if (!expected || get().runtimeTransitionStatus === expected) {
    set({ runtimeTransitionStatus: "idle" });
  }
}

async function stopCurrentCapture(get: WorkbenchGet, set: WorkbenchSet): Promise<boolean> {
  const state = get();
  if (!hasCaptureToStop(state)) {
    return true;
  }
  if (captureStopPromise) {
    return captureStopPromise;
  }
  if (!state.isNativeRuntime) {
    return false;
  }

  set({ captureStatus: "stopping", captureMessage: "正在完成捕获文件" });
  const pending = (async () => {
    try {
      const payload = await stopCaptureClient();
      get().handleCaptureState(payload);
      return payload.status !== "recording" && payload.status !== "stopping";
    } catch (error) {
      set({ captureStatus: "error", captureMessage: getErrorMessage(error) });
      return false;
    }
  })();
  captureStopPromise = pending;
  try {
    return await pending;
  } finally {
    if (captureStopPromise === pending) {
      captureStopPromise = null;
    }
  }
}

async function stopCurrentNumericLog(
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  const state = get();
  if (!hasNumericLogToStop(state)) {
    return true;
  }
  if (numericLogStopPromise) {
    return numericLogStopPromise;
  }
  if (!state.isNativeRuntime) {
    return false;
  }

  set({ numericLogStatus: "stopping", numericLogMessage: "正在完成数值 CSV" });
  const pending = (async () => {
    try {
      const payload = await stopNumericLogClient();
      get().handleNumericLogState(payload);
      return payload.status !== "recording" && payload.status !== "stopping";
    } catch (error) {
      set({ numericLogStatus: "error", numericLogMessage: getErrorMessage(error) });
      return false;
    }
  })();
  numericLogStopPromise = pending;
  try {
    return await pending;
  } finally {
    if (numericLogStopPromise === pending) {
      numericLogStopPromise = null;
    }
  }
}

async function stopCurrentRecordings(
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  const [captureStopped, numericLogStopped] = await Promise.all([
    stopCurrentCapture(get, set),
    stopCurrentNumericLog(get, set),
  ]);
  return captureStopped && numericLogStopped;
}

async function prepareAndOpenReplay(
  path: string,
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  stopCurrentModbusPolling("replay-open", false);
  await cancelActiveModbusTransaction(get);
  stopCurrentCommandWorkflows("replay-open");
  if (!(await stopCurrentRecordings(get, set))) {
    set({ replayMessage: "捕获文件尚未完成，无法打开回放" });
    return false;
  }
  if (get().connectionStatus !== "disconnected") {
    const disconnected = await disconnectCurrentSource(get, set);
    if (!disconnected) {
      set({ replayMessage: "断开数据源失败，未打开回放文件" });
      return false;
    }
  }

  revokeExtensionForBoundary(get, set, "已进入回放，实时扩展会话已撤销");

  if (!hasReplaySession(get())) {
    set({
      replayStatus: "loading",
      waveformTrigger: createIdleWaveformTriggerState(),
    });
  } else {
    set({ waveformTrigger: createIdleWaveformTriggerState() });
  }
  set({ statusMessage: "正在检查捕获文件" });
  const payload = await openReplayClient(path);
  get().handleReplayState(payload);
  return payload.status === "loading" || payload.status === "ready";
}

async function closeCurrentReplay(get: WorkbenchGet, set: WorkbenchSet): Promise<boolean> {
  const state = get();
  if (!hasReplaySession(state)) {
    return true;
  }

  set({ replayStatus: "closing", replayMessage: "正在关闭回放" });
  try {
    const payload = await closeReplayClient(state.replaySessionId);
    get().handleReplayState(payload);
    return payload.status === "idle";
  } catch (error) {
    setReplayActionError(set, error, state.replayStatus);
    return false;
  }
}

function setReplayActionError(
  set: WorkbenchSet,
  error: unknown,
  fallbackStatus: ReplayUiStatus = "error",
): void {
  const message = getErrorMessage(error);
  set({
    replayStatus: fallbackStatus,
    replayMessage: message,
    statusMessage: message,
  });
}

async function recoverReplayAfterAckFailure(
  sessionId: number,
  generation: number,
  error: unknown,
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<void> {
  const state = get();
  if (state.replaySessionId !== sessionId || state.replayGeneration !== generation) {
    return;
  }

  const ackMessage = `回放确认失败：${getErrorMessage(error)}`;
  try {
    const payload = await stopReplayClient(sessionId, generation);
    get().handleReplayState(payload);
    const message = `${ackMessage}，已停止回放`;
    set({ replayMessage: message, statusMessage: message });
  } catch (stopError) {
    const latest = get();
    if (latest.replaySessionId !== sessionId || latest.replayGeneration !== generation) {
      return;
    }
    setReplayActionError(
      set,
      new Error(`${ackMessage}；停止回放失败：${getErrorMessage(stopError)}`),
    );
  }
}

function handleCaptureQueueError(error: Error): void {
  const state = useWorkbenchStore.getState();
  if (state.captureStatus !== "recording") {
    return;
  }
  useWorkbenchStore.setState({
    captureStatus: "error",
    captureMessage: error.message,
  });
  void abortCaptureClient(error.message)
    .then((payload) => useWorkbenchStore.getState().handleCaptureState(payload))
    .catch((abortError) => {
      useWorkbenchStore.setState({ captureMessage: getErrorMessage(abortError) });
    });
}

function handleCaptureMarkerError(error: Error): void {
  const state = useWorkbenchStore.getState();
  if (state.captureStatus !== "recording") {
    return;
  }
  useWorkbenchStore.setState({
    captureMessage: error.message,
    statusMessage: error.message,
  });
}

function handleNumericLogQueueError(error: Error): void {
  const state = useWorkbenchStore.getState();
  if (state.numericLogStatus !== "recording") {
    return;
  }
  useWorkbenchStore.setState({
    numericLogStatus: "error",
    numericLogMessage: error.message,
  });
  void abortNumericLogClient(error.message)
    .then((payload) => useWorkbenchStore.getState().handleNumericLogState(payload))
    .catch((abortError) => {
      useWorkbenchStore.setState({ numericLogMessage: getErrorMessage(abortError) });
    });
}

async function cancelPendingSerialConnection(): Promise<SerialStatePayload> {
  const cancelled = await cancelSerialConnect();
  const payload =
    cancelled.status === "connected" ? await disconnectSerial() : cancelled;
  applyCancelledSerialState(payload);
  return payload;
}

function applyCancelledSerialState(payload: SerialStatePayload): void {
  const state = useWorkbenchStore.getState();
  if (
    state.source === "serial" &&
    !hasReplaySession(state) &&
    payload.status !== "connecting" &&
    payload.revision === state.serialStateRevision &&
    state.connectionStatus === "connecting"
  ) {
    useWorkbenchStore.setState({
      connectionStatus: payload.status,
      connectionActionError: "",
      serialGeneration: payload.generation,
      serialStateRevision: payload.revision,
      connectionMessage: payload.message ?? serialStatusMessage(payload.status, payload.portName),
      statusMessage: payload.message ?? serialStatusMessage(payload.status, payload.portName),
      serialModemStatus: createUnavailableSerialModemStatus(payload.generation),
      runtimeTransitionStatus:
        state.runtimeTransitionStatus === "connecting"
          ? "idle"
          : state.runtimeTransitionStatus,
      waveformTrigger: createIdleWaveformTriggerState(),
    });
    return;
  }
  state.handleSerialState(payload);
}

async function disconnectCurrentSource(
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  set({ connectionActionError: "" });
  stopCurrentModbusPolling("connection-change", false);
  await cancelActiveSerialFileSend(get);
  await cancelActiveModbusTransaction(get);
  if (get().source === "simulator") {
    const state = get();
    const terminalEntries = settleTerminalPresentation(state, terminalLineAssembler);
    resetLiveTerminalPresentationState();
    set({
      connectionStatus: "disconnected",
      connectionActionError: "",
      connectionMessage: "模拟数据已停止",
      statusMessage: "模拟数据已停止",
      serialModemStatus: createUnavailableSerialModemStatus(state.serialGeneration),
      waveformTrigger: createIdleWaveformTriggerState(),
      terminalEntries,
    });
    return true;
  }

  try {
    const payload = await disconnectSerial();
    get().handleSerialState(payload);
    if (payload.status === "connected") {
      const detail = payload.message?.trim() || "串口服务仍报告已连接";
      const message = `断开失败，当前仍保持连接：${detail}`;
      set({
        connectionActionError: message,
        connectionMessage: message,
        statusMessage: message,
      });
    }
    return payload.status === "disconnected";
  } catch (error) {
    const message = getErrorMessage(error);
    try {
      const payload = await getSerialState();
      get().handleSerialState(payload);
      const latest = get();
      getSerialRecoveryCoordinator().recordDisconnectCommandFailure({
        generation: latest.serialGeneration,
        revision: latest.serialStateRevision,
        outcome: payload.status,
      });
      if (payload.status === "disconnected") {
        return true;
      }
      if (payload.status === "connected") {
        const failureMessage = `断开失败，当前仍保持连接：${message}`;
        set({
          connectionActionError: failureMessage,
          connectionMessage: failureMessage,
          statusMessage: failureMessage,
        });
        return false;
      }
      return false;
    } catch {
      // 无法读取真实状态时保留原始断开错误，避免用二次错误覆盖用户原因。
    }
    const latest = get();
    getSerialRecoveryCoordinator().recordDisconnectCommandFailure({
      generation: latest.serialGeneration,
      revision: latest.serialStateRevision,
      outcome: "state-unavailable",
    });
    set({
      connectionStatus: "error",
      connectionMessage: message,
      statusMessage: message,
      serialModemStatus: createUnavailableSerialModemStatus(get().serialGeneration),
      waveformTrigger: createIdleWaveformTriggerState(),
    });
    return false;
  }
}

async function applyWorkspaceSnapshot(
  id: string,
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  stopCurrentModbusPolling("workspace-change", false);
  await cancelActiveModbusTransaction(get);
  stopCurrentCommandWorkflows("workspace-change");
  await getSerialRecoveryCoordinator().cancel("workspace-change", true);
  const target = get().workspaces.find((workspace) => workspace.id === id);
  if (!target) {
    throw new Error("要应用的工作区不存在");
  }
  if (!(await closeCurrentReplay(get, set))) {
    set({ statusMessage: `关闭回放失败，未切换到“${target.name}”` });
    return false;
  }
  if (!(await stopCurrentRecordings(get, set))) {
    set({ statusMessage: `结束录制失败，未切换到“${target.name}”` });
    return false;
  }
  if (get().connectionStatus !== "disconnected") {
    const disconnected = await disconnectCurrentSource(get, set);
    if (!disconnected) {
      set({ statusMessage: `断开数据源失败，未切换到“${target.name}”` });
      return false;
    }
  }


  revokeExtensionForBoundary(
    get,
    set,
    "工作区已切换，扩展授权和会话已清除",
    true,
  );

  const latestTarget = get().workspaces.find((workspace) => workspace.id === id);
  if (!latestTarget) {
    throw new Error("要应用的工作区不存在");
  }
  const config = cloneWorkspaceConfig(latestTarget.config);
  const usesBrowserFallback = !get().isNativeRuntime && config.source === "serial";
  const source = usesBrowserFallback ? "simulator" : config.source;
  const processingGraph = configureProcessingGraph(config.processingGraph);
  resetProtocolState(config.protocol, config.terminalRxTextEncoding);
  set((state) => ({
    activeWorkspaceId: latestTarget.id,
    source,
    protocol: config.protocol,
    serialConfig: config.serialConfig,
    simulatorConfig: cloneSimulatorConfig(config.simulatorConfig),
    displayMode: config.displayMode,
    terminalPresentationOverride: null,
    sendMode: config.sendMode,
    lineEnding: config.lineEnding,
    commandChecksum: config.commandChecksum,
    terminalRxRecordMode: config.terminalRxRecordMode,
    terminalRxLineEnding: config.terminalRxLineEnding,
    terminalRxTextEncoding: config.terminalRxTextEncoding,
    terminalTxTextEncoding: config.terminalTxTextEncoding,
    quickCommands: config.quickCommands,
    terminalAutoScroll: config.terminalAutoScroll,
    chartWindowSeconds: config.chartWindowSeconds,
    channelVisibility: config.channelVisibility,
    channelPresentations: config.channelPresentations,
    processingGraph,
    processingStatus: liveProcessingRuntime.getSnapshot(),
    attitudeConfig: config.attitudeConfig,
    autoResponderRules: config.autoResponderRules,
    attitudeSample: null,
    channels: [],
    processedChannels: [],
    chartFrozenChannels: null,
    chartFrozenProcessedChannels: null,
    chartFrozenExtensionChannels: null,
    chartDataRevision: state.chartDataRevision + 1,
    terminalEntries: [],
    terminalPaused: false,
    chartPaused: false,
    waveformTrigger: createIdleWaveformTriggerState(),
    stats: emptyStats(),
    protocolHealth: protocolParser.getHealthSnapshot(),
    connectionStatus: "disconnected",
    connectionActionError: "",
    serialModemStatus: createUnavailableSerialModemStatus(state.serialGeneration),
    connectionMessage: usesBrowserFallback
      ? `“${latestTarget.name}”需要串口，浏览器预览已改用模拟器`
      : `工作区“${latestTarget.name}”已应用，等待连接`,
    statusMessage: usesBrowserFallback
      ? `“${latestTarget.name}”需要串口，浏览器预览已改用模拟器`
      : `工作区“${latestTarget.name}”已应用`,
  }));
  return true;
}

function configureProcessingGraph(config: ProcessingGraphConfig): ProcessingGraphConfig {
  const nextConfig = parseProcessingGraphConfig(config);
  const nextLiveRuntime = new ProcessingGraphRuntime(nextConfig);
  const nextReplayRuntime = new ProcessingGraphRuntime(nextConfig);
  liveProcessingRuntime = nextLiveRuntime;
  replayProcessingRuntime = nextReplayRuntime;
  processingChannelBuffers.clear();
  replayProcessingChannelBuffers.clear();
  return nextConfig;
}

function activeProcessingRuntime(state: WorkbenchStore): ProcessingGraphRuntime {
  return hasReplaySession(state) ? replayProcessingRuntime : liveProcessingRuntime;
}

function pruneDerivedChannelVisibility(
  visibility: Record<string, boolean>,
  graph: ProcessingGraphConfig,
): Record<string, boolean> {
  const outputChannelIds = new Set(
    graph.nodes
      .filter((node) => node.kind === "output")
      .map((node) => processingOutputChannelId(node.id)),
  );
  return Object.fromEntries(
    Object.entries(visibility).filter(
      ([channelId]) => !channelId.startsWith("derived:") || outputChannelIds.has(channelId),
    ),
  );
}

function ensureParser(protocol: ProtocolKind, encoding: TerminalRxTextEncoding): void {
  if (parserProtocol !== protocol) {
    resetProtocolState(protocol, encoding);
  } else {
    ensureLiveTerminalTextEncoding(encoding);
  }
}

function resetProtocolState(
  protocol: ProtocolKind,
  encoding: TerminalRxTextEncoding = terminalDecoderEncoding,
): void {
  parserProtocol = protocol;
  protocolParser = createProtocolParser(protocol);
  resetLiveTerminalPresentationState(encoding);
  channelBuffers.clear();
  processingChannelBuffers.clear();
  liveProcessingRuntime.reset();
}

function resetLiveStreamBoundary(protocol: ProtocolKind): void {
  parserProtocol = protocol;
  protocolParser = createProtocolParser(protocol);
  resetLiveTerminalPresentationState();
  liveProcessingRuntime.reset();
}

function resetLiveView(protocol: ProtocolKind, set: WorkbenchSet): void {
  resetProtocolState(protocol);
  set((state) => ({
    channels: [],
    processedChannels: [],
    extensionChannels: [],
    chartFrozenChannels: null,
    chartFrozenProcessedChannels: null,
    chartFrozenExtensionChannels: null,
    attitudeSample: null,
    chartDataRevision: state.chartDataRevision + 1,
    processingStatus: liveProcessingRuntime.getSnapshot(),
    terminalEntries: [],
    terminalPaused: false,
    chartPaused: false,
    waveformTrigger: createIdleWaveformTriggerState(),
    stats: emptyStats(),
    protocolHealth: protocolParser.getHealthSnapshot(),
  }));
}

function ensureReplayParser(protocol: ProtocolKind, encoding: TerminalRxTextEncoding): void {
  if (replayParserProtocol !== protocol) {
    resetReplayProtocolState(protocol, encoding);
  } else {
    ensureReplayTerminalTextEncoding(encoding);
  }
}

function resetReplayProtocolState(
  protocol: ProtocolKind,
  encoding: TerminalRxTextEncoding = replayRxDecoderEncoding,
): void {
  replayParserProtocol = protocol;
  replayProtocolParser = createProtocolParser(protocol);
  resetReplayTerminalPresentationState(encoding);
  replayChannelBuffers.clear();
  replayProcessingChannelBuffers.clear();
  replayProcessingRuntime.reset();
}

function resetReplayView(protocol: ProtocolKind, set: WorkbenchSet): void {
  resetReplayProtocolState(protocol);
  set((state) => ({
    channels: [],
    processedChannels: [],
    extensionChannels: [],
    chartFrozenChannels: null,
    chartFrozenProcessedChannels: null,
    chartFrozenExtensionChannels: null,
    attitudeSample: null,
    chartDataRevision: state.chartDataRevision + 1,
    processingStatus: replayProcessingRuntime.getSnapshot(),
    terminalEntries: [],
    terminalPaused: false,
    chartPaused: false,
    waveformTrigger: createIdleWaveformTriggerState(),
    stats: emptyStats(),
    replayProtocolHealth: replayProtocolParser.getHealthSnapshot(),
  }));
}

function ingestReplayBatch(
  state: WorkbenchStore,
  payload: ReplayBatchPayload,
): Partial<WorkbenchStore> {
  const header = state.replayHeader;
  if (!header) {
    return {};
  }
  ensureReplayParser(header.protocol, state.terminalRxTextEncoding);

  let channels = state.channels;
  let processedChannels = state.processedChannels;
  const processingFrames: ParsedFrame[] = [];
  const terminalEntries: TerminalEntry[] = [];
  let rxBytes = 0;
  let txBytes = 0;
  let rxFrames = 0;

  for (const record of payload.records) {
    const bytes = Uint8Array.from(record.data);
    const timestamp = header.startedAtUnixMs + record.timestampUs / 1_000;
    if (record.direction === "rx") {
      rxBytes += bytes.length;
      const frames = replayProtocolParser.push(bytes, timestamp);
      processingFrames.push(...frames);
      rxFrames += frames.length;
      if (!state.terminalPaused) {
        terminalEntries.push(
          ...createRxTerminalEntries(
            bytes,
            timestamp,
            selectEffectiveTerminalRxRecordMode(state),
            state.terminalRxLineEnding,
            replayRxLineAssembler,
            replayRxDecoder,
          ),
        );
      }
    } else {
      txBytes += bytes.length;
      if (!state.terminalPaused) {
        terminalEntries.push(
          createTerminalEntry(
            "tx",
            bytes,
            timestamp,
            replayTxDecoder.decode(bytes, { stream: true }),
          ),
        );
      }
    }
  }
  const chartFrameTimestamps = createChartFrameTimestamps(
    processingFrames,
    channels[0]?.points.at(-1)?.x,
  );
  const chartFrameSequences = createChartFrameSequences(processingFrames.length);
  channels = appendFrames(
    channels,
    processingFrames,
    state.channelVisibility,
    replayChannelBuffers,
    chartFrameTimestamps,
    chartFrameSequences,
  );
  const processedSamples = replayProcessingRuntime.process(processingFrames);
  const attitudeSample = extractRuntimeAttitudeSample(
    state.attitudeConfig,
    processingFrames,
    processedSamples,
  );
  processedChannels = appendProcessedSamples(
    processedChannels,
    processedSamples,
    state.channelVisibility,
    replayProcessingChannelBuffers,
    chartFrameTimestamps,
    chartFrameSequences,
  );

  return {
    channels,
    processedChannels,
    chartFrozenChannels: state.chartPaused
      ? (state.chartFrozenChannels ?? state.channels)
      : null,
    chartFrozenProcessedChannels: state.chartPaused
      ? (state.chartFrozenProcessedChannels ?? state.processedChannels)
      : null,
    chartFrozenExtensionChannels: state.chartPaused
      ? (state.chartFrozenExtensionChannels ?? state.extensionChannels)
      : null,
    processingStatus: replayProcessingRuntime.getSnapshot(),
    attitudeSample: attitudeSample ?? state.attitudeSample,
    terminalEntries:
      terminalEntries.length > 0
        ? appendManyBounded(state.terminalEntries, terminalEntries, MAX_TERMINAL_ENTRIES)
        : state.terminalEntries,
    stats: {
      ...state.stats,
      rxBytes: state.stats.rxBytes + rxBytes,
      txBytes: state.stats.txBytes + txBytes,
      rxFrames: state.stats.rxFrames + rxFrames,
      startedAt: state.stats.startedAt ?? Date.now(),
    },
    replayProtocolHealth: replayProtocolParser.getHealthSnapshot(),
    replayPositionUs: Math.max(state.replayPositionUs, payload.endUs),
    replayNextSequence: state.replayNextSequence + 1,
  };
}

function createChartFrameTimestamps(
  frames: readonly ParsedFrame[],
  previousTimestampSeconds: number | undefined,
): number[] {
  return createNondecreasingChartTimestamps(
    frames.map((frame) => frame.timestamp / 1_000),
    previousTimestampSeconds,
  );
}

function createNondecreasingChartTimestamps(
  timestamps: readonly number[],
  previousTimestampSeconds: number | undefined,
): number[] {
  let lastTimestamp = Number.isFinite(previousTimestampSeconds)
    ? (previousTimestampSeconds as number)
    : null;

  return timestamps.map((candidate) => {
    let timestamp = candidate;
    if (!Number.isFinite(timestamp)) {
      return timestamp;
    }
    if (lastTimestamp !== null && timestamp < lastTimestamp) {
      timestamp = lastTimestamp;
    }
    lastTimestamp = timestamp;
    return timestamp;
  });
}

function createChartFrameSequences(frameCount: number): number[] {
  return Array.from({ length: frameCount }, () => {
    chartFrameSequence += 1;
    return chartFrameSequence;
  });
}

function appendFrames(
  channels: ChannelSeries[],
  frames: ParsedFrame[],
  channelVisibility: Record<string, boolean>,
  buffers: Map<string, RingBuffer<DataPoint>> = channelBuffers,
  chartFrameTimestamps: readonly number[] = frames.map((frame) => frame.timestamp / 1_000),
  chartFrameSequences: readonly number[] = createChartFrameSequences(frames.length),
): ChannelSeries[] {
  if (frames.length === 0) {
    return channels;
  }

  const nextChannels = channels.map((channel) => ({ ...channel }));
  const updatedChannelIndexes = new Set<number>();
  for (const [frameIndex, frame] of frames.entries()) {
    const chartTimestamp = chartFrameTimestamps[frameIndex];
    if (chartTimestamp === undefined || !Number.isFinite(chartTimestamp)) {
      continue;
    }
    const channelCount = Math.min(frame.values.length, MAX_PROTOCOL_CHANNELS);
    for (let index = 0; index < channelCount; index += 1) {
      const value = frame.values[index];
      if (value === undefined || !Number.isFinite(value)) {
        continue;
      }

      const channelId = `channel-${index}`;
      let buffer = buffers.get(channelId);
      if (!buffer) {
        buffer = new RingBuffer<DataPoint>(MAX_POINTS_PER_CHANNEL);
        buffers.set(channelId, buffer);
      }
      buffer.push({
        x: chartTimestamp,
        y: value,
        frameSequence: chartFrameSequences[frameIndex],
      });

      const label = frame.labels?.[index]?.trim();
      const existing = nextChannels[index];
      if (existing) {
        if (label) {
          existing.name = label;
        }
        existing.lastValue = value;
      } else {
        nextChannels[index] = {
          id: channelId,
          name: label || `CH ${index + 1}`,
          color: CHANNEL_COLORS[index % CHANNEL_COLORS.length] ?? "#46d89c",
          visible: channelVisibility[channelId] ?? true,
          points: [],
          lastValue: value,
        };
      }
      updatedChannelIndexes.add(index);
    }
  }
  for (const index of updatedChannelIndexes) {
    const channel = nextChannels[index];
    const buffer = buffers.get(`channel-${index}`);
    if (channel && buffer) {
      channel.points = buffer.toArray();
    }
  }
  return nextChannels;
}

function appendExtensionFrames(
  channels: ChannelSeries[],
  payload: ExtensionBatchPayload,
  extensionId: string,
  visibility: Record<string, boolean>,
): ChannelSeries[] {
  if (payload.frames.length === 0) {
    return channels;
  }
  const nextChannels = channels.map((channel) => ({ ...channel }));
  const updatedIndexes = new Set<number>();
  const firstChannelId = `extension:${extensionId}:0`;
  const previousTimestamp = channels
    .find((channel) => channel.id === firstChannelId)
    ?.points.at(-1)?.x;
  const chartFrameTimestamps = createNondecreasingChartTimestamps(
    payload.frames.map(() => payload.receivedAt / 1_000),
    previousTimestamp,
  );
  const chartFrameSequences = createChartFrameSequences(payload.frames.length);
  for (const [frameIndex, frame] of payload.frames.entries()) {
    const chartTimestamp = chartFrameTimestamps[frameIndex];
    if (chartTimestamp === undefined || !Number.isFinite(chartTimestamp)) {
      continue;
    }
    for (const [channelIndex, value] of frame.values.entries()) {
      if (!Number.isFinite(value)) {
        continue;
      }
      const channelId = `extension:${extensionId}:${channelIndex}`;
      let buffer = extensionChannelBuffers.get(channelId);
      if (!buffer) {
        buffer = new RingBuffer<DataPoint>(MAX_POINTS_PER_CHANNEL);
        extensionChannelBuffers.set(channelId, buffer);
      }
      buffer.push({
        x: chartTimestamp,
        y: value,
        frameSequence: chartFrameSequences[frameIndex],
      });
      const label = frame.labels?.[channelIndex]?.trim();
      const existing = nextChannels[channelIndex];
      if (existing?.id === channelId) {
        existing.name = label || existing.name;
        existing.lastValue = value;
      } else {
        nextChannels[channelIndex] = {
          id: channelId,
          name: label || `EXT CH ${channelIndex + 1}`,
          color: CHANNEL_COLORS[(channelIndex + 3) % CHANNEL_COLORS.length] ?? "#f06d76",
          visible: visibility[channelId] ?? true,
          points: [],
          lastValue: value,
        };
      }
      updatedIndexes.add(channelIndex);
    }
  }
  for (const index of updatedIndexes) {
    const channel = nextChannels[index];
    const buffer = channel ? extensionChannelBuffers.get(channel.id) : undefined;
    if (channel && buffer) {
      channel.points = buffer.toArray();
    }
  }
  return nextChannels;
}

function advanceLiveWaveformTrigger(
  state: WaveformTriggerState,
  frames: readonly ParsedFrame[],
  processedSamples: readonly ProcessingOutputSample[],
): WaveformTriggerAdvanceResult {
  if ((state.phase !== "armed" && state.phase !== "triggered") || !state.config) {
    return { state, shouldFreeze: false };
  }
  const observations = createWaveformTriggerObservations(
    state.config.channelId,
    frames,
    processedSamples,
  );
  return advanceWaveformTrigger(state, observations, latestFrameTimestampSeconds(frames));
}

function createWaveformTriggerObservations(
  channelId: string,
  frames: readonly ParsedFrame[],
  processedSamples: readonly ProcessingOutputSample[],
): WaveformTriggerObservation[] {
  const baseChannelMatch = /^channel-(\d+)$/.exec(channelId);
  if (baseChannelMatch) {
    const channelIndex = Number(baseChannelMatch[1]);
    return frames.map((frame) => {
      const value = frame.values[channelIndex];
      return {
        timestampSeconds: frame.timestamp / 1_000,
        value: value !== undefined && Number.isFinite(value) ? value : null,
      };
    });
  }

  const sampleByFrameIndex = new Map<number, ProcessingOutputSample>();
  for (const sample of processedSamples) {
    if (sample.channelId === channelId) {
      sampleByFrameIndex.set(sample.frameIndex, sample);
    }
  }
  return frames.map((frame, frameIndex) => {
    const sample = sampleByFrameIndex.get(frameIndex);
    return {
      timestampSeconds: (sample?.timestamp ?? frame.timestamp) / 1_000,
      value: sample && Number.isFinite(sample.value) ? sample.value : null,
    };
  });
}

function latestFrameTimestampSeconds(frames: readonly ParsedFrame[]): number | null {
  let latestTimestamp: number | null = null;
  for (const frame of frames) {
    const timestampSeconds = frame.timestamp / 1_000;
    if (Number.isFinite(timestampSeconds)) {
      latestTimestamp = Math.max(latestTimestamp ?? timestampSeconds, timestampSeconds);
    }
  }
  return latestTimestamp;
}

function extractRuntimeAttitudeSample(
  config: AttitudeConfig,
  frames: readonly ParsedFrame[],
  processedSamples: readonly ProcessingOutputSample[],
): (AttitudeSample & { readonly receivedAt: number }) | null {
  const values: AttitudeChannelValue[] = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const channelCount = Math.min(frame.values.length, MAX_PROTOCOL_CHANNELS);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const value = frame.values[channelIndex];
      if (value !== undefined) {
        values.push({
          frameIndex,
          timestamp: frame.timestamp,
          channelId: `channel-${channelIndex}`,
          value,
        });
      }
    }
  }
  for (const sample of processedSamples) {
    values.push({
      frameIndex: sample.frameIndex,
      timestamp: sample.timestamp,
      channelId: sample.channelId,
      value: sample.value,
    });
  }
  const sample = extractLatestAttitudeSample(config, values);
  return sample ? { ...sample, receivedAt: Date.now() } : null;
}

function createNumericLogSamples(
  frames: readonly ParsedFrame[],
  processedSamples: readonly ProcessingOutputSample[],
  channels: readonly ChannelSeries[],
): NumericLogSample[] {
  const samples: NumericLogSample[] = [];
  const channelNames = channels.map((channel) => channel.name);
  for (const frame of frames) {
    const timestampUnixUs = toUnixMicroseconds(frame.timestamp);
    if (timestampUnixUs === null) {
      continue;
    }
    const channelCount = Math.min(frame.values.length, MAX_PROTOCOL_CHANNELS);
    for (let index = 0; index < channelCount; index += 1) {
      const value = frame.values[index];
      if (value === undefined || !Number.isFinite(value)) {
        continue;
      }
      const label = frame.labels?.[index]?.trim();
      if (label) {
        channelNames[index] = label;
      }
      samples.push({
        timestampUnixUs,
        channelKind: "base",
        channelId: `channel-${index}`,
        channelName: channelNames[index] || `CH ${index + 1}`,
        value,
      });
    }
  }

  for (const sample of processedSamples) {
    const timestampUnixUs = toUnixMicroseconds(sample.timestamp);
    if (timestampUnixUs === null || !Number.isFinite(sample.value)) {
      continue;
    }
    samples.push({
      timestampUnixUs,
      channelKind: "derived",
      channelId: sample.channelId,
      channelName: sample.name,
      value: sample.value,
    });
  }
  return samples;
}

function toUnixMicroseconds(timestampMs: number): number | null {
  const timestampUs = Math.round(timestampMs * 1_000);
  return Number.isSafeInteger(timestampUs) && timestampUs >= 0 ? timestampUs : null;
}

function appendProcessedSamples(
  channels: ChannelSeries[],
  samples: readonly ProcessingOutputSample[],
  channelVisibility: Record<string, boolean>,
  buffers: Map<string, RingBuffer<DataPoint>>,
  chartFrameTimestamps: readonly number[] = [],
  chartFrameSequences: readonly number[] = [],
): ChannelSeries[] {
  if (samples.length === 0) {
    return channels;
  }

  const nextChannels = channels.map((channel) => ({ ...channel }));
  const channelIndexes = new Map(
    nextChannels.map((channel, index) => [channel.id, index] as const),
  );
  const updatedChannelIds = new Set<string>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.value)) {
      continue;
    }
    let buffer = buffers.get(sample.channelId);
    if (!buffer) {
      buffer = new RingBuffer<DataPoint>(MAX_POINTS_PER_CHANNEL);
      buffers.set(sample.channelId, buffer);
    }
    buffer.push({
      x: chartFrameTimestamps[sample.frameIndex] ?? sample.timestamp / 1_000,
      y: sample.value,
      frameSequence: chartFrameSequences[sample.frameIndex],
    });

    const existingIndex = channelIndexes.get(sample.channelId);
    if (existingIndex === undefined) {
      channelIndexes.set(sample.channelId, nextChannels.length);
      nextChannels.push({
        id: sample.channelId,
        name: sample.name,
        color: sample.color,
        visible: channelVisibility[sample.channelId] ?? true,
        points: [],
        lastValue: sample.value,
      });
    } else {
      const existing = nextChannels[existingIndex];
      if (existing) {
        existing.name = sample.name;
        existing.color = sample.color;
        existing.lastValue = sample.value;
      }
    }
    updatedChannelIds.add(sample.channelId);
  }
  for (const channelId of updatedChannelIds) {
    const channelIndex = channelIndexes.get(channelId);
    const channel = channelIndex === undefined ? undefined : nextChannels[channelIndex];
    const buffer = buffers.get(channelId);
    if (channel && buffer) {
      channel.points = buffer.toArray();
    }
  }
  return nextChannels;
}

function createTerminalEntry(
  direction: TerminalEntry["direction"],
  bytes: Uint8Array,
  timestamp: number,
  text: string,
  rxBoundary?: TerminalEntry["rxBoundary"],
): TerminalEntry {
  const visibleBytes = bytes.slice(0, MAX_TERMINAL_BYTES_PER_ENTRY);
  const truncatedSuffix = bytes.length > visibleBytes.length ? " …" : "";
  const decodedText = text.slice(0, MAX_TERMINAL_BYTES_PER_ENTRY);
  terminalEntryId += 1;
  return {
    id: terminalEntryId,
    direction,
    timestamp,
    text: sanitizeText(decodedText) + truncatedSuffix,
    decodedText: decodedText + truncatedSuffix,
    hex: formatHex(visibleBytes) + truncatedSuffix,
    byteCount: bytes.length,
    ...(rxBoundary ? { rxBoundary } : {}),
  };
}

function appendTerminalSessionBoundary(
  terminalEntries: TerminalEntry[],
  message: string,
): TerminalEntry[] {
  const entry = createTerminalEntry("system", new Uint8Array(), Date.now(), message);
  return appendBounded(
    terminalEntries,
    { ...entry, sessionBoundary: true },
    MAX_TERMINAL_ENTRIES,
  );
}

function createRxTerminalEntries(
  bytes: Uint8Array,
  timestamp: number,
  recordMode: TerminalRxRecordMode,
  lineEnding: TerminalRxLineEnding,
  assembler: TerminalLineAssembler,
  decoder: TextDecoder,
): TerminalEntry[] {
  if (recordMode === "chunk") {
    return [
      createTerminalEntry(
        "rx",
        bytes,
        timestamp,
        decoder.decode(bytes, { stream: true }),
      ),
    ];
  }
  return assembler
    .push(bytes, timestamp, lineEnding)
    .map((line) => createTerminalEntryFromAssembledLine(line, decoder));
}

function createTerminalEntryFromAssembledLine(
  line: AssembledTerminalLine,
  decoder: TextDecoder,
): TerminalEntry {
  return createTerminalEntry(
    "rx",
    line.bytes,
    line.timestamp,
    decoder.decode(line.bytes, { stream: line.boundary === "overflow" }),
    line.boundary === "line" ? undefined : line.boundary,
  );
}

function settleActiveTerminalPresentation(state: WorkbenchStore): TerminalEntry[] {
  return settleTerminalPresentation(
    state,
    hasReplaySession(state) ? replayRxLineAssembler : terminalLineAssembler,
  );
}

function settleTerminalPresentation(
  state: WorkbenchStore,
  assembler: TerminalLineAssembler,
): TerminalEntry[] {
  const decoder = assembler === replayRxLineAssembler ? replayRxDecoder : terminalDecoder;
  let terminalEntries = state.terminalEntries;
  if (!state.terminalPaused && selectEffectiveTerminalRxRecordMode(state) === "line") {
    const line = assembler.flush();
    if (line) {
      terminalEntries = appendBounded(
        terminalEntries,
        createTerminalEntryFromAssembledLine(line, decoder),
        MAX_TERMINAL_ENTRIES,
      );
    }
  }
  return appendDecoderRemainder(terminalEntries, decoder.decode());
}

function appendDecoderRemainder(
  terminalEntries: TerminalEntry[],
  remainder: string,
): TerminalEntry[] {
  if (!remainder) {
    return terminalEntries;
  }
  for (let index = terminalEntries.length - 1; index >= 0; index -= 1) {
    const entry = terminalEntries[index];
    if (!entry || entry.direction !== "rx") {
      continue;
    }
    if (entry.text.endsWith(" …")) {
      return terminalEntries;
    }
    const nextEntries = [...terminalEntries];
    nextEntries[index] = {
      ...entry,
      text: entry.text + sanitizeText(remainder),
      decodedText: (entry.decodedText ?? entry.text) + remainder,
    };
    return nextEntries;
  }
  return terminalEntries;
}

function createTerminalTextDecoder(encoding: TerminalRxTextEncoding): TextDecoder {
  return new TextDecoder(encoding);
}

function ensureLiveTerminalTextEncoding(encoding: TerminalRxTextEncoding): void {
  if (terminalDecoderEncoding !== encoding) {
    resetLiveTerminalPresentationState(encoding);
  }
}

function ensureReplayTerminalTextEncoding(encoding: TerminalRxTextEncoding): void {
  if (replayRxDecoderEncoding !== encoding) {
    resetReplayRxTerminalPresentationState(encoding);
  }
}

function resetLiveTerminalPresentationState(
  encoding: TerminalRxTextEncoding = terminalDecoderEncoding,
): void {
  terminalDecoderEncoding = encoding;
  terminalDecoder = createTerminalTextDecoder(encoding);
  terminalLineAssembler.reset();
}

function resetReplayTerminalPresentationState(
  encoding: TerminalRxTextEncoding = replayRxDecoderEncoding,
): void {
  resetReplayRxTerminalPresentationState(encoding);
  replayTxDecoder = new TextDecoder();
}

function resetReplayRxTerminalPresentationState(
  encoding: TerminalRxTextEncoding = replayRxDecoderEncoding,
): void {
  replayRxDecoderEncoding = encoding;
  replayRxDecoder = createTerminalTextDecoder(encoding);
  replayRxLineAssembler.reset();
}

function resetRxTerminalPresentationState(
  encoding: TerminalRxTextEncoding = terminalDecoderEncoding,
): void {
  resetLiveTerminalPresentationState(encoding);
  resetReplayRxTerminalPresentationState(encoding);
}

function resetTerminalPresentationState(
  encoding: TerminalRxTextEncoding = terminalDecoderEncoding,
): void {
  resetLiveTerminalPresentationState(encoding);
  resetReplayTerminalPresentationState(encoding);
}

function sanitizeText(value: string): string {
  const escapedWhitespace = value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return Array.from(escapedWhitespace, (character) => {
    const code = character.charCodeAt(0);
    if ((code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
    return (code >= 0 && code <= 31) || code === 127 ? "·" : character;
  }).join("");
}

function appendBounded<T>(items: T[], item: T, limit: number): T[] {
  if (items.length < limit) {
    return [...items, item];
  }
  return [...items.slice(items.length - limit + 1), item];
}

function appendManyBounded<T>(items: T[], additions: T[], limit: number): T[] {
  if (additions.length >= limit) {
    return additions.slice(-limit);
  }
  const keep = Math.max(0, limit - additions.length);
  return [...items.slice(-keep), ...additions];
}

function replayStatusMessage(payload: ReplayStatePayload): string {
  if (payload.message) {
    return payload.message;
  }
  switch (payload.status) {
    case "loading":
      return "正在检查捕获文件";
    case "ready":
      return payload.complete ? "捕获文件已就绪" : "不完整捕获的有效记录已就绪";
    case "playing":
      return `正在以 ${formatReplaySpeed(payload.speed)} 速度回放`;
    case "paused":
      return "回放已暂停";
    case "seeking":
      return "正在定位回放";
    case "stopping":
      return "正在停止回放";
    case "completed":
      return "回放已完成";
    case "error":
      return "回放发生未知错误";
    case "idle":
      return "回放已关闭";
  }
}

function formatReplaySpeed(speed: ReplaySpeed): string {
  return `${speed}×`;
}

function emptyStats(): TransferStats {
  return { rxBytes: 0, txBytes: 0, rxFrames: 0 };
}

function restorePersistedWorkbenchState(
  persistedState: unknown,
  currentState: WorkbenchStore,
): WorkbenchStore {
  if (
    isRecord(persistedState) &&
    persistedState.workspaceStorageStatus === "newer-version" &&
    typeof persistedState.incompatibleStorageVersion === "number"
  ) {
    return {
      ...currentState,
      workspaceStorageStatus: "newer-version",
      incompatibleStorageVersion: persistedState.incompatibleStorageVersion,
      statusMessage: `检测到版本 ${persistedState.incompatibleStorageVersion} 的较新配置，已进入只读模式`,
    };
  }
  const fallbackConfig = captureWorkspaceConfig(currentState);
  const persistedConfig = restoreWorkspaceConfig(persistedState, fallbackConfig);
  const workspaces = restoreWorkspaceProfiles(
    isRecord(persistedState) ? persistedState.workspaces : undefined,
  );
  const restoredWorkspaces =
    workspaces.length > 0
      ? workspaces
      : [
          createWorkspaceProfile(
            "默认工作区",
            persistedConfig,
            DEFAULT_WORKSPACE_ID,
          ),
        ];
  const requestedActiveId = isRecord(persistedState)
    ? persistedState.activeWorkspaceId
    : undefined;
  const activeWorkspaceId =
    typeof requestedActiveId === "string" &&
    restoredWorkspaces.some((workspace) => workspace.id === requestedActiveId)
      ? requestedActiveId
      : restoredWorkspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
  const source =
    !currentState.isNativeRuntime && persistedConfig.source === "serial"
      ? "simulator"
      : persistedConfig.source;
  const processingGraph = configureProcessingGraph(persistedConfig.processingGraph);

  return {
    ...currentState,
    ...persistedConfig,
    source,
    displayMode: persistedConfig.displayMode,
    terminalPresentationOverride: null,
    processingGraph,
    processingStatus: liveProcessingRuntime.getSnapshot(),
    processedChannels: [],
    waveformTrigger: createIdleWaveformTriggerState(),
    workspaces: restoredWorkspaces,
    activeWorkspaceId,
    workspaceStorageStatus: "writable",
    incompatibleStorageVersion: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDeduplicatingStorage<S extends object>(
  supportedVersion: number,
): PersistStorage<S> {
  let previousValue: StorageValue<S> | null = null;
  let writesBlocked = false;
  return {
    getItem: (name) => {
      const serialized = localStorage.getItem(name);
      if (!serialized) {
        previousValue = null;
        return null;
      }
      try {
        const value = JSON.parse(serialized) as StorageValue<S>;
        previousValue = value;
        writesBlocked = value.version !== undefined && value.version > supportedVersion;
        return value;
      } catch {
        previousValue = null;
        writesBlocked = false;
        return null;
      }
    },
    setItem: (name, value) => {
      if (writesBlocked) {
        return;
      }
      if (
        previousValue?.version === value.version &&
        shallowObjectEqual(previousValue?.state, value.state)
      ) {
        return;
      }
      localStorage.setItem(name, JSON.stringify(value));
      previousValue = value;
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
      previousValue = null;
      writesBlocked = false;
    },
  };
}

function shallowObjectEqual(left: object | undefined, right: object): boolean {
  if (!left) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => leftRecord[key] === rightRecord[key])
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function protocolDisplayName(protocol: ProtocolKind): string {
  return getProtocolDefinition(protocol).displayName;
}

function dataSourceDisplayName(source: DataSource): string {
  return source === "serial" ? "串口" : "模拟器";
}

function serialStatusMessage(status: ConnectionStatus, portName: string): string {
  switch (status) {
    case "connected":
      return portName ? `${portName} 已连接` : "串口已连接";
    case "connecting":
      return portName ? `正在打开 ${portName}` : "正在打开串口";
    case "disconnected":
      return portName ? `${portName} 已断开` : "等待连接";
    case "error":
      return "串口发生未知错误";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
