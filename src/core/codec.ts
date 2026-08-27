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
  const normalized = value
    .replace(/0x/gi, "")
    .replace(/[\s,;:_-]+/g, "")
    .trim();

  if (!normalized) {
    return new Uint8Array();
  }
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error("HEX 数据只能包含 0-9 和 A-F");
  }
  if (normalized.length % 2 !== 0) {
    throw new Error("HEX 数据必须由完整字节组成");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
