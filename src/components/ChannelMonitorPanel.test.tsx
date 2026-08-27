import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultWorkspaceConfig } from "../core/workspaces";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ChannelSeries } from "../types/workbench";
import { ChannelMonitorPanel } from "./ChannelMonitorPanel";

describe("ChannelMonitorPanel", () => {
  beforeEach(() => {
    const workspace = createDefaultWorkspaceConfig("simulator");
    useWorkbenchStore.setState({
      ...workspace,
      source: "simulator",
      protocol: "firewater",
      replayStatus: "idle",
      replaySessionId: 0,
      channels: [],
      processedChannels: [],
      extensionChannels: [],
      extensionChannelVisibility: {},
      chartDataRevision: 0,
      chartPaused: false,
    });
  });

  afterEach(() => cleanup());

  it("分组显示可见基础、派生与扩展通道并沿用展示配置", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      channels: [
        createChannel("channel-0", "temp", [10, 12]),
        createChannel("channel-1", "hidden", [5], false),
      ],
      processedChannels: [createChannel("derived:average", "平均值", [2, 4])],
      extensionChannels: [createChannel("extension:test:0", "扩展电压", [9, 7])],
      channelPresentations: {
        firewater: {
          "channel-0": { alias: "温度", unit: "°C", color: "#55bde8" },
        },
        justfloat: {},
      },
    });
    render(<ChannelMonitorPanel />);

    expect(screen.getByRole("table", { name: "通道实时统计" })).toBeInTheDocument();
    expect(screen.getByRole("rowgroup", { name: "基础通道" })).toBeInTheDocument();
    expect(screen.getByRole("rowgroup", { name: "派生通道" })).toBeInTheDocument();
    expect(screen.getByRole("rowgroup", { name: "扩展通道" })).toBeInTheDocument();
    const temperatureRow = screen.getByText("温度").closest("tr");
    expect(temperatureRow).not.toBeNull();
    expect(
      (temperatureRow as HTMLTableRowElement).querySelector(".channel-monitor-current-cell"),
    ).toHaveTextContent("12.000 °C");
    expect(within(temperatureRow as HTMLTableRowElement).getByText("+2.000 °C")).toBeVisible();
    expect(within(temperatureRow as HTMLTableRowElement).getByText("11.000 °C")).toBeVisible();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByText("hidden")).toBeVisible();
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("冻结只保存本地统计快照，继续后立即读取最新值", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      channels: [createChannel("channel-0", "CH 1", [1, 2])],
    });
    render(<ChannelMonitorPanel />);

    await user.click(screen.getByRole("button", { name: "冻结通道监视" }));
    expect(screen.getByText("HOLD")).toBeVisible();
    act(() => {
      useWorkbenchStore.setState({
        channels: [createChannel("channel-0", "CH 1", [1, 2, 5])],
      });
    });
    expect(screen.getByText("2.000", { selector: ".channel-monitor-current-cell" })).toBeVisible();
    expect(useWorkbenchStore.getState().chartPaused).toBe(false);

    await user.click(screen.getByRole("button", { name: "继续通道监视" }));
    expect(screen.getByText("5.000", { selector: ".channel-monitor-current-cell" })).toBeVisible();
    expect(screen.getByText("LIVE")).toBeVisible();
  });

  it("数据流边界变化时自动解除旧快照", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      channels: [createChannel("channel-0", "CH 1", [1, 2])],
      chartDataRevision: 7,
    });
    render(<ChannelMonitorPanel />);
    await user.click(screen.getByRole("button", { name: "冻结通道监视" }));

    act(() => {
      useWorkbenchStore.setState({
        channels: [createChannel("channel-0", "CH 1", [9])],
        chartDataRevision: 8,
      });
    });

    expect(screen.getByRole("button", { name: "冻结通道监视" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("9.000", { selector: ".channel-monitor-current-cell" })).toBeVisible();
  });

  it("全部通道隐藏时提供明确空态和查看全部操作", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      channels: [createChannel("channel-0", "隐藏通道", [3], false)],
    });
    render(<ChannelMonitorPanel />);

    expect(screen.getByText("没有可见通道")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "查看全部" }));
    expect(screen.getByText("隐藏通道")).toBeVisible();
  });
});

function createChannel(
  id: string,
  name: string,
  values: readonly number[],
  visible = true,
): ChannelSeries {
  return {
    id,
    name,
    color: "#46d89c",
    visible,
    points: values.map((value, index) => ({ x: index + 1, y: value })),
    lastValue: values.at(-1) ?? Number.NaN,
  };
}
