import { describe, expect, it } from "vitest";
import { encodeText, isTextEncodingLoaded, loadTextEncoding } from "./textEncoding";

describe("发送文本编码", () => {
  it("按 UTF-8 编码文本", () => {
    expect(Array.from(encodeText("中文€"))).toEqual([
      0xe4,
      0xb8,
      0xad,
      0xe6,
      0x96,
      0x87,
      0xe2,
      0x82,
      0xac,
    ]);
  });

  it("并发加载 GB18030 后按标准向量编码", async () => {
    await Promise.all([loadTextEncoding("gb18030"), loadTextEncoding("gb18030")]);

    expect(isTextEncodingLoaded("gb18030")).toBe(true);
    expect(Array.from(encodeText("中文€", "gb18030"))).toEqual([
      0xd6,
      0xd0,
      0xce,
      0xc4,
      0xa2,
      0xe3,
    ]);
  });

  it("按 Windows-1252 编码并拒绝不可表示字符", async () => {
    await loadTextEncoding("windows-1252");

    expect(Array.from(encodeText("Café €", "windows-1252"))).toEqual([
      0x43,
      0x61,
      0x66,
      0xe9,
      0x20,
      0x80,
    ]);
    expect(() => encodeText("中文", "windows-1252")).toThrow(
      /Windows-1252 无法表示字符 U\+4E2D/,
    );
  });
});
