import type { DisplayMode, LineEnding } from "./serial";

export interface ParsedFrame {
  values: number[];
  labels?: string[];
  timestamp: number;
}

export type ProtocolDropReason =
  | "unit-too-long"
  | "too-many-channels"
  | "invalid-format"
  | "invalid-label"
  | "non-finite-value"
  | "misaligned-length";

export interface ProtocolHealthSnapshot {
  readonly acceptedFrames: number;
  readonly droppedFrames: number;
  readonly resyncCount: number;
  readonly reasonCounts: Readonly<Record<ProtocolDropReason, number>>;
  readonly lastDropReason: ProtocolDropReason | null;
  readonly lastDropAt: number | null;
}

export interface DataPoint {
  x: number;
  y: number;
}

export interface ChannelSeries {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  points: DataPoint[];
  lastValue: number;
}

export interface TerminalEntry {
  id: number;
  direction: "rx" | "tx" | "system";
  timestamp: number;
  text: string;
  hex: string;
  byteCount: number;
}

export interface TransferStats {
  rxBytes: number;
  txBytes: number;
  rxFrames: number;
  startedAt?: number;
}

export interface CommandHistoryEntry {
  value: string;
  mode: DisplayMode;
  lineEnding: LineEnding;
  payloadBytes: number;
  encodedBytes: number;
  variableCount: number;
  sentAt: number;
  repeatCount: number;
}

export type CommandTaskStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "error";

export interface CommandTaskSnapshot {
  status: CommandTaskStatus;
  intervalMs: number;
  repeatCount: number | null;
  sentCount: number;
  message: string;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
}
