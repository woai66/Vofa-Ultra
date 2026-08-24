import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialCommandTaskSnapshot } from "../core/commandWorkflow";
import { createDefaultWorkspaceConfig, createWorkspaceProfile } from "../core/workspaces";
import {
  enqueueSimulatorCapture,
  startCapture,
  stopCapture,
} from "../services/captureClient";
import {
  cancelCaptureExport,
  clearCaptureExport,
  selectCaptureExportDestinationPath,
  selectCaptureExportSourcePath,
  startCaptureExport,
} from "../services/captureExportClient";
import {
  ackReplayBatch,
  closeReplay,
  openReplay,
  pauseReplay,
  playReplay,
  selectReplayFilePath,
  stopReplay,
} from "../services/replayClient";
import {
  cancelSerialConnect,
  connectSerial,
  disconnectSerial,
  listSerialPorts,
  sendSerial,
} from "../services/serialClient";
import type { CaptureStatePayload } from "../types/capture";
import type {
  CaptureExportStatePayload,
  CaptureExportStatus,
} from "../types/captureExport";
import type {
  ReplayCaptureHeader,
  ReplayStatePayload,
  ReplayStatus,
} from "../types/replay";
import type { SerialPortInfo, SerialStatePayload } from "../types/serial";
import {
  disposeWorkbenchRuntime,
  selectIsWorkspaceDirty,
  useWorkbenchStore,
} from "./workbenchStore";

vi.mock("../services/serialClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/serialClient")>();
  return {
    ...actual,
    cancelSerialConnect: vi.fn(),
    connectSerial: vi.fn(),
    disconnectSerial: vi.fn(),
    listSerialPorts: vi.fn(),
    sendSerial: vi.fn(),
  };
});

vi.mock("../services/captureClient", () => ({
  abortCapture: vi.fn(),
  enqueueSimulatorCapture: vi.fn(() => true),
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
}));

vi.mock("../services/captureExportClient", () => ({
  cancelCaptureExport: vi.fn(),
  clearCaptureExport: vi.fn(),
  selectCaptureExportDestinationPath: vi.fn(),
  selectCaptureExportSourcePath: vi.fn(),
  startCaptureExport: vi.fn(),
}));

vi.mock("../services/replayClient", () => ({
  ackReplayBatch: vi.fn(),
  closeReplay: vi.fn(),
  openReplay: vi.fn(),
  pauseReplay: vi.fn(),
  playReplay: vi.fn(),
  selectReplayFilePath: vi.fn(),
  stopReplay: vi.fn(),
}));

