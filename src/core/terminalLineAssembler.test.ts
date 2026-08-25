import { describe, expect, it } from "vitest";
import { TerminalLineAssembler } from "./terminalLineAssembler";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("TerminalLineAssembler", () => {
  it.each([
    ["lf", "first\nsecond\n", ["first\n", "second\n"]],
    ["cr", "first\rsecond\r", ["first\r", "second\r"]],
    ["crlf", "first\r\nsecond\r\n", ["first\r\n", "second\r\n"]],
  ] as const)("按 %s 聚合多行并保留行尾原始字节", (lineEnding, input, expected) => {
    const assembler = new TerminalLineAssembler();

    const lines = assembler.push(encoder.encode(input), 100, lineEnding);

    expect(lines.map((line) => decoder.decode(line.bytes))).toEqual(expected);
    expect(lines.map((line) => line.boundary)).toEqual(expected.map(() => "line"));
    expect(assembler.pendingByteCount).toBe(0);
  });

  it("跨任意 CRLF 分片聚合空行并沿用首字节时间", () => {
    const payload = encoder.encode("甲\r\n\r\n乙\r\n");
    for (let split = 1; split < payload.length; split += 1) {
      const assembler = new TerminalLineAssembler();
      const lines = [
        ...assembler.push(payload.slice(0, split), 100, "crlf"),
        ...assembler.push(payload.slice(split), 200, "crlf"),
      ];

      expect(lines.map((line) => decoder.decode(line.bytes))).toEqual([
        "甲\r\n",
        "\r\n",
        "乙\r\n",
      ]);
      expect(lines[0]?.timestamp).toBe(100);
      expect(lines.every((line) => line.timestamp === 100 || line.timestamp === 200)).toBe(true);
    }
  });

  it("UTF-8 字符跨分片时仍输出完整原始行", () => {
    const assembler = new TerminalLineAssembler();
    const payload = encoder.encode("温度=23.5\n");

    expect(assembler.push(payload.slice(0, 2), 100, "lf")).toEqual([]);
    const [line] = assembler.push(payload.slice(2), 200, "lf");

    expect(Array.from(line?.bytes ?? [])).toEqual(Array.from(payload));
    expect(decoder.decode(line?.bytes)).toBe("温度=23.5\n");
    expect(line?.timestamp).toBe(100);
  });

  it("未结束行超过上限时分段并保留余量", () => {
    const assembler = new TerminalLineAssembler(4);

    const lines = assembler.push(encoder.encode("abcdef"), 100, "lf");

    expect(lines).toMatchObject([
      { timestamp: 100, boundary: "overflow", bytes: Uint8Array.of(97, 98, 99, 100) },
    ]);
    expect(assembler.pendingByteCount).toBe(2);
    const [line] = assembler.push(encoder.encode("\n"), 200, "lf");
    expect(line).toMatchObject({ timestamp: 100, boundary: "line" });
    expect(Array.from(line?.bytes ?? [])).toEqual([101, 102, 10]);
  });

  it("允许上限长度的载荷等待紧随其后的行尾", () => {
    const assembler = new TerminalLineAssembler(4);

    expect(assembler.push(encoder.encode("abcd"), 100, "crlf")).toEqual([]);
    const [line] = assembler.push(encoder.encode("\r\n"), 200, "crlf");

    expect(decoder.decode(line?.bytes)).toBe("abcd\r\n");
    expect(line?.timestamp).toBe(100);
    expect(line?.boundary).toBe("line");
  });

  it("CRLF 前缀跨分片时不把上限长度载荷误判为超限", () => {
    const assembler = new TerminalLineAssembler(4);

    expect(assembler.push(encoder.encode("abcd\r"), 100, "crlf")).toEqual([]);
    const [line] = assembler.push(encoder.encode("\n"), 200, "crlf");

    expect(decoder.decode(line?.bytes)).toBe("abcd\r\n");
    expect(line).toMatchObject({ timestamp: 100, boundary: "line" });
  });

  it("CRLF 前缀未闭合时只溢出已确认载荷并保留首字节时间", () => {
    const assembler = new TerminalLineAssembler(4);

    expect(assembler.push(encoder.encode("abcd\r"), 100, "crlf")).toEqual([]);
    const overflow = assembler.push(encoder.encode("X"), 200, "crlf");

    expect(overflow).toMatchObject([
      { timestamp: 100, boundary: "overflow", bytes: Uint8Array.of(97, 98, 99, 100) },
    ]);
    const fragment = assembler.flush();
    expect(decoder.decode(fragment?.bytes)).toBe("\rX");
    expect(fragment).toMatchObject({ timestamp: 100, boundary: "unterminated" });
  });

  it("flush 标记未结束行，reset 则直接丢弃", () => {
    const assembler = new TerminalLineAssembler();
    assembler.push(encoder.encode("partial"), 100, "lf");

    const flushed = assembler.flush();
    expect(flushed).toMatchObject({
      timestamp: 100,
      boundary: "unterminated",
    });
    expect(Array.from(flushed?.bytes ?? [])).toEqual(Array.from(encoder.encode("partial")));
    expect(assembler.flush()).toBeNull();

    assembler.push(encoder.encode("discarded"), 200, "lf");
    assembler.reset();
    expect(assembler.pendingByteCount).toBe(0);
    expect(assembler.flush()).toBeNull();
  });

  it("复制输入内容且忽略空分片", () => {
    const assembler = new TerminalLineAssembler();
    const bytes = encoder.encode("ok\n");
    const lines = assembler.push(bytes, 100, "lf");
    bytes[0] = 0;

    expect(decoder.decode(lines[0]?.bytes)).toBe("ok\n");
    expect(assembler.push(new Uint8Array(), 200, "lf")).toEqual([]);
  });

  it("拒绝无效的未结束行上限", () => {
    expect(() => new TerminalLineAssembler(0)).toThrow(/正整数/);
    expect(() => new TerminalLineAssembler(1.5)).toThrow(/正整数/);
  });
});
