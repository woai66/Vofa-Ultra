import type { DataSource, ProtocolKind } from "./serial";

export type NumericLogStatus = "idle" | "recording" | "stopping" | "error";
export type NumericLogUiStatus = NumericLogStatus | "starting";
export type NumericLogChannelKind = "base" | "derived";

export interface NumericLogStartRequest {
  source: DataSource;
  protocol: ProtocolKind;
  destinationDirectory?: string;
}

export interface NumericLogSample {
  timestampUnixUs: number;
  channelKind: NumericLogChannelKind;
  channelId: string;
  channelName: string;
  value: number;
}

export interface NumericLogStatePayload {
  status: NumericLogStatus;
  sessionId: number;
  revision: number;
  path: string;
  startedAtUnixMs?: number;
  endedAtUnixMs?: number;
  outputBytes: number;
  sampleCount: number;
  message?: string;
}

export interface NumericLogEventHandlers {
  onState(payload: NumericLogStatePayload): void;
}
