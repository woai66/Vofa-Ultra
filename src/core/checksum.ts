import crc16modbus from "crc/calculators/crc16modbus";
import crc32 from "crc/calculators/crc32";
import { parseHex } from "./codec";

export type ChecksumInputMode = "text" | "hex";

export const MAX_CHECKSUM_INPUT_CHARACTERS = 256 * 1024;
export const MAX_CHECKSUM_INPUT_BYTES = 64 * 1024;

export interface ChecksumResult {
  byteCount: number;
  crc16Modbus: number;
  crc32: number;
  xor8: number;
  sum8: number;
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
