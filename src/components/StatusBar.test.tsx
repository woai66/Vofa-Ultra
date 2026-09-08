import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  let monotonicNow: number;

  beforeEach(() => {
    vi.useFakeTimers();
    monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    useWorkbenchStore.setState({
      source: "simulator",
      protocol: "firewater",
      connectionStatus: "connected",
      replayStatus: "idle",
      replaySessionId: 0,
      captureStatus: "idle",
      captureMessage: "",
      numericLogStatus: "idle",
      numericLogOutputBytes: 0,
      numericLogMessage: "",
      channels: [],
      processedChannels: [],
      extensionChannels: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0, startedAt: 100 },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("按实际间隔显示双向速率并在空闲后归零", () => {
    render(<StatusBar />);
    const rate = screen.getByLabelText(/实时传输/);
    expect(rate).toHaveTextContent("RX 0 B/s");
    expect(rate).toHaveTextContent("TX 0 B/s");

    act(() => {
      useWorkbenchStore.setState({
        stats: { rxBytes: 2_048, txBytes: 1_024, rxFrames: 1, startedAt: 100 },
      });
    });
    act(() => {
      monotonicNow = 1_000;
      vi.advanceTimersByTime(1_000);
    });

    expect(rate).toHaveTextContent("RX 2.0 KB/s");
    expect(rate).toHaveTextContent("TX 1.0 KB/s");
    expect(rate).toHaveAccessibleName(
      "实时传输：RX 2.0 KB/s，累计 2.0 KB；TX 1.0 KB/s，累计 1.0 KB",
    );

    act(() => {
      monotonicNow = 2_500;
      vi.advanceTimersByTime(1_000);
    });

    expect(rate).toHaveTextContent("RX 0 B/s");
    expect(rate).toHaveTextContent("TX 0 B/s");
  });

  it("统计重置后立即清零并从新基线继续采样", () => {
    render(<StatusBar />);
    const rate = screen.getByLabelText(/实时传输/);
    act(() => {
      useWorkbenchStore.setState({
        stats: { rxBytes: 2_048, txBytes: 1_024, rxFrames: 1, startedAt: 100 },
      });
    });
    act(() => {
      monotonicNow = 1_000;
      vi.advanceTimersByTime(1_000);
    });
    expect(rate).toHaveTextContent("RX 2.0 KB/s");

    act(() => {
      monotonicNow = 1_100;
      useWorkbenchStore.setState({
        stats: { rxBytes: 0, txBytes: 0, rxFrames: 0, startedAt: 200 },
      });
    });
    expect(rate).toHaveTextContent("RX 0 B/s");
    expect(rate).toHaveTextContent("TX 0 B/s");

    act(() => {
      useWorkbenchStore.setState({
        stats: { rxBytes: 1_024, txBytes: 512, rxFrames: 1, startedAt: 200 },
      });
    });
    act(() => {
      monotonicNow = 2_100;
      vi.advanceTimersByTime(1_000);
    });
    expect(rate).toHaveTextContent("RX 1.0 KB/s");
    expect(rate).toHaveTextContent("TX 512 B/s");
  });

  it("卸载时清理采样定时器", () => {
    const { unmount } = render(<StatusBar />);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("离开记录面板后仍显示数值 CSV 记录进度和失败", () => {
    render(<StatusBar />);

    act(() => {
      useWorkbenchStore.setState({
        numericLogStatus: "recording",
        numericLogOutputBytes: 2_048,
      });
    });
    expect(screen.getByLabelText("数值 CSV 记录中：2.0 KB")).toHaveTextContent(
      "CSV 2.0 KB",
    );

    act(() => {
      useWorkbenchStore.setState({
        numericLogStatus: "error",
        numericLogMessage: "磁盘空间不足",
      });
    });
    expect(screen.queryByLabelText(/数值 CSV 记录中/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "数值 CSV 记录失败：磁盘空间不足" }))
      .toHaveTextContent("CSV 失败");
  });
});
