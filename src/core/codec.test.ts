import { describe, expect, it } from "vitest";
import { encodeOutbound, formatHex, parseHex } from "./codec";

describe("HEX codec", () => {
  it("接受常见分隔符和 0x 前缀", () => {
    expect(Array.from(parseHex("0x01, 02-ff:7A"))).toEqual([0x01, 0x02, 0xff, 0x7a]);
    expect(Array.from(parseHex("0102 0X0304"))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it("拒绝非十六进制字符与半字节", () => {
    expect(() => parseHex("01 GG")).toThrow("0-9");
    expect(() => parseHex("G")).toThrow("0-9");
    expect(() => parseHex("123")).toThrow("完整字节");
  });

  it.each(["10x2", "A0xB", "00x1"])("拒绝位于片段中间的 0x：%s", (value) => {
    expect(() => parseHex(value)).toThrow("0-9");
  });

  it.each(["1 2", "0x1 0x2", "0x"])("拒绝不完整的 HEX 片段：%s", (value) => {
    expect(() => parseHex(value)).toThrow("完整字节");
  });

  it("格式化为大写的空格分隔字节", () => {
    expect(formatHex(new Uint8Array([0, 15, 255]))).toBe("00 0F FF");
  });
});
describe("outbound codec", () => {
  it("为文本添加 CR", () => {
    expect(Array.from(encodeOutbound("AT", "text", "cr"))).toEqual([0x41, 0x54, 0x0d]);
  });

  it("为 HEX 数据添加 CR 字节", () => {
    expect(Array.from(encodeOutbound("01 FF", "hex", "cr"))).toEqual([0x01, 0xff, 0x0d]);
  });

  it("为文本添加 CRLF", () => {
    const result = encodeOutbound("AT", "text", "crlf");
    expect(new TextDecoder().decode(result)).toBe("AT\r\n");
  });

  it("为 HEX 数据添加 LF 字节", () => {
    expect(Array.from(encodeOutbound("01 FF", "hex", "lf"))).toEqual([0x01, 0xff, 0x0a]);
  });
});
