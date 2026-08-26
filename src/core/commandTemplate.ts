import { encodeOutbound, parseHex } from "./codec";
import {
  createCommandChecksumSuffix,
  DEFAULT_COMMAND_CHECKSUM_MODE,
  type CommandChecksumMode,
} from "./checksum";
import type { DisplayMode, LineEnding } from "../types/serial";

export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_COMMAND_TEMPLATE_BYTES = 256 * 1024;
export const MAX_COMMAND_VARIABLES = 256;
export const MAX_COMMAND_VARIABLE_TOKEN_LENGTH = 64;

const COMMAND_VARIABLE_NAMES = [
  "seq",
  "unix_ms",
  "unix_s",
  "iso_utc",
  "task_unix_ms",
] as const;
const COMMAND_VARIABLE_FORMATS = [
  "u8",
  "u16le",
  "u16be",
  "u32le",
  "u32be",
  "u64le",
  "u64be",
] as const;

export type CommandVariableName = (typeof COMMAND_VARIABLE_NAMES)[number];
export type CommandVariableFormat = (typeof COMMAND_VARIABLE_FORMATS)[number];

interface LiteralToken {
  readonly kind: "literal";
  readonly value: string;
}

interface VariableToken {
  readonly kind: "variable";
  readonly name: CommandVariableName;
  readonly format?: CommandVariableFormat;
}

export type CommandTemplateToken = LiteralToken | VariableToken;

export interface CompiledCommandTemplate {
  readonly source: string;
  readonly mode: DisplayMode;
  readonly tokens: readonly CommandTemplateToken[];
  readonly variableCount: number;
}

export interface CommandTemplateContext {
  readonly sequence: number;
  readonly nowMs: number;
  readonly taskStartedAtMs: number;
}

export interface RenderedCommandTemplate {
  readonly bytes: Uint8Array;
  readonly checksumBytes: Uint8Array;
  readonly variableCount: number;
}

export interface CommandVariableInsertion {
  readonly mode: DisplayMode;
  readonly token: string;
  readonly label: string;
}

interface CommandVariableDefinition {
  readonly text: boolean;
  readonly hexFormats: readonly CommandVariableFormat[];
}

const VARIABLE_DEFINITIONS: Readonly<Record<CommandVariableName, CommandVariableDefinition>> = {
  seq: {
    text: true,
    hexFormats: ["u8", "u16le", "u16be", "u32le", "u32be"],
  },
  unix_ms: {
    text: true,
    hexFormats: ["u64le", "u64be"],
  },
  unix_s: {
    text: true,
    hexFormats: ["u32le", "u32be", "u64le", "u64be"],
  },
  iso_utc: {
    text: true,
    hexFormats: [],
  },
  task_unix_ms: {
    text: true,
    hexFormats: ["u64le", "u64be"],
  },
};

export const COMMAND_VARIABLE_INSERTIONS: readonly CommandVariableInsertion[] = Object.freeze([
  { mode: "text", token: "${seq}", label: "发送序号" },
  { mode: "text", token: "${unix_ms}", label: "Unix 毫秒" },
  { mode: "text", token: "${unix_s}", label: "Unix 秒" },
  { mode: "text", token: "${iso_utc}", label: "UTC 时间" },
  { mode: "text", token: "${task_unix_ms}", label: "任务起始毫秒" },
  { mode: "hex", token: "${seq:u8}", label: "序号 U8" },
  { mode: "hex", token: "${seq:u16le}", label: "序号 U16 LE" },
  { mode: "hex", token: "${seq:u16be}", label: "序号 U16 BE" },
  { mode: "hex", token: "${seq:u32le}", label: "序号 U32 LE" },
  { mode: "hex", token: "${seq:u32be}", label: "序号 U32 BE" },
  { mode: "hex", token: "${unix_ms:u64le}", label: "Unix 毫秒 U64 LE" },
  { mode: "hex", token: "${unix_ms:u64be}", label: "Unix 毫秒 U64 BE" },
  { mode: "hex", token: "${unix_s:u32le}", label: "Unix 秒 U32 LE" },
  { mode: "hex", token: "${unix_s:u32be}", label: "Unix 秒 U32 BE" },
  { mode: "hex", token: "${unix_s:u64le}", label: "Unix 秒 U64 LE" },
  { mode: "hex", token: "${unix_s:u64be}", label: "Unix 秒 U64 BE" },
  { mode: "hex", token: "${task_unix_ms:u64le}", label: "任务起始毫秒 U64 LE" },
  { mode: "hex", token: "${task_unix_ms:u64be}", label: "任务起始毫秒 U64 BE" },
]);

