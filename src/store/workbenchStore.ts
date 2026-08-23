import { create } from "zustand";
import { persist } from "zustand/middleware";
import { decodeBase64, encodeOutbound, formatHex } from "../core/codec";
import { createProtocolParser, type ProtocolParser } from "../core/protocols";
import { RingBuffer } from "../core/ringBuffer";
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
import { DEFAULT_SERIAL_CONFIG } from "../types/serial";
import type {
  ChannelSeries,
  DataPoint,
  ParsedFrame,
  TerminalEntry,
  TransferStats,
} from "../types/workbench";

const MAX_CHANNELS = 16;
const MAX_POINTS_PER_CHANNEL = 2_000;
const MAX_TERMINAL_ENTRIES = 800;
const MAX_TERMINAL_BYTES_PER_ENTRY = 2_048;
const MAX_SEND_BYTES = 64 * 1024;
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
  terminalEntries: TerminalEntry[];
  displayMode: DisplayMode;
  terminalPaused: boolean;
  terminalAutoScroll: boolean;
  chartPaused: boolean;
  chartWindowSeconds: number;
  stats: TransferStats;
  setRuntimeAvailability(nativeRuntime: boolean): void;
  setSource(source: DataSource): Promise<void>;
  setProtocol(protocol: ProtocolKind): void;
  updateSerialConfig<K extends keyof SerialConfig>(key: K, value: SerialConfig[K]): void;
  refreshPorts(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(value: string, mode: DisplayMode, lineEnding: LineEnding): Promise<void>;
  ingestBytes(bytes: Uint8Array, timestamp?: number): void;
  handleSerialData(payload: SerialDataPayload): void;
  handleSerialState(payload: SerialStatePayload): void;
  handleSerialTx(payload: SerialTxPayload): void;
  setDisplayMode(mode: DisplayMode): void;
  setTerminalPaused(paused: boolean): void;
  setTerminalAutoScroll(enabled: boolean): void;
  setChartPaused(paused: boolean): void;
  setChartWindowSeconds(seconds: number): void;
  toggleChannel(channelId: string): void;
  clearTerminal(): void;
  clearChart(): void;
  resetStats(): void;
}

export const useWorkbenchStore = create<WorkbenchStore>()(
  persist(
    (set, get) => ({
      isNativeRuntime: isTauriRuntime(),
      source: isTauriRuntime() ? "serial" : "simulator",
      protocol: "firewater",
      connectionStatus: "disconnected",
      serialGeneration: 0,
      serialStateRevision: 0,
      statusMessage: "等待连接",
      ports: [],
      isRefreshingPorts: false,
      serialConfig: DEFAULT_SERIAL_CONFIG,
      channels: [],
      terminalEntries: [],
      displayMode: "text",
      terminalPaused: false,
      terminalAutoScroll: true,
      chartPaused: false,
      chartWindowSeconds: 15,
      stats: emptyStats(),

      setRuntimeAvailability: (nativeRuntime) => {
        set((state) => ({
          isNativeRuntime: nativeRuntime,
          source: nativeRuntime ? state.source : "simulator",
          statusMessage: nativeRuntime ? state.statusMessage : "浏览器预览模式，仅使用模拟数据",
        }));
      },

      setSource: async (source) => {
        if (source === get().source) {
          return;
        }
        if (get().connectionStatus === "connected" || get().connectionStatus === "connecting") {
          await get().disconnect();
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
        resetProtocolState(protocol);
        set({ protocol, channels: [], statusMessage: protocolDisplayName(protocol) + " 已启用" });
      },

      updateSerialConfig: (key, value) => {
        set((state) => ({
          serialConfig: { ...state.serialConfig, [key]: value },
        }));
      },

      refreshPorts: async () => {
        if (!get().isNativeRuntime) {
          set({ statusMessage: "浏览器预览无法枚举本机串口" });
          return;
        }

        set({ isRefreshingPorts: true });
        try {
          const ports = await listSerialPorts();
          const currentPort = get().serialConfig.portName;
          const selectedPort = ports.some((port) => port.name === currentPort)
            ? currentPort
            : (ports[0]?.name ?? "");
          set((state) => ({
            ports,
            isRefreshingPorts: false,
            serialConfig: { ...state.serialConfig, portName: selectedPort },
            statusMessage: ports.length > 0 ? `发现 ${ports.length} 个串口设备` : "未发现串口设备",
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
        if (get().source === "simulator") {
          set({ connectionStatus: "disconnected", statusMessage: "模拟数据已停止" });
          return;
        }

        try {
          const payload = await disconnectSerial();
          get().handleSerialState(payload);
        } catch (error) {
          set({ connectionStatus: "error", statusMessage: getErrorMessage(error) });
        }
      },

      send: async (value, mode, lineEnding) => {
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
          : appendFrames(state.channels, frames);
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

      setDisplayMode: (displayMode) => set({ displayMode }),
      setTerminalPaused: (terminalPaused) => set({ terminalPaused }),
      setTerminalAutoScroll: (terminalAutoScroll) => set({ terminalAutoScroll }),
      setChartPaused: (chartPaused) => set({ chartPaused }),
      setChartWindowSeconds: (chartWindowSeconds) => set({ chartWindowSeconds }),
      toggleChannel: (channelId) => {
        set((state) => ({
          channels: state.channels.map((channel) =>
            channel.id === channelId ? { ...channel, visible: !channel.visible } : channel,
          ),
        }));
      },
      clearTerminal: () => set({ terminalEntries: [] }),
      clearChart: () => {
        channelBuffers.clear();
        set({ channels: [] });
      },
      resetStats: () => set({ stats: emptyStats() }),
    }),
    {
      name: "vofa-ultra-workbench",
      partialize: (state) => ({
        source: state.source,
        protocol: state.protocol,
        serialConfig: state.serialConfig,
        displayMode: state.displayMode,
        terminalAutoScroll: state.terminalAutoScroll,
        chartWindowSeconds: state.chartWindowSeconds,
      }),
    },
  ),
);

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

function appendFrames(channels: ChannelSeries[], frames: ParsedFrame[]): ChannelSeries[] {
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
        visible: existing?.visible ?? true,
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
