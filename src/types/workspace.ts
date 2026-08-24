import type {
  DataSource,
  DisplayMode,
  LineEnding,
  ProtocolKind,
  SerialConfig,
} from "./serial";
import type { ProcessingGraphConfig } from "./processingGraph";

export type ChartWindowSeconds = 5 | 15 | 30 | 60;

export interface WorkspaceConfigV1 {
  source: DataSource;
  protocol: ProtocolKind;
  serialConfig: SerialConfig;
  displayMode: DisplayMode;
  sendMode: DisplayMode;
  lineEnding: LineEnding;
  terminalAutoScroll: boolean;
  chartWindowSeconds: ChartWindowSeconds;
  channelVisibility: Record<string, boolean>;
}

export interface WorkspaceConfigV2 extends WorkspaceConfigV1 {
  processingGraph: ProcessingGraphConfig;
}

export type WorkspaceConfig = WorkspaceConfigV2;

export interface WorkspaceProfile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  config: WorkspaceConfig;
}

export interface WorkspaceExportV1 {
  format: "vofa-ultra.workspace";
  schemaVersion: 1;
  name: string;
  config: WorkspaceConfigV1;
}

export interface WorkspaceExportV2 {
  format: "vofa-ultra.workspace";
  schemaVersion: 2;
  name: string;
  config: WorkspaceConfigV2;
}
