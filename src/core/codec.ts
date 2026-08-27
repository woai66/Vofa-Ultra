import type { DisplayMode, LineEnding } from "../types/serial";
import type { TerminalTextEncoding } from "../types/workbench";
import { encodeText } from "./textEncoding";

const LINE_ENDING_BYTES: Record<LineEnding, readonly number[]> = {
  none: [],
  lf: [0x0a],
  cr: [0x0d],
  crlf: [0x0d, 0x0a],
};

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeOutbound(
  value: string,
  mode: DisplayMode,
  lineEnding: LineEnding,
  textEncoding: TerminalTextEncoding = "utf-8",
): Uint8Array {
  const bytes = mode === "hex" ? parseHex(value) : encodeText(value, textEncoding);
  const suffix = encodeLineEnding(lineEnding);
  const result = new Uint8Array(bytes.length + suffix.length);
  result.set(bytes);
  result.set(suffix, bytes.length);
  return result;
}

export function encodeLineEnding(lineEnding: LineEnding): Uint8Array {
  return Uint8Array.from(LINE_ENDING_BYTES[lineEnding]);
}

export function parseHex(value: string): Uint8Array {
  const tokens = value.split(/[\s,;:_-]+/).filter(Boolean);
  if (tokens.length === 0) {
    return new Uint8Array();
  }

  let byteLength = 0;
  const normalizedTokens = tokens.map((token) => {
    const digits = /^0x/i.test(token) ? token.slice(2) : token;
    if (digits.length === 0) {
      throw new Error("HEX 数据必须由完整字节组成");
    }
    if (!/^[0-9a-f]+$/i.test(digits)) {
      throw new Error("HEX 数据只能包含 0-9 和 A-F");
    }
    if (digits.length % 2 !== 0) {
      throw new Error("HEX 数据必须由完整字节组成");
    }
    byteLength += digits.length / 2;
    return digits;
  });

  const bytes = new Uint8Array(byteLength);
  let byteOffset = 0;
  for (const token of normalizedTokens) {
    for (let index = 0; index < token.length; index += 2) {
      bytes[byteOffset] = Number.parseInt(token.slice(index, index + 2), 16);
      byteOffset += 1;
    }
  }
  return bytes;
}

export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
