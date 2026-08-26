import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAttitudeConfig, extractLatestAttitudeSample } from "../core/attitude";
import { createDefaultWorkspaceConfig } from "../core/workspaces";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { AttitudeChannelValue, AttitudeQuaternion } from "../types/attitude";
import type { ChannelSeries } from "../types/workbench";
import { AttitudePanel } from "./AttitudePanel";

vi.mock("./AttitudeScene", () => ({
  AttitudeScene: ({
    orientation,
    resetToken,
  }: {
    orientation: AttitudeQuaternion;
    resetToken: number;
  }) => (
    <div role="img" aria-label="三维姿态视图" data-reset-token={resetToken}>
      {JSON.stringify(orientation)}
    </div>
  ),
}));

const NAMED_CHANNELS: ChannelSeries[] = [
  createChannel("channel-0", "roll", 1),
  createChannel("channel-1", "pitch", 2),
  createChannel("channel-2", "yaw", 3),
  createChannel("channel-3", "qw", 1),
  createChannel("channel-4", "qx", 0),
  createChannel("channel-5", "qy", 0),
  createChannel("channel-6", "qz", 0),
];

describe("AttitudePanel", () => {
  beforeEach(() => {
    const workspace = createDefaultWorkspaceConfig("simulator");
    useWorkbenchStore.setState({
      ...workspace,
      channels: NAMED_CHANNELS,
      processedChannels: [],
      attitudeSample: null,
      source: "simulator",
      protocol: "firewater",
      serialGeneration: 0,
      replaySessionId: 0,
      replayTimelineRevision: 0,
      workspaceTransitionStatus: "idle",
    });
  });

  afterEach(() => cleanup());

  it("未配置时显示明确状态并禁止重复通道映射", async () => {
    const user = userEvent.setup();
    render(<AttitudePanel theme="dark" />);

    expect(screen.getByText("姿态映射未完成")).toBeInTheDocument();
    const configuration = screen.getByRole("dialog", { name: "姿态通道配置" });
    const roll = within(configuration).getByRole("combobox", { name: "Roll 姿态通道" });
    const pitch = within(configuration).getByRole("combobox", { name: "Pitch 姿态通道" });
    await user.selectOptions(roll, "channel-0");
    expect(within(pitch).getByRole("option", { name: "roll" })).toBeDisabled();
    await user.selectOptions(pitch, "channel-1");
    await user.selectOptions(
      within(configuration).getByRole("combobox", { name: "Yaw 姿态通道" }),
      "channel-2",
    );

    expect(useWorkbenchStore.getState().attitudeConfig.channels).toMatchObject({
      roll: "channel-0",
      pitch: "channel-1",
      yaw: "channel-2",
    });
    expect(screen.queryByText("姿态映射未完成")).not.toBeInTheDocument();
  });

  it("可自动识别常见 Euler 与四元数标签并切换单位控件", async () => {
    const user = userEvent.setup();
    render(<AttitudePanel theme="dark" />);
    await user.click(screen.getByRole("button", { name: "自动映射姿态通道" }));
    expect(useWorkbenchStore.getState().attitudeConfig.channels).toMatchObject({
      roll: "channel-0",
      pitch: "channel-1",
      yaw: "channel-2",
    });

    await user.click(screen.getByRole("button", { name: "Quaternion" }));
    expect(screen.queryByRole("group", { name: "姿态角单位" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "自动映射姿态通道" }));
    expect(useWorkbenchStore.getState().attitudeConfig.channels).toMatchObject({
      w: "channel-3",
      x: "channel-4",
      y: "channel-5",
      z: "channel-6",
    });
  });

  it("冻结保持读数，归零改变显示四元数，视角复位更新 token", async () => {
    const user = userEvent.setup();
    const config = completeEulerConfig();
    const firstSample = sampleFor(config, [10, 20, 30], 1);
    useWorkbenchStore.setState({
      attitudeConfig: config,
      attitudeSample: { ...firstSample, receivedAt: Date.now() },
    });
    render(<AttitudePanel theme="dark" />);
    const scene = screen.getByRole("img", { name: "三维姿态视图" });
    const initialOrientation = scene.textContent;

    await user.click(screen.getByRole("button", { name: "冻结姿态显示" }));
    expect(screen.getByText("HOLD")).toBeInTheDocument();
    const secondSample = sampleFor(config, [40, 50, 60], 2);
    act(() => {
      useWorkbenchStore.setState({
        attitudeSample: { ...secondSample, receivedAt: Date.now() },
      });
    });
    expect(within(screen.getByLabelText("当前姿态值")).getByText("10.000°")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "以当前姿态归零" }));
    expect(scene.textContent).not.toBe(initialOrientation);
    expect(screen.getByRole("button", { name: "取消姿态归零" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    expect(scene).toHaveAttribute("data-reset-token", "0");
    await user.click(screen.getByRole("button", { name: "复位三维视角" }));
    expect(scene).toHaveAttribute("data-reset-token", "1");

    await user.click(screen.getByRole("button", { name: "继续姿态显示" }));
    expect(within(screen.getByLabelText("当前姿态值")).getByText("40.000°")).toBeVisible();
  });
});

function createChannel(id: string, name: string, lastValue: number): ChannelSeries {
  return {
    id,
    name,
    color: "#46d89c",
    visible: true,
    points: [],
    lastValue,
  };
}

function completeEulerConfig() {
  const config = createDefaultAttitudeConfig();
  config.channels.roll = "channel-0";
  config.channels.pitch = "channel-1";
  config.channels.yaw = "channel-2";
  return config;
}

function sampleFor(config: ReturnType<typeof completeEulerConfig>, values: number[], frameIndex: number) {
  const channelValues: AttitudeChannelValue[] = values.map((value, index) => ({
    frameIndex,
    timestamp: frameIndex * 1_000,
    channelId: `channel-${index}`,
    value,
  }));
  const sample = extractLatestAttitudeSample(config, channelValues);
  if (!sample) {
    throw new Error("测试姿态样本无效");
  }
  return sample;
}
