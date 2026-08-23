import type { DataSource, ProtocolKind, SerialConfig } from "./serial";

export type CaptureStatus = "idle" | "recording" | "stopping" | "error";
export type CaptureUiStatus = CaptureStatus | "starting";
export type CaptureDirection = "rx" | "tx";

export interface CaptureStartRequest {
  source: DataSource;
  protocol: ProtocolKind;
  serialConfig: SerialConfig;
}

export interface CaptureStatePayload {
  status: CaptureStatus;
  sessionId: number;
  revision: number;
  path: string;
  startedAtUnixMs?: number;
  endedAtUnixMs?: number;
  dataBytes: number;
  recordCount: number;
  message?: string;
}

export interface CaptureEventHandlers {
  onState(payload: CaptureStatePayload): void;
}
