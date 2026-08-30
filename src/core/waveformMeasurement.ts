import type { DataPoint } from "../types/workbench";

export type WaveformMeasurementCursor = "A" | "B";

export interface WaveformMeasurementAnchors {
  readonly aIndex: number;
  readonly bIndex: number;
}

export interface WaveformMeasurementPoint {
  readonly index: number;
  readonly timestampSeconds: number;
  readonly value: number;
}

export interface WaveformMeasurementResult {
  readonly pointA: WaveformMeasurementPoint;
  readonly pointB: WaveformMeasurementPoint;
  readonly deltaTimeSeconds: number;
  readonly frequencyHz: number | null;
  readonly deltaY: number;
}

interface OrderedPoint {
  readonly timestampSeconds: number;
  readonly value: number;
  readonly frameSequence: number | null;
  readonly sourceIndex: number;
}

export function getVisibleMeasurementPoints(
  points: readonly DataPoint[],
  windowSeconds: number,
): WaveformMeasurementPoint[] {
  if (!Number.isFinite(windowSeconds) || windowSeconds < 0) {
    return [];
  }

  const orderedPoints = points
    .map<OrderedPoint | null>((point, sourceIndex) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return null;
      }

      return {
        timestampSeconds: point.x,
        value: point.y,
        frameSequence: normalizeFrameSequence(point.frameSequence),
        sourceIndex,
      };
    })
    .filter((point): point is OrderedPoint => point !== null)
    .sort((left, right) => {
      const timeDifference = left.timestampSeconds - right.timestampSeconds;
      if (timeDifference !== 0) {
        return timeDifference;
      }
      if (
        left.frameSequence !== null &&
        right.frameSequence !== null &&
        left.frameSequence !== right.frameSequence
      ) {
        return left.frameSequence < right.frameSequence ? -1 : 1;
      }
      if ((left.frameSequence === null) !== (right.frameSequence === null)) {
        return left.frameSequence === null ? 1 : -1;
      }
      return left.sourceIndex - right.sourceIndex;
    });

  const latestTimestampSeconds = orderedPoints.at(-1)?.timestampSeconds;
  if (latestTimestampSeconds === undefined) {
    return [];
  }

  const firstVisibleIndex = lowerBound(
    orderedPoints,
    latestTimestampSeconds - windowSeconds,
    (point) => point.timestampSeconds,
  );

  return orderedPoints.slice(firstVisibleIndex).map((point, index) => ({
    index,
    timestampSeconds: point.timestampSeconds,
    value: point.value,
  }));
}

export function createInitialMeasurementAnchors(
  points: readonly DataPoint[],
  windowSeconds: number,
): WaveformMeasurementAnchors | null {
  const visiblePoints = getVisibleMeasurementPoints(points, windowSeconds);
  if (visiblePoints.length === 0) {
    return null;
  }

  const lastIndex = visiblePoints.length - 1;
  const pointA = visiblePoints[Math.round(lastIndex * 0.25)];
  const pointB = visiblePoints[Math.round(lastIndex * 0.75)];
  if (!pointA || !pointB) {
    return null;
  }

  return {
    aIndex: pointA.index,
    bIndex: pointB.index,
  };
}

export function snapToNearestMeasurementPoint(
  orderedPoints: readonly WaveformMeasurementPoint[],
  targetTimestampSeconds: number,
): WaveformMeasurementPoint | null {
  if (orderedPoints.length === 0 || !Number.isFinite(targetTimestampSeconds)) {
    return null;
  }

  const insertionIndex = lowerBound(
    orderedPoints,
    targetTimestampSeconds,
    (point) => point.timestampSeconds,
  );
  if (insertionIndex === 0) {
    return orderedPoints[0] ?? null;
  }
  if (insertionIndex === orderedPoints.length) {
    return orderedPoints.at(-1) ?? null;
  }

  const earlierPoint = orderedPoints[insertionIndex - 1];
  const laterPoint = orderedPoints[insertionIndex];
  if (!earlierPoint || !laterPoint) {
    return null;
  }

  const earlierDistance = targetTimestampSeconds - earlierPoint.timestampSeconds;
  const laterDistance = laterPoint.timestampSeconds - targetTimestampSeconds;
  return earlierDistance <= laterDistance ? earlierPoint : laterPoint;
}

export function resolveMeasurementAnchor(
  points: readonly DataPoint[],
  windowSeconds: number,
  anchorIndex: number,
): WaveformMeasurementPoint | null {
  const visiblePoints = getVisibleMeasurementPoints(points, windowSeconds);
  return resolveVisibleMeasurementPoint(visiblePoints, anchorIndex);
}

export function moveMeasurementAnchor(
  points: readonly DataPoint[],
  windowSeconds: number,
  anchorIndex: number,
  sampleOffset: number,
): WaveformMeasurementPoint | null {
  if (!Number.isInteger(sampleOffset)) {
    return null;
  }

  const visiblePoints = getVisibleMeasurementPoints(points, windowSeconds);
  const currentPoint = resolveVisibleMeasurementPoint(visiblePoints, anchorIndex);
  if (!currentPoint) {
    return null;
  }

  const targetIndex = Math.max(0, Math.min(currentPoint.index + sampleOffset, visiblePoints.length - 1));
  return visiblePoints[targetIndex] ?? null;
}

export function calculateWaveformMeasurement(
  points: readonly DataPoint[],
  windowSeconds: number,
  anchors: WaveformMeasurementAnchors,
): WaveformMeasurementResult | null {
  const visiblePoints = getVisibleMeasurementPoints(points, windowSeconds);
  const resolvedA = resolveVisibleMeasurementPoint(visiblePoints, anchors.aIndex);
  const resolvedB = resolveVisibleMeasurementPoint(visiblePoints, anchors.bIndex);
  if (!resolvedA || !resolvedB) {
    return null;
  }

  const [pointA, pointB] =
    resolvedA.index <= resolvedB.index
      ? [resolvedA, resolvedB]
      : [resolvedB, resolvedA];
  const deltaTimeSeconds = pointB.timestampSeconds - pointA.timestampSeconds;

  return {
    pointA,
    pointB,
    deltaTimeSeconds,
    frequencyHz: deltaTimeSeconds === 0 ? null : 1 / deltaTimeSeconds,
    deltaY: pointB.value - pointA.value,
  };
}

function resolveVisibleMeasurementPoint(
  visiblePoints: readonly WaveformMeasurementPoint[],
  index: number,
): WaveformMeasurementPoint | null {
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  return visiblePoints[index] ?? null;
}

function normalizeFrameSequence(frameSequence: number | undefined): number | null {
  return Number.isSafeInteger(frameSequence) ? (frameSequence ?? null) : null;
}

function lowerBound<T>(
  values: readonly T[],
  target: number,
  selectTimestamp: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value && selectTimestamp(value) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}
