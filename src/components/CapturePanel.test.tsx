import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { CaptureExportUiStatus } from "../types/captureExport";
import type { NumericLogUiStatus } from "../types/numericLog";
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
const setReplaySpeedMock = vi.fn(async () => true);
const stopReplayMock = vi.fn(async () => true);
const closeReplayMock = vi.fn(async () => true);
const selectCaptureExportSourceMock = vi.fn(async () => true);
const useRecentCaptureForExportMock = vi.fn(() => true);
const startCaptureExportMock = vi.fn(async () => true);
const cancelCaptureExportMock = vi.fn(async () => true);
const clearCaptureExportMock = vi.fn(async () => true);
const startNumericLogMock = vi.fn(async () => true);
const stopNumericLogMock = vi.fn(async () => true);
const addCaptureMarkerMock = vi.fn(() => true);

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
    replayFormatVersion: 2,
    replayComplete: true,
    replaySpeed: 1,
    replayPositionUs: 1_000_000,
    replayDurationUs: 3_500_000,
    replayDataBytes: 2_048,
    replayRecordCount: 128,
    replayMarkerCount: 0,
    replayMarkers: [],
    replayMessage: "",
    playReplay: playReplayMock,
    pauseReplay: pauseReplayMock,
    seekReplay: seekReplayMock,
    setReplaySpeed: setReplaySpeedMock,
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

