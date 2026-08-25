import {
  DEFAULT_SERIAL_CONFIG,
  LEGACY_LINE_ENDINGS,
  LINE_ENDINGS,
  PROTOCOL_IDS,
} from "../types/serial";
import {
  areAttitudeConfigsEqual,
  cloneAttitudeConfig,
  createDefaultAttitudeConfig,
  parseAttitudeConfig,
} from "./attitude";
import {
  cloneProcessingGraph,
  createDefaultProcessingGraph,
  parseProcessingGraphConfig,
  processingOutputChannelId,
} from "./processingGraph";
import {
  areAutoResponderRulesEqual,
  cloneAutoResponderRules,
  parseAutoResponderRules,
} from "./autoResponder";
import {
  areQuickCommandsEqual,
  cloneQuickCommands,
  parseQuickCommands,
} from "./quickCommands";
import {
  TERMINAL_RX_LINE_ENDINGS,
  TERMINAL_RX_RECORD_MODES,
  TERMINAL_RX_TEXT_ENCODINGS,
} from "../types/workbench";
import type {
  ChartWindowSeconds,
  WorkspaceConfig,
  WorkspaceConfigV1,
  WorkspaceConfigV2,
  WorkspaceConfigV3,
  WorkspaceConfigV4,
  WorkspaceConfigV5,
  WorkspaceConfigV6,
  WorkspaceConfigV7,
  WorkspaceConfigV8,
  WorkspaceExportV8,
  WorkspaceProfile,
} from "../types/workspace";
import type { AttitudeConfig } from "../types/attitude";
import type { ProcessingGraphConfig } from "../types/processingGraph";
import type { LineEnding } from "../types/serial";

export const WORKSPACE_FILE_FORMAT = "vofa-ultra.workspace";
export const WORKSPACE_SCHEMA_VERSION = 8;
export const WORKSPACE_READABLE_SCHEMA_VERSIONS = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  WORKSPACE_SCHEMA_VERSION,
] as const;
export const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACE_COUNT = 32;
export const MAX_WORKSPACE_NAME_LENGTH = 64;
export const DEFAULT_WORKSPACE_ID = "default";

const MAX_PORT_NAME_LENGTH = 256;
const MAX_WORKSPACE_ID_LENGTH = 128;
const WORKSPACE_CONFIG_V1_KEYS = [
  "source",
  "protocol",
  "serialConfig",
  "displayMode",
  "sendMode",
  "lineEnding",
  "terminalAutoScroll",
  "chartWindowSeconds",
  "channelVisibility",
] as const;
const WORKSPACE_CONFIG_V2_KEYS = [
  ...WORKSPACE_CONFIG_V1_KEYS,
  "processingGraph",
] as const;
const WORKSPACE_CONFIG_V3_KEYS = [...WORKSPACE_CONFIG_V2_KEYS, "attitudeConfig"] as const;
const WORKSPACE_CONFIG_V4_KEYS = [...WORKSPACE_CONFIG_V3_KEYS, "autoResponderRules"] as const;
const WORKSPACE_CONFIG_V5_KEYS = [...WORKSPACE_CONFIG_V4_KEYS, "quickCommands"] as const;
const WORKSPACE_CONFIG_V6_KEYS = WORKSPACE_CONFIG_V5_KEYS;
const WORKSPACE_CONFIG_V7_KEYS = [
  ...WORKSPACE_CONFIG_V6_KEYS,
  "terminalRxRecordMode",
  "terminalRxLineEnding",
] as const;
const WORKSPACE_CONFIG_V8_KEYS = [
  ...WORKSPACE_CONFIG_V7_KEYS,
  "terminalRxTextEncoding",
] as const;
const SERIAL_CONFIG_KEYS = [
  "portName",
  "baudRate",
  "dataBits",
  "parity",
  "stopBits",
  "flowControl",
  "dtr",
  "rts",
] as const;
const WORKSPACE_PROFILE_KEYS = ["id", "name", "createdAt", "updatedAt", "config"] as const;
const WORKSPACE_EXPORT_KEYS = ["format", "schemaVersion", "name", "config"] as const;
const RAW_CHANNEL_ID_PATTERN = /^channel-(?:[0-9]|1[0-5])$/;
const DERIVED_CHANNEL_ID_PATTERN = /^derived:[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CHART_WINDOWS: readonly ChartWindowSeconds[] = [5, 15, 30, 60];

export type WorkspaceConfigSource = WorkspaceConfig;

export function createDefaultWorkspaceConfig(source: WorkspaceConfig["source"]): WorkspaceConfig {
  return {
    source,
    protocol: "firewater",
    serialConfig: { ...DEFAULT_SERIAL_CONFIG },
    displayMode: "text",
    sendMode: "text",
    lineEnding: "none",
    terminalRxRecordMode: "chunk",
    terminalRxLineEnding: "lf",
    terminalRxTextEncoding: "utf-8",
    terminalAutoScroll: true,
    chartWindowSeconds: 15,
    channelVisibility: {},
    processingGraph: createDefaultProcessingGraph(),
    attitudeConfig: createDefaultAttitudeConfig(),
    autoResponderRules: [],
    quickCommands: [],
  };
}

export function captureWorkspaceConfig(state: WorkspaceConfigSource): WorkspaceConfig {
  return cloneWorkspaceConfig(state);
}

export function cloneWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  return {
    source: config.source,
    protocol: config.protocol,
    serialConfig: { ...config.serialConfig },
    displayMode: config.displayMode,
    sendMode: config.sendMode,
    lineEnding: config.lineEnding,
    terminalRxRecordMode: config.terminalRxRecordMode,
    terminalRxLineEnding: config.terminalRxLineEnding,
    terminalRxTextEncoding: config.terminalRxTextEncoding,
    terminalAutoScroll: config.terminalAutoScroll,
    chartWindowSeconds: config.chartWindowSeconds,
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: cloneAttitudeConfig(config.attitudeConfig),
    autoResponderRules: cloneAutoResponderRules(config.autoResponderRules),
    quickCommands: cloneQuickCommands(config.quickCommands),
  };
}