export function compileCommandTemplate(
  source: string,
  mode: DisplayMode,
): CompiledCommandTemplate {
  if (source.length > MAX_COMMAND_TEMPLATE_BYTES) {
    throw new Error(`命令模板不能超过 ${MAX_COMMAND_TEMPLATE_BYTES / 1024} KiB`);
  }
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MAX_COMMAND_TEMPLATE_BYTES) {
    throw new Error(`命令模板不能超过 ${MAX_COMMAND_TEMPLATE_BYTES / 1024} KiB`);
  }

  const tokens: CommandTemplateToken[] = [];
  const literalParts: string[] = [];
  let variableCount = 0;
  let cursor = 0;
  let literalStart = 0;

  const flushLiteral = () => {
    const value = literalParts.join("");
    literalParts.length = 0;
    if (value) {
      tokens.push({ kind: "literal", value });
    }
  };

  while (cursor < source.length) {
    if (source[cursor] !== "$") {
      cursor += 1;
      continue;
    }
    if (source[cursor + 1] === "$") {
      literalParts.push(source.slice(literalStart, cursor), "$");
      cursor += 2;
      literalStart = cursor;
      continue;
    }
    if (source[cursor + 1] !== "{") {
      cursor += 1;
      continue;
    }

    literalParts.push(source.slice(literalStart, cursor));
    flushLiteral();
    const end = source.indexOf("}", cursor + 2);
    if (end < 0) {
      throw new Error("命令变量缺少右花括号");
    }
    if (end - cursor + 1 > MAX_COMMAND_VARIABLE_TOKEN_LENGTH) {
      throw new Error(`命令变量 token 不能超过 ${MAX_COMMAND_VARIABLE_TOKEN_LENGTH} 个字符`);
    }

    const content = source.slice(cursor + 2, end);
    tokens.push(parseVariableToken(content, mode));
    variableCount += 1;
    if (variableCount > MAX_COMMAND_VARIABLES) {
      throw new Error(`单个命令最多包含 ${MAX_COMMAND_VARIABLES} 个变量`);
    }
    cursor = end + 1;
    literalStart = cursor;
  }

  literalParts.push(source.slice(literalStart));
  flushLiteral();
  const frozenTokens = tokens.map((token) => Object.freeze(token));
  return Object.freeze({
    source,
    mode,
    tokens: Object.freeze(frozenTokens),
    variableCount,
  });
}

export function renderCommandTemplate(
  template: CompiledCommandTemplate,
  context: CommandTemplateContext,
  lineEnding: LineEnding,
  checksumMode: CommandChecksumMode = DEFAULT_COMMAND_CHECKSUM_MODE,
): RenderedCommandTemplate {
  validateContext(context);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  for (const token of template.tokens) {
    const bytes =
      token.kind === "literal"
        ? renderLiteral(token.value, template.mode)
        : renderVariable(token, template.mode, context);
    byteLength = appendBoundedChunk(chunks, bytes, byteLength);
  }

  const payload = concatenateChunks(chunks, byteLength);
  const checksumBytes = createCommandChecksumSuffix(payload, checksumMode);
  byteLength = appendBoundedChunk(chunks, checksumBytes, byteLength);
  const lineEndingBytes = encodeOutbound("", "text", lineEnding);
  byteLength = appendBoundedChunk(chunks, lineEndingBytes, byteLength);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, checksumBytes, variableCount: template.variableCount };
}

function parseVariableToken(content: string, mode: DisplayMode): VariableToken {
  if (!content) {
    throw new Error("命令变量名称不能为空");
  }
  const separator = content.indexOf(":");
  if (separator !== content.lastIndexOf(":")) {
    throw new Error(`命令变量语法无效：\${${content}}`);
  }
  const nameText = separator < 0 ? content : content.slice(0, separator);
  const formatText = separator < 0 ? undefined : content.slice(separator + 1);
  if (!/^[a-z][a-z0-9_]*$/.test(nameText)) {
    throw new Error(`命令变量名称无效：${nameText || "<empty>"}`);
  }
  if (!COMMAND_VARIABLE_NAMES.some((candidate) => candidate === nameText)) {
    throw new Error(`未知命令变量：${nameText}`);
  }

  const name = nameText as CommandVariableName;
  const definition = VARIABLE_DEFINITIONS[name];
  if (mode === "text") {
    if (formatText !== undefined) {
      throw new Error(`文本变量 ${name} 不支持格式后缀`);
    }
    if (!definition.text) {
      throw new Error(`命令变量 ${name} 不支持文本模式`);
    }
    return { kind: "variable", name };
  }

  if (!formatText) {
    throw new Error(`HEX 变量 ${name} 必须指定定宽格式`);
  }
  if (!COMMAND_VARIABLE_FORMATS.some((candidate) => candidate === formatText)) {
    throw new Error(`未知命令变量格式：${formatText}`);
  }
  const format = formatText as CommandVariableFormat;
  if (!definition.hexFormats.includes(format)) {
    throw new Error(`命令变量 ${name} 不支持 ${format} 格式`);
  }
  return { kind: "variable", name, format };
}

