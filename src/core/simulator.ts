import {
  DEFAULT_SIMULATOR_CONFIG,
  MAX_SIMULATOR_CHANNELS,
  MIN_SIMULATOR_CHANNELS,
  SIMULATOR_SAMPLE_RATES,
  SIMULATOR_SIGNAL_TYPES,
  type SimulatorConfig,
  type SimulatorSampleRate,
  type SimulatorSignalType,
} from "../types/simulator";

export interface SimulatorSignalDefinition {
  id: SimulatorSignalType;
  displayName: string;
}

export const SIMULATOR_SIGNAL_DEFINITIONS: readonly SimulatorSignalDefinition[] = Object.freeze([
  { id: "sine", displayName: "正弦波" },
  { id: "square", displayName: "方波" },
  { id: "triangle", displayName: "三角波" },
  { id: "sawtooth", displayName: "锯齿波" },
  { id: "dc", displayName: "直流" },
  { id: "step", displayName: "阶跃" },
  { id: "sweep", displayName: "扫频" },
  { id: "multi-tone", displayName: "多音" },
  { id: "uniform-random", displayName: "均匀随机" },
  { id: "white-noise", displayName: "白噪声" },
]);

const SIMULATOR_CONFIG_KEYS = ["signal", "channelCount", "sampleRate"] as const;
const CENTER_VALUE = 10;
const AMPLITUDE = 5;
const TWO_PI = Math.PI * 2;
const UINT32_RANGE = 0x1_0000_0000;

export function createDefaultSimulatorConfig(): SimulatorConfig {
  return cloneSimulatorConfig(DEFAULT_SIMULATOR_CONFIG);
}

export function cloneSimulatorConfig(config: SimulatorConfig): SimulatorConfig {
  return {
    signal: config.signal,
    channelCount: config.channelCount,
    sampleRate: config.sampleRate,
  };
}

export function areSimulatorConfigsEqual(
  left: SimulatorConfig,
  right: SimulatorConfig,
): boolean {
  return (
    left.signal === right.signal &&
    left.channelCount === right.channelCount &&
    left.sampleRate === right.sampleRate
  );
}

export function parseSimulatorConfig(value: unknown): SimulatorConfig {
  if (!isRecord(value)) {
    throw new Error("模拟器配置必须是对象");
  }
  assertExactKeys(value);

  if (!isSimulatorSignalType(value.signal)) {
    throw new Error("模拟信号类型无效");
  }
  if (
    !Number.isInteger(value.channelCount) ||
    (value.channelCount as number) < MIN_SIMULATOR_CHANNELS ||
    (value.channelCount as number) > MAX_SIMULATOR_CHANNELS
  ) {
    throw new Error(
      `模拟器通道数必须是 ${MIN_SIMULATOR_CHANNELS}-${MAX_SIMULATOR_CHANNELS} 的整数`,
    );
  }
  if (!isSimulatorSampleRate(value.sampleRate)) {
    throw new Error("模拟器采样率无效");
  }

  return {
    signal: value.signal,
    channelCount: value.channelCount as number,
    sampleRate: value.sampleRate,
  };
}

export function tryParseSimulatorConfig(value: unknown): SimulatorConfig | null {
  try {
    return parseSimulatorConfig(value);
  } catch {
    return null;
  }
}

export function generateSimulatorValues(
  config: SimulatorConfig,
  sampleIndex: number,
): number[] {
  const parsed = parseSimulatorConfig(config);
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error("模拟器样本序号必须是非负安全整数");
  }

  const time = sampleIndex / parsed.sampleRate;
  return Array.from({ length: parsed.channelCount }, (_, channelIndex) =>
    generateChannelValue(parsed, sampleIndex, time, channelIndex),
  );
}