function loadNumericLog(
  status: NumericLogUiStatus,
  overrides: Partial<ReturnType<typeof useWorkbenchStore.getState>> = {},
): void {
  useWorkbenchStore.setState({
    isNativeRuntime: true,
    source: "simulator",
    protocol: "firewater",
    connectionStatus: "connected",
    workspaceTransitionStatus: "idle",
    runtimeTransitionStatus: "idle",
    replayStatus: "idle",
    replaySessionId: 0,
    numericLogStatus: status,
    numericLogSessionId: status === "idle" ? 0 : 17,
    numericLogRevision: status === "idle" ? 0 : 3,
    numericLogPath: status === "idle" ? "" : "C:\\captures\\numeric.csv.part",
    numericLogStartedAt: status === "idle" ? undefined : Date.now() - 2_000,
    numericLogEndedAt: undefined,
    numericLogOutputBytes: status === "idle" ? 0 : 2_048,
    numericLogSampleCount: status === "idle" ? 0 : 128,
    numericLogMessage: "",
    startNumericLog: startNumericLogMock,
    stopNumericLog: stopNumericLogMock,
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
    setReplaySpeedMock.mockClear();
    stopReplayMock.mockClear();
    closeReplayMock.mockClear();
    selectCaptureExportSourceMock.mockClear();
    useRecentCaptureForExportMock.mockClear();
    startCaptureExportMock.mockClear();
    cancelCaptureExportMock.mockClear();
    clearCaptureExportMock.mockClear();
    startNumericLogMock.mockClear();
    stopNumericLogMock.mockClear();
    addCaptureMarkerMock.mockClear();
  });

  afterEach(() => cleanup());

  it("呈现已加载完整回放的文件、进度和基础控制", () => {
    loadReplay("ready");

    render(<CapturePanel />);

    expect(screen.getByRole("tab", { name: "回放" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("回放已就绪")).toBeInTheDocument();
    expect(screen.getByText("FireWater · VUCAP v2 · 1×")).toBeInTheDocument();
    expect(screen.getByText("00:00:01 / 00:00:03")).toBeInTheDocument();
    expect(screen.getByText("2.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("完整捕获")).toBeInTheDocument();
    expect(screen.getByText("session.vucap")).toBeInTheDocument();
    expect(screen.getByText("C:\\captures\\session.vucap")).toBeInTheDocument();

    const speed = screen.getByRole("combobox", { name: "回放倍速" });
    expect(speed).toBeEnabled();
    expect(speed).toHaveValue("1");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "0.25×",
      "0.5×",
      "1×",
      "2×",
      "4×",
    ]);

    const slider = screen.getByRole("slider", { name: "回放位置" });
    expect(slider).toHaveAttribute("max", "3500000");
    expect(slider).toHaveValue("1000000");
    expect(slider).toBeEnabled();
    expect(slider).toHaveAttribute("title", "拖动定位，位置会吸附到下一协议同步点");
    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止回放" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭回放" })).toBeEnabled();
  });

  it("结构化实时连接可启动独立数值记录", async () => {
    const user = userEvent.setup();
    loadNumericLog("idle");

    render(<CapturePanel />);
    await user.click(screen.getByRole("tab", { name: "数值" }));

    expect(screen.getByLabelText("数值记录状态")).toHaveTextContent("未记录数值");
    expect(screen.getByText("CSV 长表 · FireWater")).toBeInTheDocument();
    const startButton = screen.getByRole("button", { name: "开始数值记录" });
    expect(startButton).toBeEnabled();
    await user.click(startButton);
    expect(startNumericLogMock).toHaveBeenCalledOnce();
  });

  it("录制中可选择颜色并添加命名时间线标记", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "simulator",
      protocol: "firewater",
      connectionStatus: "connected",
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      replayStatus: "idle",
      replaySessionId: 0,
      captureStatus: "recording",
      captureSessionId: 9,
      captureFormatVersion: 2,
      capturePath: "C:\\captures\\session.vucap.part",
      captureStartedAt: Date.now() - 1_000,
      captureDataBytes: 128,
      captureRecordCount: 3,
      captureMarkerCount: 1,
      addCaptureMarker: addCaptureMarkerMock,
    });

    render(<CapturePanel />);
    const input = screen.getByRole("textbox", { name: "标记名称" });
    await user.type(input, "进入稳态");
    await user.click(screen.getByRole("radio", { name: "橙色" }));
    await user.click(screen.getByRole("button", { name: "添加时间线标记" }));

    expect(addCaptureMarkerMock).toHaveBeenCalledWith("进入稳态", "orange");
    expect(input).toHaveValue("");
    expect(screen.getByText("VUCAP v2")).toBeInTheDocument();

    const maximumEmojiLabel = "😀".repeat(64);
    fireEvent.change(input, { target: { value: `${maximumEmojiLabel}extra` } });
    expect(input).toHaveValue(maximumEmojiLabel);

    act(() => useWorkbenchStore.setState({ captureMarkerCount: 512 }));
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加时间线标记" })).toBeDisabled();
  });

  it("Raw 与浏览器预览明确禁用数值文件记录", async () => {
    const user = userEvent.setup();
    loadNumericLog("idle", { protocol: "raw" });

    render(<CapturePanel />);
    await user.click(screen.getByRole("tab", { name: "数值" }));

    expect(screen.getByRole("button", { name: "开始数值记录" })).toBeDisabled();
    expect(screen.getByText("结构化协议可记录数值通道")).toBeVisible();

    act(() => useWorkbenchStore.setState({ isNativeRuntime: false }));
    expect(screen.getByRole("button", { name: "开始数值记录" })).toBeDisabled();
    expect(screen.getByText("仅桌面应用支持数值文件记录")).toBeVisible();
  });

  it("数值记录中呈现独立指标、文件和停止控制", async () => {
    const user = userEvent.setup();
    loadNumericLog("recording", { numericLogMessage: "正在流式写入数值" });

    render(<CapturePanel />);
    await user.click(screen.getByRole("tab", { name: "数值" }));

    expect(screen.getByLabelText("数值记录状态")).toHaveTextContent("正在记录数值");
    expect(screen.getByText("2.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("numeric.csv.part")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在流式写入数值");
    await user.click(screen.getByRole("button", { name: "停止数值记录" }));
    expect(stopNumericLogMock).toHaveBeenCalledOnce();
  });

  it("播放中允许切换白名单倍速并动态呈现当前值", async () => {
    const user = userEvent.setup();
    loadReplay("playing", { replaySpeed: 0.5 });

    render(<CapturePanel />);

    expect(screen.getByText("FireWater · VUCAP v2 · 0.5×")).toBeInTheDocument();
    const speed = screen.getByRole("combobox", { name: "回放倍速" });
    expect(speed).toBeEnabled();
    expect(speed).toHaveValue("0.5");

    await user.selectOptions(speed, "2");
    expect(setReplaySpeedMock).toHaveBeenCalledOnce();
    expect(setReplaySpeedMock).toHaveBeenCalledWith(2);
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
    expect(screen.getByRole("combobox", { name: "回放倍速" })).toBeDisabled();
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

  it("暂停时点击标记精确定位，播放中禁用标记定位", async () => {
    const user = userEvent.setup();
    loadReplay("paused", {
      replayMarkerCount: 2,
      replayMarkers: [
        { index: 1, timestampUs: 500_000, label: "启动", color: "green" },
        { index: 2, timestampUs: 2_100_000, label: "进入稳态", color: "orange" },
      ],
    });

    render(<CapturePanel />);
    const markerButton = screen.getByRole("button", { name: /进入稳态/ });
    expect(markerButton).toBeEnabled();
    await user.click(markerButton);
    expect(seekReplayMock).toHaveBeenCalledOnce();
    expect(seekReplayMock).toHaveBeenCalledWith(2_100_000);

    act(() => useWorkbenchStore.setState({ replayStatus: "playing" }));
    expect(screen.getByRole("button", { name: /进入稳态/ })).toBeDisabled();
  });

  it.each(["firewater", "justfloat"] as const)(
    "%s 回放开放同步点定位并只在提交时发送命令",
    (protocol) => {
      loadReplay("paused", {
        replayHeader: { ...replayHeader, protocol },
      });

      render(<CapturePanel />);

      const slider = screen.getByRole("slider", { name: "回放位置" });
      expect(slider).toBeEnabled();
      expect(slider).toHaveAttribute("title", "拖动定位，位置会吸附到下一协议同步点");
      fireEvent.change(slider, { target: { value: "2400000" } });
      expect(seekReplayMock).not.toHaveBeenCalled();
      fireEvent.pointerUp(slider);
      expect(seekReplayMock).toHaveBeenCalledOnce();
      expect(seekReplayMock).toHaveBeenCalledWith(2_400_000);
    },
  );

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
