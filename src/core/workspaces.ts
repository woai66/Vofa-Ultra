import { DEFAULT_SERIAL_CONFIG, PROTOCOL_IDS } from "../types/serial";
import type {
  ChartWindowSeconds,
  WorkspaceConfigV1,
  WorkspaceExportV1,
  WorkspaceProfile,
} from "../types/workspace";

export const WORKSPACE_FILE_FORMAT = "vofa-ultra.workspace";
export const WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024;
export const MAX_WORKSPACE_COUNT = 32;
export const MAX_WORKSPACE_NAME_LENGTH = 64;
export const DEFAULT_WORKSPACE_ID = "default";

const MAX_PORT_NAME_LENGTH = 256;
const MAX_WORKSPACE_ID_LENGTH = 128;
const WORKSPACE_CONFIG_KEYS = [
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
const CHANNEL_ID_PATTERN = /^channel-(?:[0-9]|1[0-5])$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CHART_WINDOWS: readonly ChartWindowSeconds[] = [5, 15, 30, 60];

export type WorkspaceConfigSource = WorkspaceConfigV1;

export function createDefaultWorkspaceConfig(source: WorkspaceConfigV1["source"]): WorkspaceConfigV1 {
  return {
    source,
    protocol: "firewater",
    serialConfig: { ...DEFAULT_SERIAL_CONFIG },
    displayMode: "text",
    sendMode: "text",
    lineEnding: "none",
    terminalAutoScroll: true,
    chartWindowSeconds: 15,
    channelVisibility: {},
  };
}

export function captureWorkspaceConfig(state: WorkspaceConfigSource): WorkspaceConfigV1 {
  return cloneWorkspaceConfig(state);
}

export function cloneWorkspaceConfig(config: WorkspaceConfigV1): WorkspaceConfigV1 {
  return {
    source: config.source,
    protocol: config.protocol,
    serialConfig: { ...config.serialConfig },
    displayMode: config.displayMode,
    sendMode: config.sendMode,
    lineEnding: config.lineEnding,
    terminalAutoScroll: config.terminalAutoScroll,
    chartWindowSeconds: config.chartWindowSeconds,
    channelVisibility: { ...config.channelVisibility },
  };
}

export function areWorkspaceConfigsEqual(
  left: WorkspaceConfigV1,
  right: WorkspaceConfigV1,
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
    left.terminalAutoScroll === right.terminalAutoScroll &&
    left.chartWindowSeconds === right.chartWindowSeconds &&
    JSON.stringify(leftVisibility) === JSON.stringify(rightVisibility)
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
  config: WorkspaceConfigV1,
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
  const exported: WorkspaceExportV1 = {
    format: WORKSPACE_FILE_FORMAT,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: profile.name,
    config: cloneWorkspaceConfig(profile.config),
  };
  return `${JSON.stringify(exported, null, 2)}\n`;
}

export function parseWorkspaceExport(text: string): WorkspaceExportV1 {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_FILE_BYTES) {
    throw new Error(`工作区文件不能超过 ${MAX_WORKSPACE_FILE_BYTES / 1024} KiB`);
  }

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
  if (record.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`不支持工作区 schema 版本：${String(record.schemaVersion)}`);
  }
  assertExactKeys(record, WORKSPACE_EXPORT_KEYS, "工作区文件");

  return {
    format: WORKSPACE_FILE_FORMAT,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name: validateWorkspaceName(requireString(record.name, "工作区名称")),
    config: parseWorkspaceConfig(record.config),
  };
}

export function parseWorkspaceConfig(value: unknown): WorkspaceConfigV1 {
  const record = requireRecord(value, "工作区配置");
  assertExactKeys(record, WORKSPACE_CONFIG_KEYS, "工作区配置");
  const serialConfig = requireRecord(record.serialConfig, "串口配置");
  assertExactKeys(serialConfig, SERIAL_CONFIG_KEYS, "串口配置");

  return {
    source: requireEnum(record.source, ["serial", "simulator"], "数据源"),
    protocol: requireEnum(record.protocol, PROTOCOL_IDS, "协议"),
    serialConfig: parseSerialConfig(serialConfig),
    displayMode: requireEnum(record.displayMode, ["text", "hex"], "接收显示格式"),
    sendMode: requireEnum(record.sendMode, ["text", "hex"], "发送格式"),
    lineEnding: requireEnum(record.lineEnding, ["none", "lf", "crlf"], "行尾"),
    terminalAutoScroll: requireBoolean(record.terminalAutoScroll, "终端自动滚动"),
    chartWindowSeconds: requireChartWindow(record.chartWindowSeconds),
    channelVisibility: parseChannelVisibility(record.channelVisibility),
  };
}

export function restoreWorkspaceConfig(
  value: unknown,
  fallback: WorkspaceConfigV1,
): WorkspaceConfigV1 {
  const record = isRecord(value) ? value : {};
  const serialConfig = isRecord(record.serialConfig) ? record.serialConfig : {};
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
    lineEnding: isEnum(record.lineEnding, ["none", "lf", "crlf"])
      ? record.lineEnding
      : fallback.lineEnding,
    terminalAutoScroll:
      typeof record.terminalAutoScroll === "boolean"
        ? record.terminalAutoScroll
        : fallback.terminalAutoScroll,
    chartWindowSeconds: isChartWindow(record.chartWindowSeconds)
      ? record.chartWindowSeconds
      : fallback.chartWindowSeconds,
    channelVisibility: tryParseChannelVisibility(record.channelVisibility) ?? {
      ...fallback.channelVisibility,
    },
  };
}

export function restoreWorkspaceProfiles(value: unknown): WorkspaceProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const workspaces: WorkspaceProfile[] = [];
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  for (const candidate of value.slice(0, MAX_WORKSPACE_COUNT)) {
    try {
      const profile = parseWorkspaceProfile(candidate);
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

function parseWorkspaceProfile(value: unknown): WorkspaceProfile {
  const record = requireRecord(value, "工作区快照");
  assertExactKeys(record, WORKSPACE_PROFILE_KEYS, "工作区快照");
  const createdAt = requireTimestamp(record.createdAt, "创建时间");
  const updatedAt = requireTimestamp(record.updatedAt, "更新时间");
  if (updatedAt < createdAt) {
    throw new Error("工作区更新时间早于创建时间");
  }
  return {
    id: validateWorkspaceId(requireString(record.id, "工作区 ID")),
    name: validateWorkspaceName(requireString(record.name, "工作区名称")),
    createdAt,
    updatedAt,
    config: parseWorkspaceConfig(record.config),
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

function parseChannelVisibility(value: unknown): Record<string, boolean> {
  const parsed = tryParseChannelVisibility(value);
  if (!parsed) {
    throw new Error("通道显隐配置无效");
  }
  return parsed;
}

function tryParseChannelVisibility(value: unknown): Record<string, boolean> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > 16) {
    return null;
  }
  const visibility: Record<string, boolean> = {};
  for (const [channelId, visible] of entries) {
    if (!CHANNEL_ID_PATTERN.test(channelId) || typeof visible !== "boolean") {
      return null;
    }
    if (!visible) {
      visibility[channelId] = false;
    }
  }
  return visibility;
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
