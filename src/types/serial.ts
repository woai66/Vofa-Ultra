export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type DataSource = "serial" | "simulator";
export type ProtocolKind = "firewater" | "justfloat" | "raw";
export type DisplayMode = "text" | "hex";
export type LineEnding = "none" | "lf" | "crlf";

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

export interface SerialStatePayload {
  status: ConnectionStatus;
  portName: string;
  message?: string;
  generation: number;
  revision: number;
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
