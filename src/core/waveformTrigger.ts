export const WAVEFORM_TRIGGER_EDGES = ["rising", "falling"] as const;

export type WaveformTriggerEdge = (typeof WAVEFORM_TRIGGER_EDGES)[number];
export type WaveformTriggerPhase = "idle" | "armed" | "triggered" | "frozen";

export interface WaveformTriggerConfig {
  readonly channelId: string;
  readonly edge: WaveformTriggerEdge;
  readonly threshold: number;
}

export interface WaveformTriggerObservation {
  readonly timestampSeconds: number;
  readonly value: number | null;
}

export interface WaveformTriggerState {
  readonly phase: WaveformTriggerPhase;
  readonly config: WaveformTriggerConfig | null;
  readonly postTriggerSeconds: number;
  readonly triggerTimestampSeconds: number | null;
  readonly freezeTimestampSeconds: number | null;
  readonly previousTimestampSeconds: number | null;
  readonly previousValue: number | null;
}

export interface WaveformTriggerAdvanceResult {
  readonly state: WaveformTriggerState;
  readonly shouldFreeze: boolean;
}

export function createIdleWaveformTriggerState(): WaveformTriggerState {
  return {
    phase: "idle",
    config: null,
    postTriggerSeconds: 0,
    triggerTimestampSeconds: null,
    freezeTimestampSeconds: null,
    previousTimestampSeconds: null,
    previousValue: null,
  };
}

export function createArmedWaveformTriggerState(
  config: WaveformTriggerConfig,
  windowSeconds: number,
): WaveformTriggerState {
  if (!isWaveformTriggerConfigValid(config)) {
    throw new Error("波形触发配置无效");
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error("波形触发时间窗必须是正数");
  }
  return {
    phase: "armed",
    config: { ...config },
    postTriggerSeconds: windowSeconds / 2,
    triggerTimestampSeconds: null,
    freezeTimestampSeconds: null,
    previousTimestampSeconds: null,
    previousValue: null,
  };
}

export function isWaveformTriggerConfigValid(config: WaveformTriggerConfig): boolean {
  return (
    config.channelId.length > 0 &&
    config.channelId.length <= 128 &&
    WAVEFORM_TRIGGER_EDGES.some((edge) => edge === config.edge) &&
    Number.isFinite(config.threshold)
  );
}

export function advanceWaveformTrigger(
  state: WaveformTriggerState,
  observations: readonly WaveformTriggerObservation[],
  batchEndTimestampSeconds: number | null,
): WaveformTriggerAdvanceResult {
  if (state.phase !== "armed" && state.phase !== "triggered") {
    return { state, shouldFreeze: false };
  }

  let nextState = state;
  for (const observation of observations) {
    nextState = advanceObservation(nextState, observation);
  }

  if (
    nextState.phase === "triggered" &&
    nextState.freezeTimestampSeconds !== null &&
    batchEndTimestampSeconds !== null &&
    Number.isFinite(batchEndTimestampSeconds) &&
    batchEndTimestampSeconds >= nextState.freezeTimestampSeconds
  ) {
    return {
      state: { ...nextState, phase: "frozen" },
      shouldFreeze: true,
    };
  }
  return { state: nextState, shouldFreeze: false };
}

function advanceObservation(
  state: WaveformTriggerState,
  observation: WaveformTriggerObservation,
): WaveformTriggerState {
  if (!Number.isFinite(observation.timestampSeconds) || observation.timestampSeconds < 0) {
    return cutPreviousSample(state, state.previousTimestampSeconds);
  }
  if (
    state.previousTimestampSeconds !== null &&
    observation.timestampSeconds < state.previousTimestampSeconds
  ) {
    return state;
  }
  if (observation.value === null || !Number.isFinite(observation.value)) {
    return cutPreviousSample(state, observation.timestampSeconds);
  }
  const value = observation.value;

  if (state.previousTimestampSeconds === null || state.previousValue === null) {
    return withPreviousSample(state, observation.timestampSeconds, value);
  }

  const crossed =
    state.phase === "armed" &&
    state.config !== null &&
    crossesThreshold(
      state.config.edge,
      state.config.threshold,
      state.previousValue,
      value,
    );
  if (!crossed) {
    return withPreviousSample(state, observation.timestampSeconds, value);
  }

  return {
    ...state,
    phase: "triggered",
    triggerTimestampSeconds: observation.timestampSeconds,
    freezeTimestampSeconds: observation.timestampSeconds + state.postTriggerSeconds,
    previousTimestampSeconds: observation.timestampSeconds,
    previousValue: value,
  };
}

function crossesThreshold(
  edge: WaveformTriggerEdge,
  threshold: number,
  previousValue: number,
  value: number,
): boolean {
  return edge === "rising"
    ? previousValue < threshold && value >= threshold
    : previousValue > threshold && value <= threshold;
}

function withPreviousSample(
  state: WaveformTriggerState,
  timestampSeconds: number,
  value: number,
): WaveformTriggerState {
  return {
    ...state,
    previousTimestampSeconds: timestampSeconds,
    previousValue: value,
  };
}

function cutPreviousSample(
  state: WaveformTriggerState,
  timestampSeconds: number | null,
): WaveformTriggerState {
  if (state.previousTimestampSeconds === timestampSeconds && state.previousValue === null) {
    return state;
  }
  return {
    ...state,
    previousTimestampSeconds: timestampSeconds,
    previousValue: null,
  };
}
