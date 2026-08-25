import type { TerminalRxLineEnding } from "../types/workbench";

export const MAX_TERMINAL_UNTERMINATED_LINE_BYTES = 2_048;
export const MAX_TERMINAL_LINE_ENDING_BYTES = 2;

export interface AssembledTerminalLine {
  readonly bytes: Uint8Array;
  readonly timestamp: number;
  readonly boundary: "line" | "overflow" | "unterminated";
}

const LINE_ENDING_BYTES: Readonly<Record<TerminalRxLineEnding, Uint8Array>> = {
  lf: Uint8Array.of(0x0a),
  crlf: Uint8Array.of(0x0d, 0x0a),
  cr: Uint8Array.of(0x0d),
};

export class TerminalLineAssembler {
  private pending = new Uint8Array();
  private pendingTimestamp: number | null = null;

  constructor(
    private readonly maxUnterminatedBytes = MAX_TERMINAL_UNTERMINATED_LINE_BYTES,
  ) {
    if (!Number.isSafeInteger(maxUnterminatedBytes) || maxUnterminatedBytes < 1) {
      throw new Error("终端未结束行上限必须是正整数");
    }
  }

  push(
    bytes: Uint8Array,
    timestamp: number,
    lineEnding: TerminalRxLineEnding,
  ): AssembledTerminalLine[] {
    if (bytes.length === 0) {
      return [];
    }

    const previousLength = this.pending.length;
    const combined = new Uint8Array(previousLength + bytes.length);
    combined.set(this.pending);
    combined.set(bytes, previousLength);

    const delimiter = LINE_ENDING_BYTES[lineEnding];
    const lines: AssembledTerminalLine[] = [];
    let start = 0;
    let lineTimestamp = this.pendingTimestamp ?? timestamp;

    while (start < combined.length) {
      const delimiterIndex = findDelimiter(combined, delimiter, start);
      if (
        delimiterIndex >= 0 &&
        delimiterIndex - start <= this.maxUnterminatedBytes
      ) {
        const end = delimiterIndex + delimiter.length;
        lines.push({
          bytes: combined.slice(start, end),
          timestamp: lineTimestamp,
          boundary: "line",
        });
        start = end;
        lineTimestamp = timestampForIndex(
          start,
          previousLength,
          this.pendingTimestamp,
          timestamp,
        );
        continue;
      }

      const possibleDelimiterPrefixLength =
        delimiterIndex < 0 ? matchingDelimiterPrefixLength(combined, delimiter, start) : 0;
      const confirmedPayloadLength =
        combined.length - start - possibleDelimiterPrefixLength;
      if (confirmedPayloadLength > this.maxUnterminatedBytes) {
        const end = start + this.maxUnterminatedBytes;
        lines.push({
          bytes: combined.slice(start, end),
          timestamp: lineTimestamp,
          boundary: "overflow",
        });
        start = end;
        lineTimestamp = timestampForIndex(
          start,
          previousLength,
          this.pendingTimestamp,
          timestamp,
        );
        continue;
      }
      break;
    }

    this.pending = combined.slice(start);
    this.pendingTimestamp = this.pending.length > 0 ? lineTimestamp : null;
    return lines;
  }

  flush(): AssembledTerminalLine | null {
    if (this.pending.length === 0 || this.pendingTimestamp === null) {
      return null;
    }
    const line = {
      bytes: this.pending,
      timestamp: this.pendingTimestamp,
      boundary: "unterminated" as const,
    };
    this.reset();
    return line;
  }

  reset(): void {
    this.pending = new Uint8Array();
    this.pendingTimestamp = null;
  }

  get pendingByteCount(): number {
    return this.pending.length;
  }
}

function matchingDelimiterPrefixLength(
  bytes: Uint8Array,
  delimiter: Uint8Array,
  start: number,
): number {
  const maximumLength = Math.min(delimiter.length - 1, bytes.length - start);
  for (let length = maximumLength; length > 0; length -= 1) {
    const suffixStart = bytes.length - length;
    let matches = true;
    for (let offset = 0; offset < length; offset += 1) {
      if (bytes[suffixStart + offset] !== delimiter[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return length;
    }
  }
  return 0;
}

function timestampForIndex(
  index: number,
  previousLength: number,
  pendingTimestamp: number | null,
  currentTimestamp: number,
): number {
  return index < previousLength ? (pendingTimestamp ?? currentTimestamp) : currentTimestamp;
}

function findDelimiter(
  bytes: Uint8Array,
  delimiter: Uint8Array,
  start: number,
): number {
  const lastStart = bytes.length - delimiter.length;
  for (let index = start; index <= lastStart; index += 1) {
    if (bytes[index] !== delimiter[0]) {
      continue;
    }
    let matches = true;
    for (let offset = 1; offset < delimiter.length; offset += 1) {
      if (bytes[index + offset] !== delimiter[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }
  return -1;
}