export function areWorkspaceConfigsEqual(
  left: WorkspaceConfig,
  right: WorkspaceConfig,
): boolean {
  const leftVisibility = Object.entries(left.channelVisibility).sort(([leftId], [rightId]) =>
    leftId.localeCompare(rightId),
  );
  const rightVisibility = Object.entries(right.channelVisibility).sort(([leftId], [rightId]) =>
    leftId.localeCompare(rightId),
  );

  return (
    left.source === right.source &&
    left.protocol === right.protocol &&
    left.serialConfig.portName === right.serialConfig.portName &&
    left.serialConfig.baudRate === right.serialConfig.baudRate &&
    left.serialConfig.dataBits === right.serialConfig.dataBits &&
    left.serialConfig.parity === right.serialConfig.parity &&
    left.serialConfig.stopBits === right.serialConfig.stopBits &&
    left.serialConfig.flowControl === right.serialConfig.flowControl &&
    left.serialConfig.dtr === right.serialConfig.dtr &&
    left.serialConfig.rts === right.serialConfig.rts &&
    left.displayMode === right.displayMode &&
    left.sendMode === right.sendMode &&
    left.lineEnding === right.lineEnding &&
    left.terminalRxRecordMode === right.terminalRxRecordMode &&
    left.terminalRxLineEnding === right.terminalRxLineEnding &&
    left.terminalRxTextEncoding === right.terminalRxTextEncoding &&
    left.terminalAutoScroll === right.terminalAutoScroll &&
    left.chartWindowSeconds === right.chartWindowSeconds &&
    JSON.stringify(leftVisibility) === JSON.stringify(rightVisibility) &&
    JSON.stringify(left.processingGraph) === JSON.stringify(right.processingGraph) &&
    areAttitudeConfigsEqual(left.attitudeConfig, right.attitudeConfig) &&
    areAutoResponderRulesEqual(left.autoResponderRules, right.autoResponderRules) &&
    areQuickCommandsEqual(left.quickCommands, right.quickCommands)
  );
}

export function validateWorkspaceName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error("工作区名称不能为空");
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new Error(`工作区名称不能超过 ${MAX_WORKSPACE_NAME_LENGTH} 个字符`);
  }
  if (containsControlCharacter(name)) {
    throw new Error("工作区名称不能包含控制字符");
  }
  return name;
}

export function createWorkspaceProfile(
  name: string,
  config: WorkspaceConfig,
  id = createWorkspaceId(),
  timestamp = Date.now(),
): WorkspaceProfile {
  return {
    id: validateWorkspaceId(id),
    name: validateWorkspaceName(name),
    createdAt: timestamp,
    updatedAt: timestamp,
    config: cloneWorkspaceConfig(config),
  };
}

