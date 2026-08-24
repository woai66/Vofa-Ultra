import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { CaptureExportUiStatus } from "../types/captureExport";
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
const seekReplayMock = vi.fn(async () => true);
const stopReplayMock = vi.fn(async () => true);
const closeReplayMock = vi.fn(async () => true);
const selectCaptureExportSourceMock = vi.fn(async () => true);
const useRecentCaptureForExportMock = vi.fn(() => true);
const startCaptureExportMock = vi.fn(async () => true);
const cancelCaptureExportMock = vi.fn(async () => true);
const clearCaptureExportMock = vi.fn(async () => true);

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
    replayTimelineRevision: 0,
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
    seekReplay: seekReplayMock,
    stopReplay: stopReplayMock,
    closeReplay: closeReplayMock,
    ...overrides,
  });
}

function loadExport(
  status: CaptureExportUiStatus,
  overrides: Partial<ReturnType<typeof useWorkbenchStore.getState>> = {},
): void {
  useWorkbenchStore.setState({
    isNativeRuntime: true,
    captureStatus: "idle",
    captureExportStatus: status,
    captureExportPhase: status === "running" ? "reading" : "idle",
    captureExportJobId: status === "idle" ? 0 : 7,
    captureExportRevision: status === "idle" ? 0 : 3,
    captureExportSourcePath: "C:\\captures\\session.vucap",
    captureExportDestinationPath: "",
    captureExportFormat: "csv",
    captureExportDirection: "both",
    captureExportAllowIncomplete: false,
    captureExportTotalInputBytes: 4_096,
    captureExportProcessedInputBytes: 0,
    captureExportProcessedDataBytes: 0,
    captureExportProcessedRecords: 0,
    captureExportExportedDataBytes: 0,
    captureExportExportedRecords: 0,
    captureExportOutputBytes: 0,
    captureExportSourceComplete: false,
    captureExportMessage: "",
    selectCaptureExportSource: selectCaptureExportSourceMock,
    useRecentCaptureForExport: useRecentCaptureForExportMock,
    startCaptureExport: startCaptureExportMock,
    cancelCaptureExport: cancelCaptureExportMock,
    clearCaptureExport: clearCaptureExportMock,
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
    seekReplayMock.mockClear();
    stopReplayMock.mockClear();
    closeReplayMock.mockClear();
    selectCaptureExportSourceMock.mockClear();
    useRecentCaptureForExportMock.mockClear();
    startCaptureExportMock.mockClear();
    cancelCaptureExportMock.mockClear();
    clearCaptureExportMock.mockClear();
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

    const slider = screen.getByRole("slider", { name: "回放位置" });
    expect(slider).toHaveAttribute("max", "3500000");
    expect(slider).toHaveValue("1000000");
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute("title", "结构化协议回放暂不支持定位");
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

  it("Raw 回放滑杆拖动时只更新草稿并在松手时提交一次", () => {
    loadReplay("paused", {
      replayHeader: { ...replayHeader, protocol: "raw" },
    });

    render(<CapturePanel />);

    const slider = screen.getByRole("slider", { name: "回放位置" });
    expect(slider).toBeEnabled();
    fireEvent.change(slider, { target: { value: "2100000" } });
    expect(seekReplayMock).not.toHaveBeenCalled();
    expect(screen.getByText("00:00:02 / 00:00:03")).toBeInTheDocument();

    fireEvent.pointerUp(slider);
    fireEvent.blur(slider);
    expect(seekReplayMock).toHaveBeenCalledOnce();
    expect(seekReplayMock).toHaveBeenCalledWith(2_100_000);
  });

  it("定位中允许停止或关闭但不能启动新播放", () => {
    loadReplay("seeking", {
      replayHeader: { ...replayHeader, protocol: "raw" },
      replayPositionUs: 2_000_000,
    });

    render(<CapturePanel />);

    expect(screen.getByText("正在定位")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "回放位置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止回放" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "关闭回放" })).toBeEnabled();
  });

  it("提供完整导出配置并在二进制模式禁止双向输出", async () => {
    const user = userEvent.setup();
    loadExport("idle", {
      capturePath: "C:\\captures\\recent.vucap",
      captureExportFormat: "binary",
      captureExportDirection: "rx",
    });

    render(<CapturePanel />);
    await user.click(screen.getByRole("tab", { name: "导出" }));

    expect(screen.getByLabelText("导出状态")).toHaveTextContent("等待导出");
    expect(screen.getByText("BIN · 仅 RX")).toBeInTheDocument();
    expect(screen.getByText("session.vucap")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "BIN" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "双向" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "RX" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "允许导出不完整文件的有效前缀" }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "选择位置并导出" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "使用最近录制" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "选择位置并导出" }));
    await user.click(screen.getByRole("button", { name: "使用最近录制" }));
    expect(startCaptureExportMock).toHaveBeenCalledOnce();
    expect(useRecentCaptureForExportMock).toHaveBeenCalledOnce();
  });

  it("导出运行时呈现进度并允许在提交前取消", async () => {
    const user = userEvent.setup();
    loadExport("running", {
      captureExportPhase: "reading",
      captureExportDestinationPath: "C:\\captures\\session.csv",
      captureExportProcessedInputBytes: 1_024,
      captureExportProcessedDataBytes: 512,
      captureExportProcessedRecords: 8,
      captureExportExportedDataBytes: 512,
      captureExportExportedRecords: 8,
      captureExportOutputBytes: 2_048,
      captureExportMessage: "正在读取并转换捕获记录",
    });

    render(<CapturePanel />);
    await user.click(screen.getByRole("tab", { name: "导出" }));

    expect(screen.getByLabelText("导出状态")).toHaveTextContent("正在流式导出");
    expect(screen.getByText("25%")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar", { name: "导出进度" });
    expect(progress).toHaveAttribute("max", "4096");
    expect(progress).toHaveAttribute("value", "1024");
    expect(screen.getByRole("button", { name: "选择捕获文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消导出" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "取消导出" }));
    expect(cancelCaptureExportMock).toHaveBeenCalledOnce();

    act(() =>
      useWorkbenchStore.setState({
        captureExportPhase: "committing",
        captureExportMessage: "正在原子提交导出文件",
      }),
    );
    expect(screen.getByRole("button", { name: "正在提交文件" })).toBeDisabled();
  });

  it("完成不完整源文件导出时明确标记有效前缀", async () => {
    const user = userEvent.setup();
    loadExport("completed", {
      captureExportPhase: "done",
      captureExportDestinationPath: "C:\\captures\\session.jsonl",
      captureExportFormat: "jsonl",
      captureExportProcessedInputBytes: 4_096,
      captureExportExportedRecords: 12,
      captureExportOutputBytes: 3_072,
      captureExportSourceComplete: false,
      captureExportMessage: "导出完成；源捕获不完整",
    });

    render(<CapturePanel />);
    await user.click(screen.getByRole("tab", { name: "导出" }));

    expect(screen.getByLabelText("导出状态")).toHaveTextContent("导出已完成");
    expect(screen.getByText("已提交源文件的有效记录前缀")).toBeInTheDocument();
    expect(screen.getByText("session.jsonl")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除导出结果" })).toBeEnabled();
  });
});
