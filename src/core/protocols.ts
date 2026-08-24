import type { ParsedFrame } from "../types/workbench";
import { PROTOCOL_IDS, type ProtocolKind } from "../types/serial";

const JUSTFLOAT_TAIL = new Uint8Array([0x00, 0x00, 0x80, 0x7f]);
const MAX_FIREWATER_LINE_LENGTH = 16 * 1024;
export const MAX_PROTOCOL_CHANNELS = 16;
export const MAX_PROTOCOL_LABEL_LENGTH = 64;
const MAX_JUSTFLOAT_FRAME_LENGTH =
  MAX_PROTOCOL_CHANNELS * Float32Array.BYTES_PER_ELEMENT;
const MAX_JUSTFLOAT_PENDING_LENGTH =
  MAX_JUSTFLOAT_FRAME_LENGTH + JUSTFLOAT_TAIL.length - 1;

export type ReplaySeekMode = "record-boundary" | "unsupported";

export interface ProtocolParser {
  push(bytes: Uint8Array, timestamp: number): ParsedFrame[];
  reset(): void;
}

export interface BuiltinProtocolDefinition {
  readonly id: ProtocolKind;
  readonly displayName: string;
  readonly description: string;
  readonly replaySeekMode: ReplaySeekMode;
  createParser(): ProtocolParser;
  encodeSimulatorSample(values: readonly number[], sampleIndex: number): Uint8Array;
}

export class FireWaterParser implements ProtocolParser {
  private decoder = new TextDecoder();
  private pending = "";
  private discardingLine = false;

  push(bytes: Uint8Array, timestamp: number): ParsedFrame[] {
    const decoded = this.decoder.decode(bytes, { stream: true });
    const frames: ParsedFrame[] = [];

    let start = 0;
    for (let index = decoded.indexOf("\n"); index >= 0; index = decoded.indexOf("\n", start)) {
      if (this.discardingLine) {
        this.discardingLine = false;
      } else {
        const segment = decoded.slice(start, index);
        if (this.pending.length + segment.length <= MAX_FIREWATER_LINE_LENGTH) {
          const frame = parseFireWaterLine(this.pending + segment, timestamp);
          if (frame) {
            frames.push(frame);
          }
        }
        this.pending = "";
      }
      start = index + 1;
    }

    const remainder = decoded.slice(start);
    if (!this.discardingLine) {
      if (this.pending.length + remainder.length <= MAX_FIREWATER_LINE_LENGTH) {
        this.pending += remainder;
      } else {
        this.pending = "";
        this.discardingLine = true;
      }
    }
    return frames;
  }

  reset(): void {
    this.pending = "";
    this.discardingLine = false;
    this.decoder = new TextDecoder();
  }
}

export class JustFloatParser implements ProtocolParser {
  private pending: Uint8Array = new Uint8Array();
  private discardingFrame = false;

  push(bytes: Uint8Array, timestamp: number): ParsedFrame[] {
    const buffer = concatBytes(this.pending, bytes);
    const frames: ParsedFrame[] = [];
    let frameStart = 0;

    let tailIndex = findSequence(buffer, JUSTFLOAT_TAIL, frameStart);
    while (tailIndex >= 0) {
      const frameLength = tailIndex - frameStart;
      if (
        !this.discardingFrame &&
        frameLength > 0 &&
        frameLength <= MAX_JUSTFLOAT_FRAME_LENGTH &&
        frameLength % Float32Array.BYTES_PER_ELEMENT === 0
      ) {
        const values = parseFiniteFloat32Values(buffer, frameStart, frameLength);
        if (values) {
          frames.push({ values, timestamp });
        }
      }

      this.discardingFrame = false;
      frameStart = tailIndex + JUSTFLOAT_TAIL.length;
      tailIndex = findSequence(buffer, JUSTFLOAT_TAIL, frameStart);
    }

    const remainder = buffer.slice(frameStart);
    if (this.discardingFrame || remainder.length > MAX_JUSTFLOAT_PENDING_LENGTH) {
      this.discardingFrame = true;
      this.pending = remainder.slice(-(JUSTFLOAT_TAIL.length - 1));
    } else {
      this.pending = remainder;
    }
    return frames;
  }

  reset(): void {
    this.pending = new Uint8Array();
    this.discardingFrame = false;
  }
}

export function encodeFireWaterFrame(values: readonly number[]): Uint8Array {
  assertEncodableValues(values);
  return new TextEncoder().encode(`${values.map((value) => value.toFixed(4)).join(",")}\n`);
}

