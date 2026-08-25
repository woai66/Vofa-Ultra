import { describe, expect, it } from "vitest";
import {
  COMMAND_VARIABLE_INSERTIONS,
  compileCommandTemplate,
  MAX_COMMAND_BYTES,
  MAX_COMMAND_TEMPLATE_BYTES,
  MAX_COMMAND_VARIABLES,
  renderCommandTemplate,
  type CommandTemplateContext,
} from "./commandTemplate";

const CONTEXT: CommandTemplateContext = {
  sequence: 1,
  nowMs: 1_700_000_123_456,
  taskStartedAtMs: 1_700_000_000_000,
};

describe("命令模板", () => {
  it("渲染文本变量并只采样一次显式上下文", () => {
    const template = compileCommandTemplate(
      "seq=${seq} ms=${unix_ms} s=${unix_s} utc=${iso_utc} start=${task_unix_ms}",
      "text",
    );
    const rendered = renderCommandTemplate(template, CONTEXT, "lf");

    expect(new TextDecoder().decode(rendered.bytes)).toBe(
      "seq=1 ms=1700000123456 s=1700000123 utc=2023-11-14T22:15:23.456Z " +
        "start=1700000000000\n",
    );
    expect(rendered.variableCount).toBe(5);
  });

  it("用 $$ 转义美元符号且不递归解释展开结果", () => {
    const template = compileCommandTemplate("$${seq} $$ ${seq}", "text");

    expect(new TextDecoder().decode(renderCommandTemplate(template, CONTEXT, "none").bytes)).toBe(
      "${seq} $ 1",
    );
  });

  it("在 HEX 模式直接生成定宽大小端字节", () => {
    const template = compileCommandTemplate(
      "AA ${seq:u8} ${seq:u16le} ${seq:u16be} ${unix_s:u32le} 55",
      "hex",
    );

    expect(Array.from(renderCommandTemplate(template, CONTEXT, "crlf").bytes)).toEqual([
      0xaa,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x7b,
      0xf1,
      0x53,
      0x65,
      0x55,
      0x0d,
      0x0a,
    ]);
  });

  it("编码 U64 时间并保持任务起始时间独立", () => {
    const template = compileCommandTemplate(
      "${unix_ms:u64le}${unix_ms:u64be}${task_unix_ms:u64le}",
      "hex",
    );
    const bytes = renderCommandTemplate(template, CONTEXT, "none").bytes;

    expect(Array.from(bytes.slice(0, 8))).toEqual([0x40, 0x4a, 0xe7, 0xcf, 0x8b, 0x01, 0x00, 0x00]);
    expect(Array.from(bytes.slice(8, 16))).toEqual([0x00, 0x00, 0x01, 0x8b, 0xcf, 0xe7, 0x4a, 0x40]);
    expect(Array.from(bytes.slice(16))).toEqual([0x00, 0x68, 0xe5, 0xcf, 0x8b, 0x01, 0x00, 0x00]);
  });

  it.each([
    ["${}", "text", /名称不能为空/],
    ["${unknown}", "text", /未知命令变量/],
    ["${globalThis.process}", "text", /名称无效/],
    ["${seq + 1}", "text", /名称无效/],
    ["${seq()}", "text", /名称无效/],
    ["${seq", "text", /缺少右花括号/],
    ["${seq:u16le}", "text", /不支持格式后缀/],
    ["${seq}", "hex", /必须指定定宽格式/],
    ["${iso_utc:u64le}", "hex", /不支持 u64le/],
    ["${seq:u128}", "hex", /未知命令变量格式/],
    ["${seq:u8:extra}", "hex", /语法无效/],
  ] as const)("拒绝不受支持的模板 %s", (source, mode, error) => {
    expect(() => compileCommandTemplate(source, mode)).toThrow(error);
  });

  it("要求 HEX 变量两侧字面量各自位于完整字节边界", () => {
    const leadingNibble = compileCommandTemplate("A${seq:u8}", "hex");
    const trailingNibble = compileCommandTemplate("${seq:u8}B", "hex");

    expect(() => renderCommandTemplate(leadingNibble, CONTEXT, "none")).toThrow(/完整字节/);
    expect(() => renderCommandTemplate(trailingNibble, CONTEXT, "none")).toThrow(/完整字节/);
  });

  it("拒绝定宽整数溢出而不截断或回绕", () => {
    const u8 = compileCommandTemplate("${seq:u8}", "hex");
    const u32Seconds = compileCommandTemplate("${unix_s:u32be}", "hex");

    expect(() =>
      renderCommandTemplate(u8, { ...CONTEXT, sequence: 256 }, "none"),
    ).toThrow(/超出 u8/);
    expect(() =>
      renderCommandTemplate(
        u32Seconds,
        { ...CONTEXT, nowMs: (2 ** 32 + 1) * 1_000 },
        "none",
      ),
    ).toThrow(/超出 u32be/);
  });

  it("限制上下文、变量数量、模板和最终字节大小", () => {
    const plain = compileCommandTemplate("PING", "text");
    expect(() =>
      renderCommandTemplate(plain, { ...CONTEXT, sequence: 0 }, "none"),
    ).toThrow(/从 1 开始/);
    expect(() =>
      renderCommandTemplate(plain, { ...CONTEXT, nowMs: -1 }, "none"),
    ).toThrow(/非负安全整数/);
    expect(() =>
      renderCommandTemplate(plain, { ...CONTEXT, taskStartedAtMs: 1.5 }, "none"),
    ).toThrow(/非负安全整数/);
    const iso = compileCommandTemplate("${iso_utc}", "text");
    expect(() =>
      renderCommandTemplate(iso, { ...CONTEXT, nowMs: Number.MAX_SAFE_INTEGER }, "none"),
    ).toThrow(/ISO-8601/);
    expect(() =>
      compileCommandTemplate("${seq}".repeat(MAX_COMMAND_VARIABLES + 1), "text"),
    ).toThrow(/最多包含/);
    expect(() => compileCommandTemplate("x".repeat(MAX_COMMAND_TEMPLATE_BYTES + 1), "text")).toThrow(
      /命令模板不能超过/,
    );
    expect(() =>
      compileCommandTemplate("界".repeat(Math.floor(MAX_COMMAND_TEMPLATE_BYTES / 3) + 1), "text"),
    ).toThrow(/命令模板不能超过/);

    const exact = compileCommandTemplate("x".repeat(MAX_COMMAND_BYTES), "text");
    expect(renderCommandTemplate(exact, CONTEXT, "none").bytes).toHaveLength(MAX_COMMAND_BYTES);
    expect(() => renderCommandTemplate(exact, CONTEXT, "cr")).toThrow(/单次发送不能超过/);
  });

  it("所有 UI 插入项都能在对应模式编译和渲染", () => {
    for (const insertion of COMMAND_VARIABLE_INSERTIONS) {
      const template = compileCommandTemplate(insertion.token, insertion.mode);
      const rendered = renderCommandTemplate(template, CONTEXT, "none");
      expect(rendered.bytes.length, insertion.token).toBeGreaterThan(0);
      expect(rendered.variableCount).toBe(1);
    }
  });
});
