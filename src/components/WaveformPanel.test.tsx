import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createArmedWaveformTriggerState,
  createIdleWaveformTriggerState,
} from "../core/waveformTrigger";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ChannelSeries } from "../types/workbench";
import { WaveformPanel } from "./WaveformPanel";

interface UPlotMockInstance {
  readonly options: UPlotMockOptions;
  readonly setData: ReturnType<typeof vi.fn>;
  readonly valToPosScaleKeys: string[];
  simulateScale(scaleKey: string): void;
  simulateSelection(): void;
  simulateXZoom(): Promise<void>;
}

interface UPlotMockOptions {
  width: number;
  height: number;
  scales?: Record<string, { auto?: boolean; time?: boolean }>;
  axes?: Array<{ scale?: string; stroke?: string }>;
  series?: Array<{ label?: string; scale?: string; show?: boolean }>;
  hooks?: {
    setScale?: Array<(chart: unknown, scaleKey: string) => void>;
    setSelect?: Array<(chart: unknown) => void>;
  };
}

const uPlotMockInstances = vi.hoisted(() => [] as UPlotMockInstance[]);

vi.mock("uplot", () => ({
  default: class UPlotMock {
    readonly over = document.createElement("div");
    readonly select = { left: 0, top: 0, width: 0, height: 0 };
    readonly setData = vi.fn();
    readonly valToPosScaleKeys: string[] = [];
    readonly options: UPlotMockOptions;
    width: number;
    height: number;
    private readonly hooks: {
      setScale?: Array<(chart: unknown, scaleKey: string) => void>;
      setSelect?: Array<(chart: unknown) => void>;
    };

    constructor(
      options: UPlotMockOptions,
      _data: unknown,
      target: HTMLElement,
    ) {
      this.width = options.width;
      this.height = options.height;
      this.options = options;
      this.hooks = options.hooks ?? {};
      this.over.className = "u-over";
      target.append(this.over);
      uPlotMockInstances.push(this);
    }

    setSize(size: { width: number; height: number }): void {
      this.width = size.width;
      this.height = size.height;
    }

    posToVal(position: number): number {
      return position;
    }

    valToPos(value: number, scaleKey: string): number {
      this.valToPosScaleKeys.push(scaleKey);
      return value;
    }

    simulateScale(scaleKey: string): void {
      this.hooks.setScale?.forEach((hook) => hook(this, scaleKey));
    }

    simulateSelection(): void {
      this.select.width = 100;
      this.hooks.setSelect?.forEach((hook) => hook(this));
    }

    async simulateXZoom(): Promise<void> {
      this.simulateSelection();
      await Promise.resolve();
      this.simulateScale("x");
    }

    destroy(): void {
      this.over.remove();
    }
  },
}));

const TEST_CHANNELS: ChannelSeries[] = [
  {
    id: "channel-0",
    name: "电压",
    color: "#46d89c",
    visible: true,
    points: [
      { x: 1, y: 10 },
      { x: 2, y: 20 },
      { x: 3, y: 30 },
      { x: 4, y: 40 },
      { x: 5, y: 50 },
    ],
    lastValue: 50,
  },
  {
    id: "channel-1",
    name: "电流",
    color: "#55bde8",
    visible: true,
    points: [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
      { x: 5, y: 5 },
    ],
    lastValue: 5,
  },
];

function latestUPlotMock(): UPlotMockInstance {
  const chart = uPlotMockInstances.at(-1);
  if (!chart) {
    throw new Error("波形图尚未创建");
  }
  return chart;
}

