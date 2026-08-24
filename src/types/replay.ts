import type { DataSource, ProtocolKind, SerialConfig } from "./serial";

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type ReplayStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "seeking"
  | "stopping"
  | "completed"
  | "error";

export type ReplayUiStatus =
  | ReplayStatus
  | "selecting"
  | "starting"
  | "pausing"
  | "closing";

export interface ReplayCaptureHeader {
  source: DataSource;
  protocol: ProtocolKind;
  serialConfig: SerialConfig;
  startedAtUnixMs: number;
  timeUnit: "microseconds";
}

export interface ReplayStatePayload {
  status: ReplayStatus;
  sessionId: number;
  generation: number;
  timelineRevision: number;
  revision: number;
  path: string;
  header?: ReplayCaptureHeader;
  complete: boolean;
  speed: ReplaySpeed;
  positionUs: number;
  durationUs: number;
  dataBytes: number;
  recordCount: number;
  message?: string;
}

export interface ReplayRecordPayload {
  direction: "rx" | "tx";
  timestampUs: number;
  data: number[];
}

export interface ReplayBatchPayload {
  sessionId: number;
  generation: number;
  sequence: number;
  startUs: number;
  endUs: number;
  dataBytes: number;
  records: ReplayRecordPayload[];
}

export interface ReplayEventHandlers {
  onState(payload: ReplayStatePayload): void;
  onBatch(payload: ReplayBatchPayload): void;
}
