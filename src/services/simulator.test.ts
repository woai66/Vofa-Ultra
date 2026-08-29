import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorConfig } from "../types/simulator";
import { startSimulator } from "./simulator";

describe("模拟器服务", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按冻结的采样率逐次发出动态通道数据并可停止", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const config: SimulatorConfig = { signal: "dc", channelCount: 2, sampleRate: 100 };
    const onData = vi.fn();
    const stop = startSimulator("raw", config, onData);
    config.channelCount = 16;

    vi.advanceTimersByTime(30);

    expect(onData).toHaveBeenCalledTimes(3);
    const firstBytes = onData.mock.calls[0]?.[0] as Uint8Array;
    const thirdBytes = onData.mock.calls[2]?.[0] as Uint8Array;
    const firstView = new DataView(
      firstBytes.buffer,
      firstBytes.byteOffset,
      firstBytes.byteLength,
    );
    const thirdView = new DataView(
      thirdBytes.buffer,
      thirdBytes.byteOffset,
      thirdBytes.byteLength,
    );
    expect([...firstBytes.slice(0, 8)]).toEqual([
      0x56, 0x55, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(firstView.getFloat32(8, true)).toBeCloseTo(9.8);
    expect(firstView.getFloat32(12, true)).toBeCloseTo(10.2);
    expect(thirdView.getUint32(4, true)).toBe(2);
    expect(onData.mock.calls[0]?.[1]).toBe(1_010);

    stop();
    vi.advanceTimersByTime(100);
    expect(onData).toHaveBeenCalledTimes(3);
  });

  it("停止再启动时从样本零复现同一随机序列", () => {
    vi.useFakeTimers();
    const config = { signal: "white-noise", channelCount: 3, sampleRate: 25 } as const;
    const firstRun: number[][] = [];
    const secondRun: number[][] = [];

    const stopFirst = startSimulator("raw", config, (bytes) => {
      firstRun.push([...bytes]);
    });
    vi.advanceTimersByTime(120);
    stopFirst();

    const stopSecond = startSimulator("raw", config, (bytes) => {
      secondRun.push([...bytes]);
    });
    vi.advanceTimersByTime(120);
    stopSecond();

    expect(firstRun).toHaveLength(3);
    expect(secondRun).toEqual(firstRun);
  });

  it("启动时拒绝非法配置且不创建定时器", () => {
    vi.useFakeTimers();
    const onData = vi.fn();

    expect(() =>
      startSimulator(
        "firewater",
        { signal: "sine", channelCount: 0, sampleRate: 25 },
        onData,
      ),
    ).toThrow(/通道数/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
