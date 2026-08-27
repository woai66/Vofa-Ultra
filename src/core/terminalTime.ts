export const TERMINAL_TIME_MODES = ["absolute", "relative", "interval"] as const;
export type TerminalTimeMode = (typeof TERMINAL_TIME_MODES)[number];

export const DEFAULT_TERMINAL_TIME_MODE: TerminalTimeMode = "absolute";
export const TERMINAL_TIME_MODE_STORAGE_KEY = "vofa-ultra-terminal-time-mode";

const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

export function parseTerminalTimeMode(value: unknown): TerminalTimeMode {
  return TERMINAL_TIME_MODES.some((mode) => mode === value)
    ? (value as TerminalTimeMode)
    : DEFAULT_TERMINAL_TIME_MODE;
}

export function formatTerminalTime(
  timestamp: number,
  mode: TerminalTimeMode,
  originTimestamp?: number,
  previousTimestamp?: number,
): string {
  if (!Number.isFinite(timestamp)) {
    return "--";
  }
  if (mode === "absolute") {
    try {
      return ABSOLUTE_TIME_FORMATTER.format(timestamp);
    } catch {
      return "--";
    }
  }

  const referenceTimestamp = mode === "relative" ? originTimestamp : previousTimestamp;
  if (!Number.isFinite(referenceTimestamp)) {
    return "--";
  }
  return formatSignedDuration(timestamp - (referenceTimestamp as number));
}

export function terminalTimeDateTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

function formatSignedDuration(durationMilliseconds: number): string {
  if (!Number.isFinite(durationMilliseconds)) {
    return "--";
  }
  const roundedMilliseconds = Math.round(durationMilliseconds);
  const sign = roundedMilliseconds < 0 ? "-" : "+";
  let remainingMilliseconds = Math.abs(roundedMilliseconds);
  const hours = Math.floor(remainingMilliseconds / 3_600_000);
  remainingMilliseconds %= 3_600_000;
  const minutes = Math.floor(remainingMilliseconds / 60_000);
  remainingMilliseconds %= 60_000;
  const seconds = Math.floor(remainingMilliseconds / 1_000);
  const milliseconds = remainingMilliseconds % 1_000;
  return (
    `${sign}${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.` +
    String(milliseconds).padStart(3, "0")
  );
}
