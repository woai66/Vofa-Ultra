import { afterEach, describe, expect, it, vi } from "vitest";
import { createProtocolParser } from "../core/protocols";
import type { ProtocolKind } from "../types/serial";
import type { SimulatorConfig } from "../types/simulator";
import { startSimulator } from "./simulator";

const SIMULATABLE_PROTOCOLS = [
  "firewater",
  "justfloat",
] as const satisfies readonly ProtocolKind[];

describe("模拟器服务", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(SIMULATABLE_PROTOCOLS)(
    "%s 按冻结的采样率逐次发出通道数据并可停止",
    (protocol) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const config: SimulatorConfig = {
        signal: "dc",
        channelCount: 2,
        sampleRate: 100,
      };
      const onData = vi.fn();
      const stop = startSimulator(protocol, config, onData);
      config.channelCount = 16;

      vi.advanceTimersByTime(30);

      expect(onData).toHaveBeenCalledTimes(3);
      const firstBytes = onData.mock.calls[0]?.[0] as Uint8Array;
      const thirdBytes = onData.mock.calls[2]?.[0] as Uint8Array;
      const firstValues = createProtocolParser(protocol).push(firstBytes, 1_010)[0]?.values;
      const thirdValues = createProtocolParser(protocol).push(thirdBytes, 1_030)[0]?.values;
      expect(firstValues).toHaveLength(2);
      expect(firstValues?.[0]).toBeCloseTo(9.8);
      expect(firstValues?.[1]).toBeCloseTo(10.2);
      expect(thirdValues).toHaveLength(2);
      expect(thirdValues?.[0]).toBeCloseTo(9.8);
      expect(thirdValues?.[1]).toBeCloseTo(10.2);
      expect(onData.mock.calls[0]?.[1]).toBe(1_010);

      stop();
      vi.advanceTimersByTime(100);
      expect(onData).toHaveBeenCalledTimes(3);
    },
  );

  it.each(SIMULATABLE_PROTOCOLS)(
    "%s 停止再启动时从样本零复现同一随机序列",
    (protocol) => {
      vi.useFakeTimers();
      const config = {
        signal: "white-noise",
        channelCount: 3,
        sampleRate: 25,
      } as const;
      const firstRun: number[][] = [];
      const secondRun: number[][] = [];

      const stopFirst = startSimulator(protocol, config, (bytes) => {
        firstRun.push([...bytes]);
      });
      vi.advanceTimersByTime(120);
      stopFirst();

      const stopSecond = startSimulator(protocol, config, (bytes) => {
        secondRun.push([...bytes]);
      });
      vi.advanceTimersByTime(120);
      stopSecond();

      expect(firstRun).toHaveLength(3);
      expect(secondRun).toEqual(firstRun);
    },
  );

  it("Raw Data 不支持模拟且不会创建定时器", () => {
    vi.useFakeTimers();
    const onData = vi.fn();

    expect(() =>
      startSimulator(
        "raw",
        { signal: "sine", channelCount: 2, sampleRate: 25 },
        onData,
      ),
    ).toThrow("Raw Data 不支持模拟数据");
    expect(vi.getTimerCount()).toBe(0);
    expect(onData).not.toHaveBeenCalled();
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
