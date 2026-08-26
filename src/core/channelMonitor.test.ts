import { describe, expect, it } from "vitest";
import {
  calculateChannelMonitorStats,
  CHANNEL_MONITOR_SAMPLE_LIMIT,
} from "./channelMonitor";

describe("通道监视统计", () => {
  it("只统计尾部 256 个源样本并返回当前变化与窗口", () => {
    const points = Array.from({ length: 300 }, (_, index) => ({
      x: index + 1,
      y: index + 1,
    }));

    const stats = calculateChannelMonitorStats({ points, lastValue: 300 });

    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({
      current: 300,
      delta: 1,
      minimum: 45,
      maximum: 300,
      sampleCount: CHANNEL_MONITOR_SAMPLE_LIMIT,
      firstTimestampSeconds: 45,
      lastTimestampSeconds: 300,
      spanSeconds: 255,
    });
    expect(stats?.mean).toBeCloseTo(172.5);
    expect(stats?.rms).toBeCloseTo(
      Math.sqrt(
        points
          .slice(-CHANNEL_MONITOR_SAMPLE_LIMIT)
          .reduce((sum, point) => sum + point.y * point.y, 0) /
          CHANNEL_MONITOR_SAMPLE_LIMIT,
      ),
    );
  });

  it("过滤窗口内非有限点且不回看窗口之前的极值", () => {
    const points = [
      { x: 0, y: -999 },
      ...Array.from({ length: CHANNEL_MONITOR_SAMPLE_LIMIT - 2 }, (_, index) => ({
        x: index + 1,
        y: 10,
      })),
      { x: Number.NaN, y: 20 },
      { x: 300, y: Number.POSITIVE_INFINITY },
    ];

    expect(calculateChannelMonitorStats({ points, lastValue: 10 })).toMatchObject({
      current: 10,
      delta: 0,
      minimum: 10,
      maximum: 10,
      sampleCount: CHANNEL_MONITOR_SAMPLE_LIMIT - 2,
    });
  });

  it("归一化均值与 RMS，避免极大有限值的中间求和溢出", () => {
    const maximum = Number.MAX_VALUE;
    const sameSign = calculateChannelMonitorStats({
      points: [
        { x: 1, y: maximum },
        { x: 2, y: maximum },
      ],
      lastValue: maximum,
    });
    expect(sameSign?.mean).toBe(maximum);
    expect(sameSign?.rms).toBe(maximum);

    const oppositeSigns = calculateChannelMonitorStats({
      points: [
        { x: 1, y: -maximum },
        { x: 2, y: maximum },
      ],
      lastValue: maximum,
    });
    expect(oppositeSigns?.mean).toBe(0);
    expect(oppositeSigns?.rms).toBe(maximum);
    expect(oppositeSigns?.delta).toBeNull();
  });

  it("没有有效点时使用有限的最后值并拒绝非有限通道", () => {
    expect(calculateChannelMonitorStats({ points: [], lastValue: -3 })).toEqual({
      current: -3,
      delta: null,
      minimum: -3,
      maximum: -3,
      mean: -3,
      rms: 3,
      sampleCount: 1,
      firstTimestampSeconds: null,
      lastTimestampSeconds: null,
      spanSeconds: null,
    });
    expect(
      calculateChannelMonitorStats({
        points: [{ x: 1, y: Number.NaN }],
        lastValue: Number.NaN,
      }),
    ).toBeNull();
  });
});
