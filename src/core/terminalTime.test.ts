import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_TIME_MODE,
  formatTerminalTime,
  parseTerminalTimeMode,
  terminalTimeDateTime,
} from "./terminalTime";

describe("终端时间基准", () => {
  it("解析合法模式并让未知持久化值回退为绝对时间", () => {
    expect(parseTerminalTimeMode("absolute")).toBe("absolute");
    expect(parseTerminalTimeMode("relative")).toBe("relative");
    expect(parseTerminalTimeMode("interval")).toBe("interval");
    expect(parseTerminalTimeMode("delta")).toBe(DEFAULT_TERMINAL_TIME_MODE);
    expect(parseTerminalTimeMode(null)).toBe(DEFAULT_TERMINAL_TIME_MODE);
  });

  it("保留绝对时钟格式并拒绝无效时间戳", () => {
    expect(formatTerminalTime(1_700_000_000_123, "absolute")).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3}$/,
    );
    expect(formatTerminalTime(Number.NaN, "absolute")).toBe("--");
    expect(formatTerminalTime(Number.POSITIVE_INFINITY, "absolute")).toBe("--");
    expect(terminalTimeDateTime(1_700_000_000_123)).toBe("2023-11-14T22:13:20.123Z");
    expect(terminalTimeDateTime(Number.NaN)).toBeUndefined();
    expect(terminalTimeDateTime(Number.MAX_VALUE)).toBeUndefined();
  });

  it("从缓存首条记录计算带符号相对时间且不按 24 小时回绕", () => {
    const origin = 10_000;
    expect(formatTerminalTime(origin, "relative", origin)).toBe("+00:00:00.000");
    expect(formatTerminalTime(origin + 3_661_001, "relative", origin)).toBe(
      "+01:01:01.001",
    );
    expect(formatTerminalTime(origin + 360_000_001, "relative", origin)).toBe(
      "+100:00:00.001",
    );
    expect(formatTerminalTime(origin - 25, "relative", origin)).toBe("-00:00:00.025");
  });

  it("首条间隔不伪造零值，并保留倒退记录的负间隔", () => {
    expect(formatTerminalTime(2_000, "interval", undefined, undefined)).toBe("--");
    expect(formatTerminalTime(2_125, "interval", undefined, 2_000)).toBe(
      "+00:00:00.125",
    );
    expect(formatTerminalTime(1_900, "interval", undefined, 2_000)).toBe(
      "-00:00:00.100",
    );
    expect(formatTerminalTime(2_000, "interval", undefined, Number.NaN)).toBe("--");
  });
});
