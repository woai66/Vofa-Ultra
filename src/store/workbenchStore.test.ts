import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceConfig, createWorkspaceProfile } from "../core/workspaces";
import { listSerialPorts } from "../services/serialClient";
import {
  selectIsWorkspaceDirty,
  useWorkbenchStore,
} from "./workbenchStore";

vi.mock("../services/serialClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/serialClient")>();
  return { ...actual, listSerialPorts: vi.fn() };
});

const listSerialPortsMock = vi.mocked(listSerialPorts);

describe("workbenchStore", () => {
  beforeEach(async () => {
    listSerialPortsMock.mockReset();
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

  it("仅运行数据变化时不重复写入持久化存储", () => {
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    storageWrite.mockClear();

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });
});
