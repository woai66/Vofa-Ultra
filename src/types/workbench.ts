export interface ParsedFrame {
  values: number[];
  labels?: string[];
  timestamp: number;
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