describe("WaveformPanel 波形测量", () => {
  beforeEach(() => {
    uPlotMockInstances.length = 0;
    useWorkbenchStore.setState({
      channels: TEST_CHANNELS,
      processedChannels: [],
      extensionChannels: [],
      chartPaused: false,
      chartWindowSeconds: 5,
      chartDataRevision: 0,
      waveformTrigger: createIdleWaveformTriggerState(),
      connectionStatus: "connected",
      replayStatus: "idle",
      runtimeTransitionStatus: "idle",
      workspaceTransitionStatus: "idle",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("空数据时禁用测量入口", () => {
    useWorkbenchStore.setState({ channels: [] });
    render(<WaveformPanel theme="dark" />);

    expect(screen.getByRole("button", { name: "开启波形测量" })).toBeDisabled();
  });

  it("默认为共享量程并为独立量程分配通道 scale 与焦点轴", async () => {
    const user = userEvent.setup();
    const { container } = render(<WaveformPanel theme="dark" />);

    const sharedChart = latestUPlotMock();
    expect(Object.keys(sharedChart.options.scales ?? {})).toEqual(["x", "y"]);
    expect(sharedChart.options.series?.slice(1).map((series) => series.scale)).toEqual([
      "y",
      "y",
    ]);
    expect(sharedChart.options.axes?.map((axis) => axis.scale)).toEqual(["x", "y"]);
    expect(screen.getByRole("button", { name: "共享" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "独立" }));
    const independentChart = latestUPlotMock();
    expect(Object.keys(independentChart.options.scales ?? {})).toEqual([
      "x",
      "channel:channel-0",
      "channel:channel-1",
    ]);
    expect(independentChart.options.series?.slice(1).map((series) => series.scale)).toEqual([
      "channel:channel-0",
      "channel:channel-1",
    ]);
    expect(independentChart.options.axes?.map((axis) => axis.scale)).toEqual([
      "x",
      "channel:channel-0",
    ]);
    expect(independentChart.options.axes?.[1]?.stroke).toBe(TEST_CHANNELS[0]?.color);
    expect(container.querySelector('.channel-readout[data-focused="true"] small')).toHaveTextContent(
      "电压",
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "独立量程焦点通道" }),
      "channel-1",
    );
    const focusedChart = latestUPlotMock();
    expect(focusedChart.options.axes?.map((axis) => axis.scale)).toEqual([
      "x",
      "channel:channel-1",
    ]);
    expect(focusedChart.options.axes?.[1]?.stroke).toBe(TEST_CHANNELS[1]?.color);
    expect(container.querySelector('.channel-readout[data-focused="true"] small')).toHaveTextContent(
      "电流",
    );
  });

  it("独立量程在焦点通道隐藏后回退并允许所有通道隐藏", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);
    await user.click(screen.getByRole("button", { name: "独立" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "独立量程焦点通道" }),
      "channel-1",
    );

    act(() => {
      useWorkbenchStore.setState({
        channels: TEST_CHANNELS.map((channel) =>
          channel.id === "channel-1" ? { ...channel, visible: false } : channel,
        ),
      });
    });
    expect(screen.getByRole("combobox", { name: "独立量程焦点通道" })).toHaveValue(
      "channel-0",
    );
    expect(latestUPlotMock().options.axes?.map((axis) => axis.scale)).toEqual([
      "x",
      "channel:channel-0",
    ]);

    act(() => {
      useWorkbenchStore.setState({
        channels: TEST_CHANNELS.map((channel) => ({ ...channel, visible: false })),
      });
    });
    expect(screen.getByRole("combobox", { name: "独立量程焦点通道" })).toBeDisabled();
    expect(latestUPlotMock().options.axes?.map((axis) => axis.scale)).toEqual(["x"]);
    expect(screen.getByRole("button", { name: "开启波形测量" })).toBeDisabled();
  });

  it("独立量程测量使用被测通道 scale 并同步焦点轴", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);
    await user.click(screen.getByRole("button", { name: "独立" }));
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "测量通道" }), "channel-1");

    const measuredChart = latestUPlotMock();
    expect(measuredChart.valToPosScaleKeys.slice(-4)).toEqual([
      "x",
      "x",
      "channel:channel-1",
      "channel:channel-1",
    ]);
    expect(screen.getByRole("combobox", { name: "独立量程焦点通道" })).toHaveValue(
      "channel-1",
    );
    expect(latestUPlotMock().options.axes?.map((axis) => axis.scale)).toEqual([
      "x",
      "channel:channel-1",
    ]);

    await user.click(screen.getByRole("button", { name: "关闭波形测量" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "独立量程焦点通道" }),
      "channel-0",
    );
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    expect(screen.getByRole("combobox", { name: "测量通道" })).toHaveValue("channel-1");
    expect(screen.getByRole("combobox", { name: "独立量程焦点通道" })).toHaveValue(
      "channel-1",
    );
  });

  it("触发只列出基础和派生通道并可布防解除", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      processedChannels: [
        {
          ...TEST_CHANNELS[0]!,
          id: "derived:filtered",
          name: "滤波值",
        },
      ],
      extensionChannels: [
        {
          ...TEST_CHANNELS[1]!,
          id: "extension:power",
          name: "扩展功率",
        },
      ],
    });
    render(<WaveformPanel theme="dark" />);

    await user.click(screen.getByRole("button", { name: "打开触发设置" }));
    const channelSelect = screen.getByRole("combobox", { name: "触发通道" });
    expect(within(channelSelect).getByRole("option", { name: "电压" })).toBeInTheDocument();
    expect(within(channelSelect).getByRole("option", { name: "滤波值" })).toBeInTheDocument();
    expect(within(channelSelect).queryByRole("option", { name: "扩展功率" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "下降沿" }));
    const threshold = screen.getByRole("spinbutton", { name: "触发阈值" });
    await user.clear(threshold);
    await user.type(threshold, "25");
    await user.click(screen.getByRole("button", { name: "布防" }));

    expect(useWorkbenchStore.getState().waveformTrigger).toMatchObject({
      phase: "armed",
      config: { channelId: "channel-0", edge: "falling", threshold: 25 },
    });
    expect(screen.getByRole("button", { name: "开启波形测量" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "关闭触发设置" }));
    act(() => {
      useWorkbenchStore.setState((state) => ({
        waveformTrigger: {
          ...state.waveformTrigger,
          phase: "triggered",
          triggerTimestampSeconds: 6,
          freezeTimestampSeconds: 8.5,
          previousValue: 40,
        },
      }));
    });
    expect(screen.queryByRole("combobox", { name: "触发通道" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开触发设置" }));
    await user.click(screen.getByRole("button", { name: "解除" }));
    expect(useWorkbenchStore.getState().waveformTrigger.phase).toBe("idle");
  });

  it("冻结捕获显示触发线并可重新布防恢复实时采集", async () => {
    const user = userEvent.setup();
    const armed = createArmedWaveformTriggerState(
      { channelId: "channel-0", edge: "rising", threshold: 25 },
      5,
    );
    useWorkbenchStore.setState({
      chartPaused: true,
      waveformTrigger: {
        ...armed,
        phase: "frozen",
        triggerTimestampSeconds: 3,
        freezeTimestampSeconds: 5.5,
      },
    });
    const { container } = render(<WaveformPanel theme="dark" />);

    expect(container.querySelector(".waveform-trigger-line")).not.toHaveAttribute("hidden");
    await user.click(await screen.findByRole("button", { name: "重新布防" }));
    expect(useWorkbenchStore.getState()).toMatchObject({
      chartPaused: false,
      waveformTrigger: { phase: "armed" },
    });
    expect(screen.getByText("LIVE")).toBeVisible();
  });

  it("开启时冻结视图并允许 range 控件切换采样点和通道", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);

    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    expect(useWorkbenchStore.getState().chartPaused).toBe(true);
    expect(screen.getByText("HISTORY")).toBeVisible();
    const results = screen.getByLabelText("波形测量结果");
    expect(within(results).getByText("yA").parentElement).toHaveTextContent("20.000");
    expect(within(results).getByText("yB").parentElement).toHaveTextContent("40.000");

    fireEvent.change(screen.getByRole("slider", { name: "游标 A 采样点" }), {
      target: { value: "2" },
    });
    expect(within(results).getByText("yA").parentElement).toHaveTextContent("30.000");

    await user.selectOptions(screen.getByRole("combobox", { name: "测量通道" }), "channel-1");
    expect(within(results).getByText("yA").parentElement).toHaveTextContent("2.000");
    expect(within(results).getByText("yB").parentElement).toHaveTextContent("4.000");
  });

  it("关闭测量时只恢复由测量触发的暂停", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<WaveformPanel theme="dark" />);
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    await user.click(screen.getByRole("button", { name: "关闭波形测量" }));
    expect(useWorkbenchStore.getState().chartPaused).toBe(false);
    unmount();

    useWorkbenchStore.setState({ chartPaused: true });
    render(<WaveformPanel theme="dark" />);
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    await user.click(screen.getByRole("button", { name: "关闭波形测量" }));
    expect(useWorkbenchStore.getState().chartPaused).toBe(true);
  });

  it("波形修订和清图都会清除测量状态", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));

    act(() => {
      useWorkbenchStore.setState({ chartDataRevision: 1 });
    });
    expect(screen.queryByLabelText("波形测量结果")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开启波形测量" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(useWorkbenchStore.getState().chartPaused).toBe(false);

    act(() => {
      useWorkbenchStore.setState({ chartPaused: true });
    });
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    act(() => {
      useWorkbenchStore.setState({ chartDataRevision: 2 });
    });
    expect(screen.queryByLabelText("波形测量结果")).not.toBeInTheDocument();
    expect(useWorkbenchStore.getState().chartPaused).toBe(true);

    act(() => {
      useWorkbenchStore.setState({ channels: TEST_CHANNELS, chartPaused: false });
    });
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    await user.click(screen.getByRole("button", { name: "清空波形" }));
    expect(screen.queryByLabelText("波形测量结果")).not.toBeInTheDocument();
    expect(useWorkbenchStore.getState().channels).toEqual([]);
    expect(useWorkbenchStore.getState().chartPaused).toBe(false);

    act(() => {
      useWorkbenchStore.setState({ channels: TEST_CHANNELS, chartPaused: true });
    });
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    await user.click(screen.getByRole("button", { name: "清空波形" }));
    expect(useWorkbenchStore.getState().chartPaused).toBe(true);
  });

  it("框选缩放后挂起视口跟随并可回到实时", async () => {
    const user = userEvent.setup();
    const { container } = render(<WaveformPanel theme="dark" />);
    const chart = latestUPlotMock();
    const followButton = container.querySelector<HTMLButtonElement>(".waveform-follow-latest");
    if (followButton === null) {
      throw new Error("未找到波形跟随按钮");
    }
    expect(followButton).toHaveAttribute("data-visible", "false");
    expect(followButton).toBeDisabled();
    expect(chart.setData).toHaveBeenLastCalledWith(expect.any(Array), true);

    act(() => chart.simulateScale("x"));
    expect(screen.queryByRole("button", { name: "回到实时波形" })).not.toBeInTheDocument();

    act(() => chart.simulateSelection());
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    });
    act(() => chart.simulateScale("x"));
    expect(screen.queryByRole("button", { name: "回到实时波形" })).not.toBeInTheDocument();

    await act(async () => chart.simulateXZoom());
    expect(screen.getByRole("button", { name: "回到实时波形" })).toBe(followButton);
    expect(followButton).toHaveAttribute("data-active", "true");
    expect(screen.getByText("LIVE")).toBeVisible();
    expect(useWorkbenchStore.getState().chartPaused).toBe(false);

    act(() => {
      useWorkbenchStore.setState({
        channels: TEST_CHANNELS.map((channel) => ({
          ...channel,
          points: [...channel.points, { x: 20, y: channel.lastValue + 1 }],
        })),
      });
    });
    expect(chart.setData).toHaveBeenLastCalledWith(expect.any(Array), false);
    expect(chart.setData.mock.calls.at(-1)?.[0]?.[0]).toEqual([1, 2, 3, 4, 5, 20]);

    await user.click(screen.getByRole("button", { name: "回到实时波形" }));
    expect(screen.queryByRole("button", { name: "回到实时波形" })).not.toBeInTheDocument();
    expect(followButton).toHaveAttribute("data-visible", "false");
    expect(followButton).toBeDisabled();
    expect(chart.setData).toHaveBeenLastCalledWith(expect.any(Array), true);
    expect(chart.setData.mock.calls.at(-1)?.[0]?.[0]).toEqual([20]);
  });

  it("暂停和波形修订会结束视口跟随挂起", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);

    await act(async () => latestUPlotMock().simulateXZoom());
    expect(screen.getByRole("button", { name: "回到实时波形" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "暂停波形显示" }));
    expect(screen.queryByRole("button", { name: "回到实时波形" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "继续波形显示" }));
    await act(async () => latestUPlotMock().simulateXZoom());
    expect(screen.getByRole("button", { name: "回到实时波形" })).toBeVisible();
    act(() => {
      useWorkbenchStore.setState({ chartDataRevision: 1 });
    });
    expect(screen.queryByRole("button", { name: "回到实时波形" })).not.toBeInTheDocument();
  });
});
