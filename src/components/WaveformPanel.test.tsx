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
  readonly setScale: ReturnType<typeof vi.fn>;
  readonly scales: Record<string, { min?: number; max?: number }>;
  readonly valToPosScaleKeys: string[];
  simulateScale(scaleKey: string): void;
  simulateSelection(): void;
  simulateXZoom(): Promise<void>;
}

interface UPlotMockOptions {
  width: number;
  height: number;
  scales?: Record<
    string,
    { auto?: boolean; time?: boolean; range?: [number, number] }
  >;
  axes?: Array<{ scale?: string; stroke?: string }>;
  series?: Array<{ label?: string; scale?: string; show?: boolean; stroke?: string }>;
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
    readonly scales: Record<string, { min?: number; max?: number }> = {
      x: { min: 1, max: 5 },
    };
    readonly setScale = vi.fn(
      (scaleKey: string, range: { min?: number; max?: number }) => {
        this.scales[scaleKey] = { ...range };
        this.hooks.setScale?.forEach((hook) => hook(this, scaleKey));
      },
    );
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
      this.scales.x = { min: 2, max: 4 };
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
      protocol: "firewater",
      replaySessionId: 0,
      replayHeader: undefined,
      channelPresentations: { firewater: {}, justfloat: {} },
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

  it("在读数、触发和测量中应用别名、单位与颜色且保留原始序列标签", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      channelPresentations: {
        firewater: {
          "channel-0": {
            alias: "母线电压",
            unit: "V",
            color: "#abcdef",
          },
        },
        justfloat: {},
      },
    });
    const { container } = render(<WaveformPanel theme="dark" />);

    const firstReadout = container.querySelector(".channel-readout");
    expect(firstReadout).toHaveTextContent("母线电压50.000V");
    expect(firstReadout?.querySelector(":scope > span")).toHaveStyle({
      backgroundColor: "#abcdef",
    });
    expect(latestUPlotMock().options.series?.[1]).toMatchObject({
      label: "电压",
      stroke: "#abcdef",
    });
    expect(useWorkbenchStore.getState().channels[0]).toMatchObject({
      name: "电压",
      color: "#46d89c",
      lastValue: 50,
    });

    await user.click(screen.getByRole("button", { name: "打开触发设置" }));
    expect(screen.getByRole("combobox", { name: "触发通道" })).toHaveTextContent(
      "母线电压",
    );
    expect(screen.getByText("阈值 (V)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭触发设置" }));

    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    expect(await screen.findByRole("combobox", { name: "测量通道" })).toHaveTextContent(
      "母线电压",
    );
    const yA = screen.getByText("yA").parentElement;
    const yB = screen.getByText("yB").parentElement;
    const deltaY = screen.getByText("Δy").parentElement;
    expect(yA).toHaveTextContent(/V/);
    expect(yB).toHaveTextContent(/V/);
    expect(deltaY).toHaveTextContent(/V/);
    const statistics = screen.getByLabelText("A/B 区间统计");
    expect(within(statistics).getByText("样本数").parentElement).toHaveTextContent("3");
    expect(within(statistics).getByText("最小值").parentElement).toHaveTextContent("20.000 V");
    expect(within(statistics).getByText("最大值").parentElement).toHaveTextContent("40.000 V");
    expect(within(statistics).getByText("均值").parentElement).toHaveTextContent("30.000 V");
    expect(within(statistics).getByText("RMS").parentElement).toHaveTextContent("31.091 V");
    expect(within(statistics).getByText("峰峰值").parentElement).toHaveTextContent("20.000 V");
    expect(
      container
        .querySelector<HTMLElement>('.waveform-measurement-cursor[data-cursor="A"]')
        ?.style.getPropertyValue("--measurement-channel-color"),
    ).toBe("#abcdef");

    const chartCount = uPlotMockInstances.length;
    act(() => {
      useWorkbenchStore.getState().setChannelPresentation("firewater", "channel-0", {
        alias: "电源电压",
        unit: "V",
        color: "#abcdef",
      });
    });
    expect(screen.getByRole("button", { name: "关闭波形测量" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "测量通道" })).toHaveTextContent(
      "电源电压",
    );
    expect(uPlotMockInstances).toHaveLength(chartCount);
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

  it("固定共享 Y 轴并显式恢复自动量程", async () => {
    const user = userEvent.setup();
    const { container } = render(<WaveformPanel theme="dark" />);

    expect(container.querySelector(".waveform-panel")).toHaveAttribute(
      "data-y-range-mode",
      "auto",
    );
    expect(latestUPlotMock().options.scales?.y).toEqual({ auto: true });

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    const rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    expect(within(rangeForm).getByText("共享 Y 轴")).toBeVisible();
    expect(within(rangeForm).getByText("AUTO")).toBeVisible();
    const minimum = within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" });
    const maximum = within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" });
    await user.clear(minimum);
    await user.type(minimum, "0");
    await user.clear(maximum);
    await user.type(maximum, "100");
    await user.click(within(rangeForm).getByRole("button", { name: "固定" }));

    expect(container.querySelector(".waveform-panel")).toHaveAttribute(
      "data-y-range-mode",
      "fixed",
    );
    expect(container.querySelector(".waveform-panel")).toHaveAttribute(
      "data-y-range-min",
      "0",
    );
    expect(container.querySelector(".waveform-panel")).toHaveAttribute(
      "data-y-range-max",
      "100",
    );
    expect(latestUPlotMock().options.scales?.y).toEqual({
      auto: false,
      range: [0, 100],
    });
    expect(screen.getByRole("button", { name: "设置 Y 轴量程" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("button", { name: "设置 Y 轴量程" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    await user.click(screen.getByRole("button", { name: "自动" }));
    expect(container.querySelector(".waveform-panel")).toHaveAttribute(
      "data-y-range-mode",
      "auto",
    );
    expect(latestUPlotMock().options.scales?.y).toEqual({ auto: true });
  });

  it("拒绝非递增范围且保留已应用范围", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    let rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    const initialMinimum = within(rangeForm).getByRole("spinbutton", {
      name: "Y 轴下限",
    });
    const initialMaximum = within(rangeForm).getByRole("spinbutton", {
      name: "Y 轴上限",
    });
    await user.clear(initialMinimum);
    await user.type(initialMinimum, "-10");
    await user.clear(initialMaximum);
    await user.type(initialMaximum, "10");
    await user.click(within(rangeForm).getByRole("button", { name: "固定" }));

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    const minimum = within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" });
    const maximum = within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" });
    await user.clear(minimum);
    await user.type(minimum, "10");
    await user.clear(maximum);
    await user.type(maximum, "10");

    expect(within(rangeForm).getByRole("alert")).toHaveTextContent(
      "下限必须小于上限",
    );
    expect(within(rangeForm).getByRole("button", { name: "固定" })).toBeDisabled();
    expect(latestUPlotMock().options.scales?.y?.range).toEqual([-10, 10]);
  });

  it("为独立通道保存隔离的固定范围并保留共享范围", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    let rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    await user.clear(within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" }));
    await user.type(
      within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" }),
      "-100",
    );
    await user.clear(within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" }));
    await user.type(
      within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" }),
      "100",
    );
    await user.click(within(rangeForm).getByRole("button", { name: "固定" }));

    await user.click(screen.getByRole("button", { name: "独立" }));
    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    await user.clear(within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" }));
    await user.type(
      within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" }),
      "0",
    );
    await user.clear(within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" }));
    await user.type(
      within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" }),
      "60",
    );
    await user.click(within(rangeForm).getByRole("button", { name: "固定" }));
    expect(latestUPlotMock().options.scales?.["channel:channel-0"]).toEqual({
      auto: false,
      range: [0, 60],
    });
    expect(latestUPlotMock().options.scales?.["channel:channel-1"]).toEqual({
      auto: true,
    });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "独立量程焦点通道" }),
      "channel-1",
    );
    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    await user.clear(within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" }));
    await user.type(
      within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" }),
      "-5",
    );
    await user.clear(within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" }));
    await user.type(
      within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" }),
      "5",
    );
    await user.click(within(rangeForm).getByRole("button", { name: "固定" }));
    expect(latestUPlotMock().options.scales?.["channel:channel-0"]?.range).toEqual([
      0,
      60,
    ]);
    expect(latestUPlotMock().options.scales?.["channel:channel-1"]?.range).toEqual([
      -5,
      5,
    ]);

    await user.click(screen.getByRole("button", { name: "共享" }));
    expect(latestUPlotMock().options.scales?.y?.range).toEqual([-100, 100]);

    await user.click(screen.getByRole("button", { name: "独立" }));
    act(() => {
      useWorkbenchStore.setState({ channels: [TEST_CHANNELS[0]!] });
    });
    act(() => {
      useWorkbenchStore.setState({ channels: TEST_CHANNELS });
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "独立量程焦点通道" }),
      "channel-1",
    );
    expect(latestUPlotMock().options.scales?.["channel:channel-1"]).toEqual({
      auto: true,
    });
  });

  it("固定范围跨视图操作保留并在数据修订或清图时恢复自动", async () => {
    const user = userEvent.setup();
    render(<WaveformPanel theme="dark" />);

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    const rangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    const minimum = within(rangeForm).getByRole("spinbutton", { name: "Y 轴下限" });
    const maximum = within(rangeForm).getByRole("spinbutton", { name: "Y 轴上限" });
    await user.clear(minimum);
    await user.type(minimum, "0");
    await user.clear(maximum);
    await user.type(maximum, "100");
    await user.click(within(rangeForm).getByRole("button", { name: "固定" }));

    const zoomedChart = latestUPlotMock();
    await act(async () => zoomedChart.simulateXZoom());
    expect(screen.getByRole("button", { name: "回到实时波形" })).toBeVisible();
    expect(zoomedChart.scales.x).toEqual({ min: 2, max: 4 });

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    const updatedRangeForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    const updatedMaximum = within(updatedRangeForm).getByRole("spinbutton", {
      name: "Y 轴上限",
    });
    await user.clear(updatedMaximum);
    await user.type(updatedMaximum, "200");
    await user.click(within(updatedRangeForm).getByRole("button", { name: "固定" }));
    expect(latestUPlotMock()).not.toBe(zoomedChart);
    expect(latestUPlotMock().scales.x).toEqual({ min: 2, max: 4 });
    expect(screen.getByRole("button", { name: "回到实时波形" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "15s" }));
    await user.click(screen.getByRole("button", { name: "暂停波形显示" }));
    await user.click(screen.getByRole("button", { name: "开启波形测量" }));
    expect(latestUPlotMock().options.scales?.y?.range).toEqual([0, 200]);

    act(() => {
      useWorkbenchStore.setState({ chartDataRevision: 1 });
    });
    expect(latestUPlotMock().options.scales?.y).toEqual({ auto: true });
    expect(screen.getByRole("button", { name: "设置 Y 轴量程" })).toHaveAttribute(
      "data-active",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "设置 Y 轴量程" }));
    const nextForm = screen.getByRole("form", { name: "Y 轴量程设置" });
    await user.type(
      within(nextForm).getByRole("spinbutton", { name: "Y 轴下限" }),
      "0",
    );
    await user.type(
      within(nextForm).getByRole("spinbutton", { name: "Y 轴上限" }),
      "100",
    );
    await user.click(within(nextForm).getByRole("button", { name: "固定" }));
    await user.click(screen.getByRole("button", { name: "清空波形" }));
    expect(screen.queryByRole("button", { name: "设置 Y 轴量程" })).not.toBeInTheDocument();
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
    const results = await screen.findByLabelText("波形测量结果");
    expect(within(results).getByText("yA").parentElement).toHaveTextContent("20.000");
    expect(within(results).getByText("yB").parentElement).toHaveTextContent("40.000");
    const statistics = screen.getByLabelText("A/B 区间统计");
    expect(within(statistics).getByText("样本数").parentElement).toHaveTextContent("3");
    expect(within(statistics).getByText("均值").parentElement).toHaveTextContent("30.000");

    fireEvent.change(screen.getByRole("slider", { name: "游标 A 采样点" }), {
      target: { value: "2" },
    });
    expect(within(results).getByText("yA").parentElement).toHaveTextContent("30.000");
    expect(within(statistics).getByText("样本数").parentElement).toHaveTextContent("2");
    expect(within(statistics).getByText("均值").parentElement).toHaveTextContent("35.000");

    await user.selectOptions(screen.getByRole("combobox", { name: "测量通道" }), "channel-1");
    expect(within(results).getByText("yA").parentElement).toHaveTextContent("2.000");
    expect(within(results).getByText("yB").parentElement).toHaveTextContent("4.000");
    expect(within(statistics).getByText("样本数").parentElement).toHaveTextContent("3");
    expect(within(statistics).getByText("均值").parentElement).toHaveTextContent("3.000");
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