function generateChannelValue(
  config: SimulatorConfig,
  sampleIndex: number,
  time: number,
  channelIndex: number,
): number {
  const phase = channelIndex * Math.PI / 6;
  const frequency = 0.5 + (channelIndex % 8) * 0.125;
  const cycle = positiveFraction(time * frequency + phase / TWO_PI);
  const channelOffset = (channelIndex - (config.channelCount - 1) / 2) * 0.4;

  switch (config.signal) {
    case "sine":
      return CENTER_VALUE + AMPLITUDE * Math.sin(TWO_PI * frequency * time + phase);
    case "square":
      return CENTER_VALUE + (cycle < 0.5 ? AMPLITUDE : -AMPLITUDE);
    case "triangle":
      return CENTER_VALUE + AMPLITUDE * (1 - 4 * Math.abs(cycle - 0.5));
    case "sawtooth":
      return CENTER_VALUE + AMPLITUDE * (2 * cycle - 1);
    case "dc":
      return CENTER_VALUE + channelOffset;
    case "step":
      return CENTER_VALUE + channelOffset + (sampleIndex < config.sampleRate * 2 ? -AMPLITUDE : AMPLITUDE);
    case "sweep":
      return generateSweepValue(time, phase);
    case "multi-tone":
      return generateMultiToneValue(time, phase);
    case "uniform-random":
      return CENTER_VALUE + AMPLITUDE * (uniformSample(sampleIndex, channelIndex, 0) * 2 - 1);
    case "white-noise":
      return CENTER_VALUE + AMPLITUDE * gaussianSample(sampleIndex, channelIndex) / 3;
  }
}

function generateSweepValue(time: number, phase: number): number {
  const duration = 10;
  const startFrequency = 0.2;
  const endFrequency = 2;
  const localTime = time % duration;
  const sweepRate = (endFrequency - startFrequency) / duration;
  const sweepPhase = TWO_PI * (
    startFrequency * localTime + sweepRate * localTime * localTime / 2
  );
  return CENTER_VALUE + AMPLITUDE * Math.sin(sweepPhase + phase);
}

function generateMultiToneValue(time: number, phase: number): number {
  const normalized =
    0.6 * Math.sin(TWO_PI * 0.5 * time + phase) +
    0.3 * Math.sin(TWO_PI * 1.25 * time + phase * 0.5) +
    0.1 * Math.sin(TWO_PI * 2 * time + phase * 1.5);
  return CENTER_VALUE + AMPLITUDE * normalized;
}

function gaussianSample(sampleIndex: number, channelIndex: number): number {
  const first = Math.max(uniformSample(sampleIndex, channelIndex, 1), Number.EPSILON);
  const second = uniformSample(sampleIndex, channelIndex, 2);
  const value = Math.sqrt(-2 * Math.log(first)) * Math.cos(TWO_PI * second);
  return Math.max(-3, Math.min(3, value));
}

function uniformSample(sampleIndex: number, channelIndex: number, stream: number): number {
  const seed = (
    Math.imul(sampleIndex + 1, 0x9e3779b1) ^
    Math.imul(channelIndex + 1, 0x85ebca77) ^
    Math.imul(stream + 1, 0xc2b2ae3d)
  ) >>> 0;
  return hashUint32(seed) / UINT32_RANGE;
}

function hashUint32(value: number): number {
  let hashed = value >>> 0;
  hashed = Math.imul(hashed ^ (hashed >>> 16), 0x21f0aaad);
  hashed = Math.imul(hashed ^ (hashed >>> 15), 0x735a2d97);
  return (hashed ^ (hashed >>> 15)) >>> 0;
}

function positiveFraction(value: number): number {
  return value - Math.floor(value);
}

function isSimulatorSignalType(value: unknown): value is SimulatorSignalType {
  return SIMULATOR_SIGNAL_TYPES.some((signal) => signal === value);
}

function isSimulatorSampleRate(value: unknown): value is SimulatorSampleRate {
  return SIMULATOR_SAMPLE_RATES.some((sampleRate) => sampleRate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>): void {
  const keys = Object.keys(record);
  if (
    keys.length !== SIMULATOR_CONFIG_KEYS.length ||
    keys.some((key) => !SIMULATOR_CONFIG_KEYS.includes(key as (typeof SIMULATOR_CONFIG_KEYS)[number]))
  ) {
    throw new Error("模拟器配置包含未知或缺失字段");
  }
}
