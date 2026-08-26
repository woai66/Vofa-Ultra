import { describe, expect, it } from "vitest";
import {
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_TOTAL_TEMPLATE_BYTES,
  areQuickCommandsEqual,
  cloneQuickCommands,
  createQuickCommand,
  parseQuickCommands,
} from "./quickCommands";
import { LEGACY_LINE_ENDINGS } from "../types/serial";
import type { QuickCommand } from "../types/workbench";

function command(overrides: Partial<QuickCommand> = {}): QuickCommand {
  return {
    id: "quick-1",
    name: "查询状态",
    template: "STATUS?",
    mode: "text",
    lineEnding: "crlf",
    ...overrides,
  };
}

describe("快捷命令", () => {
  it("严格解析并保留模板原文、模式、行尾和顺序", () => {
    const commands = [
      command({ template: "  STATUS?  " }),
      command({
        id: "quick-2",
        name: "读取寄存器",
        template: "01 03 00 00 ${seq:u8}",
        mode: "hex",
        lineEnding: "none",
      }),
    ];

    const parsed = parseQuickCommands(commands);

    expect(parsed).toEqual(commands);
    expect(parsed).not.toBe(commands);
    expect(parsed[0]).not.toBe(commands[0]);
  });

  it("允许只发送行尾并拒绝空命令和非法模板", () => {
    expect(parseQuickCommands([command({ template: "", lineEnding: "cr" })])).toEqual([
      command({ template: "", lineEnding: "cr" }),
    ]);
    expect(() =>
      parseQuickCommands([command({ template: "", lineEnding: "none" })]),
    ).toThrow(/不能为空/);
    expect(() =>
      parseQuickCommands([command({ mode: "hex", template: "0" })]),
    ).toThrow(/完整字节/);
    expect(() =>
      parseQuickCommands([command({ template: "${unknown}" })]),
    ).toThrow(/未知命令变量/);
  });

  it("只在当前格式接受 CR 行尾", () => {
    const crCommand = command({ lineEnding: "cr" });

    expect(parseQuickCommands([crCommand])).toEqual([crCommand]);
    expect(() => parseQuickCommands([crCommand], LEGACY_LINE_ENDINGS)).toThrow(/行尾无效/);
  });

  it("拒绝未知字段、重复或非法 ID 和非法名称", () => {
    expect(() => parseQuickCommands([{ ...command(), script: "send()" }])).toThrow(/未知字段/);
    expect(() => parseQuickCommands([command(), command({ name: "另一条" })])).toThrow(/ID 重复/);
    expect(() => parseQuickCommands([command({ id: "quick command" })])).toThrow(/ID/);
    expect(() => parseQuickCommands([command({ name: "\u0000" })])).toThrow(/名称/);
  });

  it("按 UTF-8 字节限制模板总量并允许边界值", () => {
    const maximum = [
      command({ id: "quick-1", template: "你".repeat(21_845), lineEnding: "none" }),
      command({ id: "quick-2", template: "你".repeat(21_845), lineEnding: "none" }),
      command({ id: "quick-3", template: "AA" }),
    ];
    expect(
      maximum.reduce(
        (total, item) => total + new TextEncoder().encode(item.template).byteLength,
        0,
      ),
    ).toBe(MAX_QUICK_COMMAND_TOTAL_TEMPLATE_BYTES);
    expect(parseQuickCommands(maximum)).toHaveLength(3);
    expect(() =>
      parseQuickCommands([...maximum, command({ id: "quick-4", template: "你" })]),
    ).toThrow(/模板总量/);
  });

  it("限制命令数量并创建稳定且唯一的 ID", () => {
    const existing = Array.from({ length: MAX_QUICK_COMMANDS - 1 }, (_, index) =>
      command({ id: `quick-${index + 1}`, name: `命令 ${index + 1}` }),
    );
    const created = createQuickCommand("新命令", "PING", "text", "lf", existing);

    expect(created).toMatchObject({
      name: "新命令",
      template: "PING",
      mode: "text",
      lineEnding: "lf",
    });
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(existing.some((item) => item.id === created.id)).toBe(false);
    expect(existing).toHaveLength(MAX_QUICK_COMMANDS - 1);
    expect(() =>
      createQuickCommand("超额", "PING", "text", "none", [...existing, created]),
    ).toThrow(/最多包含/);
  });

  it("克隆不共享对象且相等比较对顺序敏感", () => {
    const commands = [command(), command({ id: "quick-2", name: "复位" })];
    const cloned = cloneQuickCommands(commands);

    expect(cloned).toEqual(commands);
    expect(cloned[0]).not.toBe(commands[0]);
    expect(areQuickCommandsEqual(commands, cloned)).toBe(true);
    expect(areQuickCommandsEqual(commands, [...cloned].reverse())).toBe(false);
  });
});
