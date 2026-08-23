import { create, type StoreApi } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { decodeBase64, encodeOutbound, formatHex } from "../core/codec";
import { createProtocolParser, type ProtocolParser } from "../core/protocols";
import { RingBuffer } from "../core/ringBuffer";
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
  connectSerial,
  disconnectSerial,
  isTauriRuntime,
  listSerialPorts,
  sendSerial,
} from "../services/serialClient";
import type {
  ConnectionStatus,
  DataSource,
  DisplayMode,
  LineEnding,
  ProtocolKind,
  SerialConfig,
  SerialDataPayload,
  SerialPortInfo,
  SerialStatePayload,
  SerialTxPayload,
} from "../types/serial";
import type {
  ChannelSeries,
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

const MAX_CHANNELS = 16;
const MAX_POINTS_PER_CHANNEL = 2_000;
const MAX_TERMINAL_ENTRIES = 800;
const MAX_TERMINAL_BYTES_PER_ENTRY = 2_048;
const MAX_SEND_BYTES = 64 * 1024;
const WORKBENCH_STORAGE_VERSION = 1;
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
  channels: ChannelSeries[];
  channelVisibility: Record<string, boolean>;
  terminalEntries: TerminalEntry[];
  displayMode: DisplayMode;
  sendMode: DisplayMode;
  lineEnding: LineEnding;
  terminalPaused: boolean;
  terminalAutoScroll: boolean;
  chartPaused: boolean;
  chartWindowSeconds: ChartWindowSeconds;
  stats: TransferStats;
  workspaces: WorkspaceProfile[];
  activeWorkspaceId: string;
  workspaceTransitionStatus: "idle" | "switching" | "deleting";
  workspaceStorageStatus: "writable" | "newer-version";
  incompatibleStorageVersion: number | null;
  setRuntimeAvailability(nativeRuntime: boolean): void;
  setSource(source: DataSource): Promise<void>;
  setProtocol(protocol: ProtocolKind): void;
  updateSerialConfig<K extends keyof SerialConfig>(key: K, value: SerialConfig[K]): void;
  refreshPorts(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<boolean>;
  send(value: string, mode: DisplayMode, lineEnding: LineEnding): Promise<void>;
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
      channels: [],
      channelVisibility: {},
      terminalEntries: [],
      displayMode: INITIAL_WORKSPACE_CONFIG.displayMode,
      sendMode: INITIAL_WORKSPACE_CONFIG.sendMode,
      lineEnding: INITIAL_WORKSPACE_CONFIG.lineEnding,
      terminalPaused: false,
      terminalAutoScroll: INITIAL_WORKSPACE_CONFIG.terminalAutoScroll,
      chartPaused: false,
      chartWindowSeconds: INITIAL_WORKSPACE_CONFIG.chartWindowSeconds,
      stats: emptyStats(),
      workspaces: [INITIAL_WORKSPACE],
      activeWorkspaceId: INITIAL_WORKSPACE.id,
      workspaceTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      incompatibleStorageVersion: null,

      setRuntimeAvailability: (nativeRuntime) => {
        set((state) => ({
          isNativeRuntime: nativeRuntime,
          source: nativeRuntime ? state.source : "simulator",
          statusMessage: nativeRuntime ? state.statusMessage : "浏览器预览模式，仅使用模拟数据",
        }));
      },

      setSource: async (source) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        if (source === "serial" && !get().isNativeRuntime) {
          set({ statusMessage: "浏览器预览无法使用本机串口" });
          return;
        }
        if (source === get().source) {
          return;
        }
        if (get().connectionStatus === "connected" || get().connectionStatus === "connecting") {
          const disconnected = await get().disconnect();
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
      },

      setProtocol: (protocol) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        resetProtocolState(protocol);
        set({ protocol, channels: [], statusMessage: protocolDisplayName(protocol) + " 已启用" });
      },

      updateSerialConfig: (key, value) => {
        if (get().workspaceTransitionStatus !== "idle") {
          return;
        }
        set((state) => ({
          serialConfig: { ...state.serialConfig, [key]: value },
        }));
      },

      refreshPorts: async () => {
        if (get().workspaceTransitionStatus !== "idle" || get().isRefreshingPorts) {
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
        const state = get();
        if (state.workspaceTransitionStatus !== "idle") {
          return;
        }
        if (state.source === "simulator") {
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

        set({ connectionStatus: "connecting", statusMessage: `正在打开 ${state.serialConfig.portName}` });
        try {
          const payload = await connectSerial(state.serialConfig);
          get().handleSerialState(payload);
          set({ stats: { ...emptyStats(), startedAt: Date.now() } });
        } catch (error) {
          set({ connectionStatus: "error", statusMessage: getErrorMessage(error) });
        }
      },

      disconnect: async () => {
        if (get().workspaceTransitionStatus !== "idle") {
          return false;
        }
        return disconnectCurrentSource(get, set);
      },

      send: async (value, mode, lineEnding) => {
        if (get().workspaceTransitionStatus !== "idle") {
          throw new Error("工作区切换期间无法发送数据");
        }
        const bytes = encodeOutbound(value, mode, lineEnding);
        if (bytes.length === 0) {
          return;
        }
        if (bytes.length > MAX_SEND_BYTES) {
          throw new Error(`单次发送不能超过 ${MAX_SEND_BYTES / 1024} KiB，请拆分后重试`);
        }
        if (get().connectionStatus !== "connected") {
          throw new Error("请先连接数据源");
        }

        if (get().source === "serial") {
          await sendSerial(bytes);
        } else {
          get().handleSerialTx({
            data: bytesToBase64(bytes),
            byteCount: bytes.length,
            transmittedAt: Date.now(),
            generation: get().serialGeneration,
          });
        }
      },

      ingestBytes: (bytes, timestamp = Date.now()) => {
        const state = get();
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
        if (state.source !== "serial" || payload.generation !== state.serialGeneration) {
          return;
        }
        get().ingestBytes(decodeBase64(payload.data), payload.receivedAt);
      },

      handleSerialState: (payload) => {
        const state = get();
        if (state.source !== "serial" || payload.revision < state.serialStateRevision) {
          return;
        }
        if (payload.status === "error") {
          set({
            connectionStatus: "error",
            serialGeneration: payload.generation,
            serialStateRevision: payload.revision,
            statusMessage: payload.message ?? "串口发生未知错误",
          });
          return;
        }
        set({
          connectionStatus: payload.status,
          serialGeneration: payload.generation,
          serialStateRevision: payload.revision,
          statusMessage:
            payload.message ?? serialStatusMessage(payload.status, payload.portName),
        });
      },

      handleSerialTx: (payload) => {
        const state = get();
        if (state.source === "serial" && payload.generation !== state.serialGeneration) {
          return;
        }
        const bytes = decodeBase64(payload.data);
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
        if (state.workspaceTransitionStatus !== "idle" || state.isRefreshingPorts) {
          return false;
        }
        const target = state.workspaces.find((workspace) => workspace.id === id);
        if (!target) {
          throw new Error("要应用的工作区不存在");
        }
        set({ workspaceTransitionStatus: "switching" });
        try {
          return await applyWorkspaceSnapshot(id, get, set);
        } finally {
          set({ workspaceTransitionStatus: "idle" });
        }
      },
      deleteWorkspace: async (id) => {
        const state = get();
        if (state.workspaceTransitionStatus !== "idle" || state.isRefreshingPorts) {
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
  const target = get().workspaces.find((workspace) => workspace.id === id);
  if (!target) {
    throw new Error("要应用的工作区不存在");
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

function appendFrames(
  channels: ChannelSeries[],
  frames: ParsedFrame[],
  channelVisibility: Record<string, boolean>,
): ChannelSeries[] {
  if (frames.length === 0) {
    return channels;
  }

  const nextChannels = channels.map((channel) => ({ ...channel }));
  for (const frame of frames) {
    const channelCount = Math.min(frame.values.length, MAX_CHANNELS);
    for (let index = 0; index < channelCount; index += 1) {
      const value = frame.values[index];
      if (value === undefined || !Number.isFinite(value)) {
        continue;
      }

      const channelId = `channel-${index}`;
      let buffer = channelBuffers.get(channelId);
      if (!buffer) {
        buffer = new RingBuffer<DataPoint>(MAX_POINTS_PER_CHANNEL);
        channelBuffers.set(channelId, buffer);
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
  switch (protocol) {
    case "firewater":
      return "FireWater";
    case "justfloat":
      return "JustFloat";
    case "raw":
      return "Raw Data";
  }
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
