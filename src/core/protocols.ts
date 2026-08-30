import type {
  ParsedFrame,
  ProtocolDropReason,
  ProtocolHealthSnapshot,
} from "../types/workbench";
import { PROTOCOL_IDS, type ProtocolKind } from "../types/serial";

const JUSTFLOAT_TAIL = new Uint8Array([0x00, 0x00, 0x80, 0x7f]);
const MAX_FIREWATER_LINE_LENGTH = 16 * 1024;
export const MAX_PROTOCOL_CHANNELS = 16;
export const MAX_PROTOCOL_LABEL_LENGTH = 64;
const MAX_JUSTFLOAT_FRAME_LENGTH =
  MAX_PROTOCOL_CHANNELS * Float32Array.BYTES_PER_ELEMENT;
const MAX_JUSTFLOAT_PENDING_LENGTH =
  MAX_JUSTFLOAT_FRAME_LENGTH + JUSTFLOAT_TAIL.length - 1;
export const MAX_PROTOCOL_HEALTH_COUNT = 0xffff_ffff;

const PROTOCOL_DROP_REASONS = [
  "unit-too-long",
  "too-many-channels",
  "invalid-format",
  "invalid-label",
  "non-finite-value",
  "misaligned-length",
] as const satisfies readonly ProtocolDropReason[];

export const PROTOCOL_DROP_REASON_LABELS: Readonly<Record<ProtocolDropReason, string>> =
  Object.freeze({
    "unit-too-long": "单元超过长度上限",
    "too-many-channels": "通道数量超过上限",
    "invalid-format": "帧格式无效",
    "invalid-label": "通道标签无效",
    "non-finite-value": "包含非有限数值",
    "misaligned-length": "浮点帧长度未按 4 字节对齐",
  });

export type ReplaySeekMode = "record-boundary" | "protocol-boundary" | "unsupported";

export interface ProtocolParser {
  push(bytes: Uint8Array, timestamp: number): ParsedFrame[];
  getHealthSnapshot(): ProtocolHealthSnapshot;
  clearHealth(): void;
  reset(): void;
}

export interface BuiltinProtocolDefinition {
  readonly id: ProtocolKind;
  readonly displayName: string;
  readonly description: string;
  readonly replaySeekMode: ReplaySeekMode;
  createParser(): ProtocolParser;
  encodeSimulatorSample?(values: readonly number[], sampleIndex: number): Uint8Array;
}

export class FireWaterParser implements ProtocolParser {
  private decoder = new TextDecoder();
  private pending = "";
  private discardingLine = false;
  private readonly health = new ProtocolHealthTracker();

  push(bytes: Uint8Array, timestamp: number): ParsedFrame[] {
    const decoded = this.decoder.decode(bytes, { stream: true });
    const frames: ParsedFrame[] = [];

    let start = 0;
    for (let index = decoded.indexOf("\n"); index >= 0; index = decoded.indexOf("\n", start)) {
      if (this.discardingLine) {
        this.discardingLine = false;
        this.health.resync();
      } else {
        const segment = decoded.slice(start, index);
        if (this.pending.length + segment.length <= MAX_FIREWATER_LINE_LENGTH) {
          const result = parseFireWaterLine(this.pending + segment, timestamp);
          if (result.frame) {
            frames.push(result.frame);
            this.health.accept();
          } else if (result.reason) {
            this.health.drop(result.reason, timestamp);
          }
        } else {
          this.health.drop("unit-too-long", timestamp);
          this.health.resync();
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
        this.health.drop("unit-too-long", timestamp);
      }
    }
    return frames;
  }

  getHealthSnapshot(): ProtocolHealthSnapshot {
    return this.health.getSnapshot();
  }

  clearHealth(): void {
    this.health.clear();
  }

  reset(): void {
    this.pending = "";
    this.discardingLine = false;
    this.decoder = new TextDecoder();
    this.health.clear();
  }
}

export class JustFloatParser implements ProtocolParser {
  private pending: Uint8Array = new Uint8Array();
  private discardingFrame = false;
  private readonly health = new ProtocolHealthTracker();

