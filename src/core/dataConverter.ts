import { formatHex, parseHex } from "./codec";

export type DataConverterDirection = "bytes-to-numbers" | "numbers-to-bytes";
export type DataConverterEndianness = "le" | "be";
export type DataNumericType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";

export const MAX_DATA_CONVERTER_INPUT_CHARACTERS = 256 * 1024;
export const MAX_DATA_CONVERTER_OUTPUT_BYTES = 64 * 1024;

export const DATA_NUMERIC_TYPE_OPTIONS: readonly {
  value: DataNumericType;
  label: string;
  byteWidth: number;
}[] = [
  { value: "u8", label: "u8 · 无符号 8 位", byteWidth: 1 },
  { value: "i8", label: "i8 · 有符号 8 位", byteWidth: 1 },
  { value: "u16", label: "u16 · 无符号 16 位", byteWidth: 2 },
  { value: "i16", label: "i16 · 有符号 16 位", byteWidth: 2 },
  { value: "u32", label: "u32 · 无符号 32 位", byteWidth: 4 },
  { value: "i32", label: "i32 · 有符号 32 位", byteWidth: 4 },
  { value: "f32", label: "f32 · 32 位浮点", byteWidth: 4 },
  { value: "f64", label: "f64 · 64 位浮点", byteWidth: 8 },
];

export interface DataConverterResult {
  byteCount: number;
  valueCount: number;
  normalizedHex: string;
  numericText: string;
}

const NUMBER_TOKEN_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const INTEGER_TOKEN_PATTERN = /^[+-]?\d+$/;
const NON_FINITE_TOKEN_PATTERN = /^[+-]?(?:infinity|nan)$/i;
const MAX_NUMBER_TOKEN_CHARACTERS = 128;

const INTEGER_RANGES: Readonly<Partial<Record<DataNumericType, readonly [number, number]>>> = {
  u8: [0, 0xff],
  i8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  i16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  i32: [-0x80000000, 0x7fffffff],
};

export function convertData(
  value: string,
  direction: DataConverterDirection,
  numericType: DataNumericType,
  endianness: DataConverterEndianness,
): DataConverterResult {
  if (value.length > MAX_DATA_CONVERTER_INPUT_CHARACTERS) {
    throw new Error("转换输入文本不能超过 256 KiB");
  }

  if (value.trim().length === 0) {
    return {
      byteCount: 0,
      valueCount: 0,
      normalizedHex: "",
      numericText: "",
    };
  }

  return direction === "bytes-to-numbers"
    ? convertBytesToNumbers(value, numericType, endianness)
    : convertNumbersToBytes(value, numericType, endianness);
}

export function numericTypeByteWidth(numericType: DataNumericType): number {
  switch (numericType) {
    case "u8":
    case "i8":
      return 1;
    case "u16":
    case "i16":
      return 2;
    case "u32":
    case "i32":
    case "f32":
      return 4;
    case "f64":
      return 8;
  }
}

function convertBytesToNumbers(
  value: string,
  numericType: DataNumericType,
  endianness: DataConverterEndianness,
): DataConverterResult {
  const bytes = parseHex(value);
  validateByteLimit(bytes.length);
  const byteWidth = numericTypeByteWidth(numericType);
  if (bytes.length % byteWidth !== 0) {
    throw new Error(`${numericType} 每个数值需要 ${byteWidth} 字节，当前输入未对齐`);
  }

  const numbers = readNumbers(bytes, numericType, endianness);
  return {
    byteCount: bytes.length,
    valueCount: numbers.length,
    normalizedHex: formatHex(bytes),
    numericText: numbers.map(formatNumber).join(", "),
  };
}

function convertNumbersToBytes(
  value: string,
  numericType: DataNumericType,
  endianness: DataConverterEndianness,
): DataConverterResult {
  const tokens = parseNumberTokens(value);
  const byteWidth = numericTypeByteWidth(numericType);
  validateByteLimit(tokens.length * byteWidth);
  const numbers = tokens.map((token) => parseNumberToken(token, numericType));
  const bytes = new Uint8Array(numbers.length * byteWidth);
  const view = new DataView(bytes.buffer);
  const littleEndian = endianness === "le";

  numbers.forEach((number, index) => {
    const offset = index * byteWidth;
    writeNumber(view, offset, number, numericType, littleEndian);
    if (numericType === "f32" && !Number.isFinite(view.getFloat32(offset, littleEndian))) {
      throw new Error(`数值 ${formatNumber(number)} 超出 f32 的有限范围`);
    }
  });

  const normalizedNumbers = readNumbers(bytes, numericType, endianness);
  return {
    byteCount: bytes.length,
    valueCount: normalizedNumbers.length,
    normalizedHex: formatHex(bytes),
    numericText: normalizedNumbers.map(formatNumber).join(", "),
  };
}

