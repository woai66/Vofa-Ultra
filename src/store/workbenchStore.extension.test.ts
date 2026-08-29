import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionBatchPayload,
  ExtensionInspectionPayload,
  ExtensionStatePayload,
} from "../types/extensions";
import {
  activateExtension,
  deactivateExtension,
  inspectExtension,
  pushExtensionBatch,
  selectExtensionPackagePath,
} from "../services/extensionClient";
import { useWorkbenchStore, WORKBENCH_STORAGE_KEY } from "./workbenchStore";

const extensionClientMocks = vi.hoisted(() => ({
  activateExtension: vi.fn(),
  deactivateExtension: vi.fn(),
  getExtensionState: vi.fn(),
  inspectExtension: vi.fn(),
  pushExtensionBatch: vi.fn(),
  resetExtension: vi.fn(),
  selectExtensionPackagePath: vi.fn(),
}));

vi.mock("../services/extensionClient", () => extensionClientMocks);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const INSPECTION: ExtensionInspectionPayload = {
  format: "vofa-ultra-extension",
  schemaVersion: 1,
  manifest: {
    id: "io.vofa.example-parser",
    version: "1.0.0",
    name: "Example Parser",
    description: "test",
    license: "MIT",
    apiVersion: 1,
    kind: "protocol-parser",
    capabilities: ["live-rx.read"],
  },
  packageSha256: "a".repeat(64),
  moduleSha256: "b".repeat(64),
  packageBytes: 2_048,
  moduleBytes: 1_024,
};

function activeState(overrides: Partial<ExtensionStatePayload> = {}): ExtensionStatePayload {
  return {
    status: "active",
    sessionId: 7,
    generation: 3,
    revision: 1,
    nextSequence: 1,
    manifest: INSPECTION.manifest,
    packageSha256: INSPECTION.packageSha256,
    moduleSha256: INSPECTION.moduleSha256,
    authorizedCapabilities: ["live-rx.read"],
    processedBytes: 0,
    emittedFrames: 0,
    message: "扩展已启用",
    ...overrides,
  };
}

function idleState(): ExtensionStatePayload {
  return {
    status: "idle",
    sessionId: 0,
    generation: 0,
    revision: 2,
    nextSequence: 1,
    authorizedCapabilities: [],
    processedBytes: 0,
    emittedFrames: 0,
  };
}

async function activateTestExtension(): Promise<void> {
  await useWorkbenchStore.getState().inspectExtensionPackage();
  await useWorkbenchStore.getState().activateInspectedExtension(true);
}

