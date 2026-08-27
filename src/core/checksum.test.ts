import { describe, expect, it } from "vitest";
import {
  calculateChecksums,
  COMMAND_CHECKSUM_MODES,
  createCommandChecksumSuffix,
  DEFAULT_COMMAND_CHECKSUM_MODE,
  MAX_CHECKSUM_INPUT_BYTES,
  MAX_CHECKSUM_INPUT_CHARACTERS,
  parseCommandChecksumMode,
} from "./checksum";

const STANDARD_PAYLOAD = new TextEncoder().encode("123456789");

describe("checksum calculator", () => {
  it("matches the canonical 123456789 vectors", () => {
    expect(calculateChecksums("123456789", "text")).toEqual({
      byteCount: 9,
      crc16Modbus: 0x4b37,
      crc32: 0xcbf43926,
      xor8: 0x31,
      sum8: 0xdd,
    });
  });

  it("treats TEXT as UTF-8 and matches equivalent separated HEX bytes", () => {
    const text = calculateChecksums("123456789", "text");
    const hex = calculateChecksums("0x31,32-33:34_35;36 37 38 39", "hex");

    expect(hex).toEqual(text);
    expect(calculateChecksums("中", "text")).toMatchObject({
      byteCount: 3,
      xor8: 0xf1,
      sum8: 0x49,
    });
  });

  it("keeps the standard empty-input values explicit", () => {
    expect(calculateChecksums("", "text")).toEqual({
      byteCount: 0,
      crc16Modbus: 0xffff,
      crc32: 0,
      xor8: 0,
      sum8: 0,
    });
  });

  it("reuses strict HEX parsing and bounds both source text and decoded bytes", () => {
    expect(() => calculateChecksums("01 GG", "hex")).toThrow("0-9 和 A-F");
    expect(() => calculateChecksums("123", "hex")).toThrow("完整字节");
    expect(() => calculateChecksums(
      " ".repeat(MAX_CHECKSUM_INPUT_CHARACTERS + 1),
      "hex",
    )).toThrow("256 KiB");
    expect(() => calculateChecksums(
      "A".repeat(MAX_CHECKSUM_INPUT_BYTES + 1),
      "text",
    )).toThrow("64 KiB");
    expect(() => calculateChecksums(
      "00".repeat(MAX_CHECKSUM_INPUT_BYTES + 1),
      "hex",
    )).toThrow("64 KiB");
    expect(calculateChecksums("A".repeat(MAX_CHECKSUM_INPUT_BYTES), "text").byteCount)
      .toBe(MAX_CHECKSUM_INPUT_BYTES);
  });
});

describe("命令校验尾", () => {
  it("公开稳定的模式顺序、显示信息和默认值", () => {
    expect(COMMAND_CHECKSUM_MODES).toEqual([
      { value: "none", label: "无" },
      { value: "crc16-modbus-le", label: "CRC-16/MODBUS（低字节在前）" },
      { value: "crc16-modbus-be", label: "CRC-16/MODBUS（高字节在前）" },
      { value: "crc32-le", label: "CRC-32（低字节在前）" },
      { value: "crc32-be", label: "CRC-32（高字节在前）" },
      { value: "xor8", label: "XOR-8" },
      { value: "sum8", label: "SUM-8" },
    ]);
    expect(DEFAULT_COMMAND_CHECKSUM_MODE).toBe("none");
  });

  it("严格解析七种模式且拒绝宽松转换和未知持久化值", () => {
    for (const option of COMMAND_CHECKSUM_MODES) {
      expect(parseCommandChecksumMode(option.value)).toBe(option.value);
    }
    for (const invalid of [
      null,
      undefined,
      "",
      "NONE",
      " none",
      "crc16-modbus",
      "crc16-modbus-le ",
      0,
      {},
    ]) {
      expect(() => parseCommandChecksumMode(invalid)).toThrow("命令校验模式无效");
    }
  });

  it("按 123456789 标准向量生成原始大小端校验字节", () => {
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "none"))).toEqual([]);
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "crc16-modbus-le"))).toEqual([
      0x37,
      0x4b,
    ]);
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "crc16-modbus-be"))).toEqual([
      0x4b,
      0x37,
    ]);
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "crc32-le"))).toEqual([
      0x26,
      0x39,
      0xf4,
      0xcb,
    ]);
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "crc32-be"))).toEqual([
      0xcb,
      0xf4,
      0x39,
      0x26,
    ]);
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "xor8"))).toEqual([0x31]);
    expect(Array.from(createCommandChecksumSuffix(STANDARD_PAYLOAD, "sum8"))).toEqual([0xdd]);
  });

  it("明确空 payload 的每种原始校验结果", () => {
    const empty = new Uint8Array();

    expect(Array.from(createCommandChecksumSuffix(empty, "none"))).toEqual([]);
    expect(Array.from(createCommandChecksumSuffix(empty, "crc16-modbus-le"))).toEqual([0xff, 0xff]);
    expect(Array.from(createCommandChecksumSuffix(empty, "crc16-modbus-be"))).toEqual([0xff, 0xff]);
    expect(Array.from(createCommandChecksumSuffix(empty, "crc32-le"))).toEqual([0, 0, 0, 0]);
    expect(Array.from(createCommandChecksumSuffix(empty, "crc32-be"))).toEqual([0, 0, 0, 0]);
    expect(Array.from(createCommandChecksumSuffix(empty, "xor8"))).toEqual([0]);
    expect(Array.from(createCommandChecksumSuffix(empty, "sum8"))).toEqual([0]);
  });
});
