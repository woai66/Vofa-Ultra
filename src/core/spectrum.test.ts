import { describe, expect, it } from "vitest";
import type { DataPoint } from "../types/workbench";
import {
  analyzeSpectrum,
  SPECTRUM_WINDOW_SIZES,
  type SpectrumWindowSize,
} from "./spectrum";

function createSignal(
  pointCount: number,
  sampleRateHz: number,
  valueAt: (index: number) => number,
  timestampAt: (index: number) => number = (index) => index / sampleRateHz,
): DataPoint[] {
  return Array.from({ length: pointCount }, (_, index) => ({
    x: timestampAt(index),
    y: valueAt(index),
  }));
}

function expectOk(result: ReturnType<typeof analyzeSpectrum>) {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error(`Expected an ok spectrum result, received ${result.status}`);
  }
  return result;
}

describe("频谱分析配置", () => {
  it("公开三个支持的窗长，并在各边界生成含 DC 和 Nyquist 的单边频谱", () => {
    expect(SPECTRUM_WINDOW_SIZES).toEqual([256, 512, 1024]);

    for (const windowSize of SPECTRUM_WINDOW_SIZES) {
      const sampleRateHz = windowSize * 2;
      const result = expectOk(
        analyzeSpectrum(createSignal(windowSize, sampleRateHz, () => 0), windowSize, sampleRateHz),
      );

      expect(result.pointCount).toBe(windowSize);
      expect(result.sampleRateHz).toBe(sampleRateHz);
      expect(result.frequencyResolutionHz).toBe(2);
      expect(result.frequenciesHz).toHaveLength(windowSize / 2 + 1);
      expect(result.amplitudes).toHaveLength(windowSize / 2 + 1);
      expect(result.frequenciesHz[0]).toBe(0);
      expect(result.frequenciesHz.at(-1)).toBe(sampleRateHz / 2);
    }
  });

  it("运行时拒绝未支持的窗长", () => {
    for (const invalidSize of [128, 255, 2048, Number.NaN]) {
      expect(() => analyzeSpectrum([], invalidSize as SpectrumWindowSize, 1_000)).toThrow(RangeError);
    }
  });

  it("接受采样率闭区间边界，并拒绝非有限或越界采样率", () => {
    const points = createSignal(256, 1, () => 0);
    expect(analyzeSpectrum(points, 256, 0.1).status).toBe("ok");
    expect(analyzeSpectrum(points, 256, 1_000_000).status).toBe("ok");

    for (const sampleRateHz of [0.099, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => analyzeSpectrum(points, 256, sampleRateHz)).toThrow(RangeError);
    }
  });
});

describe("频谱幅值和主峰", () => {
  it("恢复精确 bin 单频的频率和峰值幅度", () => {
    const windowSize = 512;
    const sampleRateHz = 1_024;
    const frequencyHz = 128;
    const amplitude = 2.5;
    const points = createSignal(windowSize, sampleRateHz, (index) => {
      return 7 + amplitude * Math.cos((2 * Math.PI * frequencyHz * index) / sampleRateHz);
    });

    const result = expectOk(analyzeSpectrum(points, windowSize, sampleRateHz));
    const expectedBin = frequencyHz / result.frequencyResolutionHz;

    expect(result.peakFrequencyHz).toBe(frequencyHz);
    expect(result.peakAmplitude).toBeCloseTo(amplitude, 10);
    expect(result.amplitudes[expectedBin]).toBeCloseTo(amplitude, 10);
    expect(result.amplitudes[0]).toBeCloseTo(0, 10);
  });

  it("在双频信号中选择幅度较大的非 DC 主峰", () => {
    const windowSize = 1024;
    const sampleRateHz = 2_048;
    const points = createSignal(windowSize, sampleRateHz, (index) => {
      const weaker = 0.75 * Math.sin((2 * Math.PI * 80 * index) / sampleRateHz);
      const stronger = 1.8 * Math.cos((2 * Math.PI * 300 * index) / sampleRateHz);
      return 12 + weaker + stronger;
    });

    const result = expectOk(analyzeSpectrum(points, windowSize, sampleRateHz));

    expect(result.peakFrequencyHz).toBe(300);
    expect(result.peakAmplitude).toBeCloseTo(1.8, 10);
    expect(result.amplitudes[40]).toBeCloseTo(0.75, 10);
    expect(result.amplitudes[150]).toBeCloseTo(1.8, 10);
  });

  it("去除常量信号的 DC，且不伪造非 DC 主峰", () => {
    const result = expectOk(analyzeSpectrum(createSignal(256, 256, () => 42), 256, 256));

    expect(result.amplitudes.every((amplitude) => amplitude === 0)).toBe(true);
    expect(result.peakFrequencyHz).toBeNull();
    expect(result.peakAmplitude).toBe(0);
  });

  it("Nyquist bin 不执行双倍幅值缩放", () => {
    const amplitude = 1.25;
    const points = createSignal(256, 512, (index) => amplitude * Math.cos(Math.PI * index));
    const result = expectOk(analyzeSpectrum(points, 256, 512));

    expect(result.peakFrequencyHz).toBe(256);
    expect(result.peakAmplitude).toBeCloseTo(amplitude, 10);
    expect(result.amplitudes.at(-1)).toBeCloseTo(amplitude, 10);
  });
});

describe("频谱输入语义", () => {
  it("点数不足时报告所需点数和当前点数", () => {
    expect(analyzeSpectrum(createSignal(255, 1_000, () => 0), 256, 1_000)).toEqual({
      status: "insufficient",
      requiredPointCount: 256,
      availablePointCount: 255,
    });
  });

  it("严格拒绝分析窗口内的非有限 y 值", () => {
    for (const invalidValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const points = createSignal(256, 1_000, (index) => (index === 128 ? invalidValue : 0));
      expect(analyzeSpectrum(points, 256, 1_000)).toEqual({
        status: "invalid-data",
        reason: "non-finite",
      });
    }
  });

  it("同 timestamp、不同或倒序 x 均不影响按输入顺序进行的分析", () => {
    const windowSize = 256;
    const sampleRateHz = 1_024;
    const signal = (index: number) => Math.cos((2 * Math.PI * 64 * index) / sampleRateHz);
    const timestampStrategies = [
      () => 5,
      (index: number) => index * index + 100,
      (index: number) => -index,
      (index: number) => (index % 2 === 0 ? Number.NaN : Number.POSITIVE_INFINITY),
    ];

    for (const timestampAt of timestampStrategies) {
      const result = expectOk(
        analyzeSpectrum(createSignal(windowSize, sampleRateHz, signal, timestampAt), windowSize, sampleRateHz),
      );
      expect(result.peakFrequencyHz).toBe(64);
      expect(result.peakAmplitude).toBeCloseTo(1, 10);
    }
  });

  it("只分析最后一个完整窗口，并忽略窗口外的非有限值", () => {
    const windowSize = 256;
    const sampleRateHz = 512;
    const prefix: DataPoint[] = [
      { x: 0, y: Number.NaN },
      ...createSignal(31, sampleRateHz, (index) => 50 * Math.cos((2 * Math.PI * 8 * index) / sampleRateHz)),
    ];
    const tail = createSignal(windowSize, sampleRateHz, (index) => {
      return 1.5 * Math.sin((2 * Math.PI * 40 * index) / sampleRateHz);
    });

    const result = expectOk(analyzeSpectrum([...prefix, ...tail], windowSize, sampleRateHz));

    expect(result.pointCount).toBe(windowSize);
    expect(result.peakFrequencyHz).toBe(40);
    expect(result.peakAmplitude).toBeCloseTo(1.5, 10);
  });
});
