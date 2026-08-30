import type {
  SerialDataPayload,
  SerialRxObservabilitySnapshot,
  SerialStatePayload,
} from "../types/serial";

export interface SerialRxObservationResult {
  accept: boolean;
  snapshot: SerialRxObservabilitySnapshot;
}

export function createIdleSerialRxObservability(): SerialRxObservabilitySnapshot {
  return {
    status: "idle",
    generation: 0,
    finalized: false,
    backendRxBytes: 0,
    backendRxEvents: 0,
    acceptedRxBytes: 0,
    acceptedRxEvents: 0,
    ipcGapBytes: 0,
    ipcGapEvents: 0,
    duplicateEvents: 0,
    outOfOrderEvents: 0,
    staleGenerationEvents: 0,
    contractViolations: 0,
    unfinalizedGenerations: 0,
    nextSequence: 0,
    nextStreamOffset: 0,
  };
}

export function observeSerialRxState(
  current: SerialRxObservabilitySnapshot,
  payload: SerialStatePayload,
): SerialRxObservabilitySnapshot {
  const generationChanged = payload.generation !== current.generation;
  const unfinalizedGenerations =
    current.unfinalizedGenerations +
    (generationChanged && current.generation > 0 && !current.finalized ? 1 : 0);
  const base = generationChanged
    ? {
        ...createIdleSerialRxObservability(),
        generation: payload.generation,
        status: payload.generation > 0 ? ("monitoring" as const) : ("idle" as const),
        unfinalizedGenerations,
      }
    : current;
  const reportedBackendRxBytes = isCounter(payload.backendRxBytes)
    ? payload.backendRxBytes
    : null;
  const reportedBackendRxEvents = isCounter(payload.backendRxEvents)
    ? payload.backendRxEvents
    : null;
  const countersValid =
    reportedBackendRxBytes !== null && reportedBackendRxEvents !== null;
  const backendRxBytes = Math.max(
    base.backendRxBytes,
    reportedBackendRxBytes ?? base.backendRxBytes,
  );
  const backendRxEvents = Math.max(
    base.backendRxEvents,
    reportedBackendRxEvents ?? base.backendRxEvents,
  );
  const countersRegressed =
    (reportedBackendRxBytes !== null &&
      reportedBackendRxBytes < base.backendRxBytes) ||
    (reportedBackendRxEvents !== null &&
      reportedBackendRxEvents < base.backendRxEvents);
  const next = {
    ...base,
    uiPipeline: payload.uiPipeline ?? base.uiPipeline,
    backendRxBytes,
    backendRxEvents,
    contractViolations:
      base.contractViolations + (!countersValid || countersRegressed ? 1 : 0),
  };

  if (payload.status === "connected" || payload.status === "connecting") {
    return withIntegrityStatus(next, false);
  }
  if (payload.generation === 0 && backendRxBytes === 0 && backendRxEvents === 0) {
    return { ...next, status: "idle", finalized: true };
  }

  const finalGapEvents = Math.max(
    next.ipcGapEvents,
    backendRxEvents - next.acceptedRxEvents,
  );
  const finalGapBytes = Math.max(
    next.ipcGapBytes,
    backendRxBytes - next.acceptedRxBytes,
  );
  return withIntegrityStatus(
    {
      ...next,
      finalized: true,
      ipcGapEvents: finalGapEvents,
      ipcGapBytes: finalGapBytes,
    },
    true,
  );
}

export function observeSerialRxData(
  current: SerialRxObservabilitySnapshot,
  payload: SerialDataPayload,
  actualByteCount: number,
): SerialRxObservationResult {
  if (payload.generation !== current.generation || current.finalized) {
    return {
      accept: false,
      snapshot: withIntegrityStatus({
        ...current,
        staleGenerationEvents: current.staleGenerationEvents + 1,
      }),
    };
  }

  const fieldsValid = [
    payload.sequence,
    payload.streamOffset,
    payload.byteCount,
    payload.receivedAtMonotonicUs,
    payload.backendRxBytes,
    payload.backendRxEvents,
    actualByteCount,
  ].every(isCounter);
  if (!fieldsValid || payload.byteCount !== actualByteCount) {
    return {
      accept: false,
      snapshot: withIntegrityStatus({
        ...current,
        contractViolations: current.contractViolations + 1,
      }),
    };
  }

  const eventEndOffset = payload.streamOffset + actualByteCount;
  const expectedBackendEvents = payload.sequence + 1;
  const selfConsistent =
    Number.isSafeInteger(eventEndOffset) &&
    Number.isSafeInteger(expectedBackendEvents) &&
    payload.backendRxBytes === eventEndOffset &&
    payload.backendRxEvents === expectedBackendEvents;
  const backendRxBytes = Math.max(current.backendRxBytes, payload.backendRxBytes);
  const backendRxEvents = Math.max(current.backendRxEvents, payload.backendRxEvents);
  const common = {
    ...current,
    backendRxBytes,
    backendRxEvents,
    contractViolations: current.contractViolations + (selfConsistent ? 0 : 1),
  };

  if (payload.sequence < current.nextSequence) {
    const duplicate =
      payload.sequence === current.lastSequence &&
      payload.streamOffset === current.lastStreamOffset &&
      payload.byteCount === current.lastByteCount;
    return {
      accept: false,
      snapshot: withIntegrityStatus({
        ...common,
        duplicateEvents: current.duplicateEvents + (duplicate ? 1 : 0),
        outOfOrderEvents: current.outOfOrderEvents + (duplicate ? 0 : 1),
      }),
    };
  }

  if (payload.streamOffset < current.nextStreamOffset) {
    return {
      accept: false,
      snapshot: withIntegrityStatus({
        ...common,
        outOfOrderEvents: current.outOfOrderEvents + 1,
        contractViolations: common.contractViolations + 1,
      }),
    };
  }

  const monotonicRegressed =
    current.lastReceivedAtMonotonicUs !== undefined &&
    payload.receivedAtMonotonicUs < current.lastReceivedAtMonotonicUs;
  const eventGap = payload.sequence - current.nextSequence;
  const byteGap = payload.streamOffset - current.nextStreamOffset;
  const snapshot = withIntegrityStatus({
    ...common,
    acceptedRxBytes: current.acceptedRxBytes + actualByteCount,
    acceptedRxEvents: current.acceptedRxEvents + 1,
    ipcGapEvents: current.ipcGapEvents + eventGap,
    ipcGapBytes: current.ipcGapBytes + byteGap,
    contractViolations:
      common.contractViolations +
      (monotonicRegressed || (eventGap === 0 && byteGap > 0) ? 1 : 0),
    nextSequence: payload.sequence + 1,
    nextStreamOffset: eventEndOffset,
    lastSequence: payload.sequence,
    lastStreamOffset: payload.streamOffset,
    lastByteCount: payload.byteCount,
    lastReceivedAtMonotonicUs: payload.receivedAtMonotonicUs,
  });

  return { accept: true, snapshot };
}

function withIntegrityStatus(
  snapshot: SerialRxObservabilitySnapshot,
  finalized = snapshot.finalized,
): SerialRxObservabilitySnapshot {
  const degraded =
    snapshot.ipcGapBytes > 0 ||
    snapshot.ipcGapEvents > 0 ||
    snapshot.duplicateEvents > 0 ||
    snapshot.outOfOrderEvents > 0 ||
    snapshot.staleGenerationEvents > 0 ||
    snapshot.contractViolations > 0 ||
    snapshot.unfinalizedGenerations > 0;
  return {
    ...snapshot,
    finalized,
    status: degraded ? "degraded" : finalized ? "verified" : "monitoring",
  };
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
