import { create, type StoreApi } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { decodeBase64, encodeOutbound, formatHex } from "../core/codec";
import {
  appendCommandHistory,
  CommandScheduler,
  commandHistoryPayloadBytes,
  createInitialCommandTaskSnapshot,
  type CommandTaskStopReason,
  type PreparedCommand,
} from "../core/commandWorkflow";
import {
  createProtocolParser,
  getProtocolDefinition,
  MAX_PROTOCOL_CHANNELS,
  protocolSupportsReplaySeek,
  type ProtocolParser,
} from "../core/protocols";
import { RingBuffer } from "../core/ringBuffer";
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
  restoreWorkspaceConfig,
  restoreWorkspaceProfiles,
} from "../core/workspaces";
import {
  abortCapture as abortCaptureClient,
  enqueueSimulatorCapture,
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
  cancelSerialConnect,
  connectSerial,
  disconnectSerial,
  isTauriRuntime,
  listSerialPorts,
  sendSerial,
} from "../services/serialClient";
import {
  ackReplayBatch as ackReplayBatchClient,
  closeReplay as closeReplayClient,
  openReplay as openReplayClient,
  pauseReplay as pauseReplayClient,
  playReplay as playReplayClient,
  selectReplayFilePath,
  seekReplay as seekReplayClient,
  stopReplay as stopReplayClient,
} from "../services/replayClient";
import type { CaptureStatePayload, CaptureUiStatus } from "../types/capture";
import type {
  CaptureExportDirection,
  CaptureExportFormat,
  CaptureExportStatePayload,
  CaptureExportUiStatus,
} from "../types/captureExport";
import type {
  ReplayBatchPayload,
  ReplayCaptureHeader,
  ReplayStatePayload,
  ReplayUiStatus,
} from "../types/replay";
import type {
  ConnectionStatus,
  DataSource,
  DisplayMode,
  LineEnding,
  ProtocolKind,
  SerialConfig,
  SerialDataPayload,
  SerialDiagnosticsReport,
  SerialPortInfo,
  SerialRecoverySnapshot,
  SerialStatePayload,
  SerialTxPayload,
} from "../types/serial";
import type {
  ChannelSeries,
  CommandHistoryEntry,
  CommandTaskSnapshot,
  DataPoint,
  ParsedFrame,
  TerminalEntry,
  TransferStats,
} from "../types/workbench";
import type {
  ChartWindowSeconds,
  WorkspaceExportV1,
  WorkspaceProfile,
} from "../types/workspace";

const MAX_POINTS_PER_CHANNEL = 2_000;
const MAX_TERMINAL_ENTRIES = 800;
const MAX_TERMINAL_BYTES_PER_ENTRY = 2_048;
const MAX_SEND_BYTES = 64 * 1024;
const WORKBENCH_STORAGE_VERSION = 1;
const APP_VERSION = "0.1.0";
const INITIAL_SERIAL_RECOVERY: SerialRecoverySnapshot = {
  enabled: false,
  phase: "off",
  attempt: 0,
  maxAttempts: SERIAL_RECOVERY_DELAYS_MS.length,
  message: "自动重连未启用",
  diagnosticEventCount: 0,
  diagnosticDroppedEvents: 0,
};
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
let terminalDecoder = new TextDecoder();
let terminalEntryId = 0;
const channelBuffers = new Map<string, RingBuffer<DataPoint>>();
let replayParserProtocol: ProtocolKind = "raw";
let replayProtocolParser: ProtocolParser = createProtocolParser(replayParserProtocol);
let replayRxDecoder = new TextDecoder();
let replayTxDecoder = new TextDecoder();
const replayChannelBuffers = new Map<string, RingBuffer<DataPoint>>();
let captureStopPromise: Promise<boolean> | null = null;
let serialRecoveryCoordinator: SerialReconnectCoordinator | null = null;
let serialConnectOperation = 0;
let serialRecoverySettingOperation = 0;
let commandScheduler: CommandScheduler | null = null;
let commandSendInFlight = false;
let captureExportDialogOperation = 0;

type RuntimeTransitionStatus =
  | "idle"
  | "switching-source"
  | "connecting"
  | "disconnecting"
  | "starting-capture"
  | "stopping-capture"
  | "selecting-replay"
  | "opening-replay"
  | "controlling-replay"
  | "switching-workspace";

