import { describe, expect, it } from "vitest";
import {
  convertData,
  MAX_DATA_CONVERTER_INPUT_CHARACTERS,
  MAX_DATA_CONVERTER_OUTPUT_BYTES,
  numericTypeByteWidth,
  type DataConverterEndianness,
  type DataNumericType,
} from "./dataConverter";

interface ConversionVector {
  numericType: DataNumericType;
  endianness: DataConverterEndianness;
  numbers: string;
  hex: string;
}

const CONVERSION_VECTORS: readonly ConversionVector[] = [
  { numericType: "u8", endianness: "le", numbers: "0, 255", hex: "00 FF" },
  { numericType: "i8", endianness: "be", numbers: "-128, 127", hex: "80 7F" },
  { numericType: "u16", endianness: "le", numbers: "4660", hex: "34 12" },
  { numericType: "u16", endianness: "be", numbers: "4660", hex: "12 34" },
  { numericType: "i16", endianness: "le", numbers: "-2", hex: "FE FF" },
  { numericType: "i16", endianness: "be", numbers: "-2", hex: "FF FE" },
  { numericType: "u32", endianness: "le", numbers: "305419896", hex: "78 56 34 12" },
  { numericType: "u32", endianness: "be", numbers: "305419896", hex: "12 34 56 78" },
  { numericType: "i32", endianness: "le", numbers: "-2", hex: "FE FF FF FF" },
  { numericType: "i32", endianness: "be", numbers: "-2", hex: "FF FF FF FE" },
  { numericType: "f32", endianness: "le", numbers: "1", hex: "00 00 80 3F" },
  { numericType: "f32", endianness: "be", numbers: "1", hex: "3F 80 00 00" },
  {
    numericType: "f64",
    endianness: "le",
    numbers: "1",
    hex: "00 00 00 00 00 00 F0 3F",
  },
  {
    numericType: "f64",
    endianness: "be",
    numbers: "1",
    hex: "3F F0 00 00 00 00 00 00",
  },
];