describe("workbenchStore 协议扩展", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    localStorage.clear();
    vi.mocked(selectExtensionPackagePath).mockReset().mockResolvedValue("C:\\ext\\parser.vux");
    vi.mocked(inspectExtension).mockReset().mockResolvedValue(INSPECTION);
    vi.mocked(activateExtension).mockReset().mockResolvedValue(activeState());
    vi.mocked(deactivateExtension).mockReset().mockResolvedValue(idleState());
    vi.mocked(pushExtensionBatch).mockReset();
    extensionClientMocks.getExtensionState.mockReset().mockResolvedValue(idleState());
    extensionClientMocks.resetExtension.mockReset().mockResolvedValue(activeState({ generation: 4 }));
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "simulator",
      protocol: "raw",
      connectionStatus: "connected",
      replayStatus: "idle",
      replaySessionId: 0,
      replayHeader: undefined,
      channels: [],
      processedChannels: [],
      extensionChannels: [],
      extensionChannelVisibility: {},
      extensionInspection: null,
      extensionPackagePath: "",
      extensionAuthorizationRevision: 0,
      extensionState: idleState(),
      extensionOperation: "idle",
      extensionMessage: "选择 .vux 扩展包后检查",
      extensionQueue: {
        active: false,
        inFlight: false,
        queuedBatches: 0,
        queuedBytes: 0,
      },
      terminalEntries: [],
      terminalPaused: false,
      chartPaused: false,
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().setProtocol("firewater");
    useWorkbenchStore.getState().clearTerminal();
    useWorkbenchStore.setState({ connectionStatus: "connected" });
  });

  it("基础链路同步完成，扩展结果异步进入独立通道", async () => {
    const pending = deferred<ExtensionBatchPayload>();
    vi.mocked(pushExtensionBatch).mockReturnValueOnce(pending.promise);
    await activateTestExtension();

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);

    const synchronous = useWorkbenchStore.getState();
    expect(synchronous.channels).toHaveLength(2);
    expect(synchronous.extensionChannels).toHaveLength(0);
    expect(synchronous.terminalEntries).toHaveLength(1);
    expect(synchronous.stats).toMatchObject({ rxBytes: 4, rxFrames: 1 });
    expect(pushExtensionBatch).toHaveBeenCalledOnce();

    pending.resolve({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      receivedAt: 1_000,
      acceptedBytes: 4,
      frames: [{ values: [10, 20], labels: ["temp", "volt"] }],
    });
    await vi.waitFor(() => expect(useWorkbenchStore.getState().extensionChannels).toHaveLength(2));

    const extensionChannels = useWorkbenchStore.getState().extensionChannels;
    expect(extensionChannels.map((channel) => channel.id)).toEqual([
      "extension:io.vofa.example-parser:0",
      "extension:io.vofa.example-parser:1",
    ]);
    expect(useWorkbenchStore.getState().channels.map((channel) => channel.id)).toEqual([
      "channel-0",
      "channel-1",
    ]);
  });

  it("清图丢弃在途画面但保持后续扩展序号连续", async () => {
    const first = deferred<ExtensionBatchPayload>();
    const second = deferred<ExtensionBatchPayload>();
    vi.mocked(pushExtensionBatch)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await activateTestExtension();

    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(1), 1_000);
    useWorkbenchStore.getState().clearChart();
    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(2), 1_001);

    first.resolve({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      receivedAt: 1_000,
      acceptedBytes: 1,
      frames: [{ values: [99], labels: ["stale"] }],
    });
    await vi.waitFor(() => expect(pushExtensionBatch).toHaveBeenCalledTimes(2));
    expect(useWorkbenchStore.getState().extensionChannels).toHaveLength(0);
    expect(useWorkbenchStore.getState().extensionState.nextSequence).toBe(2);

    second.resolve({
      sessionId: 7,
      generation: 3,
      sequence: 2,
      receivedAt: 1_001,
      acceptedBytes: 1,
      frames: [{ values: [42], labels: ["fresh"] }],
    });

    await vi.waitFor(() => expect(useWorkbenchStore.getState().extensionChannels).toHaveLength(1));
    expect(useWorkbenchStore.getState().extensionChannels[0]?.name).toBe("fresh");
    expect(useWorkbenchStore.getState().extensionState).toMatchObject({
      nextSequence: 3,
      processedBytes: 2,
      emittedFrames: 2,
    });
  });

  it("相同接收时间的跨批输出保留真实时间与完整帧序", async () => {
    vi.mocked(pushExtensionBatch)
      .mockResolvedValueOnce({
        sessionId: 7,
        generation: 3,
        sequence: 1,
        receivedAt: 1_000,
        acceptedBytes: 1,
        frames: [{ values: [1] }, { values: [2] }],
      })
      .mockResolvedValueOnce({
        sessionId: 7,
        generation: 3,
        sequence: 2,
        receivedAt: 1_000,
        acceptedBytes: 1,
        frames: [{ values: [3] }],
      });
    await activateTestExtension();

    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(1), 1_000);
    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState().extensionChannels[0]?.points).toHaveLength(2);
    });
    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(2), 1_000);
    await vi.waitFor(() => {
      expect(useWorkbenchStore.getState().extensionChannels[0]?.points).toHaveLength(3);
    });

    const points = useWorkbenchStore.getState().extensionChannels[0]?.points ?? [];
    expect(points.map((point) => point.y)).toEqual([1, 2, 3]);
    expect(points.map((point) => point.x)).toEqual([1, 1, 1]);
    expect(new Set(points.map((point) => point.frameSequence)).size).toBe(3);
  });

  it("扩展状态和显隐不会写入工作区持久化数据", async () => {
    vi.mocked(pushExtensionBatch).mockResolvedValue({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      receivedAt: 1_000,
      acceptedBytes: 1,
      frames: [{ values: [5], labels: ["private-label"] }],
    });
    await activateTestExtension();
    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(1), 1_000);
    await vi.waitFor(() => expect(useWorkbenchStore.getState().extensionChannels).toHaveLength(1));
    const channelId = useWorkbenchStore.getState().extensionChannels[0]?.id ?? "";
    useWorkbenchStore.getState().toggleExtensionChannel(channelId);

    const stored = JSON.parse(localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(Object.keys(stored.state ?? {}).some((key) => key.startsWith("extension"))).toBe(false);
    expect(localStorage.getItem(WORKBENCH_STORAGE_KEY)).not.toContain("private-label");
    expect(localStorage.getItem(WORKBENCH_STORAGE_KEY)).not.toContain("C:\\\\ext");
    expect(useWorkbenchStore.getState().channelVisibility[channelId]).toBeUndefined();
    expect(useWorkbenchStore.getState().extensionChannelVisibility[channelId]).toBe(false);
  });

  it("协议边界撤销会话并忽略旧批次的迟到结果", async () => {
    const pending = deferred<ExtensionBatchPayload>();
    vi.mocked(pushExtensionBatch).mockReturnValueOnce(pending.promise);
    await activateTestExtension();
    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(1), 1_000);

    useWorkbenchStore.getState().setProtocol("raw");
    expect(useWorkbenchStore.getState().extensionState.status).toBe("idle");
    expect(deactivateExtension).toHaveBeenCalledWith(7);

    pending.resolve({
      sessionId: 7,
      generation: 3,
      sequence: 1,
      receivedAt: 1_000,
      acceptedBytes: 1,
      frames: [{ values: [99] }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(useWorkbenchStore.getState().extensionChannels).toHaveLength(0);
  });

  it("协议边界也撤销仅检查但尚未启用的授权上下文", async () => {
    await useWorkbenchStore.getState().inspectExtensionPackage();
    const authorizationRevision = useWorkbenchStore.getState().extensionAuthorizationRevision;

    useWorkbenchStore.getState().setProtocol("raw");

    expect(useWorkbenchStore.getState()).toMatchObject({
      extensionAuthorizationRevision: authorizationRevision + 1,
      extensionInspection: INSPECTION,
      extensionPackagePath: "C:\\ext\\parser.vux",
      extensionMessage: "基础协议已切换，扩展会话已撤销",
    });
    expect(deactivateExtension).not.toHaveBeenCalled();
  });

  it("重置后使用新的运行代次和从 1 开始的批次序号", async () => {
    await activateTestExtension();
    extensionClientMocks.resetExtension.mockResolvedValueOnce(
      activeState({ generation: 4, nextSequence: 1 }),
    );
    vi.mocked(pushExtensionBatch).mockResolvedValueOnce({
      sessionId: 7,
      generation: 4,
      sequence: 1,
      receivedAt: 1_000,
      acceptedBytes: 1,
      frames: [],
    });

    await expect(useWorkbenchStore.getState().resetExtension()).resolves.toBe(true);
    expect(extensionClientMocks.resetExtension).toHaveBeenCalledWith(7, 3);
    expect(useWorkbenchStore.getState().extensionState).toMatchObject({
      status: "active",
      generation: 4,
      nextSequence: 1,
    });

    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(1), 1_000);
    await vi.waitFor(() => expect(pushExtensionBatch).toHaveBeenCalledOnce());
    expect(pushExtensionBatch).toHaveBeenCalledWith(7, 4, 1, 1_000, Uint8Array.of(1));
  });

  it("回放会话存在时实时输入不会进入扩展队列", async () => {
    await activateTestExtension();
    useWorkbenchStore.setState({ replaySessionId: 99, replayStatus: "ready" });

    useWorkbenchStore.getState().ingestBytes(Uint8Array.of(1), 1_000);

    expect(pushExtensionBatch).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().extensionQueue.queuedBatches).toBe(0);
  });

  it("连接前置校验失败时保留原扩展会话", async () => {
    await activateTestExtension();
    useWorkbenchStore.setState((state) => ({
      source: "serial",
      serialConfig: { ...state.serialConfig, portName: "" },
    }));

    await useWorkbenchStore.getState().connect();

    expect(useWorkbenchStore.getState().extensionState.status).toBe("active");
    expect(deactivateExtension).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().statusMessage).toBe("请先选择串口设备");
  });

  it("实时连接结束时撤销扩展会话", async () => {
    await activateTestExtension();
    useWorkbenchStore.setState({ source: "serial", serialStateRevision: 10 });

    useWorkbenchStore.getState().handleSerialState({
      status: "disconnected",
      portName: "COM3",
      generation: 4,
      revision: 11,
    });

    expect(useWorkbenchStore.getState().extensionState.status).toBe("idle");
    expect(deactivateExtension).toHaveBeenCalledWith(7);
  });

  it("拒绝不一致的 active 启用结果后主动清理后端会话", async () => {
    vi.mocked(activateExtension).mockResolvedValueOnce(
      activeState({ packageSha256: "c".repeat(64), sessionId: 11 }),
    );
    await useWorkbenchStore.getState().inspectExtensionPackage();

    await expect(useWorkbenchStore.getState().activateInspectedExtension(true)).resolves.toBe(false);
    expect(deactivateExtension).toHaveBeenCalledWith(11);
    expect(useWorkbenchStore.getState().extensionState.status).not.toBe("active");
  });

  it("丢弃过时的初始化快照并清理其后端会话", async () => {
    const stale = deferred<ExtensionStatePayload>();
    extensionClientMocks.getExtensionState
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(idleState());

    const firstInitialization = useWorkbenchStore.getState().initializeExtensionRuntime();
    const secondInitialization = useWorkbenchStore.getState().initializeExtensionRuntime();
    stale.resolve(activeState({ sessionId: 17 }));

    await Promise.all([firstInitialization, secondInitialization]);

    expect(deactivateExtension).toHaveBeenCalledWith(17);
    expect(useWorkbenchStore.getState().extensionState.status).toBe("idle");
    expect(useWorkbenchStore.getState().extensionOperation).toBe("idle");
  });
});
