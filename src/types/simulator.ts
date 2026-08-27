export const SIMULATOR_SIGNAL_TYPES = [
  "sine",
  "square",
  "triangle",
  "sawtooth",
  "dc",
  "step",
  "sweep",
  "multi-tone",
  "uniform-random",
  "white-noise",
] as const;

export type SimulatorSignalType = (typeof SIMULATOR_SIGNAL_TYPES)[number];

export const SIMULATOR_SAMPLE_RATES = [10, 25, 50, 100, 200] as const;

export type SimulatorSampleRate = (typeof SIMULATOR_SAMPLE_RATES)[number];

export const MIN_SIMULATOR_CHANNELS = 1;
export const MAX_SIMULATOR_CHANNELS = 16;

export interface SimulatorConfig {
  signal: SimulatorSignalType;
  channelCount: number;
  sampleRate: SimulatorSampleRate;
}

export const DEFAULT_SIMULATOR_CONFIG: Readonly<SimulatorConfig> = Object.freeze({
  signal: "sine",
  channelCount: 3,
  sampleRate: 25,
});