function renderLiteral(value: string, mode: DisplayMode): Uint8Array {
  return mode === "text" ? new TextEncoder().encode(value) : parseHex(value);
}

function renderVariable(
  token: VariableToken,
  mode: DisplayMode,
  context: CommandTemplateContext,
): Uint8Array {
  if (mode === "text") {
    return new TextEncoder().encode(renderTextVariable(token.name, context));
  }
  if (!token.format) {
    throw new Error(`HEX 变量 ${token.name} 缺少定宽格式`);
  }
  return encodeUnsignedVariable(token.name, token.format, context);
}

function renderTextVariable(
  name: CommandVariableName,
  context: CommandTemplateContext,
): string {
  switch (name) {
    case "seq":
      return String(context.sequence);
    case "unix_ms":
      return String(context.nowMs);
    case "unix_s":
      return String(Math.floor(context.nowMs / 1_000));
    case "iso_utc": {
      const date = new Date(context.nowMs);
      if (!Number.isFinite(date.getTime())) {
        throw new Error("命令变量时间超出 ISO-8601 可表示范围");
      }
      return date.toISOString();
    }
    case "task_unix_ms":
      return String(context.taskStartedAtMs);
  }
}

function encodeUnsignedVariable(
  name: CommandVariableName,
  format: CommandVariableFormat,
  context: CommandTemplateContext,
): Uint8Array {
  const value = variableUnsignedValue(name, context);
  const layout = unsignedFormatLayout(format);
  const maximum = (1n << BigInt(layout.byteLength * 8)) - 1n;
  if (value > maximum) {
    throw new Error(`命令变量 ${name} 的值超出 ${format} 范围`);
  }

  const bytes = new Uint8Array(layout.byteLength);
  for (let index = 0; index < bytes.length; index += 1) {
    const byteIndex = layout.littleEndian ? index : bytes.length - index - 1;
    bytes[byteIndex] = Number((value >> BigInt(index * 8)) & 0xffn);
  }
  return bytes;
}

function variableUnsignedValue(
  name: CommandVariableName,
  context: CommandTemplateContext,
): bigint {
  switch (name) {
    case "seq":
      return BigInt(context.sequence);
    case "unix_ms":
      return BigInt(context.nowMs);
    case "unix_s":
      return BigInt(Math.floor(context.nowMs / 1_000));
    case "task_unix_ms":
      return BigInt(context.taskStartedAtMs);
    case "iso_utc":
      throw new Error("命令变量 iso_utc 不支持 HEX 模式");
  }
}

function unsignedFormatLayout(format: CommandVariableFormat): {
  byteLength: number;
  littleEndian: boolean;
} {
  switch (format) {
    case "u8":
      return { byteLength: 1, littleEndian: true };
    case "u16le":
      return { byteLength: 2, littleEndian: true };
    case "u16be":
      return { byteLength: 2, littleEndian: false };
    case "u32le":
      return { byteLength: 4, littleEndian: true };
    case "u32be":
      return { byteLength: 4, littleEndian: false };
    case "u64le":
      return { byteLength: 8, littleEndian: true };
    case "u64be":
      return { byteLength: 8, littleEndian: false };
  }
}

function validateContext(context: CommandTemplateContext): void {
  if (!Number.isSafeInteger(context.sequence) || context.sequence < 1) {
    throw new Error("命令变量序号必须是从 1 开始的安全整数");
  }
  for (const [field, value] of [
    ["当前时间", context.nowMs],
    ["任务起始时间", context.taskStartedAtMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field}必须是非负安全整数毫秒值`);
    }
  }
}

function appendBoundedChunk(
  chunks: Uint8Array[],
  chunk: Uint8Array,
  currentLength: number,
): number {
  if (chunk.length > MAX_COMMAND_BYTES - currentLength) {
    throw new Error(`单次发送不能超过 ${MAX_COMMAND_BYTES / 1024} KiB，请拆分后重试`);
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return currentLength + chunk.length;
}

function concatenateChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