describe("data converter", () => {
  it.each(CONVERSION_VECTORS)(
    "converts canonical $endianness $numericType vectors in both directions",
    ({ numericType, endianness, numbers, hex }) => {
      expect(convertData(numbers, "numbers-to-bytes", numericType, endianness)).toMatchObject({
        normalizedHex: hex,
        numericText: numbers,
      });
      expect(convertData(hex, "bytes-to-numbers", numericType, endianness)).toMatchObject({
        normalizedHex: hex,
        numericText: numbers,
      });
    },
  );

  it("fixes every numeric type byte width", () => {
    expect(
      (["u8", "i8", "u16", "i16", "u32", "i32", "f32", "f64"] as const).map(
        numericTypeByteWidth,
      ),
    ).toEqual([1, 1, 2, 2, 4, 4, 4, 8]);
  });

  it("decodes canonical floating-point bytes with explicit endianness", () => {
    expect(convertData("00 00 80 3F", "bytes-to-numbers", "f32", "le")).toEqual({
      byteCount: 4,
      valueCount: 1,
      normalizedHex: "00 00 80 3F",
      numericText: "1",
    });
    expect(convertData("3F 80 00 00", "bytes-to-numbers", "f32", "be").numericText).toBe("1");
  });

  it("encodes signed values and changes multi-byte layout with endianness", () => {
    expect(convertData("-2", "numbers-to-bytes", "i16", "be").normalizedHex).toBe("FF FE");
    expect(convertData("-2", "numbers-to-bytes", "i16", "le").normalizedHex).toBe("FE FF");
    expect(convertData("1, 256; 65535", "numbers-to-bytes", "u16", "be")).toMatchObject({
      valueCount: 3,
      normalizedHex: "00 01 01 00 FF FF",
      numericText: "1, 256, 65535",
    });
  });

  it("covers integer boundaries and keeps negative zero explicit", () => {
    expect(convertData("0 255", "numbers-to-bytes", "u8", "le").normalizedHex).toBe("00 FF");
    expect(convertData("-2147483648 2147483647", "numbers-to-bytes", "i32", "le").numericText)
      .toBe("-2147483648, 2147483647");
    expect(convertData("-0", "numbers-to-bytes", "f64", "le").numericText).toBe("-0");
    expect(() => convertData("256", "numbers-to-bytes", "u8", "le")).toThrow("0..255");
    expect(() => convertData("-2147483649", "numbers-to-bytes", "i32", "le"))
      .toThrow("-2147483648..2147483647");
    for (const [numericType, values] of [
      ["i8", "-128 127"],
      ["u16", "0 65535"],
      ["i16", "-32768 32767"],
      ["u32", "0 4294967295"],
    ] as const) {
      expect(convertData(values, "numbers-to-bytes", numericType, "be").numericText).toBe(
        values.replace(" ", ", "),
      );
    }
    expect(() => convertData("1.5", "numbers-to-bytes", "i16", "le")).toThrow("整数");
    expect(() => convertData("0x10", "numbers-to-bytes", "u16", "le")).toThrow("十进制");
  });

  it("rejects misalignment, malformed lists, non-finite values, and f32 overflow", () => {
    expect(() => convertData("01", "bytes-to-numbers", "u16", "le")).toThrow("未对齐");
    expect(() => convertData("1,", "numbers-to-bytes", "u16", "le")).toThrow("分隔");
    expect(() => convertData("1,,2", "numbers-to-bytes", "u16", "le")).toThrow("空项");
    expect(() => convertData("1::2", "numbers-to-bytes", "u16", "le")).toThrow("分隔");
    expect(() => convertData("NaN", "numbers-to-bytes", "f32", "le")).toThrow("有限值");
    expect(() => convertData("Infinity", "numbers-to-bytes", "f64", "le")).toThrow("有限值");
    expect(() => convertData("3.5e38", "numbers-to-bytes", "f32", "le")).toThrow("有限范围");
    expect(() => convertData("00 00 80 7F", "bytes-to-numbers", "f32", "le"))
      .toThrow("NaN 或 Infinity");
    expect(() => convertData("00 00 00 00 00 00 F8 7F", "bytes-to-numbers", "f64", "le"))
      .toThrow("NaN 或 Infinity");
    expect(() => convertData("00", "bytes-to-numbers", "f64", "le")).toThrow("未对齐");
    expect(() => convertData("123", "bytes-to-numbers", "u8", "le")).toThrow("完整字节");
    expect(() => convertData("1".repeat(129), "numbers-to-bytes", "f64", "le"))
      .toThrow("128");
  });

  it("normalizes shared HEX syntax and preserves finite floating-point round trips", () => {
    expect(convertData("0x01,02-03:04_05;06", "bytes-to-numbers", "u8", "le"))
      .toMatchObject({
        normalizedHex: "01 02 03 04 05 06",
        numericText: "1, 2, 3, 4, 5, 6",
      });
    const encoded = convertData("0.1 -0 1.5", "numbers-to-bytes", "f32", "le");
    expect(convertData(encoded.normalizedHex, "bytes-to-numbers", "f32", "le").numericText)
      .toBe(encoded.numericText);
  });

  it("bounds source text and output bytes while keeping empty input empty", () => {
    expect(convertData("", "bytes-to-numbers", "u16", "le")).toEqual({
      byteCount: 0,
      valueCount: 0,
      normalizedHex: "",
      numericText: "",
    });
    expect(() => convertData(
      " ".repeat(MAX_DATA_CONVERTER_INPUT_CHARACTERS + 1),
      "bytes-to-numbers",
      "u8",
      "le",
    )).toThrow("256 KiB");
    expect(() => convertData(
      "00".repeat(MAX_DATA_CONVERTER_OUTPUT_BYTES + 1),
      "bytes-to-numbers",
      "u8",
      "le",
    )).toThrow("64 KiB");
    expect(convertData(
      "00".repeat(MAX_DATA_CONVERTER_OUTPUT_BYTES),
      "bytes-to-numbers",
      "u8",
      "le",
    ).byteCount).toBe(MAX_DATA_CONVERTER_OUTPUT_BYTES);
    const oversizedValues = `${"0 ".repeat(MAX_DATA_CONVERTER_OUTPUT_BYTES)}0`;
    expect(() => convertData(oversizedValues, "numbers-to-bytes", "u8", "le"))
      .toThrow("64 KiB");
  });
});