function parseNumberTokens(value: string): string[] {
  const trimmed = value.trim();
  if (/^[,;]/.test(trimmed) || /[,;]$/.test(trimmed) || /[,;]\s*[,;]/.test(trimmed)) {
    throw new Error("数值列表包含空项或尾随分隔符");
  }
  const tokens = trimmed.split(/[\s,;]+/);
  for (const token of tokens) {
    if (NON_FINITE_TOKEN_PATTERN.test(token)) {
      throw new Error("数值必须是有限值，不能使用 NaN 或 Infinity");
    }
    if (token.length > MAX_NUMBER_TOKEN_CHARACTERS) {
      throw new Error("单个数值文本不能超过 128 个字符");
    }
    if (!NUMBER_TOKEN_PATTERN.test(token)) {
      throw new Error("数值列表只能使用十进制数，并以空白、逗号或分号分隔");
    }
  }
  return tokens;
}

function parseNumberToken(token: string, numericType: DataNumericType): number {
  const integerRange = INTEGER_RANGES[numericType];
  if (integerRange && !INTEGER_TOKEN_PATTERN.test(token)) {
    throw new Error(`${numericType} 只能输入十进制整数`);
  }

  const number = Number(token);
  if (!Number.isFinite(number)) {
    throw new Error("数值必须是有限值，不能使用 NaN 或 Infinity");
  }
  if (integerRange && (number < integerRange[0] || number > integerRange[1])) {
    throw new Error(`${token} 超出 ${numericType} 的范围 ${integerRange[0]}..${integerRange[1]}`);
  }
  return number;
}

function readNumbers(
  bytes: Uint8Array,
  numericType: DataNumericType,
  endianness: DataConverterEndianness,
): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteWidth = numericTypeByteWidth(numericType);
  const littleEndian = endianness === "le";
  const numbers: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += byteWidth) {
    const number = readNumber(view, offset, numericType, littleEndian);
    if (!Number.isFinite(number)) {
      throw new Error("字节数据解码为 NaN 或 Infinity，请检查类型和字节序");
    }
    numbers.push(number);
  }
  return numbers;
}

function readNumber(
  view: DataView,
  offset: number,
  numericType: DataNumericType,
  littleEndian: boolean,
): number {
  switch (numericType) {
    case "u8":
      return view.getUint8(offset);
    case "i8":
      return view.getInt8(offset);
    case "u16":
      return view.getUint16(offset, littleEndian);
    case "i16":
      return view.getInt16(offset, littleEndian);
    case "u32":
      return view.getUint32(offset, littleEndian);
    case "i32":
      return view.getInt32(offset, littleEndian);
    case "f32":
      return view.getFloat32(offset, littleEndian);
    case "f64":
      return view.getFloat64(offset, littleEndian);
  }
}

function writeNumber(
  view: DataView,
  offset: number,
  value: number,
  numericType: DataNumericType,
  littleEndian: boolean,
): void {
  switch (numericType) {
    case "u8":
      view.setUint8(offset, value);
      break;
    case "i8":
      view.setInt8(offset, value);
      break;
    case "u16":
      view.setUint16(offset, value, littleEndian);
      break;
    case "i16":
      view.setInt16(offset, value, littleEndian);
      break;
    case "u32":
      view.setUint32(offset, value, littleEndian);
      break;
    case "i32":
      view.setInt32(offset, value, littleEndian);
      break;
    case "f32":
      view.setFloat32(offset, value, littleEndian);
      break;
    case "f64":
      view.setFloat64(offset, value, littleEndian);
      break;
  }
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : value.toString();
}

function validateByteLimit(byteCount: number): void {
  if (byteCount > MAX_DATA_CONVERTER_OUTPUT_BYTES) {
    throw new Error("转换结果不能超过 64 KiB");
  }
}
