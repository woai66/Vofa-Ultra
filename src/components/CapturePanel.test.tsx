import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ReplayCaptureHeader, ReplayUiStatus } from "../types/replay";
import { CapturePanel } from "./CapturePanel";

const initialState = useWorkbenchStore.getInitialState();
const replayHeader: ReplayCaptureHeader = {
  source: "simulator",
  protocol: "firewater",
  serialConfig: {
    portName: "",
    baudRate: 115_200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flowControl: "none",
    dtr: true,
    rts: true,
  },
  startedAtUnixMs: 1_000,
  timeUnit: "microseconds",
};

const playReplayMock = vi.fn(async () => true);
const pauseReplayMock = vi.fn(async () => true);
const stopReplayMock = vi.fn(async () => true);
const closeReplayMock = vi.fn(async () => true);

function loadReplay(
  status: ReplayUiStatus,
  overrides: Partial<ReturnType<typeof useWorkbenchStore.getState>> = {},
): void {
  useWorkbenchStore.setState({
    isNativeRuntime: true,
    workspaceTransitionStatus: "idle",
    runtimeTransitionStatus: "idle",
    replayStatus: status,
    replaySessionId: 7,
    replayGeneration: 2,
    replayRevision: 3,
    replayPath: "C:\\captures\\session.vucap",
    replayHeader,
    replayComplete: true,
    replayPositionUs: 1_000_000,
    replayDurationUs: 3_500_000,
    replayDataBytes: 2_048,
    replayRecordCount: 128,
    replayMessage: "",
    playReplay: playReplayMock,
    pauseReplay: pauseReplayMock,
    stopReplay: stopReplayMock,
    closeReplay: closeReplayMock,
    ...overrides,
  });
}

describe("CapturePanel replay controls", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkbenchStore.persist.clearStorage();
    useWorkbenchStore.setState(initialState, true);
    playReplayMock.mockClear();
    pauseReplayMock.mockClear();
    stopReplayMock.mockClear();
    closeReplayMock.mockClear();
  });

  afterEach(() => cleanup());

  it("呈现已加载完整回放的文件、进度和基础控制", () => {
    loadReplay("ready");

    render(<CapturePanel />);

    expect(screen.getByRole("tab", { name: "回放" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("回放已就绪")).toBeInTheDocument();
    expect(screen.getByText("FireWater · 1×")).toBeInTheDocument();
    expect(screen.getByText("00:00:01 / 00:00:03")).toBeInTheDocument();
    expect(screen.getByText("2.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("完整捕获")).toBeInTheDocument();
    expect(screen.getByText("session.vucap")).toBeInTheDocument();
    expect(screen.getByText("C:\\captures\\session.vucap")).toBeInTheDocument();

    const progress = screen.getByRole("progressbar", { name: "回放进度" });
    expect(progress).toHaveAttribute("max", "3500000");
    expect(progress).toHaveAttribute("value", "1000000");
    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止回放" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭回放" })).toBeEnabled();
  });

  it("截断尾部警告下正确切换播放、暂停、继续和停止控制", async () => {
    const user = userEvent.setup();
    const warning = "捕获文件未正常结束，将回放已验证的完整记录前缀";
    loadReplay("playing", {
      replayComplete: false,
      replayMessage: warning,
    });

    render(<CapturePanel />);

    expect(screen.getByText("尾部不完整，仅回放有效记录")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(warning);
    expect(screen.getByText("正在回放")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止回放" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(pauseReplayMock).toHaveBeenCalledOnce();

    act(() => useWorkbenchStore.setState({ replayStatus: "paused" }));
    expect(screen.getByText("回放已暂停")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(warning);
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止回放" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "继续" }));
    await user.click(screen.getByRole("button", { name: "停止回放" }));
    expect(playReplayMock).toHaveBeenCalledOnce();
    expect(stopReplayMock).toHaveBeenCalledOnce();

    act(() => useWorkbenchStore.setState({ replayStatus: "stopping" }));
    expect(screen.getByText("正在停止")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止回放" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭回放" })).toBeDisabled();
  });
});
