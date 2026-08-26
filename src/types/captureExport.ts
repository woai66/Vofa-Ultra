export type CaptureExportFormat = "csv" | "jsonl" | "binary";
export type CaptureExportDirection = "both" | "rx" | "tx";

export type CaptureExportStatus =
  | "idle"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "error";

export type CaptureExportUiStatus =
  | CaptureExportStatus
  | "selecting-source"
  | "selecting-destination"
  | "starting";

export type CaptureExportPhase =
  | "idle"
  | "preparing"
  | "reading"
  | "finalizing"
  | "committing"
  | "done";

export interface CaptureExportRequest {
  sourcePath: string;
  destinationPath: string;
  format: CaptureExportFormat;
  direction: CaptureExportDirection;
  allowIncomplete: boolean;
}

export interface CaptureExportStatePayload {
  status: CaptureExportStatus;
  phase: CaptureExportPhase;
  jobId: number;
  revision: number;
  sourcePath: string;
  destinationPath: string;
  format: CaptureExportFormat;
  direction: CaptureExportDirection;
  allowIncomplete: boolean;
  totalInputBytes: number;
  processedInputBytes: number;
  processedDataBytes: number;
  processedRecords: number;
  exportedDataBytes: number;
  exportedRecords: number;
  outputBytes: number;
  sourceComplete: boolean;
  startedAtUnixMs?: number;
  endedAtUnixMs?: number;
  message?: string;
}

export interface CaptureExportEventHandlers {
  onState(payload: CaptureExportStatePayload): void;
}