export function createWorkspaceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeUniqueWorkspaceName(
  requestedName: string,
  workspaces: readonly WorkspaceProfile[],
): string {
  const baseName = validateWorkspaceName(requestedName);
  const usedNames = new Set(workspaces.map((workspace) => workspace.name.toLocaleLowerCase()));
  if (!usedNames.has(baseName.toLocaleLowerCase())) {
    return baseName;
  }

  for (let suffix = 2; suffix <= MAX_WORKSPACE_COUNT + 1; suffix += 1) {
    const suffixText = ` (${suffix})`;
    const candidate = `${baseName.slice(0, MAX_WORKSPACE_NAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  throw new Error("无法生成唯一的工作区名称");
}

export function assertWorkspaceNameAvailable(
  name: string,
  workspaces: readonly WorkspaceProfile[],
  exceptId?: string,
): string {
  const validatedName = validateWorkspaceName(name);
  const duplicate = workspaces.some(
    (workspace) =>
      workspace.id !== exceptId &&
      workspace.name.toLocaleLowerCase() === validatedName.toLocaleLowerCase(),
  );
  if (duplicate) {
    throw new Error(`工作区“${validatedName}”已存在`);
  }
  return validatedName;
}

export function serializeWorkspace(profile: WorkspaceProfile): string {
  const exported: WorkspaceExportV8 = {
    format: WORKSPACE_FILE_FORMAT,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: profile.name,
    config: cloneWorkspaceConfig(profile.config),
  };
  const serialized = `${JSON.stringify(exported, null, 2)}\n`;
  assertWorkspaceFileSize(serialized);
  return serialized;
}

export function parseWorkspaceExport(text: string): WorkspaceExportV8 {
  assertWorkspaceFileSize(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("工作区文件不是有效的 JSON");
  }

  const record = requireRecord(parsed, "工作区文件");
  if (record.format !== WORKSPACE_FILE_FORMAT) {
    throw new Error("这不是 Vofa-Ultra 工作区文件");
  }
  if (!isReadableWorkspaceSchemaVersion(record.schemaVersion)) {
    throw new Error(`不支持工作区 schema 版本：${String(record.schemaVersion)}`);
  }
  assertExactKeys(record, WORKSPACE_EXPORT_KEYS, "工作区文件");
  const config = parseVersionedWorkspaceConfig(record.schemaVersion, record.config);

  return {
    format: WORKSPACE_FILE_FORMAT,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: validateWorkspaceName(requireString(record.name, "工作区名称")),
    config,
  };
}

function assertWorkspaceFileSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(`工作区文件不能超过 ${MAX_WORKSPACE_FILE_BYTES / 1024} KiB`);
  }
}

export function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  return parseWorkspaceConfigWithLineEndings(value, LINE_ENDINGS);
}

function parseWorkspaceConfigWithLineEndings(
  value: unknown,
  allowedLineEndings: readonly LineEnding[],
): WorkspaceConfigV8 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V8_KEYS, "工作区配置");
  return {
    ...parseWorkspaceConfigV7Record(record, allowedLineEndings),
    terminalRxTextEncoding: requireEnum(
      record.terminalRxTextEncoding,
      TERMINAL_RX_TEXT_ENCODINGS,
      "接收文本编码",
    ),
  };
}

function parseWorkspaceConfigV7(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LINE_ENDINGS,
): WorkspaceConfigV7 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V7_KEYS, "工作区配置");
  return parseWorkspaceConfigV7Record(record, allowedLineEndings);
}

function parseWorkspaceConfigV7Record(
  record: Record<string, unknown>,
  allowedLineEndings: readonly LineEnding[],
): WorkspaceConfigV7 {
  const processingGraph = parseProcessingGraphConfig(record.processingGraph);
  const attitudeConfig = parseAttitudeConfig(record.attitudeConfig);
  assertAttitudeChannelsMatchGraph(attitudeConfig, processingGraph);
  const autoResponderRules = parseAutoResponderRules(
    record.autoResponderRules,
    allowedLineEndings,
  );
  const quickCommands = parseQuickCommands(record.quickCommands, allowedLineEndings);
  const config = parseWorkspaceConfigBase(record, processingGraph, allowedLineEndings);

  return {
    ...config,
    processingGraph,
    attitudeConfig,
    autoResponderRules,
    quickCommands,
    terminalRxRecordMode: requireEnum(
      record.terminalRxRecordMode,
      TERMINAL_RX_RECORD_MODES,
      "接收记录方式",
    ),
    terminalRxLineEnding: requireEnum(
      record.terminalRxLineEnding,
      TERMINAL_RX_LINE_ENDINGS,
      "接收行尾",
    ),
  };
}

function parseWorkspaceConfigV5(value: unknown): WorkspaceConfigV5 {
  return parseWorkspaceConfigV6(value, LEGACY_LINE_ENDINGS);
}

function parseWorkspaceConfigV6(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LINE_ENDINGS,
): WorkspaceConfigV6 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V6_KEYS, "工作区配置");
  const processingGraph = parseProcessingGraphConfig(record.processingGraph);
  const attitudeConfig = parseAttitudeConfig(record.attitudeConfig);
  assertAttitudeChannelsMatchGraph(attitudeConfig, processingGraph);
  return {
    ...parseWorkspaceConfigBase(record, processingGraph, allowedLineEndings),
    processingGraph,
    attitudeConfig,
    autoResponderRules: parseAutoResponderRules(record.autoResponderRules, allowedLineEndings),
    quickCommands: parseQuickCommands(record.quickCommands, allowedLineEndings),
  };
}

function parseWorkspaceConfigV4(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LEGACY_LINE_ENDINGS,
): WorkspaceConfigV4 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V4_KEYS, "工作区配置");
  const processingGraph = parseProcessingGraphConfig(record.processingGraph);
  const attitudeConfig = parseAttitudeConfig(record.attitudeConfig);
  assertAttitudeChannelsMatchGraph(attitudeConfig, processingGraph);
  return {
    ...parseWorkspaceConfigBase(record, processingGraph, allowedLineEndings),
    processingGraph,
    attitudeConfig,
    autoResponderRules: parseAutoResponderRules(record.autoResponderRules, allowedLineEndings),
  };
}

function parseWorkspaceConfigV3(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LEGACY_LINE_ENDINGS,
): WorkspaceConfigV3 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V3_KEYS, "工作区配置");
  const processingGraph = parseProcessingGraphConfig(record.processingGraph);
  const attitudeConfig = parseAttitudeConfig(record.attitudeConfig);
  assertAttitudeChannelsMatchGraph(attitudeConfig, processingGraph);
  return {
    ...parseWorkspaceConfigBase(record, processingGraph, allowedLineEndings),
    processingGraph,
    attitudeConfig,
  };
}

function parseWorkspaceConfigV2(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LEGACY_LINE_ENDINGS,
): WorkspaceConfigV2 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V2_KEYS, "工作区配置");
  const processingGraph = parseProcessingGraphConfig(record.processingGraph);
  return {
    ...parseWorkspaceConfigBase(record, processingGraph, allowedLineEndings),
    processingGraph,
  };
}

function parseWorkspaceConfigV1(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LEGACY_LINE_ENDINGS,
): WorkspaceConfigV1 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_V1_KEYS, "工作区配置");
  return parseWorkspaceConfigBase(record, createDefaultProcessingGraph(), allowedLineEndings);
}

function parseWorkspaceConfigBase(
  record: Record<string, unknown>,
  processingGraph: ProcessingGraphConfig,
  allowedLineEndings: readonly LineEnding[],
): WorkspaceConfigV1 {
  const serialConfig = requireRecord(record.serialConfig, "串口配置");
  assertExactKeys(serialConfig, SERIAL_CONFIG_KEYS, "串口配置");

  return {
    source: requireEnum(record.source, ["serial", "simulator"], "数据源"),
    protocol: requireEnum(record.protocol, PROTOCOL_IDS, "协议"),
    serialConfig: parseSerialConfig(serialConfig),
    displayMode: requireEnum(record.displayMode, ["text", "hex"], "接收显示格式"),
    sendMode: requireEnum(record.sendMode, ["text", "hex"], "发送格式"),
    lineEnding: requireEnum(record.lineEnding, allowedLineEndings, "行尾"),
    terminalAutoScroll: requireBoolean(record.terminalAutoScroll, "终端自动滚动"),
    chartWindowSeconds: requireChartWindow(record.chartWindowSeconds),
    channelVisibility: parseChannelVisibility(record.channelVisibility, processingGraph),
  };
}

function migrateWorkspaceConfigV1(config: WorkspaceConfigV1): WorkspaceConfigV2 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: createDefaultProcessingGraph(),
  };
}

function migrateWorkspaceConfigV2(config: WorkspaceConfigV2): WorkspaceConfigV3 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: createDefaultAttitudeConfig(),
  };
}

function migrateWorkspaceConfigV3(config: WorkspaceConfigV3): WorkspaceConfigV4 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: cloneAttitudeConfig(config.attitudeConfig),
    autoResponderRules: [],
  };
}

function migrateWorkspaceConfigV4(config: WorkspaceConfigV4): WorkspaceConfigV5 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: cloneAttitudeConfig(config.attitudeConfig),
    autoResponderRules: cloneAutoResponderRules(config.autoResponderRules),
    quickCommands: [],
  };
}

function migrateWorkspaceConfigV5(config: WorkspaceConfigV5): WorkspaceConfigV6 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: cloneAttitudeConfig(config.attitudeConfig),
    autoResponderRules: cloneAutoResponderRules(config.autoResponderRules),
    quickCommands: cloneQuickCommands(config.quickCommands),
  };
}

function migrateWorkspaceConfigV6(config: WorkspaceConfigV6): WorkspaceConfigV7 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: cloneAttitudeConfig(config.attitudeConfig),
    autoResponderRules: cloneAutoResponderRules(config.autoResponderRules),
    quickCommands: cloneQuickCommands(config.quickCommands),
    terminalRxRecordMode: "chunk",
    terminalRxLineEnding: "lf",
  };
}

function migrateWorkspaceConfigV7(config: WorkspaceConfigV7): WorkspaceConfigV8 {
  return {
    ...config,
    serialConfig: { ...config.serialConfig },
    channelVisibility: { ...config.channelVisibility },
    processingGraph: cloneProcessingGraph(config.processingGraph),
    attitudeConfig: cloneAttitudeConfig(config.attitudeConfig),
    autoResponderRules: cloneAutoResponderRules(config.autoResponderRules),
    quickCommands: cloneQuickCommands(config.quickCommands),
    terminalRxTextEncoding: "utf-8",
  };
}

function parseVersionedWorkspaceConfig(version: unknown, value: unknown): WorkspaceConfig {
  if (version === 1) {
    return migrateWorkspaceConfigV7(
      migrateWorkspaceConfigV6(
        migrateWorkspaceConfigV5(
          migrateWorkspaceConfigV4(
            migrateWorkspaceConfigV3(
              migrateWorkspaceConfigV2(migrateWorkspaceConfigV1(parseWorkspaceConfigV1(value))),
            ),
          ),
        ),
      ),
    );
  }
  if (version === 2) {
    return migrateWorkspaceConfigV7(
      migrateWorkspaceConfigV6(
        migrateWorkspaceConfigV5(
          migrateWorkspaceConfigV4(
            migrateWorkspaceConfigV3(migrateWorkspaceConfigV2(parseWorkspaceConfigV2(value))),
          ),
        ),
      ),
    );
  }
  if (version === 3) {
    return migrateWorkspaceConfigV7(
      migrateWorkspaceConfigV6(
        migrateWorkspaceConfigV5(
          migrateWorkspaceConfigV4(migrateWorkspaceConfigV3(parseWorkspaceConfigV3(value))),
        ),
      ),
    );
  }
  if (version === 4) {
    return migrateWorkspaceConfigV7(
      migrateWorkspaceConfigV6(
        migrateWorkspaceConfigV5(migrateWorkspaceConfigV4(parseWorkspaceConfigV4(value))),
      ),
    );
  }
  if (version === 5) {
    return migrateWorkspaceConfigV7(
      migrateWorkspaceConfigV6(migrateWorkspaceConfigV5(parseWorkspaceConfigV5(value))),
    );
  }
  if (version === 6) {
    return migrateWorkspaceConfigV7(migrateWorkspaceConfigV6(parseWorkspaceConfigV6(value)));
  }
  if (version === 7) {
    return migrateWorkspaceConfigV7(parseWorkspaceConfigV7(value));
  }
  if (version === WORKSPACE_SCHEMA_VERSION) {
    return parseWorkspaceConfig(value);
  }
  throw new Error(`不支持工作区 schema 版本：${String(version)}`);
}

function isReadableWorkspaceSchemaVersion(
  value: unknown,
): value is (typeof WORKSPACE_READABLE_SCHEMA_VERSIONS)[number] {
  return WORKSPACE_READABLE_SCHEMA_VERSIONS.some((version) => version === value);
}

export function restoreWorkspaceConfig(
  value: unknown,
  fallback: WorkspaceConfig,
  allowedLineEndings: readonly LineEnding[] = LINE_ENDINGS,
): WorkspaceConfig {
  const record = isRecord(value) ? value : {};
  const serialConfig = isRecord(record.serialConfig) ? record.serialConfig : {};
  const processingGraph = tryParseProcessingGraph(record.processingGraph) ??
    cloneProcessingGraph(fallback.processingGraph);
  const attitudeConfig =
    tryParseAttitudeConfig(record.attitudeConfig, processingGraph) ??
    cloneAttitudeConfig(fallback.attitudeConfig);
  const autoResponderRules =
    tryParseAutoResponderRules(record.autoResponderRules, allowedLineEndings) ??
    cloneAutoResponderRules(fallback.autoResponderRules);
  const quickCommands =
    tryParseQuickCommands(record.quickCommands, allowedLineEndings) ??
    cloneQuickCommands(fallback.quickCommands);
  return {
    source: isEnum(record.source, ["serial", "simulator"]) ? record.source : fallback.source,
    protocol: isEnum(record.protocol, PROTOCOL_IDS)
      ? record.protocol
      : fallback.protocol,
    serialConfig: {
      portName: isPortName(serialConfig.portName)
        ? serialConfig.portName
        : fallback.serialConfig.portName,
      baudRate: isBaudRate(serialConfig.baudRate)
        ? serialConfig.baudRate
        : fallback.serialConfig.baudRate,
      dataBits: isEnum(serialConfig.dataBits, [5, 6, 7, 8])
        ? serialConfig.dataBits
        : fallback.serialConfig.dataBits,
      parity: isEnum(serialConfig.parity, ["none", "odd", "even"])
        ? serialConfig.parity
        : fallback.serialConfig.parity,
      stopBits: isEnum(serialConfig.stopBits, [1, 2])
        ? serialConfig.stopBits
        : fallback.serialConfig.stopBits,
      flowControl: isEnum(serialConfig.flowControl, ["none", "software", "hardware"])
        ? serialConfig.flowControl
        : fallback.serialConfig.flowControl,
      dtr: typeof serialConfig.dtr === "boolean" ? serialConfig.dtr : fallback.serialConfig.dtr,
      rts: typeof serialConfig.rts === "boolean" ? serialConfig.rts : fallback.serialConfig.rts,
    },
    displayMode: isEnum(record.displayMode, ["text", "hex"])
      ? record.displayMode
      : fallback.displayMode,
    sendMode: isEnum(record.sendMode, ["text", "hex"]) ? record.sendMode : fallback.sendMode,
    lineEnding: isEnum(record.lineEnding, allowedLineEndings)
      ? record.lineEnding
      : fallback.lineEnding,
    terminalRxRecordMode: isEnum(record.terminalRxRecordMode, TERMINAL_RX_RECORD_MODES)
      ? record.terminalRxRecordMode
      : fallback.terminalRxRecordMode,
    terminalRxLineEnding: isEnum(record.terminalRxLineEnding, TERMINAL_RX_LINE_ENDINGS)
      ? record.terminalRxLineEnding
      : fallback.terminalRxLineEnding,
    terminalRxTextEncoding: isEnum(record.terminalRxTextEncoding, TERMINAL_RX_TEXT_ENCODINGS)
      ? record.terminalRxTextEncoding
      : fallback.terminalRxTextEncoding,
    terminalAutoScroll:
      typeof record.terminalAutoScroll === "boolean"
        ? record.terminalAutoScroll
        : fallback.terminalAutoScroll,
    chartWindowSeconds: isChartWindow(record.chartWindowSeconds)
      ? record.chartWindowSeconds
      : fallback.chartWindowSeconds,
    channelVisibility: tryParseChannelVisibility(record.channelVisibility, processingGraph) ?? {
      ...fallback.channelVisibility,
    },
    processingGraph,
    attitudeConfig,
    autoResponderRules,
    quickCommands,
  };
}

export function restoreWorkspaceProfiles(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LINE_ENDINGS,
): WorkspaceProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const workspaces: WorkspaceProfile[] = [];
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  for (const candidate of value.slice(0, MAX_WORKSPACE_COUNT)) {
    try {
      const profile = parseWorkspaceProfile(candidate, allowedLineEndings);
      const normalizedName = profile.name.toLocaleLowerCase();
      if (usedIds.has(profile.id) || usedNames.has(normalizedName)) {
        continue;
      }
      usedIds.add(profile.id);
      usedNames.add(normalizedName);
      workspaces.push(profile);
    } catch {
      // 损坏的本地快照不能阻止工作台启动，其余条目仍可恢复。
    }
  }
  return workspaces;
}

function parseWorkspaceProfile(
  value: unknown,
  allowedLineEndings: readonly LineEnding[],
): WorkspaceProfile {
  const record = requireRecord(value, "工作区快照");
  assertExactKeys(record, WORKSPACE_PROFILE_KEYS, "工作区快照");
  const createdAt = requireTimestamp(record.createdAt, "创建时间");
  const updatedAt = requireTimestamp(record.updatedAt, "更新时间");
  if (updatedAt < createdAt) {
    throw new Error("工作区更新时间早于创建时间");
  }
  const configRecord = requireRecord(record.config, "工作区配置");
  const config = Object.hasOwn(configRecord, "terminalRxTextEncoding")
    ? parseWorkspaceConfigWithLineEndings(configRecord, allowedLineEndings)
    : Object.hasOwn(configRecord, "terminalRxRecordMode")
      ? migrateWorkspaceConfigV7(parseWorkspaceConfigV7(configRecord, allowedLineEndings))
    : Object.hasOwn(configRecord, "quickCommands")
      ? migrateWorkspaceConfigV7(
          migrateWorkspaceConfigV6(parseWorkspaceConfigV6(configRecord, allowedLineEndings)),
        )
    : Object.hasOwn(configRecord, "autoResponderRules")
      ? migrateWorkspaceConfigV7(
          migrateWorkspaceConfigV6(
            migrateWorkspaceConfigV5(
              migrateWorkspaceConfigV4(parseWorkspaceConfigV4(configRecord, allowedLineEndings)),
            ),
          ),
        )
      : Object.hasOwn(configRecord, "attitudeConfig")
        ? migrateWorkspaceConfigV7(
            migrateWorkspaceConfigV6(
              migrateWorkspaceConfigV5(
                migrateWorkspaceConfigV4(
                  migrateWorkspaceConfigV3(
                    parseWorkspaceConfigV3(configRecord, allowedLineEndings),
                  ),
                ),
              ),
            ),
          )
      : Object.hasOwn(configRecord, "processingGraph")
      ? migrateWorkspaceConfigV7(
          migrateWorkspaceConfigV6(
            migrateWorkspaceConfigV5(
              migrateWorkspaceConfigV4(
                migrateWorkspaceConfigV3(
                  migrateWorkspaceConfigV2(
                    parseWorkspaceConfigV2(configRecord, allowedLineEndings),
                  ),
                ),
              ),
            ),
          ),
        )
      : migrateWorkspaceConfigV7(
          migrateWorkspaceConfigV6(
            migrateWorkspaceConfigV5(
              migrateWorkspaceConfigV4(
                migrateWorkspaceConfigV3(
                  migrateWorkspaceConfigV2(
                    migrateWorkspaceConfigV1(
                      parseWorkspaceConfigV1(configRecord, allowedLineEndings),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
  return {
    id: validateWorkspaceId(requireString(record.id, "工作区 ID")),
    name: validateWorkspaceName(requireString(record.name, "工作区名称")),
    createdAt,
    updatedAt,
    config,
  };
}

function parseSerialConfig(record: Record<string, unknown>) {
  return {
    portName: requirePortName(record.portName),
    baudRate: requireBaudRate(record.baudRate),
    dataBits: requireEnum(record.dataBits, [5, 6, 7, 8], "数据位"),
    parity: requireEnum(record.parity, ["none", "odd", "even"], "校验位"),
    stopBits: requireEnum(record.stopBits, [1, 2], "停止位"),
    flowControl: requireEnum(
      record.flowControl,
      ["none", "software", "hardware"],
      "流控",
    ),
    dtr: requireBoolean(record.dtr, "DTR"),
    rts: requireBoolean(record.rts, "RTS"),
  };
}

function parseChannelVisibility(
  value: unknown,
  processingGraph = createDefaultProcessingGraph(),
): Record<string, boolean> {
  const parsed = tryParseChannelVisibility(value, processingGraph);
  if (!parsed) {
    throw new Error("通道显隐配置无效");
  }
  return parsed;
}

function tryParseChannelVisibility(
  value: unknown,
  processingGraph = createDefaultProcessingGraph(),
): Record<string, boolean> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > 32) {
    return null;
  }
  const derivedChannelIds = new Set(
    processingGraph.nodes
      .filter((node) => node.kind === "output")
      .map((node) => processingOutputChannelId(node.id)),
  );
  const visibility: Record<string, boolean> = {};
  for (const [channelId, visible] of entries) {
    const knownChannel =
      RAW_CHANNEL_ID_PATTERN.test(channelId) ||
      (DERIVED_CHANNEL_ID_PATTERN.test(channelId) && derivedChannelIds.has(channelId));
    if (!knownChannel || typeof visible !== "boolean") {
      return null;
    }
    if (!visible) {
      visibility[channelId] = false;
    }
  }
  return visibility;
}

function tryParseProcessingGraph(value: unknown) {
  try {
    return parseProcessingGraphConfig(value);
  } catch {
    return null;
  }
}

function tryParseAttitudeConfig(
  value: unknown,
  processingGraph: ProcessingGraphConfig,
): AttitudeConfig | null {
  try {
    const attitudeConfig = parseAttitudeConfig(value);
    assertAttitudeChannelsMatchGraph(attitudeConfig, processingGraph);
    return attitudeConfig;
  } catch {
    return null;
  }
}

function tryParseAutoResponderRules(
  value: unknown,
  allowedLineEndings: readonly LineEnding[],
) {
  try {
    return parseAutoResponderRules(value, allowedLineEndings);
  } catch {
    return null;
  }
}

function tryParseQuickCommands(value: unknown, allowedLineEndings: readonly LineEnding[]) {
  try {
    return parseQuickCommands(value, allowedLineEndings);
  } catch {
    return null;
  }
}

export function pruneAttitudeConfigForGraph(
  config: AttitudeConfig,
  processingGraph: ProcessingGraphConfig,
): AttitudeConfig {
  const nextConfig = cloneAttitudeConfig(config);
  const derivedChannelIds = processingOutputChannelIds(processingGraph);
  for (const key of Object.keys(nextConfig.channels) as (keyof AttitudeConfig["channels"])[]) {
    const channelId = nextConfig.channels[key];
    if (channelId.startsWith("derived:") && !derivedChannelIds.has(channelId)) {
      nextConfig.channels[key] = "";
    }
  }
  return nextConfig;
}

function assertAttitudeChannelsMatchGraph(
  config: AttitudeConfig,
  processingGraph: ProcessingGraphConfig,
): void {
  const derivedChannelIds = processingOutputChannelIds(processingGraph);
  const unknownChannel = Object.values(config.channels).find(
    (channelId) => channelId.startsWith("derived:") && !derivedChannelIds.has(channelId),
  );
  if (unknownChannel) {
    throw new Error(`姿态映射引用未知派生通道：${unknownChannel}`);
  }
}

function processingOutputChannelIds(processingGraph: ProcessingGraphConfig): Set<string> {
  return new Set(
    processingGraph.nodes
      .filter((node) => node.kind === "output")
      .map((node) => processingOutputChannelId(node.id)),
  );
}

function validateWorkspaceId(value: string): string {
  if (
    !value ||
    value.length > MAX_WORKSPACE_ID_LENGTH ||
    !WORKSPACE_ID_PATTERN.test(value)
  ) {
    throw new Error("工作区 ID 无效");
  }
  return value;
}

function requirePortName(value: unknown): string {
  if (!isPortName(value)) {
    throw new Error(`串口名称必须是不超过 ${MAX_PORT_NAME_LENGTH} 个字符的字符串`);
  }
  return value;
}

function isPortName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PORT_NAME_LENGTH &&
    !containsControlCharacter(value)
  );
}

function requireBaudRate(value: unknown): number {
  if (!isBaudRate(value)) {
    throw new Error("波特率必须是 1 到 12000000 之间的整数");
  }
  return value;
}

function isBaudRate(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 12_000_000;
}

function requireChartWindow(value: unknown): ChartWindowSeconds {
  if (!isChartWindow(value)) {
    throw new Error("波形时间窗仅支持 5、15、30 或 60 秒");
  }
  return value;
}

function isChartWindow(value: unknown): value is ChartWindowSeconds {
  return CHART_WINDOWS.some((candidate) => candidate === value);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} 必须是布尔值`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} 必须是字符串`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} 无效`);
  }
  return Number(value);
}

function requireEnum<const T>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!isEnum(value, allowed)) {
    throw new Error(`${field} 的值无效`);
  }
  return value;
}

function isEnum<const T>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((candidate) => candidate === value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actualKeys = Object.keys(value);
  const missingKey = expectedKeys.find((key) => !Object.hasOwn(value, key));
  const unknownKey = actualKeys.find((key) => !expectedKeys.includes(key));
  if (missingKey) {
    throw new Error(`${field} 缺少字段：${missingKey}`);
  }
  if (unknownKey) {
    throw new Error(`${field} 包含未知字段：${unknownKey}`);
  }
}
