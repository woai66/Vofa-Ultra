import type { ParsedFrame } from "../types/workbench";

const JUSTFLOAT_TAIL = new Uint8Array([0x00, 0x00, 0x80, 0x7f]);
const MAX_FIREWATER_LINE_LENGTH = 16 * 1024;
const MAX_JUSTFLOAT_FRAME_LENGTH = 64 * 1024;

export interface ProtocolParser {
  push(bytes: Uint8Array, timestamp?: number): ParsedFrame[];
  reset(): void;
}

export class FireWaterParser implements ProtocolParser {
  private decoder = new TextDecoder();
  private pending = "";

  push(bytes: Uint8Array, timestamp = Date.now()): ParsedFrame[] {
    this.pending += this.decoder.decode(bytes, { stream: true });
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";

    if (this.pending.length > MAX_FIREWATER_LINE_LENGTH) {
      this.pending = "";
      this.decoder = new TextDecoder();
    }

    const frames: ParsedFrame[] = [];
    for (const line of lines) {
      const frame = parseFireWaterLine(line, timestamp);
      if (frame) {
        frames.push(frame);
      }
    }
    return frames;
  }

  reset(): void {
    this.pending = "";
    this.decoder = new TextDecoder();
  }
}

export class JustFloatParser implements ProtocolParser {
  private pending: Uint8Array = new Uint8Array();

  push(bytes: Uint8Array, timestamp = Date.now()): ParsedFrame[] {
    this.pending = concatBytes(this.pending, bytes);
    const frames: ParsedFrame[] = [];

    let tailIndex = findSequence(this.pending, JUSTFLOAT_TAIL);
    while (tailIndex >= 0) {
      const frameBytes = this.pending.slice(0, tailIndex);
      this.pending = this.pending.slice(tailIndex + JUSTFLOAT_TAIL.length);

      if (frameBytes.length > 0 && frameBytes.length % Float32Array.BYTES_PER_ELEMENT === 0) {
        const view = new DataView(
          frameBytes.buffer,
          frameBytes.byteOffset,
          frameBytes.byteLength,
        );
        const values: number[] = [];
        for (let offset = 0; offset < frameBytes.length; offset += Float32Array.BYTES_PER_ELEMENT) {
          values.push(view.getFloat32(offset, true));
        }
        frames.push({ values, timestamp });
      }

      tailIndex = findSequence(this.pending, JUSTFLOAT_TAIL);
    }

    if (this.pending.length > MAX_JUSTFLOAT_FRAME_LENGTH) {
      this.pending = this.pending.slice(-(JUSTFLOAT_TAIL.length - 1));
    }
    return frames;
  }

  reset(): void {
    this.pending = new Uint8Array();
  }
}

export function createProtocolParser(protocol: "firewater" | "justfloat" | "raw"): ProtocolParser {
  switch (protocol) {
    case "firewater":
      return new FireWaterParser();
    case "justfloat":
      return new JustFloatParser();
    case "raw":
      return {
        push: () => [],
        reset: () => undefined,
      };
  }
}

export function encodeFireWaterFrame(values: number[]): Uint8Array {
  return new TextEncoder().encode(`${values.map((value) => value.toFixed(4)).join(",")}\n`);
}

export function encodeJustFloatFrame(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT + JUSTFLOAT_TAIL.length);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  bytes.set(JUSTFLOAT_TAIL, values.length * Float32Array.BYTES_PER_ELEMENT);
  return bytes;
}

function parseFireWaterLine(line: string, timestamp: number): ParsedFrame | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const labels: string[] = [];
  const values: number[] = [];
  const tokens = trimmed.split(/[\s,]+/);
  for (const token of tokens) {
    const separatorIndex = token.lastIndexOf(":");
    const label = separatorIndex > 0 ? token.slice(0, separatorIndex) : "";
    const valueText = separatorIndex > 0 ? token.slice(separatorIndex + 1) : token;
    const value = Number(valueText);
    if (!Number.isFinite(value)) {
      return null;
    }
    labels.push(label);
    values.push(value);
  }

  return {
    values,
    labels: labels.some(Boolean) ? labels : undefined,
    timestamp,
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function findSequence(buffer: Uint8Array, sequence: Uint8Array): number {
  const lastStart = buffer.length - sequence.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (buffer[start + index] !== sequence[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return start;
    }
  }
  return -1;
}
