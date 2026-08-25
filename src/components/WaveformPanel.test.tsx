import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ChannelSeries } from "../types/workbench";
import { WaveformPanel } from "./WaveformPanel";

interface UPlotMockInstance {
  readonly setData: ReturnType<typeof vi.fn>;
  simulateScale(scaleKey: string): void;
  simulateSelection(): void;
  simulateXZoom(): Promise<void>;
}

const uPlotMockInstances = vi.hoisted(() => [] as UPlotMockInstance[]);

vi.mock("uplot", () => ({
  default: class UPlotMock {
    readonly over = document.createElement("div");
    readonly select = { left: 0, top: 0, width: 0, height: 0 };
    readonly setData = vi.fn();
    width: number;
    height: number;
    private readonly hooks: {
      setScale?: Array<(chart: unknown, scaleKey: string) => void>;
      setSelect?: Array<(chart: unknown) => void>;
    };

    constructor(
      options: {
        width: number;
        height: number;
        hooks?: {
          setScale?: Array<(chart: unknown, scaleKey: string) => void>;
          setSelect?: Array<(chart: unknown) => void>;
        };
      },
      _data: unknown,
      target: HTMLElement,
    ) {
      this.width = options.width;
      this.height = options.height;
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

    valToPos(value: number): number {
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
      chartPaused: false,
      chartWindowSeconds: 5,
      chartDataRevision: 0,
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