const cancelSerialConnectMock = vi.mocked(cancelSerialConnect);
const connectSerialMock = vi.mocked(connectSerial);
const disconnectSerialMock = vi.mocked(disconnectSerial);
const listSerialPortsMock = vi.mocked(listSerialPorts);
const sendSerialMock = vi.mocked(sendSerial);
const enqueueSimulatorCaptureMock = vi.mocked(enqueueSimulatorCapture);
const startCaptureMock = vi.mocked(startCapture);
const stopCaptureMock = vi.mocked(stopCapture);
const cancelCaptureExportMock = vi.mocked(cancelCaptureExport);
const clearCaptureExportMock = vi.mocked(clearCaptureExport);
const selectCaptureExportDestinationPathMock = vi.mocked(
  selectCaptureExportDestinationPath,
);
const selectCaptureExportSourcePathMock = vi.mocked(selectCaptureExportSourcePath);
const startCaptureExportMock = vi.mocked(startCaptureExport);
const ackReplayBatchMock = vi.mocked(ackReplayBatch);
const closeReplayMock = vi.mocked(closeReplay);
const openReplayMock = vi.mocked(openReplay);
const pauseReplayMock = vi.mocked(pauseReplay);
const playReplayMock = vi.mocked(playReplay);
const selectReplayFilePathMock = vi.mocked(selectReplayFilePath);
const stopReplayMock = vi.mocked(stopReplay);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const TEST_REPLAY_HEADER: ReplayCaptureHeader = {
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

function replayState(
  status: ReplayStatus,
  overrides: Partial<ReplayStatePayload> = {},
): ReplayStatePayload {
  return {
    status,
    sessionId: 7,
    generation: 0,
    revision: 1,
    path: "C:\\captures\\session.vucap",
    header: TEST_REPLAY_HEADER,
    complete: true,
    positionUs: 0,
    durationUs: 50_000,
    dataBytes: 32,
    recordCount: 4,
    ...overrides,
  };
}

function captureExportState(
  status: CaptureExportStatus,
  overrides: Partial<CaptureExportStatePayload> = {},
): CaptureExportStatePayload {
  return {
    status,
    phase: status === "running" ? "reading" : status === "idle" ? "idle" : "done",
    jobId: status === "idle" ? 0 : 7,
    revision: status === "idle" ? 0 : 1,
    sourcePath: status === "idle" ? "" : "C:\\captures\\session.vucap",
    destinationPath: status === "idle" ? "" : "C:\\captures\\session.csv",
    format: "csv",
    direction: "both",
    allowIncomplete: false,
    totalInputBytes: 4_096,
    processedInputBytes: status === "completed" ? 4_096 : 1_024,
    processedDataBytes: 512,
    processedRecords: 8,
    exportedDataBytes: 512,
    exportedRecords: 8,
    outputBytes: 1_024,
    sourceComplete: status === "completed",
    ...overrides,
  };
}

describe("workbenchStore", () => {
  beforeEach(async () => {
    useWorkbenchStore.getState().stopPeriodicSend();
    await useWorkbenchStore.getState().setSerialRecoveryEnabled(false);
    useWorkbenchStore.getState().clearSerialDiagnostics();
    cancelSerialConnectMock.mockReset().mockResolvedValue({
      status: "disconnected",
      portName: "",
      generation: 0,
      revision: 0,
    });
    connectSerialMock.mockReset();
    disconnectSerialMock.mockReset().mockResolvedValue({
      status: "disconnected",
      portName: "",
      generation: 0,
      revision: 0,
    });
    listSerialPortsMock.mockReset();
    sendSerialMock.mockReset().mockResolvedValue(undefined);
    enqueueSimulatorCaptureMock.mockReset().mockReturnValue(true);
    startCaptureMock.mockReset();
    stopCaptureMock.mockReset();
    cancelCaptureExportMock.mockReset();
    clearCaptureExportMock.mockReset();
    selectCaptureExportDestinationPathMock.mockReset();
    selectCaptureExportSourcePathMock.mockReset();
    startCaptureExportMock.mockReset();
    ackReplayBatchMock.mockReset().mockResolvedValue(undefined);
    closeReplayMock.mockReset();
    openReplayMock.mockReset();
    pauseReplayMock.mockReset();
    playReplayMock.mockReset();
    selectReplayFilePathMock.mockReset();
    stopReplayMock.mockReset();
    localStorage.clear();
    useWorkbenchStore.persist.clearStorage();
    const config = createDefaultWorkspaceConfig("simulator");
    const workspace = createWorkspaceProfile("默认工作区", config, "default", 100);
    useWorkbenchStore.setState({
      isNativeRuntime: false,
      ...config,
      source: "simulator",
      connectionStatus: "disconnected",
      serialGeneration: 0,
      serialStateRevision: 0,
      statusMessage: "等待连接",
      ports: [],
      isRefreshingPorts: false,
      serialRecovery: {
        enabled: false,
        phase: "off",
        attempt: 0,
        maxAttempts: 10,
        message: "自动重连未启用",
        diagnosticEventCount: 0,
        diagnosticDroppedEvents: 0,
      },
      isCancellingSerialConnection: false,
      channels: [],
      terminalEntries: [],
      commandHistory: [],
      commandTask: createInitialCommandTaskSnapshot(),
      isSendingCommand: false,
      terminalPaused: false,
      chartPaused: false,
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      incompatibleStorageVersion: null,
      captureStatus: "idle",
      captureSessionId: 0,
      captureRevision: 0,
      capturePath: "",
      captureStartedAt: undefined,
      captureEndedAt: undefined,
      captureDataBytes: 0,
      captureRecordCount: 0,
      captureMessage: "",
      captureExportStatus: "idle",
      captureExportPhase: "idle",
      captureExportJobId: 0,
      captureExportRevision: 0,
      captureExportSourcePath: "",
      captureExportDestinationPath: "",
      captureExportFormat: "csv",
      captureExportDirection: "both",
      captureExportAllowIncomplete: false,
      captureExportTotalInputBytes: 0,
      captureExportProcessedInputBytes: 0,
      captureExportProcessedDataBytes: 0,
      captureExportProcessedRecords: 0,
      captureExportExportedDataBytes: 0,
      captureExportExportedRecords: 0,
      captureExportOutputBytes: 0,
      captureExportSourceComplete: false,
      captureExportStartedAt: undefined,
      captureExportEndedAt: undefined,
      captureExportMessage: "",
      replayStatus: "idle",
      replaySessionId: 0,
      replayGeneration: 0,
      replayRevision: 0,
      replayPath: "",
      replayHeader: undefined,
      replayComplete: false,
      replayPositionUs: 0,
      replayDurationUs: 0,
      replayDataBytes: 0,
      replayRecordCount: 0,
      replayNextSequence: 1,
      replayMessage: "",
    });
    useWorkbenchStore.getState().clearChart();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("仅在成功发送后记录会话历史并合并连续重复项", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    await useWorkbenchStore.getState().send("PING", "text", "lf");
    await useWorkbenchStore.getState().send("PING", "text", "lf");

    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({
        value: "PING",
        mode: "text",
        lineEnding: "lf",
        encodedBytes: 5,
        repeatCount: 2,
      }),
    ]);

    await useWorkbenchStore.getState().send("PING", "text", "none");
    expect(useWorkbenchStore.getState().commandHistory).toHaveLength(2);
  });

  it("发送失败不写入历史且释放发送互斥状态", async () => {
    sendSerialMock.mockRejectedValueOnce(new Error("TX 队列已满"));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 1,
    });

    await expect(
      useWorkbenchStore.getState().send("PING", "text", "none"),
    ).rejects.toThrow("TX 队列已满");
    expect(useWorkbenchStore.getState()).toMatchObject({
      commandHistory: [],
      isSendingCommand: false,
    });

    await expect(
      useWorkbenchStore.getState().send("PING", "text", "none"),
    ).resolves.toBeUndefined();
    expect(useWorkbenchStore.getState().commandHistory).toHaveLength(1);
  });

  it("有限周期发送串行完成并把重复命令压缩为一条历史", async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, 3);
    await vi.advanceTimersByTimeAsync(40);

    expect(useWorkbenchStore.getState().commandTask).toMatchObject({
      status: "completed",
      sentCount: 3,
      repeatCount: 3,
    });
    expect(useWorkbenchStore.getState().commandHistory).toEqual([
      expect.objectContaining({ value: "PING", repeatCount: 3 }),
    ]);
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toHaveLength(3);
  });

  it("持续任务可立即停止且不会再产生定时发送", async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });

    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, null);
    await flushPromises();
    expect(useWorkbenchStore.getState().commandTask.sentCount).toBe(1);

    useWorkbenchStore.getState().stopPeriodicSend();
    const stoppedCount = useWorkbenchStore.getState().commandTask.sentCount;
    expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(200);
    expect(useWorkbenchStore.getState().commandTask.sentCount).toBe(stoppedCount);
  });

  it("断开数据源和串口故障都会停止持续任务", async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().startPeriodicSend("SIM", "text", "none", 20, null);
    await flushPromises();

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(true);
    expect(useWorkbenchStore.getState().commandTask).toMatchObject({
      status: "stopped",
      sentCount: 1,
    });

    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 4,
      serialStateRevision: 10,
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().startPeriodicSend("SERIAL", "text", "none", 20, null);
    await flushPromises();
    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      errorCode: "read-failed",
      generation: 4,
      revision: 11,
    });

    expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
    expect(useWorkbenchStore.getState().commandTask.message).toContain("连接已中断");
  });

  it("切换工作区、打开回放和运行时卸载都会停止任务", async () => {
    vi.useFakeTimers();
    const target = createWorkspaceProfile(
      "任务目标工作区",
      createDefaultWorkspaceConfig("simulator"),
      "command-target",
      200,
    );
    useWorkbenchStore.setState((state) => ({
      source: "simulator",
      connectionStatus: "connected",
      workspaces: [...state.workspaces, target],
    }));
    useWorkbenchStore.getState().startPeriodicSend("WORKSPACE", "text", "none", 20, null);
    await flushPromises();

    await expect(useWorkbenchStore.getState().switchWorkspace(target.id)).resolves.toBe(true);
    expect(useWorkbenchStore.getState().commandTask.message).toContain("工作区已切换");

    openReplayMock.mockResolvedValue(replayState("ready"));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "simulator",
      connectionStatus: "connected",
      capturePath: "C:\\captures\\session.vucap",
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().startPeriodicSend("REPLAY", "text", "none", 20, null);
    await flushPromises();
    await expect(useWorkbenchStore.getState().openRecentCapture()).resolves.toBe(true);
    expect(useWorkbenchStore.getState().commandTask.message).toContain("回放流程");

    useWorkbenchStore.setState({
      replayStatus: "idle",
      replaySessionId: 0,
      replayHeader: undefined,
      source: "simulator",
      connectionStatus: "connected",
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().startPeriodicSend("DISPOSE", "text", "none", 20, null);
    await flushPromises();
    disposeWorkbenchRuntime();
    expect(useWorkbenchStore.getState().commandTask.message).toContain("运行环境已卸载");
  });

  it("周期任务拒绝空草稿，即使配置了行尾", () => {
    useWorkbenchStore.setState({ connectionStatus: "connected" });

    expect(() =>
      useWorkbenchStore.getState().startPeriodicSend("", "text", "lf", 1_000, 1),
    ).toThrow("不能为空");
  });

  it("切换数据源时清空上一数据源的通道", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
    });

    await useWorkbenchStore.getState().setSource("serial");

    expect(useWorkbenchStore.getState().source).toBe("serial");
    expect(useWorkbenchStore.getState().channels).toEqual([]);
  });

  it("忽略迟到的串口状态事件", () => {
    useWorkbenchStore.setState({
      source: "serial",
      connectionStatus: "connected",
      serialStateRevision: 10,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 9,
    });
    expect(useWorkbenchStore.getState().connectionStatus).toBe("connected");

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      generation: 2,
      revision: 11,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialStateRevision: 11,
      statusMessage: "设备已移除",
    });
  });

  it("意外断线先完成录制，再按强身份跨端口恢复", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const captureStopped = deferred<CaptureStatePayload>();
    const originalPort: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    const reappearedPort = { ...originalPort, name: "COM19" };
    stopCaptureMock.mockReturnValue(captureStopped.promise);
    listSerialPortsMock.mockResolvedValue([reappearedPort]);
    connectSerialMock.mockResolvedValue({
      status: "connected",
      portName: "COM19",
      generation: 8,
      revision: 3,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [originalPort],
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM3",
      },
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
      terminalEntries: [
        {
          id: 1,
          direction: "rx",
          timestamp: 1_000,
          text: "old",
          hex: "6F 6C 64",
          byteCount: 3,
        },
      ],
      stats: { rxBytes: 256, txBytes: 32, rxFrames: 8, startedAt: 1_000 },
    });
    await useWorkbenchStore.getState().setSerialRecoveryEnabled(true);
    useWorkbenchStore.getState().handleSerialState({
      status: "connected",
      portName: "COM3",
      generation: 7,
      revision: 1,
    });
    useWorkbenchStore.setState({
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 1,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      errorCode: "read-failed",
      generation: 7,
      revision: 2,
    });

    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(listSerialPortsMock).not.toHaveBeenCalled();
    captureStopped.resolve({
      status: "idle",
      sessionId: 0,
      revision: 2,
      path: "C:\\captures\\session.vucap",
      endedAtUnixMs: Date.now(),
      dataBytes: 256,
      recordCount: 8,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(listSerialPortsMock).toHaveBeenCalledOnce();
    expect(connectSerialMock).toHaveBeenCalledWith(
      expect.objectContaining({ portName: "COM19" }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      serialConfig: { portName: "COM19" },
      serialRecovery: { phase: "armed", attempt: 0 },
      channels: [{ id: "channel-0", points: [{ x: 1, y: 2 }] }],
      terminalEntries: [{ text: "old" }],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("恢复已启用但身份阻断时由 Store 完成故障录制收尾", async () => {
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    stopCaptureMock.mockResolvedValue({
      status: "idle",
      sessionId: 0,
      revision: 2,
      path: "C:\\captures\\blocked-device.vucap",
      endedAtUnixMs: Date.now(),
      dataBytes: 64,
      recordCount: 2,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM3",
      },
    });
    await useWorkbenchStore.getState().setSerialRecoveryEnabled(true);
    useWorkbenchStore.getState().handleSerialState({
      status: "connected",
      portName: "COM3",
      generation: 7,
      revision: 1,
    });
    expect(useWorkbenchStore.getState().serialRecovery.phase).toBe("blocked");
    useWorkbenchStore.setState({
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 1,
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "error",
      portName: "COM3",
      message: "设备已移除",
      errorCode: "read-failed",
      generation: 7,
      revision: 2,
    });

    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState().captureStatus).toBe("idle");
    });
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(listSerialPortsMock).not.toHaveBeenCalled();
    expect(connectSerialMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialRecovery: { enabled: true, phase: "blocked" },
      captureStatus: "idle",
      captureSessionId: 0,
    });
  });

  it("取消手动连接会立即释放界面事务并保持后端取消结果", async () => {
    const pendingConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock.mockReturnValue(pendingConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState()).toMatchObject({
        connectionStatus: "connecting",
        runtimeTransitionStatus: "connecting",
      });
    });

    const cancelling = useWorkbenchStore.getState().cancelSerialConnection();
    expect(useWorkbenchStore.getState().runtimeTransitionStatus).toBe("idle");
    await cancelling;
    expect(cancelSerialConnectMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState().connectionStatus).toBe("disconnected");

    pendingConnection.resolve({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    await connecting;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      runtimeTransitionStatus: "idle",
      isCancellingSerialConnection: false,
    });
  });

  it("后端尚未发布连接状态时用相同 revision 的取消快照纠正乐观状态", async () => {
    const pendingConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock.mockReturnValue(pendingConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 4,
      revision: 8,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "disconnected",
      serialGeneration: 4,
      serialStateRevision: 8,
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledOnce();
      expect(useWorkbenchStore.getState()).toMatchObject({
        connectionStatus: "connecting",
        serialGeneration: 4,
        serialStateRevision: 8,
        runtimeTransitionStatus: "connecting",
      });
    });

    await useWorkbenchStore.getState().cancelSerialConnection();

    expect(disconnectSerialMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      serialGeneration: 4,
      serialStateRevision: 8,
      runtimeTransitionStatus: "idle",
      isCancellingSerialConnection: false,
      serialRecovery: { phase: "off", attempt: 0 },
    });

    pendingConnection.reject(new Error("串口连接已取消"));
    await connecting;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      runtimeTransitionStatus: "idle",
    });
  });

  it("从错误稳态重连时用相同 revision 的取消快照恢复错误与兜底消息", async () => {
    const pendingConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock.mockReturnValue(pendingConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "error",
      portName: "COM3",
      errorCode: "open-failed",
      generation: 4,
      revision: 8,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "error",
      serialGeneration: 4,
      serialStateRevision: 8,
      statusMessage: "上次连接失败",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledOnce();
      expect(useWorkbenchStore.getState()).toMatchObject({
        connectionStatus: "connecting",
        serialGeneration: 4,
        serialStateRevision: 8,
        runtimeTransitionStatus: "connecting",
      });
    });

    await useWorkbenchStore.getState().cancelSerialConnection();

    expect(disconnectSerialMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      serialGeneration: 4,
      serialStateRevision: 8,
      statusMessage: "串口发生未知错误",
      runtimeTransitionStatus: "idle",
      isCancellingSerialConnection: false,
      serialRecovery: { phase: "off", attempt: 0 },
    });

    pendingConnection.reject(new Error("串口连接已取消"));
    await connecting;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "error",
      statusMessage: "串口发生未知错误",
      runtimeTransitionStatus: "idle",
    });
  });

  it("取消与刚完成连接竞速时会主动断开", async () => {
    const cancelResult = deferred<SerialStatePayload>();
    cancelSerialConnectMock.mockReturnValue(cancelResult.promise);
    disconnectSerialMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 3,
      revision: 3,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connecting",
      runtimeTransitionStatus: "connecting",
    });

    const cancelling = useWorkbenchStore.getState().cancelSerialConnection();
    useWorkbenchStore.getState().handleSerialState({
      status: "connected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    cancelResult.resolve({
      status: "connected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    await cancelling;

    expect(disconnectSerialMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      serialGeneration: 3,
      serialStateRevision: 3,
      serialRecovery: { phase: "off" },
    });
  });

  it("旧连接 Promise 失败不会污染取消后发起的新连接", async () => {
    const firstConnection = deferred<SerialStatePayload>();
    const secondConnection = deferred<SerialStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    connectSerialMock
      .mockReturnValueOnce(firstConnection.promise)
      .mockReturnValueOnce(secondConnection.promise);
    cancelSerialConnectMock.mockResolvedValue({
      status: "disconnected",
      portName: "COM3",
      generation: 2,
      revision: 2,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
    });

    const first = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledTimes(1);
    });
    await useWorkbenchStore.getState().cancelSerialConnection();

    const second = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(connectSerialMock).toHaveBeenCalledTimes(2);
    });
    firstConnection.reject(new Error("旧连接迟到失败"));
    await first;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connecting",
      runtimeTransitionStatus: "connecting",
    });

    secondConnection.resolve({
      status: "connected",
      portName: "COM3",
      generation: 3,
      revision: 3,
    });
    await second;
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      runtimeTransitionStatus: "idle",
    });
  });

  it("运行时卸载会阻止异步前置结束后再打开串口", async () => {
    const replayClosed = deferred<ReplayStatePayload>();
    const port: SerialPortInfo = {
      name: "COM3",
      kind: "usb",
      serialNumber: "DEVICE-001",
      vendorId: 0x1234,
      productId: 0x5678,
    };
    closeReplayMock.mockReturnValue(replayClosed.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      ports: [port],
      serialConfig: { ...useWorkbenchStore.getState().serialConfig, portName: "COM3" },
      replayStatus: "ready",
      replaySessionId: 7,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
    });

    const connecting = useWorkbenchStore.getState().connect();
    await vi.waitFor(() => {
      expect(closeReplayMock).toHaveBeenCalledOnce();
    });
    disposeWorkbenchRuntime();
    replayClosed.resolve(
      replayState("idle", {
        revision: 2,
        path: "",
        header: undefined,
        complete: false,
      }),
    );
    await connecting;

    expect(connectSerialMock).not.toHaveBeenCalled();
  });

  it("相同 revision 的断开快照不会重复重置恢复状态", () => {
    useWorkbenchStore.setState({
      source: "serial",
      connectionStatus: "disconnected",
      serialGeneration: 4,
      serialStateRevision: 8,
      serialRecovery: {
        enabled: true,
        phase: "waiting",
        attempt: 2,
        maxAttempts: 10,
        message: "等待重试",
        diagnosticEventCount: 5,
        diagnosticDroppedEvents: 0,
      },
    });

    useWorkbenchStore.getState().handleSerialState({
      status: "disconnected",
      portName: "COM3",
      generation: 4,
      revision: 8,
    });

    expect(useWorkbenchStore.getState().serialRecovery).toMatchObject({
      phase: "waiting",
      attempt: 2,
    });
  });

  it("保存当前工作区并另存为独立快照", () => {
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);

    useWorkbenchStore.getState().setProtocol("raw");
    useWorkbenchStore.getState().setSendMode("hex");
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(true);

    useWorkbenchStore.getState().saveActiveWorkspace("原始数据");
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);
    expect(useWorkbenchStore.getState().workspaces[0]).toMatchObject({
      name: "原始数据",
      config: { protocol: "raw", sendMode: "hex" },
    });

    const copiedId = useWorkbenchStore.getState().saveWorkspaceAs("原始数据副本");
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: copiedId,
    });
    expect(useWorkbenchStore.getState().workspaces).toHaveLength(2);
    expect(() => useWorkbenchStore.getState().saveWorkspaceAs("原始数据")).toThrow(/已存在/);
  });

  it("切换工作区时清空运行数据且不自动连接", async () => {
    const targetConfig = createDefaultWorkspaceConfig("serial");
    targetConfig.serialConfig.portName = "COM11";
    targetConfig.protocol = "justfloat";
    targetConfig.displayMode = "hex";
    targetConfig.channelVisibility = { "channel-0": false };
    const target = createWorkspaceProfile("串口台架", targetConfig, "serial-bench", 200);
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      connectionStatus: "connected",
      terminalPaused: true,
      chartPaused: true,
      terminalEntries: [
        {
          id: 1,
          direction: "rx",
          timestamp: 1,
          text: "1",
          hex: "31",
          byteCount: 1,
        },
      ],
      stats: { rxBytes: 12, txBytes: 3, rxFrames: 1, startedAt: 1 },
    }));

    const applied = await useWorkbenchStore.getState().switchWorkspace(target.id);

    expect(applied).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      source: "simulator",
      protocol: "justfloat",
      displayMode: "hex",
      connectionStatus: "disconnected",
      terminalPaused: false,
      chartPaused: false,
      channels: [],
      terminalEntries: [],
      channelVisibility: { "channel-0": false },
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(false);

    useWorkbenchStore.getState().setChartWindowSeconds(30);
    useWorkbenchStore.getState().saveActiveWorkspace("串口台架");
    const copiedId = useWorkbenchStore.getState().saveWorkspaceAs("串口台架副本");
    expect(
      useWorkbenchStore.getState().workspaces.find((workspace) => workspace.id === target.id)
        ?.config.source,
    ).toBe("serial");
    expect(
      useWorkbenchStore.getState().workspaces.find((workspace) => workspace.id === copiedId)
        ?.config.source,
    ).toBe("serial");
  });

  it("将通道显隐偏好应用到稍后出现的数据", () => {
    useWorkbenchStore.setState({ channelVisibility: { "channel-0": false } });

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    expect(useWorkbenchStore.getState().channels.map((channel) => channel.visible)).toEqual([
      false,
      true,
    ]);
    useWorkbenchStore.getState().toggleChannel("channel-0");
    expect(useWorkbenchStore.getState().channelVisibility).toEqual({});
  });

  it("导入同名工作区时生成后缀且不自动应用", () => {
    const beforeActiveId = useWorkbenchStore.getState().activeWorkspaceId;
    const importedId = useWorkbenchStore.getState().importWorkspace({
      format: "vofa-ultra.workspace",
      schemaVersion: 1,
      name: "默认工作区",
      config: createDefaultWorkspaceConfig("serial"),
    });

    expect(useWorkbenchStore.getState().activeWorkspaceId).toBe(beforeActiveId);
    expect(useWorkbenchStore.getState().workspaces.find((item) => item.id === importedId)?.name).toBe(
      "默认工作区 (2)",
    );
  });

  it("删除活动工作区时先切换，并禁止删除最后一个", async () => {
    const second = createWorkspaceProfile(
      "第二工作区",
      createDefaultWorkspaceConfig("simulator"),
      "second",
      200,
    );
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, second],
    }));

    expect(await useWorkbenchStore.getState().deleteWorkspace("default")).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "second",
      workspaces: [{ id: "second" }],
    });
    await expect(useWorkbenchStore.getState().deleteWorkspace("second")).rejects.toThrow(
      /至少需要保留/,
    );
  });

  it("通过 rehydrate 把 v0 单工作区设置迁移为默认快照", async () => {
    localStorage.setItem(
      "vofa-ultra-workbench",
      JSON.stringify({
        version: 0,
        state: {
          source: "serial",
          protocol: "raw",
          serialConfig: {
            portName: "COM8",
            baudRate: 230_400,
            dataBits: 8,
            parity: "none",
            stopBits: 1,
            flowControl: "none",
            dtr: true,
            rts: true,
          },
          displayMode: "hex",
          terminalAutoScroll: false,
          chartWindowSeconds: 30,
        },
      }),
    );

    await useWorkbenchStore.persist.rehydrate();

    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "default",
      workspaces: [
        {
          id: "default",
          name: "默认工作区",
          config: {
            source: "serial",
            protocol: "raw",
            displayMode: "hex",
            sendMode: "text",
            lineEnding: "none",
            chartWindowSeconds: 30,
          },
        },
      ],
    });
    expect(
      JSON.parse(localStorage.getItem("vofa-ultra-workbench") ?? "null"),
    ).toMatchObject({ version: 1 });
  });

  it("拒绝并保留更高版本的持久化数据", async () => {
    const futureValue = JSON.stringify({
      version: 2,
      state: {
        futureWorkspaceFormat: true,
        workspaces: [{ id: "future-only" }],
      },
    });
    localStorage.setItem("vofa-ultra-workbench", futureValue);

    await useWorkbenchStore.persist.rehydrate();
    useWorkbenchStore.getState().setDisplayMode("hex");

    expect(useWorkbenchStore.getState()).toMatchObject({
      workspaceStorageStatus: "newer-version",
      incompatibleStorageVersion: 2,
    });
    expect(() => useWorkbenchStore.getState().saveActiveWorkspace("不会保存")).toThrow(
      /版本 2.*不能保存/,
    );
    expect(localStorage.getItem("vofa-ultra-workbench")).toBe(futureValue);
    useWorkbenchStore.persist.clearStorage();
  });

  it("工作区事务进行时拒绝重入和配置修改", async () => {
    const targetConfig = createDefaultWorkspaceConfig("simulator");
    targetConfig.protocol = "raw";
    const target = createWorkspaceProfile("目标工作区", targetConfig, "target", 200);
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      connectionStatus: "connected",
    }));

    const firstSwitch = useWorkbenchStore.getState().switchWorkspace(target.id);
    expect(useWorkbenchStore.getState().workspaceTransitionStatus).toBe("switching");
    useWorkbenchStore.getState().updateSerialConfig("baudRate", 9_600);
    const secondSwitch = await useWorkbenchStore.getState().switchWorkspace("default");

    expect(secondSwitch).toBe(false);
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(115_200);
    expect(await firstSwitch).toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      protocol: "raw",
      workspaceTransitionStatus: "idle",
    });
  });

  it("串口列表刷新期间拒绝切换和删除工作区", async () => {
    const target = createWorkspaceProfile(
      "目标工作区",
      createDefaultWorkspaceConfig("simulator"),
      "target",
      200,
    );
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      isRefreshingPorts: true,
    }));

    expect(await useWorkbenchStore.getState().switchWorkspace(target.id)).toBe(false);
    expect(await useWorkbenchStore.getState().deleteWorkspace("default")).toBe(false);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: "default",
      isRefreshingPorts: true,
      workspaces: [{ id: "default" }, { id: "target" }],
      workspaceTransitionStatus: "idle",
    });
  });

  it("拒绝并发刷新串口列表并保持忙碌状态直到请求完成", async () => {
    let resolvePorts: ((ports: Awaited<ReturnType<typeof listSerialPorts>>) => void) | undefined;
    listSerialPortsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePorts = resolve;
        }),
    );
    useWorkbenchStore.setState({ isNativeRuntime: true });

    const firstRefresh = useWorkbenchStore.getState().refreshPorts();
    const secondRefresh = useWorkbenchStore.getState().refreshPorts();

    expect(listSerialPortsMock).toHaveBeenCalledTimes(1);
    await secondRefresh;
    expect(useWorkbenchStore.getState().isRefreshingPorts).toBe(true);

    resolvePorts?.([{ name: "COM7", kind: "usb" }]);
    await firstRefresh;
    expect(useWorkbenchStore.getState()).toMatchObject({
      isRefreshingPorts: false,
      ports: [{ name: "COM7", kind: "usb" }],
      serialConfig: { portName: "COM7" },
    });
  });

  it("开始录制时冻结数据源、协议和串口参数", async () => {
    startCaptureMock.mockResolvedValue({
      status: "recording",
      sessionId: 7,
      revision: 3,
      path: "C:\\captures\\session.vucap",
      startedAtUnixMs: 1_000,
      dataBytes: 0,
      recordCount: 0,
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "justfloat",
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM7",
        baudRate: 921_600,
      },
    });

    expect(await useWorkbenchStore.getState().startCapture()).toBe(true);
    expect(startCaptureMock).toHaveBeenCalledWith({
      source: "simulator",
      protocol: "justfloat",
      serialConfig: expect.objectContaining({ portName: "COM7", baudRate: 921_600 }),
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "recording",
      captureSessionId: 7,
      capturePath: "C:\\captures\\session.vucap",
    });

    useWorkbenchStore.getState().setProtocol("raw");
    await useWorkbenchStore.getState().setSource("serial");
    useWorkbenchStore.getState().updateSerialConfig("baudRate", 57_600);
    expect(useWorkbenchStore.getState().protocol).toBe("justfloat");
    expect(useWorkbenchStore.getState().source).toBe("simulator");
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(921_600);
  });

  it("暂停视图时仍把模拟器原始 RX 和 TX 送入录制队列", () => {
    useWorkbenchStore.setState({
      captureStatus: "recording",
      captureSessionId: 4,
      terminalPaused: true,
      chartPaused: true,
      connectionStatus: "connected",
    });
    const rxBytes = new Uint8Array([1, 2, 3]);
    const txBytes = new Uint8Array([4, 5]);

    useWorkbenchStore.getState().ingestBytes(rxBytes, 1_000);
    useWorkbenchStore.getState().handleSerialTx({
      data: btoa(String.fromCharCode(...txBytes)),
      byteCount: txBytes.length,
      transmittedAt: 1_001,
      generation: 0,
    });

    expect(enqueueSimulatorCaptureMock).toHaveBeenNthCalledWith(
      1,
      4,
      "rx",
      rxBytes,
      expect.any(Function),
    );
    expect(enqueueSimulatorCaptureMock).toHaveBeenNthCalledWith(
      2,
      4,
      "tx",
      txBytes,
      expect.any(Function),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      channels: [],
      terminalEntries: [],
      stats: { rxBytes: 3, txBytes: 2 },
    });
  });

  it("工作区切换先完成录制并忽略迟到状态", async () => {
    const target = createWorkspaceProfile(
      "目标工作区",
      createDefaultWorkspaceConfig("simulator"),
      "target",
      200,
    );
    stopCaptureMock.mockResolvedValue({
      status: "idle",
      sessionId: 9,
      revision: 6,
      path: "C:\\captures\\complete.vucap",
      startedAtUnixMs: 1_000,
      endedAtUnixMs: 2_000,
      dataBytes: 128,
      recordCount: 4,
      message: "捕获文件已完成",
    });
    useWorkbenchStore.setState((state) => ({
      workspaces: [...state.workspaces, target],
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 9,
      captureRevision: 5,
    }));

    expect(await useWorkbenchStore.getState().switchWorkspace(target.id)).toBe(true);
    expect(stopCaptureMock).toHaveBeenCalledOnce();
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      captureStatus: "idle",
      captureRevision: 6,
      captureDataBytes: 128,
    });

    useWorkbenchStore.getState().handleCaptureState({
      status: "recording",
      sessionId: 9,
      revision: 5,
      path: "late.vucap",
      dataBytes: 64,
      recordCount: 2,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureStatus: "idle",
      captureRevision: 6,
      captureDataBytes: 128,
    });
  });

  it("录制尚未收尾时不提前断开数据源", async () => {
    stopCaptureMock.mockResolvedValue({
      status: "stopping",
      sessionId: 11,
      revision: 8,
      path: "C:\\captures\\pending.vucap",
      startedAtUnixMs: 1_000,
      dataBytes: 64,
      recordCount: 2,
      message: "正在完成捕获文件",
    });
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 11,
      captureRevision: 7,
    });

    await expect(useWorkbenchStore.getState().disconnect()).resolves.toBe(false);
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      captureStatus: "stopping",
      statusMessage: "结束录制失败，未断开数据源",
    });
  });

  it("选择源文件后按格式生成请求且二进制强制单一方向", async () => {
    selectCaptureExportSourcePathMock.mockResolvedValue(
      "C:\\captures\\session.vucap",
    );
    selectCaptureExportDestinationPathMock.mockResolvedValue(
      "C:\\captures\\session.bin",
    );
    startCaptureExportMock.mockResolvedValue(
      captureExportState("running", {
        phase: "reading",
        destinationPath: "C:\\captures\\session.bin",
        format: "binary",
        direction: "rx",
      }),
    );
    useWorkbenchStore.setState({ isNativeRuntime: true });

    await expect(
      useWorkbenchStore.getState().selectCaptureExportSource(),
    ).resolves.toBe(true);
    useWorkbenchStore.getState().setCaptureExportFormat("binary");
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "idle",
      captureExportFormat: "binary",
      captureExportDirection: "rx",
      captureExportSourcePath: "C:\\captures\\session.vucap",
    });

    await expect(useWorkbenchStore.getState().startCaptureExport()).resolves.toBe(true);
    expect(selectCaptureExportDestinationPathMock).toHaveBeenCalledWith(
      "C:\\captures\\session.vucap",
      "binary",
    );
    expect(startCaptureExportMock).toHaveBeenCalledWith({
      sourcePath: "C:\\captures\\session.vucap",
      destinationPath: "C:\\captures\\session.bin",
      format: "binary",
      direction: "rx",
      allowIncomplete: false,
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "running",
      captureExportJobId: 7,
      captureExportDestinationPath: "C:\\captures\\session.bin",
    });
  });

  it("录制活跃时拒绝选择或启动导出且不打开文件对话框", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      captureStatus: "recording",
      captureExportSourcePath: "C:\\captures\\older.vucap",
    });

    await expect(
      useWorkbenchStore.getState().selectCaptureExportSource(),
    ).resolves.toBe(false);
    await expect(useWorkbenchStore.getState().startCaptureExport()).resolves.toBe(false);
    expect(selectCaptureExportSourcePathMock).not.toHaveBeenCalled();
    expect(selectCaptureExportDestinationPathMock).not.toHaveBeenCalled();
    expect(startCaptureExportMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().captureExportMessage).toContain("完成当前捕获文件");
  });

  it("按任务和修订过滤迟到导出状态并可取消当前任务", async () => {
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("running", { jobId: 7, revision: 3 }),
    );
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("completed", {
        jobId: 6,
        revision: 99,
        outputBytes: 99_999,
      }),
    );
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("completed", {
        jobId: 7,
        revision: 3,
        outputBytes: 88_888,
      }),
    );
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "running",
      captureExportJobId: 7,
      captureExportRevision: 3,
      captureExportOutputBytes: 1_024,
    });

    cancelCaptureExportMock.mockResolvedValue(
      captureExportState("cancelling", {
        phase: "reading",
        jobId: 7,
        revision: 4,
      }),
    );
    await expect(useWorkbenchStore.getState().cancelCaptureExport()).resolves.toBe(true);
    expect(cancelCaptureExportMock).toHaveBeenCalledWith(7);
    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "cancelling",
      captureExportRevision: 4,
    });

    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("cancelled", { jobId: 7, revision: 5 }),
    );
    expect(useWorkbenchStore.getState().captureExportStatus).toBe("cancelled");
  });

  it("修改已完成任务的导出选项会进入新草稿", () => {
    useWorkbenchStore.getState().handleCaptureExportState(
      captureExportState("completed", {
        jobId: 7,
        revision: 4,
        message: "导出完成",
      }),
    );

    useWorkbenchStore.getState().setCaptureExportDirection("tx");

    expect(useWorkbenchStore.getState()).toMatchObject({
      captureExportStatus: "idle",
      captureExportPhase: "idle",
      captureExportSourcePath: "C:\\captures\\session.vucap",
      captureExportDestinationPath: "",
      captureExportDirection: "tx",
      captureExportOutputBytes: 0,
      captureExportExportedRecords: 0,
      captureExportMessage: "",
    });
  });

  it("取消选择回放文件时保留连接和录制会话", async () => {
    selectReplayFilePathMock.mockResolvedValue(null);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 12,
    });

    await expect(useWorkbenchStore.getState().openReplayFile()).resolves.toBe(false);

    expect(stopCaptureMock).not.toHaveBeenCalled();
    expect(openReplayMock).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "connected",
      captureStatus: "recording",
      captureSessionId: 12,
      replayStatus: "idle",
      runtimeTransitionStatus: "idle",
    });
  });

  it("进入回放文件选择时立即停止周期任务且取消后不恢复", async () => {
    vi.useFakeTimers();
    const selection = deferred<string | null>();
    selectReplayFilePathMock.mockReturnValue(selection.promise);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "simulator",
      connectionStatus: "connected",
    });
    useWorkbenchStore.getState().startPeriodicSend("PING", "text", "none", 20, null);
    await flushPromises();

    const opening = useWorkbenchStore.getState().openReplayFile();
    expect(useWorkbenchStore.getState().commandTask).toMatchObject({
      status: "stopped",
      sentCount: 1,
    });
    expect(useWorkbenchStore.getState().commandTask.message).toContain("回放流程");

    await vi.advanceTimersByTimeAsync(200);
    expect(useWorkbenchStore.getState().commandTask.sentCount).toBe(1);
    selection.resolve(null);
    await expect(opening).resolves.toBe(false);
    expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
  });

  it("选择文件后断开实时数据源但不修改工作区协议", async () => {
    selectReplayFilePathMock.mockResolvedValue("C:\\captures\\session.vucap");
    openReplayMock.mockResolvedValue(replayState("ready"));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      protocol: "raw",
    });
    const dirtyBeforeReplay = selectIsWorkspaceDirty(useWorkbenchStore.getState());

    await expect(useWorkbenchStore.getState().openReplayFile()).resolves.toBe(true);

    expect(openReplayMock).toHaveBeenCalledWith("C:\\captures\\session.vucap");
    expect(useWorkbenchStore.getState()).toMatchObject({
      connectionStatus: "disconnected",
      protocol: "raw",
      replayStatus: "ready",
      replaySessionId: 7,
      replayHeader: { protocol: "firewater" },
    });
    expect(selectIsWorkspaceDirty(useWorkbenchStore.getState())).toBe(dirtyBeforeReplay);
  });

  it("文件选择期间拒绝并发连接事务", async () => {
    let resolveSelection: ((path: string | null) => void) | undefined;
    selectReplayFilePathMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    useWorkbenchStore.setState({ isNativeRuntime: true });

    const opening = useWorkbenchStore.getState().openReplayFile();
    expect(useWorkbenchStore.getState().runtimeTransitionStatus).toBe("selecting-replay");
    await useWorkbenchStore.getState().connect();
    expect(useWorkbenchStore.getState().connectionStatus).toBe("disconnected");

    resolveSelection?.(null);
    await opening;
    expect(useWorkbenchStore.getState().runtimeTransitionStatus).toBe("idle");
  });

  it("回放批次只更新一次状态并保持跨批解析和 TX 解码", async () => {
    playReplayMock.mockResolvedValue(
      replayState("playing", { generation: 1, revision: 2 }),
    );
    useWorkbenchStore.setState({
      protocol: "raw",
      replayStatus: "ready",
      replaySessionId: 7,
      replayGeneration: 0,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
      replayComplete: true,
      replayDurationUs: 50_000,
      terminalEntries: [
        { id: 1, direction: "system", timestamp: 0, text: "旧数据", hex: "", byteCount: 0 },
      ],
    });

    await expect(useWorkbenchStore.getState().playReplay()).resolves.toBe(true);
    expect(ackReplayBatchMock).toHaveBeenCalledWith(7, 1, 0);
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);

    const encoder = new TextEncoder();
    const txBytes = encoder.encode("中");
    let updates = 0;
    const unsubscribe = useWorkbenchStore.subscribe(() => {
      updates += 1;
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 7,
      records: [
        { direction: "rx", timestampUs: 1_000, data: Array.from(encoder.encode("a:1,")) },
        { direction: "tx", timestampUs: 1_000, data: Array.from(txBytes.slice(0, 1)) },
      ],
    });
    expect(updates).toBe(1);

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 1,
      sequence: 2,
      startUs: 2_000,
      endUs: 2_000,
      dataBytes: 6,
      records: [
        { direction: "rx", timestampUs: 2_000, data: Array.from(encoder.encode("b:2\n")) },
        { direction: "tx", timestampUs: 2_000, data: Array.from(txBytes.slice(1)) },
      ],
    });
    unsubscribe();

    const state = useWorkbenchStore.getState();
    expect(state.protocol).toBe("raw");
    expect(state.channels.map((channel) => channel.lastValue)).toEqual([1, 2]);
    expect(state.stats).toMatchObject({ rxBytes: 8, txBytes: 3, rxFrames: 1 });
    expect(
      state.terminalEntries
        .filter((entry) => entry.direction === "tx")
        .map((entry) => entry.text)
        .join(""),
    ).toBe("中");
    expect(state.terminalEntries.at(-1)?.timestamp).toBe(1_002);
    expect(state.replayNextSequence).toBe(3);
    expect(ackReplayBatchMock.mock.calls).toEqual([
      [7, 1, 0],
      [7, 1, 1],
      [7, 1, 2],
    ]);
    expect(enqueueSimulatorCaptureMock).not.toHaveBeenCalled();
  });

  it("启动 ACK 失败时停止已经进入 playing 的后端回放", async () => {
    playReplayMock.mockResolvedValue(
      replayState("playing", { generation: 1, revision: 2 }),
    );
    ackReplayBatchMock.mockRejectedValue(new Error("启动 ACK 失败"));
    stopReplayMock.mockResolvedValue(
      replayState("ready", { generation: 2, revision: 4, positionUs: 0 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "ready",
      replaySessionId: 7,
      replayGeneration: 0,
      replayRevision: 1,
      replayHeader: TEST_REPLAY_HEADER,
    });

    await expect(useWorkbenchStore.getState().playReplay()).resolves.toBe(false);

    expect(ackReplayBatchMock).toHaveBeenCalledWith(7, 1, 0);
    expect(stopReplayMock).toHaveBeenCalledWith(7, 1);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "ready",
      replayGeneration: 2,
      replayPositionUs: 0,
      runtimeTransitionStatus: "idle",
    });
    expect(useWorkbenchStore.getState().replayMessage).toContain("已停止回放");
  });

  it("忽略旧会话、旧代次和乱序回放批次", () => {
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });
    const record = {
      direction: "rx" as const,
      timestampUs: 1_000,
      data: Array.from(new TextEncoder().encode("1\n")),
    };

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 6,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [record],
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 2,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [record],
    });
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 2,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [record],
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayNextSequence: 1,
      terminalEntries: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
    expect(ackReplayBatchMock).not.toHaveBeenCalled();
  });

  it("暂停与停止回放时保留画面并回到文件起点", async () => {
    pauseReplayMock.mockResolvedValue(
      replayState("paused", { generation: 3, revision: 3, positionUs: 20_000 }),
    );
    stopReplayMock.mockResolvedValue(
      replayState("ready", { generation: 4, revision: 5, positionUs: 0 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 2,
      replayRevision: 2,
      replayHeader: TEST_REPLAY_HEADER,
      replayPositionUs: 20_000,
      terminalEntries: [
        { id: 4, direction: "rx", timestamp: 1_020, text: "1", hex: "31", byteCount: 1 },
      ],
    });

    await expect(useWorkbenchStore.getState().pauseReplay()).resolves.toBe(true);
    await expect(useWorkbenchStore.getState().stopReplay()).resolves.toBe(true);

    expect(pauseReplayMock).toHaveBeenCalledWith(7, 2);
    expect(stopReplayMock).toHaveBeenCalledWith(7, 3);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "ready",
      replayPositionUs: 0,
      terminalEntries: [{ text: "1" }],
    });
  });

  it("控制命令在途时忽略旧代次批次", () => {
    const record = {
      direction: "rx" as const,
      timestampUs: 1_000,
      data: Array.from(new TextEncoder().encode("1\n")),
    };

    for (const replayStatus of ["pausing", "stopping", "closing"] as const) {
      useWorkbenchStore.setState({
        replayStatus,
        replaySessionId: 7,
        replayGeneration: 3,
        replayHeader: TEST_REPLAY_HEADER,
        replayNextSequence: 1,
        terminalEntries: [],
      });
      useWorkbenchStore.getState().handleReplayBatch({
        sessionId: 7,
        generation: 3,
        sequence: 1,
        startUs: 1_000,
        endUs: 1_000,
        dataBytes: 2,
        records: [record],
      });
      expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);
    }

    expect(ackReplayBatchMock).not.toHaveBeenCalled();
  });

  it("暂停命令在途时拒绝迟到的 playing 状态与旧批次", async () => {
    let resolvePause: ((payload: ReplayStatePayload) => void) | undefined;
    pauseReplayMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePause = resolve;
        }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    const pausing = useWorkbenchStore.getState().pauseReplay();
    useWorkbenchStore.getState().handleReplayState(
      replayState("playing", { generation: 3, revision: 5, positionUs: 500 }),
    );
    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("1\n")),
        },
      ],
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "pausing",
      replayRevision: 4,
      terminalEntries: [],
    });
    expect(ackReplayBatchMock).not.toHaveBeenCalled();

    resolvePause?.(
      replayState("paused", { generation: 4, revision: 6, positionUs: 0 }),
    );
    await expect(pausing).resolves.toBe(true);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "paused",
      replayGeneration: 4,
      replayRevision: 6,
    });
  });

  it("迟到的 ACK 失败不会覆盖已经换代的暂停状态", async () => {
    let rejectAck: ((error: Error) => void) | undefined;
    ackReplayBatchMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectAck = reject;
        }),
    );
    pauseReplayMock.mockResolvedValue(
      replayState("paused", { generation: 4, revision: 5, positionUs: 1_000 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("1\n")),
        },
      ],
    });
    await expect(useWorkbenchStore.getState().pauseReplay()).resolves.toBe(true);
    rejectAck?.(new Error("IPC 已断开"));
    await Promise.resolve();

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "paused",
      replayGeneration: 4,
    });
    expect(stopReplayMock).not.toHaveBeenCalled();
  });

  it("当前代次 ACK 失败时主动停止回放并解除屏障", async () => {
    ackReplayBatchMock.mockRejectedValue(new Error("ACK 队列已满"));
    stopReplayMock.mockResolvedValue(
      replayState("ready", { generation: 4, revision: 5, positionUs: 0 }),
    );
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 3,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayNextSequence: 1,
    });

    useWorkbenchStore.getState().handleReplayBatch({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      startUs: 1_000,
      endUs: 1_000,
      dataBytes: 2,
      records: [
        {
          direction: "rx",
          timestampUs: 1_000,
          data: Array.from(new TextEncoder().encode("1\n")),
        },
      ],
    });

    await vi.waitFor(() => expect(stopReplayMock).toHaveBeenCalledWith(7, 3));
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "ready",
      replayGeneration: 4,
      replayPositionUs: 0,
      runtimeTransitionStatus: "idle",
    });
    expect(useWorkbenchStore.getState().replayMessage).toContain("已停止回放");
  });

  it("同一播放代次的迟到状态事件不会倒拨进度", () => {
    useWorkbenchStore.setState({
      replayStatus: "playing",
      replaySessionId: 7,
      replayGeneration: 2,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      replayPositionUs: 20_000,
    });

    useWorkbenchStore.getState().handleReplayState(
      replayState("playing", {
        generation: 2,
        revision: 5,
        positionUs: 10_000,
      }),
    );

    expect(useWorkbenchStore.getState()).toMatchObject({
      replayRevision: 5,
      replayPositionUs: 20_000,
    });
  });

  it("从回放连接实时数据源前清空旧回放画面", async () => {
    closeReplayMock.mockResolvedValue(
      replayState("idle", {
        generation: 3,
        revision: 5,
        path: "",
        header: undefined,
        complete: false,
        durationUs: 0,
        dataBytes: 0,
        recordCount: 0,
      }),
    );
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      replayStatus: "ready",
      replaySessionId: 7,
      replayGeneration: 2,
      replayRevision: 4,
      replayHeader: TEST_REPLAY_HEADER,
      channels: [
        {
          id: "channel-0",
          name: "CH 1",
          color: "#46d89c",
          visible: true,
          points: [{ x: 1, y: 2 }],
          lastValue: 2,
        },
      ],
      terminalEntries: [
        { id: 9, direction: "rx", timestamp: 1_000, text: "旧回放", hex: "", byteCount: 6 },
      ],
      stats: { rxBytes: 6, txBytes: 0, rxFrames: 1 },
    });

    await useWorkbenchStore.getState().connect();

    expect(closeReplayMock).toHaveBeenCalledWith(7);
    expect(useWorkbenchStore.getState()).toMatchObject({
      replayStatus: "idle",
      connectionStatus: "connected",
      channels: [],
      terminalEntries: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
  });

  it("切换工作区前关闭回放会话", async () => {
    const target = createWorkspaceProfile(
      "回放后工作区",
      createDefaultWorkspaceConfig("simulator"),
      "after-replay",
      300,
    );
    closeReplayMock.mockResolvedValue(
      replayState("idle", {
        sessionId: 7,
        revision: 3,
        path: "",
        header: undefined,
        complete: false,
        durationUs: 0,
        dataBytes: 0,
        recordCount: 0,
      }),
    );
    useWorkbenchStore.setState((state) => ({
      isNativeRuntime: true,
      workspaces: [...state.workspaces, target],
      replayStatus: "ready",
      replaySessionId: 7,
      replayRevision: 2,
      replayHeader: TEST_REPLAY_HEADER,
    }));

    await expect(useWorkbenchStore.getState().switchWorkspace(target.id)).resolves.toBe(true);
    expect(closeReplayMock).toHaveBeenCalledWith(7);
    expect(useWorkbenchStore.getState()).toMatchObject({
      activeWorkspaceId: target.id,
      replayStatus: "idle",
      connectionStatus: "disconnected",
    });
  });

  it("仅运行数据变化时不重复写入持久化存储", () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("命令历史与任务状态不会写入持久化存储", async () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
    });
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();

    await useWorkbenchStore.getState().send("PRIVATE", "text", "none");

    expect(useWorkbenchStore.getState().commandHistory).toHaveLength(1);
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });
});