  push(bytes: Uint8Array, timestamp: number): ParsedFrame[] {
    const buffer = concatBytes(this.pending, bytes);
    const frames: ParsedFrame[] = [];
    let frameStart = 0;

    let tailIndex = findJustFloatTail(buffer, frameStart, this.discardingFrame);
    while (tailIndex >= 0) {
      const frameLength = tailIndex - frameStart;
      if (this.discardingFrame) {
        this.health.resync();
      } else if (frameLength === 0) {
        this.health.drop("invalid-format", timestamp);
      } else if (frameLength > MAX_JUSTFLOAT_FRAME_LENGTH) {
        this.health.drop("unit-too-long", timestamp);
        this.health.resync();
      } else if (frameLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        this.health.drop("misaligned-length", timestamp);
      } else {
        const values = parseFiniteFloat32Values(buffer, frameStart, frameLength);
        if (!values) {
          this.health.drop("non-finite-value", timestamp);
        } else {
          frames.push({ values, timestamp });
          this.health.accept();
        }
      }

      this.discardingFrame = false;
      frameStart = tailIndex + JUSTFLOAT_TAIL.length;
      tailIndex = findJustFloatTail(buffer, frameStart, this.discardingFrame);
    }

    const remainder = buffer.slice(frameStart);
    if (this.discardingFrame || remainder.length > MAX_JUSTFLOAT_PENDING_LENGTH) {
      if (!this.discardingFrame) {
        this.health.drop("unit-too-long", timestamp);
      }
      this.discardingFrame = true;
      this.pending = remainder.slice(-(JUSTFLOAT_TAIL.length - 1));
    } else {
      this.pending = remainder;
    }
    return frames;
  }

  getHealthSnapshot(): ProtocolHealthSnapshot {
    return this.health.getSnapshot();
  }

  clearHealth(): void {
    this.health.clear();
  }

