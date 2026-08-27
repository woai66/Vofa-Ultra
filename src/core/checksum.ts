import crc16modbus from "crc/calculators/crc16modbus";
import crc32 from "crc/calculators/crc32";
import { parseHex } from "./codec";

export type ChecksumInputMode = "text" | "hex";

export const COMMAND_CHECKSUM_MODES = [
  { value: "none", label: "无" },
  { value: "crc16-modbus-le", label: "CRC-16/MODBUS（低字节在前）" },
  { value: "crc16-modbus-be", label: "CRC-16/MODBUS（高字节在前）" },
  { value: "crc32-le", label: "CRC-32（低字节在前）" },
  { value: "crc32-be", label: "CRC-32（高字节在前）" },
  { value: "xor8", label: "XOR-8" },
  { value: "sum8", label: "SUM-8" },
] as const;

export type CommandChecksumMode = (typeof COMMAND_CHECKSUM_MODES)[number]["value"];

export const DEFAULT_COMMAND_CHECKSUM_MODE: CommandChecksumMode = "none";

export const MAX_CHECKSUM_INPUT_CHARACTERS = 256 * 1024;
export const MAX_CHECKSUM_INPUT_BYTES = 64 * 1024;

export interface ChecksumResult {
  byteCount: number;
  crc16Modbus: number;
  crc32: number;
  xor8: number;
  sum8: number;
}

export function parseCommandChecksumMode(value: unknown): CommandChecksumMode {
  const option = COMMAND_CHECKSUM_MODES.find((candidate) => candidate.value === value);
  if (!option) {
    throw new Error("命令校验模式无效");
  }
  return option.value;
}

export function createCommandChecksumSuffix(
  payload: Uint8Array,
  mode: CommandChecksumMode,
): Uint8Array {
  const parsedMode = parseCommandChecksumMode(mode);
  switch (parsedMode) {
    case "none":
      return new Uint8Array();
    case "crc16-modbus-le":
    case "crc16-modbus-be":
    case "crc32-le":
    case "crc32-be": {
      const byteLength = parsedMode.startsWith("crc16") ? 2 : 4;
      const bytes = new Uint8Array(byteLength);
      const view = new DataView(bytes.buffer);
      const value = byteLength === 2 ? crc16modbus(payload) : crc32(payload);
      if (byteLength === 2) {
        view.setUint16(0, value, parsedMode.endsWith("-le"));
      } else {
        view.setUint32(0, value, parsedMode.endsWith("-le"));
      }
      return bytes;
    }
    case "xor8":
    case "sum8": {
      let value = 0;
      for (const byte of payload) {
        value = parsedMode === "xor8" ? value ^ byte : value + byte;
      }
      return Uint8Array.of(value & 0xff);
    }
  }
}

export function calculateChecksums(
  value: string,
  mode: ChecksumInputMode,
): ChecksumResult {
  if (value.length > MAX_CHECKSUM_INPUT_CHARACTERS) {
    throw new Error("校验输入文本不能超过 256 KiB");
  }

  const bytes = mode === "hex" ? parseHex(value) : new TextEncoder().encode(value);
  if (bytes.length > MAX_CHECKSUM_INPUT_BYTES) {
    throw new Error("校验输入不能超过 64 KiB");
  }

  let xor8 = 0;
  let sum8 = 0;
  for (const byte of bytes) {
    xor8 ^= byte;
    sum8 = (sum8 + byte) & 0xff;
  }

  return {
    byteCount: bytes.length,
    crc16Modbus: crc16modbus(bytes) & 0xffff,
    crc32: crc32(bytes) >>> 0,
    xor8,
    sum8,
  };
}
