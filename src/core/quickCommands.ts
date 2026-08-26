import {
  compileCommandTemplate,
  renderCommandTemplate,
} from "./commandTemplate";
import { LINE_ENDINGS, type DisplayMode, type LineEnding } from "../types/serial";
import type { QuickCommand } from "../types/workbench";

export const MAX_QUICK_COMMANDS = 32;
export const MAX_QUICK_COMMAND_NAME_LENGTH = 64;
export const MAX_QUICK_COMMAND_TOTAL_TEMPLATE_BYTES = 128 * 1024;

const QUICK_COMMAND_KEYS = ["id", "name", "template", "mode", "lineEnding"] as const;
const QUICK_COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TEMPLATE_VALIDATION_CONTEXT = {
  sequence: 1,
  nowMs: 0,
  taskStartedAtMs: 0,
} as const;

export function parseQuickCommands(
  value: unknown,
  allowedLineEndings: readonly LineEnding[] = LINE_ENDINGS,
): QuickCommand[] {
  if (!Array.isArray(value)) {
    throw new Error("快捷命令必须是数组");
  }
  if (value.length > MAX_QUICK_COMMANDS) {
    throw new Error(`快捷命令最多包含 ${MAX_QUICK_COMMANDS} 条`);
  }

  const commands = value.map((command) => parseQuickCommand(command, allowedLineEndings));
  const usedIds = new Set<string>();
  let totalTemplateBytes = 0;
  for (const command of commands) {
    if (usedIds.has(command.id)) {
      throw new Error(`快捷命令 ID 重复：${command.id}`);
    }
    usedIds.add(command.id);
    totalTemplateBytes += new TextEncoder().encode(command.template).byteLength;
    if (totalTemplateBytes > MAX_QUICK_COMMAND_TOTAL_TEMPLATE_BYTES) {
      throw new Error(
        `快捷命令模板总量不能超过 ${MAX_QUICK_COMMAND_TOTAL_TEMPLATE_BYTES / 1024} KiB`,
      );
    }
  }
  return commands;
}

export function cloneQuickCommands(commands: readonly QuickCommand[]): QuickCommand[] {
  return commands.map((command) => ({ ...command }));
}

export function areQuickCommandsEqual(
  left: readonly QuickCommand[],
  right: readonly QuickCommand[],
): boolean {
  return left.length === right.length && left.every((command, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      command.id === candidate.id &&
      command.name === candidate.name &&
      command.template === candidate.template &&
      command.mode === candidate.mode &&
      command.lineEnding === candidate.lineEnding;
  });
}

export function createQuickCommand(
  name: string,
  template: string,
  mode: DisplayMode,
  lineEnding: LineEnding,
  existingCommands: readonly QuickCommand[],
): QuickCommand {
  const command = {
    id: createQuickCommandId(existingCommands),
    name,
    template,
    mode,
    lineEnding,
  };
  const commands = parseQuickCommands([...existingCommands, command]);
  const created = commands.at(-1);
  if (!created) {
    throw new Error("无法创建快捷命令");
  }
  return created;
}

function parseQuickCommand(
  value: unknown,
  allowedLineEndings: readonly LineEnding[],
): QuickCommand {
  const record = requireRecord(value, "快捷命令");
  assertExactKeys(record, QUICK_COMMAND_KEYS, "快捷命令");

  const id = requireString(record.id, "快捷命令 ID");
  if (!QUICK_COMMAND_ID_PATTERN.test(id)) {
    throw new Error("快捷命令 ID 只能包含字母、数字、下划线和连字符，且不能超过 64 个字符");
  }

  const name = requireString(record.name, "快捷命令名称").trim();
  if (!name || name.length > MAX_QUICK_COMMAND_NAME_LENGTH || containsControlCharacter(name)) {
    throw new Error(
      `快捷命令名称必须为 1 到 ${MAX_QUICK_COMMAND_NAME_LENGTH} 个无控制字符文本`,
    );
  }

  const template = requireString(record.template, "快捷命令模板");
  const mode = requireEnum(record.mode, ["text", "hex"], "快捷命令格式");
  const lineEnding = requireEnum(record.lineEnding, allowedLineEndings, "快捷命令行尾");
  const compiled = compileCommandTemplate(template, mode);
  const rendered = renderCommandTemplate(compiled, TEMPLATE_VALIDATION_CONTEXT, lineEnding);
  if (rendered.bytes.length === 0) {
    throw new Error("快捷命令内容不能为空");
  }

  return { id, name, template, mode, lineEnding };
}

function createQuickCommandId(commands: readonly QuickCommand[]): string {
  const usedIds = new Set(commands.map((command) => command.id));
  if (typeof globalThis.crypto?.randomUUID === "function") {
    const id = `quick-${globalThis.crypto.randomUUID()}`;
    if (!usedIds.has(id)) {
      return id;
    }
  }
  for (let index = 1; index <= MAX_QUICK_COMMANDS + 1; index += 1) {
    const id = `quick-${index}`;
    if (!usedIds.has(id)) {
      return id;
    }
  }
  throw new Error("无法生成快捷命令 ID");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串`);
  }
  return value;
}

function requireEnum<const T>(value: unknown, allowed: readonly T[], label: string): T {
  if (!allowed.some((candidate) => candidate === value)) {
    throw new Error(`${label}无效`);
  }
  return value as T;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).find((key) => !expected.has(key));
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (unknown) {
    throw new Error(`${label}包含未知字段：${unknown}`);
  }
  if (missing) {
    throw new Error(`${label}缺少字段：${missing}`);
  }
}