  reset(): void {
    this.pending = new Uint8Array();
    this.discardingFrame = false;
    this.health.clear();
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

const protocolRegistry = {
  firewater: Object.freeze({
    id: "firewater",
    displayName: "FireWater",
    description: "文本帧",
    replaySeekMode: "protocol-boundary",
    createParser: () => new FireWaterParser(),
    encodeSimulatorSample: (values: readonly number[]) => encodeFireWaterFrame(values),
  }),
  justfloat: Object.freeze({
    id: "justfloat",
    displayName: "JustFloat",
    description: "浮点帧",
    replaySeekMode: "protocol-boundary",
    createParser: () => new JustFloatParser(),
    encodeSimulatorSample: (values: readonly number[]) => encodeJustFloatFrame(values),
  }),
  raw: Object.freeze({
    id: "raw",
    displayName: "Raw Data",
    description: "原始字节 · 无波形",
    replaySeekMode: "record-boundary",
    createParser: (): ProtocolParser => {
      const health = createEmptyProtocolHealth();
      return {
        push: () => [],
        getHealthSnapshot: () => health,
        clearHealth: () => undefined,
        reset: () => undefined,
      };
    },
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
  return getProtocolDefinition(protocol).replaySeekMode !== "unsupported";
}

interface FireWaterLineResult {
  readonly frame: ParsedFrame | null;
  readonly reason: ProtocolDropReason | null;
}

function parseFireWaterLine(line: string, timestamp: number): FireWaterLineResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return { frame: null, reason: null };
  }

  const labels: string[] = [];
  const values: number[] = [];
  if (trimmed.startsWith(",") || trimmed.endsWith(",") || /,\s*,/.test(trimmed)) {
    return { frame: null, reason: "invalid-format" };
  }
  const tokens = trimmed.split(/[\s,]+/);
  if (tokens.length > MAX_PROTOCOL_CHANNELS) {
    return { frame: null, reason: "too-many-channels" };
  }
  let namedSeparator: ":" | "=" | null = null;
  for (const token of tokens) {
    const colonIndex = token.indexOf(":");
    const equalsIndex = token.indexOf("=");
    if (colonIndex >= 0 && equalsIndex >= 0) {
      return { frame: null, reason: "invalid-format" };
    }
    const separator = colonIndex >= 0 ? ":" : equalsIndex >= 0 ? "=" : null;
    const separatorIndex = separator === ":" ? colonIndex : equalsIndex;
    if (
      separator !== null &&
      (separatorIndex !== token.lastIndexOf(separator) ||
        separatorIndex === 0 ||
        (namedSeparator !== null && namedSeparator !== separator))
    ) {
      return { frame: null, reason: "invalid-format" };
    }
    if (separator !== null) {
      namedSeparator = separator;
    }
    const label = separator !== null ? token.slice(0, separatorIndex) : "";
    if (label && !isValidProtocolLabel(label)) {
      return { frame: null, reason: "invalid-label" };
    }
    const valueText = separator !== null ? token.slice(separatorIndex + 1) : token;
    if (!valueText) {
      return { frame: null, reason: "invalid-format" };
    }
    const value = Number(valueText);
    if (!Number.isFinite(value)) {
      return { frame: null, reason: "non-finite-value" };
    }
    labels.push(label);
    values.push(value);
  }

  return {
    frame: {
      values,
      labels: labels.some(Boolean) ? labels : undefined,
      timestamp,
    },
    reason: null,
  };
}

export function createEmptyProtocolHealth(): ProtocolHealthSnapshot {
  return createProtocolHealthSnapshot(0, 0, 0, createEmptyReasonCounts(), null, null);
}

export class ProtocolHealthTracker {
  private acceptedFrames = 0;
  private droppedFrames = 0;
  private resyncCount = 0;
  private reasonCounts = createEmptyReasonCounts();
  private lastDropReason: ProtocolDropReason | null = null;
  private lastDropAt: number | null = null;
  private cachedSnapshot: ProtocolHealthSnapshot | null = createEmptyProtocolHealth();

  accept(): void {
    const acceptedFrames = incrementProtocolHealthCount(this.acceptedFrames);
    if (acceptedFrames !== this.acceptedFrames) {
      this.acceptedFrames = acceptedFrames;
      this.cachedSnapshot = null;
    }
  }

  drop(reason: ProtocolDropReason, timestamp: number): void {
    this.droppedFrames = incrementProtocolHealthCount(this.droppedFrames);
    this.reasonCounts[reason] = incrementProtocolHealthCount(this.reasonCounts[reason]);
    this.lastDropReason = reason;
    this.lastDropAt = timestamp;
    this.cachedSnapshot = null;
  }

  resync(): void {
    const resyncCount = incrementProtocolHealthCount(this.resyncCount);
    if (resyncCount !== this.resyncCount) {
      this.resyncCount = resyncCount;
      this.cachedSnapshot = null;
    }
  }

  getSnapshot(): ProtocolHealthSnapshot {
    this.cachedSnapshot ??= createProtocolHealthSnapshot(
      this.acceptedFrames,
      this.droppedFrames,
      this.resyncCount,
      this.reasonCounts,
      this.lastDropReason,
      this.lastDropAt,
    );
    return this.cachedSnapshot;
  }

  clear(): void {
    this.acceptedFrames = 0;
    this.droppedFrames = 0;
    this.resyncCount = 0;
    this.reasonCounts = createEmptyReasonCounts();
    this.lastDropReason = null;
    this.lastDropAt = null;
    this.cachedSnapshot = createEmptyProtocolHealth();
  }
}

function createEmptyReasonCounts(): Record<ProtocolDropReason, number> {
  return Object.fromEntries(
    PROTOCOL_DROP_REASONS.map((reason) => [reason, 0]),
  ) as Record<ProtocolDropReason, number>;
}

function createProtocolHealthSnapshot(
  acceptedFrames: number,
  droppedFrames: number,
  resyncCount: number,
  reasonCounts: Readonly<Record<ProtocolDropReason, number>>,
  lastDropReason: ProtocolDropReason | null,
  lastDropAt: number | null,
): ProtocolHealthSnapshot {
  return Object.freeze({
    acceptedFrames,
    droppedFrames,
    resyncCount,
    reasonCounts: Object.freeze({ ...reasonCounts }),
    lastDropReason,
    lastDropAt,
  });
}

export function incrementProtocolHealthCount(value: number): number {
  return Math.min(value + 1, MAX_PROTOCOL_HEALTH_COUNT);
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
      return (
        code <= 32 ||
        code === 44 ||
        code === 58 ||
        code === 61 ||
        (code >= 127 && code <= 159)
      );
    })
  );
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function findJustFloatTail(
  buffer: Uint8Array,
  frameStart: number,
  allowUnaligned: boolean,
): number {
  let firstUnalignedCandidate = -1;
  let firstCandidateByAlignment: number[] | null = null;
  let repeatedAlignmentMask = 0;
  const lastStart = buffer.length - JUSTFLOAT_TAIL.length;
  for (let start = frameStart; start <= lastStart; start += 1) {
    if (
      buffer[start] !== JUSTFLOAT_TAIL[0] ||
      buffer[start + 1] !== JUSTFLOAT_TAIL[1] ||
      buffer[start + 2] !== JUSTFLOAT_TAIL[2] ||
      buffer[start + 3] !== JUSTFLOAT_TAIL[3]
    ) {
      continue;
    }
    if ((start - frameStart) % Float32Array.BYTES_PER_ELEMENT === 0) {
      return start;
    }

    if (firstUnalignedCandidate < 0) {
      firstUnalignedCandidate = start;
    }
    if (!allowUnaligned) {
      firstCandidateByAlignment ??= [-1, -1, -1, -1];
      const alignment = start % Float32Array.BYTES_PER_ELEMENT;
      if ((firstCandidateByAlignment[alignment] ?? -1) < 0) {
        firstCandidateByAlignment[alignment] = start;
      } else {
        repeatedAlignmentMask |= 1 << alignment;
      }
    }
  }

  if (allowUnaligned) {
    return firstUnalignedCandidate;
  }
  if (!firstCandidateByAlignment || repeatedAlignmentMask === 0) {
    return -1;
  }

  let recoveryCandidate = -1;
  for (let alignment = 0; alignment < Float32Array.BYTES_PER_ELEMENT; alignment += 1) {
    if ((repeatedAlignmentMask & (1 << alignment)) === 0) {
      continue;
    }
    const candidate = firstCandidateByAlignment[alignment] ?? -1;
    if (candidate >= 0 && (recoveryCandidate < 0 || candidate < recoveryCandidate)) {
      recoveryCandidate = candidate;
    }
  }
  return recoveryCandidate;
}
