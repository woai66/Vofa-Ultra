import { describe, expect, it } from "vitest";
import {
  calculateWaveformIntervalStatistics,
  type WaveformIntervalSample,
} from "./waveformIntervalStatistics";

function sample(timestampSeconds: number, value: number): WaveformIntervalSample {
  return { timestampSeconds, value };
}

describe("波形 A/B 区间统计", () => {
  it("按闭区间统计有限样本且不依赖 A/B 顺序", () => {
    const points = [
      sample(0, -10),
      sample(1, 1),
      sample(2, 3),
      sample(3, 5),
      sample(4, 9),
      sample(Number.NaN, 7),
      sample(2.5, Number.POSITIVE_INFINITY),
    ];

    const statistics = calculateWaveformIntervalStatistics(points, 3, 1);

    expect(statistics).not.toBeNull();
    expect(statistics).toMatchObject({
      sampleCount: 3,
      minimum: 1,
      maximum: 5,
      mean: 3,
      peakToPeak: 4,
    });
    expect(statistics?.rms).toBeCloseTo(Math.sqrt(35 / 3), 12);
  });

  it("单样本区间返回自身、绝对 RMS 和零峰峰值", () => {
    expect(calculateWaveformIntervalStatistics([sample(7, -4)], 7, 7)).toEqual({
      sampleCount: 1,
      minimum: -4,
      maximum: -4,
      mean: -4,
      rms: 4,
      peakToPeak: 0,
    });
  });

  it("空区间或非法边界返回明确空结果", () => {
    const points = [sample(1, 2), sample(2, 4)];

    expect(calculateWaveformIntervalStatistics(points, 3, 4)).toBeNull();
    expect(calculateWaveformIntervalStatistics(points, Number.NaN, 2)).toBeNull();
    expect(calculateWaveformIntervalStatistics([], 0, 1)).toBeNull();
  });

  it("缩放求和避免有限极值在均值和 RMS 中溢出", () => {
    const maximum = Number.MAX_VALUE;
    const statistics = calculateWaveformIntervalStatistics(
      [sample(0, maximum), sample(1, -maximum)],
      0,
      1,
    );

    expect(statistics).toEqual({
      sampleCount: 2,
      minimum: -maximum,
      maximum,
      mean: 0,
      rms: maximum,
      peakToPeak: null,
    });
  });
});
