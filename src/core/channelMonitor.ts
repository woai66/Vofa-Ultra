import type { ChannelSeries } from "../types/workbench";

export const CHANNEL_MONITOR_SAMPLE_LIMIT = 256;

export interface ChannelMonitorStats {
  readonly current: number;
  readonly delta: number | null;
  readonly minimum: number;
  readonly maximum: number;
  readonly mean: number;
  readonly rms: number;
  readonly sampleCount: number;
  readonly firstTimestampSeconds: number | null;
  readonly lastTimestampSeconds: number | null;
  readonly spanSeconds: number | null;
}

export function calculateChannelMonitorStats(
  channel: Pick<ChannelSeries, "points" | "lastValue">,
): ChannelMonitorStats | null {
  const samples: Array<{ timestampSeconds: number; value: number }> = [];
  const firstSourceIndex = Math.max(0, channel.points.length - CHANNEL_MONITOR_SAMPLE_LIMIT);
  for (let index = firstSourceIndex; index < channel.points.length; index += 1) {
    const point = channel.points[index];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      samples.push({ timestampSeconds: point.x, value: point.y });
    }
  }

  if (samples.length === 0) {
    return Number.isFinite(channel.lastValue)
      ? singleValueStats(channel.lastValue)
      : null;
  }

  const values = samples.map((sample) => sample.value);
  const current = values.at(-1) ?? channel.lastValue;
  const previous = values.at(-2);
  const rawDelta = previous === undefined ? null : current - previous;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const maximumAbsolute = values.reduce(
    (maximumValue, value) => Math.max(maximumValue, Math.abs(value)),
    0,
  );
  const { mean, rms } = normalizedMoments(values, maximumAbsolute);
  const firstTimestampSeconds = samples[0]?.timestampSeconds ?? null;
  const lastTimestampSeconds = samples.at(-1)?.timestampSeconds ?? null;
  const rawSpan =
    firstTimestampSeconds === null || lastTimestampSeconds === null
      ? null
      : lastTimestampSeconds - firstTimestampSeconds;

  return {
    current,
    delta: rawDelta !== null && Number.isFinite(rawDelta) ? rawDelta : null,
    minimum,
    maximum,
    mean,
    rms,
    sampleCount: values.length,
    firstTimestampSeconds,
    lastTimestampSeconds,
    spanSeconds: rawSpan !== null && Number.isFinite(rawSpan) ? rawSpan : null,
  };
}

function normalizedMoments(
  values: readonly number[],
  maximumAbsolute: number,
): { mean: number; rms: number } {
  if (maximumAbsolute === 0) {
    return { mean: 0, rms: 0 };
  }

  let normalizedSum = 0;
  let normalizedSquareSum = 0;
  for (const value of values) {
    const normalized = value / maximumAbsolute;
    normalizedSum += normalized;
    normalizedSquareSum += normalized * normalized;
  }
  return {
    mean: maximumAbsolute * (normalizedSum / values.length),
    rms: maximumAbsolute * Math.sqrt(normalizedSquareSum / values.length),
  };
}

function singleValueStats(value: number): ChannelMonitorStats {
  return {
    current: value,
    delta: null,
    minimum: value,
    maximum: value,
    mean: value,
    rms: Math.abs(value),
    sampleCount: 1,
    firstTimestampSeconds: null,
    lastTimestampSeconds: null,
    spanSeconds: null,
  };
}
