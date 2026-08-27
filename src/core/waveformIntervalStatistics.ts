export interface WaveformIntervalSample {
  readonly timestampSeconds: number;
  readonly value: number;
}

export interface WaveformIntervalStatistics {
  readonly sampleCount: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly mean: number;
  readonly rms: number;
  readonly peakToPeak: number | null;
}

export function calculateWaveformIntervalStatistics(
  points: readonly WaveformIntervalSample[],
  firstTimestampSeconds: number,
  secondTimestampSeconds: number,
): WaveformIntervalStatistics | null {
  if (!Number.isFinite(firstTimestampSeconds) || !Number.isFinite(secondTimestampSeconds)) {
    return null;
  }

  const intervalStart = Math.min(firstTimestampSeconds, secondTimestampSeconds);
  const intervalEnd = Math.max(firstTimestampSeconds, secondTimestampSeconds);
  let sampleCount = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let magnitudeScale = 0;

  for (const point of points) {
    if (!isFinitePointInInterval(point, intervalStart, intervalEnd)) {
      continue;
    }
    sampleCount += 1;
    minimum = Math.min(minimum, point.value);
    maximum = Math.max(maximum, point.value);
    magnitudeScale = Math.max(magnitudeScale, Math.abs(point.value));
  }

  if (sampleCount === 0) {
    return null;
  }

  let mean = 0;
  let rms = 0;
  if (magnitudeScale > 0) {
    let scaledSum = 0;
    let sumCompensation = 0;
    let scaledSquareSum = 0;
    let squareCompensation = 0;

    for (const point of points) {
      if (!isFinitePointInInterval(point, intervalStart, intervalEnd)) {
        continue;
      }
      const scaledValue = point.value / magnitudeScale;
      const adjustedValue = scaledValue - sumCompensation;
      const nextSum = scaledSum + adjustedValue;
      sumCompensation = nextSum - scaledSum - adjustedValue;
      scaledSum = nextSum;

      const scaledSquare = scaledValue * scaledValue;
      const adjustedSquare = scaledSquare - squareCompensation;
      const nextSquareSum = scaledSquareSum + adjustedSquare;
      squareCompensation = nextSquareSum - scaledSquareSum - adjustedSquare;
      scaledSquareSum = nextSquareSum;
    }

    const normalizedMean = Math.max(-1, Math.min(1, scaledSum / sampleCount));
    const normalizedMeanSquare = Math.max(0, Math.min(1, scaledSquareSum / sampleCount));
    mean = normalizedMean * magnitudeScale;
    rms = Math.sqrt(normalizedMeanSquare) * magnitudeScale;
  }

  const peakToPeak = maximum - minimum;
  return {
    sampleCount,
    minimum,
    maximum,
    mean,
    rms,
    peakToPeak: Number.isFinite(peakToPeak) ? peakToPeak : null,
  };
}

function isFinitePointInInterval(
  point: WaveformIntervalSample,
  intervalStart: number,
  intervalEnd: number,
): boolean {
  return (
    Number.isFinite(point.timestampSeconds) &&
    Number.isFinite(point.value) &&
    point.timestampSeconds >= intervalStart &&
    point.timestampSeconds <= intervalEnd
  );
}
