import { describe, expect, it } from "vitest";
import { SIMULATOR_SIGNAL_TYPES } from "../types/simulator";
import {
  areSimulatorConfigsEqual,
  cloneSimulatorConfig,
  createDefaultSimulatorConfig,
  generateSimulatorValues,
  parseSimulatorConfig,
  tryParseSimulatorConfig,
} from "./simulator";

describe("模拟信号生成器", () => {
  it("创建和克隆默认配置时保持独立引用", () => {
    const first = createDefaultSimulatorConfig();
    const second = cloneSimulatorConfig(first);

    expect(first).toEqual({ signal: "sine", channelCount: 3, sampleRate: 25 });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(areSimulatorConfigsEqual(first, second)).toBe(true);
    second.channelCount = 4;
    expect(areSimulatorConfigsEqual(first, second)).toBe(false);
  });

  it("严格接受完整配置并拒绝未知字段、越界值和非法样本序号", () => {
    expect(
      parseSimulatorConfig({
        signal: "white-noise",
        channelCount: 16,
        sampleRate: 200,
      }),
    ).toEqual({ signal: "white-noise", channelCount: 16, sampleRate: 200 });

    expect(() =>
      parseSimulatorConfig({ signal: "sine", channelCount: 3, sampleRate: 25, seed: 1 }),
    ).toThrow(/未知或缺失字段/);
    expect(() =>
      parseSimulatorConfig({ signal: "sine", channelCount: 0, sampleRate: 25 }),
    ).toThrow(/通道数/);
    expect(() =>
      parseSimulatorConfig({ signal: "sine", channelCount: 17, sampleRate: 25 }),
    ).toThrow(/通道数/);
    expect(() =>
      parseSimulatorConfig({ signal: "sine", channelCount: 3, sampleRate: 30 }),
    ).toThrow(/采样率/);
    expect(() =>
      parseSimulatorConfig({ signal: "script", channelCount: 3, sampleRate: 25 }),
    ).toThrow(/信号类型/);
    expect(tryParseSimulatorConfig(null)).toBeNull();
    expect(() => generateSimulatorValues(createDefaultSimulatorConfig(), -1)).toThrow(/样本序号/);
  });

  it("按逻辑时间生成稳定的正弦向量", () => {
    const config = createDefaultSimulatorConfig();

    expect(generateSimulatorValues(config, 0)).toEqual([
      10,
      12.5,
      10 + 5 * Math.sin(Math.PI / 3),
    ]);
    expect(generateSimulatorValues(config, 25)[0]).toBeCloseTo(10, 12);
    expect(
      generateSimulatorValues({ ...config, sampleRate: 100 }, 100)[0],
    ).toBeCloseTo(10, 12);
  });

  it.each(SIMULATOR_SIGNAL_TYPES)("%s 在 1 和 16 通道边界生成有限数值", (signal) => {
    const single = generateSimulatorValues({ signal, channelCount: 1, sampleRate: 10 }, 123);
    const maximum = generateSimulatorValues({ signal, channelCount: 16, sampleRate: 200 }, 456);

    expect(single).toHaveLength(1);
    expect(maximum).toHaveLength(16);
    expect([...single, ...maximum].every(Number.isFinite)).toBe(true);
  });

  it("阶跃在两秒边界切换且直流保持不随时间变化", () => {
    const step = { signal: "step", channelCount: 3, sampleRate: 25 } as const;
    expect(generateSimulatorValues(step, 49)).toEqual([4.6, 5, 5.4]);
    expect(generateSimulatorValues(step, 50)).toEqual([14.6, 15, 15.4]);

    const dc = { signal: "dc", channelCount: 3, sampleRate: 25 } as const;
    expect(generateSimulatorValues(dc, 0)).toEqual(generateSimulatorValues(dc, 10_000));
  });

  it.each(["uniform-random", "white-noise"] as const)(
    "%s 使用固定种子生成可复现且有界的序列",
    (signal) => {
      const config = { signal, channelCount: 16, sampleRate: 200 } as const;
      const first = Array.from({ length: 32 }, (_, index) =>
        generateSimulatorValues(config, index),
      );
      const second = Array.from({ length: 32 }, (_, index) =>
        generateSimulatorValues(config, index),
      );

      expect(second).toEqual(first);
      expect(new Set(first.flat()).size).toBeGreaterThan(100);
      expect(first.flat().every((value) => value >= 5 && value <= 15)).toBe(true);
    },
  );
});
