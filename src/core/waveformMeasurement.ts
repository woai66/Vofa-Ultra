import type { DataPoint } from "../types/workbench";

export type WaveformMeasurementCursor = "A" | "B";

export interface WaveformMeasurementAnchors {
  readonly aTimestampSeconds: number;
  readonly bTimestampSeconds: number;
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
        sourceIndex,
      };
    })
    .filter((point): point is OrderedPoint => point !== null)
    .sort((left, right) => {
      const timeDifference = left.timestampSeconds - right.timestampSeconds;
      return timeDifference === 0 ? left.sourceIndex - right.sourceIndex : timeDifference;
    });

  const uniquePoints: OrderedPoint[] = [];
  for (const point of orderedPoints) {
    const previousPoint = uniquePoints.at(-1);
    if (previousPoint?.timestampSeconds === point.timestampSeconds) {
      uniquePoints[uniquePoints.length - 1] = point;
    } else {
      uniquePoints.push(point);
    }
  }

  const latestTimestampSeconds = uniquePoints.at(-1)?.timestampSeconds;
  if (latestTimestampSeconds === undefined) {
    return [];
  }

  const firstVisibleIndex = lowerBound(
    uniquePoints,
    latestTimestampSeconds - windowSeconds,
    (point) => point.timestampSeconds,
  );

  return uniquePoints.slice(firstVisibleIndex).map((point, index) => ({
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
    aTimestampSeconds: pointA.timestampSeconds,
    bTimestampSeconds: pointB.timestampSeconds,
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
  anchorTimestampSeconds: number,
): WaveformMeasurementPoint | null {
  const visiblePoints = getVisibleMeasurementPoints(points, windowSeconds);
  return resolveAnchorInVisiblePoints(visiblePoints, anchorTimestampSeconds);
}

export function moveMeasurementAnchor(
  points: readonly DataPoint[],
  windowSeconds: number,
  anchorTimestampSeconds: number,
  sampleOffset: number,
): WaveformMeasurementPoint | null {
  if (!Number.isInteger(sampleOffset)) {
    return null;
  }

  const visiblePoints = getVisibleMeasurementPoints(points, windowSeconds);
  const currentPoint = resolveAnchorInVisiblePoints(visiblePoints, anchorTimestampSeconds);
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
  const resolvedA = resolveAnchorInVisiblePoints(visiblePoints, anchors.aTimestampSeconds);
  const resolvedB = resolveAnchorInVisiblePoints(visiblePoints, anchors.bTimestampSeconds);
  if (!resolvedA || !resolvedB) {
    return null;
  }

  const [pointA, pointB] =
    resolvedA.timestampSeconds <= resolvedB.timestampSeconds
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

function resolveAnchorInVisiblePoints(
  visiblePoints: readonly WaveformMeasurementPoint[],
  anchorTimestampSeconds: number,
): WaveformMeasurementPoint | null {
  if (!Number.isFinite(anchorTimestampSeconds)) {
    return null;
  }

  const firstPoint = visiblePoints[0];
  const lastPoint = visiblePoints.at(-1);
  if (
    !firstPoint ||
    !lastPoint ||
    anchorTimestampSeconds < firstPoint.timestampSeconds ||
    anchorTimestampSeconds > lastPoint.timestampSeconds
  ) {
    return null;
  }

  return snapToNearestMeasurementPoint(visiblePoints, anchorTimestampSeconds);
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
