import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceConfig, createWorkspaceProfile } from "../core/workspaces";
import {
  enqueueSimulatorCapture,
  startCapture,
  stopCapture,
} from "../services/captureClient";
import { listSerialPorts } from "../services/serialClient";
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

const listSerialPortsMock = vi.mocked(listSerialPorts);
const enqueueSimulatorCaptureMock = vi.mocked(enqueueSimulatorCapture);
const startCaptureMock = vi.mocked(startCapture);
const stopCaptureMock = vi.mocked(stopCapture);

describe("workbenchStore", () => {
  beforeEach(async () => {
    listSerialPortsMock.mockReset();
    enqueueSimulatorCaptureMock.mockReset().mockReturnValue(true);
    startCaptureMock.mockReset();
    stopCaptureMock.mockReset();
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
    expect(useWorkbenchStore.getState().protocol).toBe("justfloat");
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

  it("仅运行数据变化时不重复写入持久化存储", () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });
});
