import type { DataSource, ProtocolKind, SerialConfig } from "./serial";

export type CaptureStatus = "idle" | "recording" | "stopping" | "error";
export type CaptureUiStatus = CaptureStatus | "starting";
export type CaptureDirection = "rx" | "tx";
export const MAX_CAPTURE_MARKERS = 512;
export const MAX_CAPTURE_MARKER_LABEL_CHARS = 64;
export const MAX_CAPTURE_MARKER_LABEL_BYTES = 256;
export const CAPTURE_MARKER_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;
export type CaptureMarkerColor = (typeof CAPTURE_MARKER_COLORS)[number];

export interface CaptureStartRequest {
  source: DataSource;
  protocol: ProtocolKind;
  serialConfig: SerialConfig;
}

export interface CaptureStatePayload {
  status: CaptureStatus;
  sessionId: number;
  revision: number;
  formatVersion: number;
  path: string;
  startedAtUnixMs?: number;
  endedAtUnixMs?: number;
  dataBytes: number;
  recordCount: number;
  markerCount: number;
  message?: string;
}

export interface CaptureEventHandlers {
  onState(payload: CaptureStatePayload): void;
}
