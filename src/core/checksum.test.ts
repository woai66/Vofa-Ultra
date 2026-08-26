import { describe, expect, it } from "vitest";
import {
  calculateChecksums,
  MAX_CHECKSUM_INPUT_BYTES,
  MAX_CHECKSUM_INPUT_CHARACTERS,
} from "./checksum";

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
