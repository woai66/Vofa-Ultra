import type { ParsedFrame } from "../types/workbench";
import { MAX_SPECTRUM_SAMPLE_RATE_HZ, MIN_SPECTRUM_SAMPLE_RATE_HZ } from "./spectrumConfig";

export function parseChartSampleRate(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    value < MIN_SPECTRUM_SAMPLE_RATE_HZ || value > MAX_SPECTRUM_SAMPLE_RATE_HZ
  ) {
    throw new Error("采样率必须在 0.1 Hz 到 1 MHz 之间");
  }
  return value;
}

export class WaveformSampleClock {
  private nextSampleIndex = 0;
  private sampleRateHz: number | null = null;

  reset(): void {
    this.nextSampleIndex = 0;
    this.sampleRateHz = null;
  }

  project(frames: readonly ParsedFrame[], sampleRateHz: number): number[] {
    parseChartSampleRate(sampleRateHz);
    if (sampleRateHz !== this.sampleRateHz) {
      this.nextSampleIndex = 0;
      this.sampleRateHz = sampleRateHz;
    }
    // 用整数样本序号计算，避免逐帧累加浮点间隔造成长期漂移。
    return frames.map(() => this.nextSampleIndex++ / sampleRateHz);
  }
}
