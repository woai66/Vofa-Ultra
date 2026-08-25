import type {
  DataSource,
  DisplayMode,
  LineEnding,
  ProtocolKind,
  SerialConfig,
} from "./serial";
import type { ProcessingGraphConfig } from "./processingGraph";
import type { AttitudeConfig } from "./attitude";
import type { AutoResponderRule } from "./automation";
import type {
  QuickCommand,
  TerminalRxLineEnding,
  TerminalRxRecordMode,
  TerminalRxTextEncoding,
} from "./workbench";

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

export interface WorkspaceConfigV3 extends WorkspaceConfigV2 {
  attitudeConfig: AttitudeConfig;
}

export interface WorkspaceConfigV4 extends WorkspaceConfigV3 {
  autoResponderRules: AutoResponderRule[];
}

export interface WorkspaceConfigV5 extends WorkspaceConfigV4 {
  quickCommands: QuickCommand[];
}

export type WorkspaceConfigV6 = WorkspaceConfigV5;

export interface WorkspaceConfigV7 extends WorkspaceConfigV6 {
  terminalRxRecordMode: TerminalRxRecordMode;
  terminalRxLineEnding: TerminalRxLineEnding;
}

export interface WorkspaceConfigV8 extends WorkspaceConfigV7 {
  terminalRxTextEncoding: TerminalRxTextEncoding;
}

export type WorkspaceConfig = WorkspaceConfigV8;

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

export interface WorkspaceExportV3 {
  format: "vofa-ultra.workspace";
  schemaVersion: 3;
  name: string;
  config: WorkspaceConfigV3;
}

export interface WorkspaceExportV4 {
  format: "vofa-ultra.workspace";
  schemaVersion: 4;
  name: string;
  config: WorkspaceConfigV4;
}

export interface WorkspaceExportV5 {
  format: "vofa-ultra.workspace";
  schemaVersion: 5;
  name: string;
  config: WorkspaceConfigV5;
}

export interface WorkspaceExportV6 {
  format: "vofa-ultra.workspace";
  schemaVersion: 6;
  name: string;
  config: WorkspaceConfigV6;
}

export interface WorkspaceExportV7 {
  format: "vofa-ultra.workspace";
  schemaVersion: 7;
  name: string;
  config: WorkspaceConfigV7;
}

export interface WorkspaceExportV8 {
  format: "vofa-ultra.workspace";
  schemaVersion: 8;
  name: string;
  config: WorkspaceConfigV8;
}