export interface WorkbenchStore {
  isNativeRuntime: boolean;
  source: DataSource;
  protocol: ProtocolKind;
  connectionStatus: ConnectionStatus;
  serialGeneration: number;
  serialStateRevision: number;
  statusMessage: string;
  ports: SerialPortInfo[];
  isRefreshingPorts: boolean;
  serialConfig: SerialConfig;
  serialRecovery: SerialRecoverySnapshot;
  isCancellingSerialConnection: boolean;
  channels: ChannelSeries[];
  channelVisibility: Record<string, boolean>;
  terminalEntries: TerminalEntry[];
  displayMode: DisplayMode;
  sendMode: DisplayMode;
  lineEnding: LineEnding;
  commandHistory: CommandHistoryEntry[];
  commandTask: CommandTaskSnapshot;
  isSendingCommand: boolean;
  terminalPaused: boolean;
  terminalAutoScroll: boolean;
  chartPaused: boolean;
  chartWindowSeconds: ChartWindowSeconds;
  stats: TransferStats;
  workspaces: WorkspaceProfile[];
  activeWorkspaceId: string;
  workspaceTransitionStatus: "idle" | "switching" | "deleting";
  runtimeTransitionStatus: RuntimeTransitionStatus;
  workspaceStorageStatus: "writable" | "newer-version";
  incompatibleStorageVersion: number | null;
  captureStatus: CaptureUiStatus;
  captureSessionId: number;
  captureRevision: number;
  capturePath: string;
  captureStartedAt?: number;
  captureEndedAt?: number;
  captureDataBytes: number;
  captureRecordCount: number;
  captureMessage: string;
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
  replayComplete: boolean;
  replayPositionUs: number;
  replayDurationUs: number;
  replayDataBytes: number;
  replayRecordCount: number;
  replayNextSequence: number;
  replayMessage: string;
  setRuntimeAvailability(nativeRuntime: boolean): void;
  setSource(source: DataSource): Promise<void>;
  setProtocol(protocol: ProtocolKind): void;
  updateSerialConfig<K extends keyof SerialConfig>(key: K, value: SerialConfig[K]): void;
  refreshPorts(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<boolean>;
  setSerialRecoveryEnabled(enabled: boolean): Promise<void>;
  cancelSerialConnection(): Promise<void>;
  clearSerialDiagnostics(): void;
  getSerialDiagnostics(): SerialDiagnosticsReport;
  send(value: string, mode: DisplayMode, lineEnding: LineEnding): Promise<void>;
  startPeriodicSend(
    value: string,
    mode: DisplayMode,
    lineEnding: LineEnding,
    intervalMs: number,
    repeatCount: number | null,
  ): void;
  stopPeriodicSend(): void;
  clearCommandHistory(): void;
  ingestBytes(bytes: Uint8Array, timestamp?: number): void;
  handleSerialData(payload: SerialDataPayload): void;
  handleSerialState(payload: SerialStatePayload): void;
  handleSerialTx(payload: SerialTxPayload): void;
  setDisplayMode(mode: DisplayMode): void;
  setSendMode(mode: DisplayMode): void;
  setLineEnding(lineEnding: LineEnding): void;
  setTerminalPaused(paused: boolean): void;
  setTerminalAutoScroll(enabled: boolean): void;
  setChartPaused(paused: boolean): void;
  setChartWindowSeconds(seconds: ChartWindowSeconds): void;
  toggleChannel(channelId: string): void;
  clearTerminal(): void;
  clearChart(): void;
  resetStats(): void;
  startCapture(): Promise<boolean>;
  stopCapture(): Promise<boolean>;
  handleCaptureState(payload: CaptureStatePayload): void;
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
  stopReplay(): Promise<boolean>;
  closeReplay(): Promise<boolean>;
  handleReplayState(payload: ReplayStatePayload): void;
  handleReplayBatch(payload: ReplayBatchPayload): void;
  saveActiveWorkspace(name: string): void;
  saveWorkspaceAs(name: string): string;
  switchWorkspace(id: string): Promise<boolean>;
  deleteWorkspace(id: string): Promise<boolean>;
  importWorkspace(workspace: WorkspaceExportV1): string;
}

type PersistedWorkbenchState = Pick<
  WorkbenchStore,
  | "source"
  | "protocol"
  | "serialConfig"
  | "displayMode"
  | "sendMode"
  | "lineEnding"
  | "terminalAutoScroll"
  | "chartWindowSeconds"
  | "channelVisibility"
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
      statusMessage: "等待连接",
      ports: [],
      isRefreshingPorts: false,
      serialConfig: { ...INITIAL_WORKSPACE_CONFIG.serialConfig },
      serialRecovery: { ...INITIAL_SERIAL_RECOVERY },
      isCancellingSerialConnection: false,
      channels: [],
      channelVisibility: {},
      terminalEntries: [],
      displayMode: INITIAL_WORKSPACE_CONFIG.displayMode,
      sendMode: INITIAL_WORKSPACE_CONFIG.sendMode,
      lineEnding: INITIAL_WORKSPACE_CONFIG.lineEnding,
      commandHistory: [],
      commandTask: createInitialCommandTaskSnapshot(),
      isSendingCommand: false,
      terminalPaused: false,
      terminalAutoScroll: INITIAL_WORKSPACE_CONFIG.terminalAutoScroll,
      chartPaused: false,
      chartWindowSeconds: INITIAL_WORKSPACE_CONFIG.chartWindowSeconds,
      stats: emptyStats(),
      workspaces: [INITIAL_WORKSPACE],
      activeWorkspaceId: INITIAL_WORKSPACE.id,
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      incompatibleStorageVersion: null,
      captureStatus: "idle",
      captureSessionId: 0,
      captureRevision: 0,
      capturePath: "",
      captureDataBytes: 0,
      captureRecordCount: 0,
      captureMessage: "",
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
      replayComplete: false,
      replayPositionUs: 0,
      replayDurationUs: 0,
      replayDataBytes: 0,
      replayRecordCount: 0,
      replayNextSequence: 1,
      replayMessage: "",