export function encodeJustFloatFrame(values: readonly number[]): Uint8Array {
  assertEncodableValues(values);
  if (values.some((value) => !Number.isFinite(Math.fround(value)))) {
    throw new RangeError("JustFloat 数值必须能表示为有限 float32");
  }
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT + JUSTFLOAT_TAIL.length);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  bytes.set(JUSTFLOAT_TAIL, values.length * Float32Array.BYTES_PER_ELEMENT);
  return bytes;
}

const RAW_ENCODER = new TextEncoder();

const protocolRegistry = {
  firewater: Object.freeze({
    id: "firewater",
    displayName: "FireWater",
    description: "文本帧",
    replaySeekMode: "unsupported",
    createParser: () => new FireWaterParser(),
    encodeSimulatorSample: (values: readonly number[]) => encodeFireWaterFrame(values),
  }),
  justfloat: Object.freeze({
    id: "justfloat",
    displayName: "JustFloat",
    description: "浮点帧",
    replaySeekMode: "unsupported",
    createParser: () => new JustFloatParser(),
    encodeSimulatorSample: (values: readonly number[]) => encodeJustFloatFrame(values),
  }),
  raw: Object.freeze({
    id: "raw",
    displayName: "Raw Data",
    description: "原始字节",
    replaySeekMode: "record-boundary",
    createParser: (): ProtocolParser => ({
      push: () => [],
      reset: () => undefined,
    }),
    encodeSimulatorSample: (values: readonly number[], sampleIndex: number) =>
      RAW_ENCODER.encode(
        `sample=${sampleIndex.toString().padStart(5, "0")} ` +
          `temp=${formatSimulatorValue(values[0])} ` +
          `voltage=${formatSimulatorValue(values[1])} ` +
          `load=${formatSimulatorValue(values[2])}\n`,
      ),
  }),
} as const satisfies Readonly<Record<ProtocolKind, BuiltinProtocolDefinition>>;

export const PROTOCOL_REGISTRY: Readonly<
  Record<ProtocolKind, BuiltinProtocolDefinition>
> = Object.freeze(protocolRegistry);

export const BUILTIN_PROTOCOLS: readonly BuiltinProtocolDefinition[] = Object.freeze(
  PROTOCOL_IDS.map((id) => PROTOCOL_REGISTRY[id]),
);

export function getProtocolDefinition(protocol: ProtocolKind): BuiltinProtocolDefinition {
  return PROTOCOL_REGISTRY[protocol];
}

export function createProtocolParser(protocol: ProtocolKind): ProtocolParser {
  return getProtocolDefinition(protocol).createParser();
}

export function protocolSupportsReplaySeek(protocol: ProtocolKind): boolean {
  return getProtocolDefinition(protocol).replaySeekMode === "record-boundary";
}

function parseFireWaterLine(line: string, timestamp: number): ParsedFrame | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const labels: string[] = [];
  const values: number[] = [];
  const tokens = trimmed.split(/[\s,]+/);
  if (tokens.length > MAX_PROTOCOL_CHANNELS) {
    return null;
  }
  for (const token of tokens) {
    const separatorIndex = token.indexOf(":");
    if (separatorIndex !== token.lastIndexOf(":")) {
      return null;
    }
    const label = separatorIndex > 0 ? token.slice(0, separatorIndex) : "";
    if (label && !isValidProtocolLabel(label)) {
      return null;
    }
    const valueText = separatorIndex > 0 ? token.slice(separatorIndex + 1) : token;
    if (!valueText) {
      return null;
    }
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

function parseFiniteFloat32Values(
  buffer: Uint8Array,
  byteOffset: number,
  byteLength: number,
): number[] | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset + byteOffset, byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) {
      return null;
    }
    values.push(value);
  }
  return values;
}

function assertEncodableValues(values: readonly number[]): void {
  if (
    values.length === 0 ||
    values.length > MAX_PROTOCOL_CHANNELS ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new RangeError(`协议帧必须包含 1 到 ${MAX_PROTOCOL_CHANNELS} 个有限数值`);
  }
}

function isValidProtocolLabel(label: string): boolean {
  return (
    label.length <= MAX_PROTOCOL_LABEL_LENGTH &&
    !Array.from(label).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 44 || code === 58 || (code >= 127 && code <= 159);
    })
  );
}

function formatSimulatorValue(value: number | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "n/a";
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function findSequence(buffer: Uint8Array, sequence: Uint8Array, fromIndex = 0): number {
  const lastStart = buffer.length - sequence.length;
  for (let start = fromIndex; start <= lastStart; start += 1) {
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
