import { describe, expect, it } from "vitest";
import { parseChartSampleRate, WaveformSampleClock } from "./waveformTimebase";

const frame = (timestamp: number) => ({ timestamp, values: [1] });

describe("固定采样时基", () => {
  it("同一接收块内的三帧按 1 kHz 分离，跨块不受 USB 到达抖动影响", () => {
    const clock = new WaveformSampleClock();
    expect(clock.project([frame(1000), frame(1000), frame(1000)], 1000))
      .toEqual([0, 0.001, 0.002]);
    expect(clock.project([frame(1060), frame(1060)], 1000)).toEqual([0.003, 0.004]);
  });

  it("清图或切换时间线、改变采样率时重新从片段起点计时", () => {
    const clock = new WaveformSampleClock();
    clock.project([frame(1000), frame(1000)], 1000);
    clock.reset();
    expect(clock.project([frame(2000), frame(2000)], 1000)).toEqual([0, 0.001]);
    expect(clock.project([frame(3000), frame(3000)], 2000)).toEqual([0, 0.0005]);
    clock.reset();
    expect(clock.project([frame(4000)], 2000)).toEqual([0]);
  });

  it("实时和回放时钟互不串扰，空批次不推进样本序号", () => {
    const live = new WaveformSampleClock();
    const replay = new WaveformSampleClock();
    live.project([frame(1)], 10);
    expect(live.project([], 10)).toEqual([]);
    expect(replay.project([frame(1)], 10)).toEqual([0]);
    expect(live.project([frame(500)], 10)).toEqual([0.1]);
  });

  it("不修改原始接收时间，并支持小数采样率", () => {
    const frames = [frame(1000), frame(2000)];
    expect(new WaveformSampleClock().project(frames, 2.5)).toEqual([0, 0.4]);
    expect(frames.map(({ timestamp }) => timestamp)).toEqual([1000, 2000]);
  });

  it("采样序号不会因丢弃旧绘图缓冲而漂移", () => {
    const clock = new WaveformSampleClock();
    clock.project(Array.from({ length: 12000 }, () => frame(1)), 200);
    expect(clock.project([frame(65000)], 200)).toEqual([60]);
  });

  it.each([0, -1, 0.09, 1000001, NaN, Infinity, "1000", undefined])(
    "拒绝无效采样率 %s", (rate) => expect(() => parseChartSampleRate(rate)).toThrow(),
  );

  it("null 明确选择主机接收时间，边界采样率可用", () => {
    expect(parseChartSampleRate(null)).toBeNull();
    expect(parseChartSampleRate(0.1)).toBe(0.1);
    expect(parseChartSampleRate(1000000)).toBe(1000000);
  });
});
