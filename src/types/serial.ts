export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type DataSource = "serial" | "simulator";
export const PROTOCOL_IDS = ["firewater", "justfloat", "raw"] as const;
export type ProtocolKind = (typeof PROTOCOL_IDS)[number];
export type DisplayMode = "text" | "hex";
export type SerialControlLine = "dtr" | "rts";
export const LINE_ENDINGS = ["none", "lf", "cr", "crlf"] as const;
export const LEGACY_LINE_ENDINGS = ["none", "lf", "crlf"] as const;
export type LineEnding = (typeof LINE_ENDINGS)[number];
export type SerialErrorCode =
  | "invalid-config"
  | "open-failed"
  | "dtr-failed"
  | "rts-failed"
  | "worker-start-failed"
  | "read-failed"
  | "write-failed"
  | "worker-panic"
  | "unknown";
export type SerialControlLineCommandErrorCode =
  | "invalid-control-line"
  | "not-connected"
  | "connection-changed"
  | "modbus-busy"
  | "file-send-busy"
  | "control-line-busy"
  | "worker-stopped"
  | "rts-hardware-flow-control"
  | "operation-id-exhausted"
  | "queue-full"
  | "connection-lost"
  | "task-failed"
  | "state-lock-failed";
export type SerialControlLineErrorCode = SerialErrorCode | SerialControlLineCommandErrorCode;

export interface SerialControlLineErrorPayload {
  errorCode: SerialControlLineErrorCode;
  message: string;
}
export type SerialRecoveryPhase =
  | "off"
  | "idle"
  | "armed"
  | "waiting"
  | "scanning"
  | "connecting"
  | "blocked"
  | "exhausted";

export interface SerialPortInfo {
  name: string;
  kind: "usb" | "bluetooth" | "pci" | "unknown";
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
  vendorId?: number;
  productId?: number;
}

export interface SerialConfig {
  portName: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: "none" | "odd" | "even";
  stopBits: 1 | 2;
  flowControl: "none" | "software" | "hardware";
  dtr: boolean;
  rts: boolean;
}

export interface SerialDataPayload {
  data: string;
  receivedAt: number;
  generation: number;
}

export interface SerialTxPayload {
  data: string;
  byteCount: number;
  transmittedAt: number;
  generation: number;
}

export type SerialFileSendStatus =
  | "idle"
  | "queued"
  | "sending"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "error";

export interface SerialFileSendPayload {
  jobId: number;
  revision: number;
  generation: number;
  status: SerialFileSendStatus;
  fileName: string;
  totalBytes: number;
  transmittedBytes: number;
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  errorCode?: string;
  message: string;
}

export type SerialModbusTransactionStatus =
  | "waiting"
  | "completed"
  | "exception"
  | "timeout"
  | "cancelled"
  | "error";

export interface SerialModbusTransactionPayload {
  transactionId: number;
  status: SerialModbusTransactionStatus;
  request: string;
  response?: string;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  generation: number;
  errorCode?: string;
  exceptionCode?: number;
  message: string;
}

export interface SerialStatePayload {
  status: ConnectionStatus;
  portName: string;
  message?: string;
  errorCode?: SerialErrorCode;
  generation: number;
  revision: number;
}

export interface SerialReconnectTarget {
  kind: "usb";
  vendorId: number;
  productId: number;
  serialNumber: string;
}

export interface SerialRecoverySnapshot {
  enabled: boolean;
  phase: SerialRecoveryPhase;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt?: number;
  message: string;
  diagnosticEventCount: number;
  diagnosticDroppedEvents: number;
}

export interface SerialDiagnosticEvent {
  sequence: number;
  elapsedMs: number;
  kind: string;
  attempt?: number;
  delayMs?: number;
  generation?: number;
  revision?: number;
  errorCode?: string;
  candidateCount?: number;
  outcome?: string;
}

export interface SerialDiagnosticsReport {
  format: "vofa-ultra.serial-diagnostics";
  schemaVersion: 1;
  generatedAt: number;
  appVersion: string;
  connection: {
    status: ConnectionStatus;
    recoveryPhase: SerialRecoveryPhase;
    attempt: number;
    generation: number;
    revision: number;
  };
  serial: Omit<SerialConfig, "portName">;
  target?: {
    kind: "usb";
    vendorId: number;
    productId: number;
    serialPresent: true;
    matchPolicy: "usb-serial";
  };
  eventCount: number;
  droppedEvents: number;
  events: SerialDiagnosticEvent[];
}

export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  portName: "",
  baudRate: 115_200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
  dtr: true,
  rts: true,
};

export const BAUD_RATES = [
  1_200,
  2_400,
  4_800,
  9_600,
  19_200,
  38_400,
  57_600,
  115_200,
  230_400,
  460_800,
  921_600,
  1_000_000,
  2_000_000,
] as const;
