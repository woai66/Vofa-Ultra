import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceConfig, createWorkspaceProfile } from "../core/workspaces";
import {
  enqueueSimulatorCapture,
  startCapture,
  stopCapture,
} from "../services/captureClient";
import {
  ackReplayBatch,
  closeReplay,
  openReplay,
  pauseReplay,
  playReplay,
  selectReplayFilePath,
  stopReplay,
} from "../services/replayClient";
import { listSerialPorts } from "../services/serialClient";
import type {
  ReplayCaptureHeader,
  ReplayStatePayload,
  ReplayStatus,
} from "../types/replay";
import {
  selectIsWorkspaceDirty,
  useWorkbenchStore,
} from "./workbenchStore";

vi.mock("../services/serialClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/serialClient")>();
  return { ...actual, listSerialPorts: vi.fn() };
});

vi.mock("../services/captureClient", () => ({
  abortCapture: vi.fn(),
  enqueueSimulatorCapture: vi.fn(() => true),
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
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

const listSerialPortsMock = vi.mocked(listSerialPorts);
const enqueueSimulatorCaptureMock = vi.mocked(enqueueSimulatorCapture);
const startCaptureMock = vi.mocked(startCapture);
const stopCaptureMock = vi.mocked(stopCapture);
const ackReplayBatchMock = vi.mocked(ackReplayBatch);
const closeReplayMock = vi.mocked(closeReplay);
const openReplayMock = vi.mocked(openReplay);
const pauseReplayMock = vi.mocked(pauseReplay);
const playReplayMock = vi.mocked(playReplay);
const selectReplayFilePathMock = vi.mocked(selectReplayFilePath);
const stopReplayMock = vi.mocked(stopReplay);

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

describe("workbenchStore", () => {
  beforeEach(async () => {
    listSerialPortsMock.mockReset();
    enqueueSimulatorCaptureMock.mockReset().mockReturnValue(true);
    startCaptureMock.mockReset();
    stopCaptureMock.mockReset();
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
      channels: [],
      terminalEntries: [],
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
});