      setRuntimeAvailability: (nativeRuntime) => {
        if (!nativeRuntime && get().isNativeRuntime) {
          stopCurrentCommandTask("source-change");
        }
        set((state) => ({
          isNativeRuntime: nativeRuntime,
          source: nativeRuntime ? state.source : "simulator",
          statusMessage: nativeRuntime ? state.statusMessage : "浏览器预览模式，仅使用模拟数据",
        }));
      },

      setSource: async (source) => {
        if (
          get().workspaceTransitionStatus !== "idle" ||
          get().runtimeTransitionStatus !== "idle" ||
          isCaptureActive(get().captureStatus) ||
          hasReplaySession(get())
        ) {
          return;
        }
        if (source === "serial" && !get().isNativeRuntime) {
          set({ statusMessage: "浏览器预览无法使用本机串口" });
          return;
        }
        if (source === get().source) {
          return;
        }
        stopCurrentCommandTask("source-change");
        if (!beginRuntimeTransition(get, set, "switching-source")) {
          return;
        }
        try {
          await getSerialRecoveryCoordinator().cancel("source-change", true);
          if (get().connectionStatus === "connected" || get().connectionStatus === "connecting") {
            const disconnected = await disconnectCurrentSource(get, set);
            if (!disconnected) {
              return;
            }
          }
          resetProtocolState(get().protocol);
          set({
            source,
            channels: [],
            connectionStatus: "disconnected",
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
          isRecoveryActivePhase(get().serialRecovery.phase) ||
          isCaptureActive(get().captureStatus) ||
          hasReplaySession(get())
        ) {
          return;
        }
        resetProtocolState(protocol);
        set({ protocol, channels: [], statusMessage: protocolDisplayName(protocol) + " 已启用" });
      },

      updateSerialConfig: (key, value) => {
        if (
          get().workspaceTransitionStatus !== "idle" ||
          get().runtimeTransitionStatus !== "idle" ||
          isRecoveryActivePhase(get().serialRecovery.phase) ||
          isCaptureActive(get().captureStatus) ||
          hasReplaySession(get())
        ) {
          return;
        }
        set((state) => ({
          serialConfig: { ...state.serialConfig, [key]: value },
        }));
      },

      refreshPorts: async () => {
        if (
          get().workspaceTransitionStatus !== "idle" ||
          get().runtimeTransitionStatus !== "idle" ||
          get().isRefreshingPorts ||
          isRecoveryActivePhase(get().serialRecovery.phase) ||
          hasReplaySession(get())
        ) {
          return;
        }
        if (!get().isNativeRuntime) {
          set({ statusMessage: "浏览器预览无法枚举本机串口" });
          return;
        }

        set({ isRefreshingPorts: true });
        try {
          const ports = await listSerialPorts();
          const currentPort = get().serialConfig.portName;
          const currentPortAvailable = ports.some((port) => port.name === currentPort);
          const selectedPort = currentPort || ports[0]?.name || "";
          set((state) => ({
            ports,
            isRefreshingPorts: false,
            serialConfig: { ...state.serialConfig, portName: selectedPort },
            statusMessage:
              currentPort && !currentPortAvailable
                ? `${currentPort} 当前不可用`
                : ports.length > 0
                  ? `发现 ${ports.length} 个串口设备`
                  : "未发现串口设备",
          }));
        } catch (error) {
          set({
            isRefreshingPorts: false,
            connectionStatus: "error",
            statusMessage: getErrorMessage(error),
          });
        }
      },

      connect: async () => {
        if (get().isCancellingSerialConnection) {
          return;
        }
        if (!beginRuntimeTransition(get, set, "connecting")) {
          return;
        }
        stopCurrentCommandTask("connection-change");
        const operation = ++serialConnectOperation;
        try {
          await getSerialRecoveryCoordinator().cancel("manual-connect", true);
          if (operation !== serialConnectOperation) {
            return;
          }
          const hadReplaySession = hasReplaySession(get());
          if (!(await closeCurrentReplay(get, set))) {
            set({ statusMessage: "关闭回放失败，未连接数据源" });
            return;
          }
          if (operation !== serialConnectOperation) {
            return;
          }
          if (hadReplaySession) {
            resetLiveView(get().protocol, set);
          }
          if (hasCaptureToStop(get()) && !(await stopCurrentCapture(get, set))) {
            set({ statusMessage: "结束录制失败，未连接数据源" });
            return;
          }
          if (operation !== serialConnectOperation) {
            return;
          }
          const state = get();
          if (state.workspaceTransitionStatus !== "idle") {
            return;
          }
          if (state.source === "simulator") {
            resetProtocolState(state.protocol);
            set({
              connectionStatus: "connected",
              statusMessage: "模拟数据正在运行",
              stats: { ...emptyStats(), startedAt: Date.now() },
            });
            return;
          }
          if (!state.serialConfig.portName) {
            set({ connectionStatus: "error", statusMessage: "请先选择串口设备" });
            return;
          }

          const selectedPort = state.ports.find(
            (port) => port.name === state.serialConfig.portName,
          );
          getSerialRecoveryCoordinator().prepareManualConnection(
            state.serialConfig,
            selectedPort,
          );
          set({
            connectionStatus: "connecting",
            statusMessage: `正在打开 ${state.serialConfig.portName}`,
          });
          try {
            const payload = await connectSerial(state.serialConfig);
            if (operation !== serialConnectOperation) {
              return;
            }
            get().handleSerialState(payload);
            set({ stats: { ...emptyStats(), startedAt: Date.now() } });
          } catch (error) {
            if (
              operation === serialConnectOperation &&
              get().connectionStatus === "connecting"
            ) {
              set({ connectionStatus: "error", statusMessage: getErrorMessage(error) });
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
        stopCurrentCommandTask("connection-change");
        try {
          await getSerialRecoveryCoordinator().cancel("manual-disconnect", true);
          if (!(await stopCurrentCapture(get, set))) {
            set({ statusMessage: "结束录制失败，未断开数据源" });
            return false;
          }
          return disconnectCurrentSource(get, set);
        } finally {
          endRuntimeTransition(get, set, "disconnecting");
        }
      },

      setSerialRecoveryEnabled: async (enabled) => {
        const operation = ++serialRecoverySettingOperation;
        const state = get();
        if (enabled && (!state.isNativeRuntime || state.source !== "serial")) {
          set({ statusMessage: "自动重连仅适用于桌面串口数据源" });
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
            set({ statusMessage: `取消串口连接失败：${getErrorMessage(error)}` });
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
          runtimeTransitionStatus:
            state.runtimeTransitionStatus === "connecting"
              ? "idle"
              : state.runtimeTransitionStatus,
          statusMessage: recoveryActive ? "正在取消自动重连" : "正在取消串口连接",
        });
        try {
          await getSerialRecoveryCoordinator().cancel("user-cancelled", true);
          if (manualConnecting && !recoveryWasConnecting) {
            await cancelPendingSerialConnection();
          } else if (!recoveryWasConnecting) {
            set({ statusMessage: "自动重连已取消" });
          }
        } catch (error) {
          set({ statusMessage: `取消串口连接失败：${getErrorMessage(error)}` });
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
          connectionStatus: state.connectionStatus,
          generation: state.serialGeneration,
          revision: state.serialStateRevision,
          serialConfig: state.serialConfig,
        });
      },

      send: async (value, mode, lineEnding) => {
        const bytes = encodeOutbound(value, mode, lineEnding);
        if (bytes.length === 0) {
          return;
        }
        assertCommandSize(bytes);
        await executePreparedCommand({ value, mode, lineEnding, bytes }, "manual", get, set);
      },

      startPeriodicSend: (value, mode, lineEnding, intervalMs, repeatCount) => {
        if (value.length === 0) {
          throw new Error("发送内容不能为空");
        }
        const bytes = encodeOutbound(value, mode, lineEnding);
        if (bytes.length === 0) {
          throw new Error("发送内容不能为空");
        }
        assertCommandSize(bytes);
        assertCommandCanStart(get());
        getCommandScheduler().start({
          value,
          mode,
          lineEnding,
          bytes,
          intervalMs,
          repeatCount,
        });
      },

      stopPeriodicSend: () => {
        stopCurrentCommandTask("user");
      },

      clearCommandHistory: () => {
        set({ commandHistory: [] });
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
        ensureParser(state.protocol);
        const frames = protocolParser.push(bytes, timestamp);
        const nextChannels = state.chartPaused
          ? state.channels
          : appendFrames(state.channels, frames, state.channelVisibility);
        const terminalEntry = state.terminalPaused
          ? null
          : createTerminalEntry("rx", bytes, timestamp, terminalDecoder.decode(bytes, { stream: true }));

        set({
          channels: nextChannels,
          terminalEntries: terminalEntry
            ? appendBounded(state.terminalEntries, terminalEntry, MAX_TERMINAL_ENTRIES)
            : state.terminalEntries,
          stats: {
            ...state.stats,
            rxBytes: state.stats.rxBytes + bytes.length,
            rxFrames: state.stats.rxFrames + frames.length,
            startedAt: state.stats.startedAt ?? timestamp,
          },
        });
      },

      handleSerialData: (payload) => {
        const state = get();
        if (
          hasReplaySession(state) ||
          state.source !== "serial" ||
          payload.generation !== state.serialGeneration
        ) {
          return;
        }
        get().ingestBytes(decodeBase64(payload.data), payload.receivedAt);
      },

      handleSerialState: (payload) => {
        const state = get();
        if (
          hasReplaySession(state) ||
          state.source !== "serial" ||
          payload.revision <= state.serialStateRevision
        ) {
          return;
        }
        if (payload.status !== "connected") {
          stopCurrentCommandTask("connection-lost");
        }
        const previousStatus = state.connectionStatus;
        if (payload.status === "error") {
          set({
            connectionStatus: "error",
            serialGeneration: payload.generation,
            serialStateRevision: payload.revision,
            statusMessage: payload.message ?? "串口发生未知错误",
          });
          const recoveryOwnsCaptureBoundary = getSerialRecoveryCoordinator().observeState(
            payload,
            previousStatus,
          );
          if (!recoveryOwnsCaptureBoundary && hasCaptureToStop(state)) {
            void stopCurrentCapture(get, set);
          }
          return;
        }
        set({
          connectionStatus: payload.status,
          serialGeneration: payload.generation,
          serialStateRevision: payload.revision,
          statusMessage:
            payload.message ?? serialStatusMessage(payload.status, payload.portName),
        });
        getSerialRecoveryCoordinator().observeState(payload, previousStatus);
        if (payload.status === "disconnected" && hasCaptureToStop(state)) {
          void stopCurrentCapture(get, set);
        }
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
              new TextDecoder().decode(bytes),
            );
        set({
          terminalEntries: entry
            ? appendBounded(state.terminalEntries, entry, MAX_TERMINAL_ENTRIES)
            : state.terminalEntries,
          stats: { ...state.stats, txBytes: state.stats.txBytes + payload.byteCount },
        });
      },

      setDisplayMode: (displayMode) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ displayMode });
        }
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
      setTerminalPaused: (terminalPaused) => set({ terminalPaused }),
      setTerminalAutoScroll: (terminalAutoScroll) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ terminalAutoScroll });
        }
      },
      setChartPaused: (chartPaused) => set({ chartPaused }),
      setChartWindowSeconds: (chartWindowSeconds) => {
        if (get().workspaceTransitionStatus === "idle") {
          set({ chartWindowSeconds });
        }
      },
      toggleChannel: (channelId) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        set((state) => {
          const channel = state.channels.find((candidate) => candidate.id === channelId);
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
          };
        });
      },
      clearTerminal: () => set({ terminalEntries: [] }),
      clearChart: () => {
        channelBuffers.clear();
        set({ channels: [] });
      },
      resetStats: () => set({ stats: emptyStats() }),
      startCapture: async () => {
        const state = get();
        if (
          state.workspaceTransitionStatus !== "idle" ||
          state.runtimeTransitionStatus !== "idle" ||
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
      handleCaptureState: (payload) => {
        if (payload.revision < get().captureRevision) {
          return;
        }
        set({
          captureStatus: payload.status,
          captureSessionId: payload.sessionId,
          captureRevision: payload.revision,
          capturePath: payload.path,
          captureStartedAt: payload.startedAtUnixMs,
          captureEndedAt: payload.endedAtUnixMs,
          captureDataBytes: payload.dataBytes,
          captureRecordCount: payload.recordCount,
          captureMessage: payload.message ?? "",
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
        stopCurrentCommandTask("replay-open");

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
        stopCurrentCommandTask("replay-open");

        try {
          await getSerialRecoveryCoordinator().cancel("replay-open", true);
          if (!(await stopCurrentCapture(get, set))) {
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
        set({ replayStatus: "starting", replayMessage: "正在启动 1× 回放" });
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
        if (timelineChanged && payload.header) {
          resetReplayView(payload.header.protocol, set);
        }
        set({
          replayStatus: payload.status,
          replaySessionId: payload.sessionId,
          replayGeneration: payload.generation,
          replayTimelineRevision: payload.timelineRevision,
          replayRevision: payload.revision,
          replayPath: payload.path,
          replayHeader: payload.header,
          replayComplete: payload.complete,
          replayPositionUs: keepLatestRunPosition
            ? Math.max(state.replayPositionUs, payload.positionUs)
            : payload.positionUs,
          replayDurationUs: payload.durationUs,
          replayDataBytes: payload.dataBytes,
          replayRecordCount: payload.recordCount,
          replayNextSequence: timelineChanged ? 1 : state.replayNextSequence,
          replayMessage: payload.message ?? "",
          statusMessage: replayStatusMessage(payload),
        });
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
          isCaptureTransitioning(state.captureStatus)
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
          isCaptureTransitioning(state.captureStatus)
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
      name: "vofa-ultra-workbench",
      version: WORKBENCH_STORAGE_VERSION,
      storage: createDeduplicatingStorage<PersistedWorkbenchState>(
        WORKBENCH_STORAGE_VERSION,
      ),
      partialize: (state) => ({
        source: state.source,
        protocol: state.protocol,
        serialConfig: state.serialConfig,
        displayMode: state.displayMode,
        sendMode: state.sendMode,
        lineEnding: state.lineEnding,
        terminalAutoScroll: state.terminalAutoScroll,
        chartWindowSeconds: state.chartWindowSeconds,
        channelVisibility: state.channelVisibility,
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
        if (version !== 0) {
          throw new Error(`不支持从持久化版本 ${version} 降级到 ${WORKBENCH_STORAGE_VERSION}`);
        }
        const config = restoreWorkspaceConfig(persistedState, INITIAL_WORKSPACE_CONFIG);
        const workspace = createWorkspaceProfile(
          "默认工作区",
          config,
          DEFAULT_WORKSPACE_ID,
        );
        return {
          ...(isRecord(persistedState) ? persistedState : {}),
          ...config,
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
        } as PersistedWorkbenchState;
      },
      merge: (persistedState, currentState) =>
        restorePersistedWorkbenchState(persistedState, currentState),
    },
  ),
);

export function disposeWorkbenchRuntime(): void {
  stopCurrentCommandTask("runtime-dispose");
  if (!serialRecoveryCoordinator) {
    return;
  }
  const state = useWorkbenchStore.getState();
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
      stopCurrentCapture(useWorkbenchStore.getState, useWorkbenchStore.setState),
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
      resetLiveStreamBoundary(state.protocol);
      useWorkbenchStore.setState({
        stats: { ...emptyStats(), startedAt: Date.now() },
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

export function selectIsWorkspaceDirty(state: WorkbenchStore): boolean {
  const activeWorkspace = selectActiveWorkspace(state);
  if (!activeWorkspace) {
    return true;
  }
  const savedConfig = cloneWorkspaceConfig(activeWorkspace.config);
  if (!state.isNativeRuntime && savedConfig.source === "serial") {
    savedConfig.source = "simulator";
  }
  return !areWorkspaceConfigsEqual(captureWorkspaceConfig(state), savedConfig);
}

function captureWorkspaceConfigForSave(state: WorkbenchStore) {
  const config = captureWorkspaceConfig(state);
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

function getCommandScheduler(): CommandScheduler {
  if (commandScheduler) {
    return commandScheduler;
  }

  commandScheduler = new CommandScheduler({
    now: Date.now,
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
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

function stopCurrentCommandTask(reason: CommandTaskStopReason): boolean {
  return commandScheduler?.stop(reason) ?? false;
}

function assertCommandCanStart(state: WorkbenchStore): void {
  assertCommandCanSend(state);
  if (commandSendInFlight || state.isSendingCommand) {
    throw new Error("请等待当前发送完成后再启动周期任务");
  }
  if (getCommandScheduler().isActive()) {
    throw new Error("已有发送任务正在运行或停止中");
  }
}

function assertCommandCanSend(state: WorkbenchStore): void {
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
}

function assertCommandSize(bytes: Uint8Array): void {
  if (bytes.length > MAX_SEND_BYTES) {
    throw new Error(`单次发送不能超过 ${MAX_SEND_BYTES / 1024} KiB，请拆分后重试`);
  }
}

async function executePreparedCommand(
  command: PreparedCommand,
  origin: "manual" | "scheduler",
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<void> {
  const state = get();
  assertCommandCanSend(state);
  assertCommandSize(command.bytes);
  if (origin === "manual" && getCommandScheduler().isActive()) {
    throw new Error("周期发送运行中，请先停止任务");
  }
  if (commandSendInFlight) {
    throw new Error("上一次发送尚未完成");
  }

  commandSendInFlight = true;
  set({ isSendingCommand: true });
  try {
    if (state.source === "serial") {
      await sendSerial(command.bytes);
    } else {
      get().handleSerialTx({
        data: bytesToBase64(command.bytes),
        byteCount: command.bytes.length,
        transmittedAt: Date.now(),
        generation: get().serialGeneration,
      });
    }
    const sentAt = Date.now();
    set((latest) => ({
      isSendingCommand: false,
      commandHistory: appendCommandHistory(latest.commandHistory, {
        value: command.value,
        mode: command.mode,
        lineEnding: command.lineEnding,
        payloadBytes: commandHistoryPayloadBytes(command.value),
        encodedBytes: command.bytes.length,
        sentAt,
      }),
    }));
  } catch (error) {
    set({ isSendingCommand: false });
    throw error;
  } finally {
    commandSendInFlight = false;
  }
}

function isCaptureTransitioning(status: CaptureUiStatus): boolean {
  return status === "starting" || status === "stopping";
}

function isCaptureActive(status: CaptureUiStatus): boolean {
  return status === "starting" || status === "recording" || status === "stopping";
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

async function prepareAndOpenReplay(
  path: string,
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  stopCurrentCommandTask("replay-open");
  if (!(await stopCurrentCapture(get, set))) {
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

  if (!hasReplaySession(get())) {
    set({ replayStatus: "loading" });
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
      serialGeneration: payload.generation,
      serialStateRevision: payload.revision,
      statusMessage: payload.message ?? serialStatusMessage(payload.status, payload.portName),
      runtimeTransitionStatus:
        state.runtimeTransitionStatus === "connecting"
          ? "idle"
          : state.runtimeTransitionStatus,
    });
    return;
  }
  state.handleSerialState(payload);
}

async function disconnectCurrentSource(
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  if (get().source === "simulator") {
    set({ connectionStatus: "disconnected", statusMessage: "模拟数据已停止" });
    return true;
  }

  try {
    const payload = await disconnectSerial();
    get().handleSerialState(payload);
    return payload.status === "disconnected";
  } catch (error) {
    set({ connectionStatus: "error", statusMessage: getErrorMessage(error) });
    return false;
  }
}

async function applyWorkspaceSnapshot(
  id: string,
  get: WorkbenchGet,
  set: WorkbenchSet,
): Promise<boolean> {
  stopCurrentCommandTask("workspace-change");
  await getSerialRecoveryCoordinator().cancel("workspace-change", true);
  const target = get().workspaces.find((workspace) => workspace.id === id);
  if (!target) {
    throw new Error("要应用的工作区不存在");
  }
  if (!(await closeCurrentReplay(get, set))) {
    set({ statusMessage: `关闭回放失败，未切换到“${target.name}”` });
    return false;
  }
  if (!(await stopCurrentCapture(get, set))) {
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

  const latestTarget = get().workspaces.find((workspace) => workspace.id === id);
  if (!latestTarget) {
    throw new Error("要应用的工作区不存在");
  }
  const config = cloneWorkspaceConfig(latestTarget.config);
  const usesBrowserFallback = !get().isNativeRuntime && config.source === "serial";
  resetProtocolState(config.protocol);
  set({
    activeWorkspaceId: latestTarget.id,
    source: usesBrowserFallback ? "simulator" : config.source,
    protocol: config.protocol,
    serialConfig: config.serialConfig,
    displayMode: config.displayMode,
    sendMode: config.sendMode,
    lineEnding: config.lineEnding,
    terminalAutoScroll: config.terminalAutoScroll,
    chartWindowSeconds: config.chartWindowSeconds,
    channelVisibility: config.channelVisibility,
    channels: [],
    terminalEntries: [],
    terminalPaused: false,
    chartPaused: false,
    stats: emptyStats(),
    connectionStatus: "disconnected",
    statusMessage: usesBrowserFallback
      ? `“${latestTarget.name}”需要串口，浏览器预览已改用模拟器`
      : `工作区“${latestTarget.name}”已应用`,
  });
  return true;
}

function ensureParser(protocol: ProtocolKind): void {
  if (parserProtocol !== protocol) {
    resetProtocolState(protocol);
  }
}

function resetProtocolState(protocol: ProtocolKind): void {
  parserProtocol = protocol;
  protocolParser = createProtocolParser(protocol);
  terminalDecoder = new TextDecoder();
  channelBuffers.clear();
}

function resetLiveStreamBoundary(protocol: ProtocolKind): void {
  parserProtocol = protocol;
  protocolParser = createProtocolParser(protocol);
  terminalDecoder = new TextDecoder();
}

function resetLiveView(protocol: ProtocolKind, set: WorkbenchSet): void {
  resetProtocolState(protocol);
  set({
    channels: [],
    terminalEntries: [],
    terminalPaused: false,
    chartPaused: false,
    stats: emptyStats(),
  });
}

function ensureReplayParser(protocol: ProtocolKind): void {
  if (replayParserProtocol !== protocol) {
    resetReplayProtocolState(protocol);
  }
}

function resetReplayProtocolState(protocol: ProtocolKind): void {
  replayParserProtocol = protocol;
  replayProtocolParser = createProtocolParser(protocol);
  replayRxDecoder = new TextDecoder();
  replayTxDecoder = new TextDecoder();
  replayChannelBuffers.clear();
}

function resetReplayView(protocol: ProtocolKind, set: WorkbenchSet): void {
  resetReplayProtocolState(protocol);
  set({
    channels: [],
    terminalEntries: [],
    terminalPaused: false,
    chartPaused: false,
    stats: emptyStats(),
  });
}

function ingestReplayBatch(
  state: WorkbenchStore,
  payload: ReplayBatchPayload,
): Partial<WorkbenchStore> {
  const header = state.replayHeader;
  if (!header) {
    return {};
  }
  ensureReplayParser(header.protocol);

  let channels = state.channels;
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
      rxFrames += frames.length;
      if (!state.chartPaused) {
        channels = appendFrames(
          channels,
          frames,
          state.channelVisibility,
          replayChannelBuffers,
        );
      }
      if (!state.terminalPaused) {
        terminalEntries.push(
          createTerminalEntry(
            "rx",
            bytes,
            timestamp,
            replayRxDecoder.decode(bytes, { stream: true }),
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

  return {
    channels,
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
    replayPositionUs: Math.max(state.replayPositionUs, payload.endUs),
    replayNextSequence: state.replayNextSequence + 1,
  };
}

function appendFrames(
  channels: ChannelSeries[],
  frames: ParsedFrame[],
  channelVisibility: Record<string, boolean>,
  buffers: Map<string, RingBuffer<DataPoint>> = channelBuffers,
): ChannelSeries[] {
  if (frames.length === 0) {
    return channels;
  }

  const nextChannels = channels.map((channel) => ({ ...channel }));
  for (const frame of frames) {
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
      buffer.push({ x: frame.timestamp / 1_000, y: value });

      const existing = nextChannels[index];
      const label = frame.labels?.[index]?.trim();
      nextChannels[index] = {
        id: channelId,
        name: label || existing?.name || `CH ${index + 1}`,
        color: existing?.color ?? CHANNEL_COLORS[index % CHANNEL_COLORS.length] ?? "#46d89c",
        visible: existing?.visible ?? channelVisibility[channelId] ?? true,
        points: buffer.toArray(),
        lastValue: value,
      };
    }
  }
  return nextChannels;
}

function createTerminalEntry(
  direction: TerminalEntry["direction"],
  bytes: Uint8Array,
  timestamp: number,
  text: string,
): TerminalEntry {
  const visibleBytes = bytes.slice(0, MAX_TERMINAL_BYTES_PER_ENTRY);
  const truncatedSuffix = bytes.length > visibleBytes.length ? " …" : "";
  terminalEntryId += 1;
  return {
    id: terminalEntryId,
    direction,
    timestamp,
    text: sanitizeText(text.slice(0, MAX_TERMINAL_BYTES_PER_ENTRY)) + truncatedSuffix,
    hex: formatHex(visibleBytes) + truncatedSuffix,
    byteCount: bytes.length,
  };
}

function sanitizeText(value: string): string {
  const escapedWhitespace = value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return Array.from(escapedWhitespace, (character) => {
    const code = character.charCodeAt(0);
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
      return "正在以 1× 速度回放";
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

  return {
    ...currentState,
    ...persistedConfig,
    source,
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
        writesBlocked =
          value.version !== undefined &&
          value.version !== 0 &&
          value.version !== supportedVersion;
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
