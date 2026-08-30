import type { DisplayMode, LineEnding } from "./serial";
import type { CommandChecksumMode } from "../core/checksum";

export const TERMINAL_RX_RECORD_MODES = ["chunk", "line"] as const;
export type TerminalRxRecordMode = (typeof TERMINAL_RX_RECORD_MODES)[number];
export const TERMINAL_RX_LINE_ENDINGS = ["lf", "crlf", "cr"] as const;
export type TerminalRxLineEnding = (typeof TERMINAL_RX_LINE_ENDINGS)[number];
export const TERMINAL_TEXT_ENCODINGS = ["utf-8", "gb18030", "windows-1252"] as const;
export type TerminalTextEncoding = (typeof TERMINAL_TEXT_ENCODINGS)[number];
export const TERMINAL_RX_TEXT_ENCODINGS = TERMINAL_TEXT_ENCODINGS;
export type TerminalRxTextEncoding = TerminalTextEncoding;

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
  frameSequence?: number;
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
  decodedText?: string;
  hex: string;
  byteCount: number;
  sessionBoundary?: boolean;
  rxBoundary?: "overflow" | "unterminated";
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
  checksumMode: CommandChecksumMode;
  textEncoding: TerminalTextEncoding;
  payloadBytes: number;
  encodedBytes: number;
  variableCount: number;
  sentAt: number;
  repeatCount: number;
}

export interface QuickCommand {
  id: string;
  name: string;
  template: string;
  mode: DisplayMode;
  lineEnding: LineEnding;
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
