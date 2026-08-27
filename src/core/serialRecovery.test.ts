import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERIAL_CONFIG } from "../types/serial";
import type {
  SerialPortInfo,
  SerialRecoverySnapshot,
  SerialStatePayload,
} from "../types/serial";
import {
  createSerialReconnectTarget,
  matchSerialReconnectTarget,
  SERIAL_RECOVERY_DELAYS_MS,
  SerialDiagnosticLog,
  SerialReconnectCoordinator,
  type SerialRecoveryDependencies,
} from "./serialRecovery";

const USB_PORT: SerialPortInfo = {
  name: "COM3",
  kind: "usb",
  manufacturer: "Acme",
  product: "Telemetry",
  serialNumber: "DEVICE-001",
  vendorId: 0x1234,
  productId: 0x5678,
};

const CONNECTED_STATE: SerialStatePayload = {
  status: "connected",
  portName: USB_PORT.name,
  generation: 4,
  revision: 10,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

interface RecoveryHarness {
  coordinator: SerialReconnectCoordinator;
  dependencies: SerialRecoveryDependencies;
  listPorts: ReturnType<typeof vi.fn<() => Promise<SerialPortInfo[]>>>;
  connect: ReturnType<typeof vi.fn<SerialRecoveryDependencies["connect"]>>;
  cancelPendingConnection: ReturnType<
    typeof vi.fn<SerialRecoveryDependencies["cancelPendingConnection"]>
  >;
  prepareCaptureBoundary: ReturnType<
    typeof vi.fn<SerialRecoveryDependencies["prepareCaptureBoundary"]>
  >;
  applyBackendState: ReturnType<
    typeof vi.fn<SerialRecoveryDependencies["applyBackendState"]>
  >;
  updatePorts: ReturnType<typeof vi.fn<SerialRecoveryDependencies["updatePorts"]>>;
  updatePortName: ReturnType<
    typeof vi.fn<SerialRecoveryDependencies["updatePortName"]>
  >;
  resetStreamAfterReconnect: ReturnType<
    typeof vi.fn<SerialRecoveryDependencies["resetStreamAfterReconnect"]>
  >;
  snapshots: SerialRecoverySnapshot[];
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

function createHarness(): RecoveryHarness {
  const snapshots: SerialRecoverySnapshot[] = [];
  const listPorts = vi.fn<() => Promise<SerialPortInfo[]>>().mockResolvedValue([]);
  const connect = vi.fn<SerialRecoveryDependencies["connect"]>();
  const cancelPendingConnection = vi.fn<
    SerialRecoveryDependencies["cancelPendingConnection"]
  >().mockResolvedValue(undefined);
  const prepareCaptureBoundary = vi.fn<
    SerialRecoveryDependencies["prepareCaptureBoundary"]
  >().mockResolvedValue(true);
  const applyBackendState = vi.fn<SerialRecoveryDependencies["applyBackendState"]>();
  const updatePorts = vi.fn<SerialRecoveryDependencies["updatePorts"]>();
  const updatePortName = vi.fn<SerialRecoveryDependencies["updatePortName"]>();
  const resetStreamAfterReconnect = vi.fn<
    SerialRecoveryDependencies["resetStreamAfterReconnect"]
  >();
  const dependencies: SerialRecoveryDependencies = {
    now: Date.now,
    setTimer: globalThis.setTimeout,
    clearTimer: globalThis.clearTimeout,
    listPorts,
    connect,
    cancelPendingConnection,
    prepareCaptureBoundary,
    applyBackendState,
    updatePorts,
    updatePortName,
    resetStreamAfterReconnect,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  };
  return {
    coordinator: new SerialReconnectCoordinator(dependencies),
    dependencies,
    listPorts,
    connect,
    cancelPendingConnection,
    prepareCaptureBoundary,
    applyBackendState,
    updatePorts,
    updatePortName,
    resetStreamAfterReconnect,
    snapshots,
  };
}

async function armAndLoseConnection(harness: RecoveryHarness): Promise<void> {
  await harness.coordinator.setEnabled(true, {
    status: "connected",
    generation: CONNECTED_STATE.generation,
    config: { ...DEFAULT_SERIAL_CONFIG, portName: USB_PORT.name },
    port: USB_PORT,
  });
  harness.coordinator.observeState(
    {
      status: "error",
      portName: USB_PORT.name,
      errorCode: "read-failed",
      generation: CONNECTED_STATE.generation,
      revision: CONNECTED_STATE.revision + 1,
    },
    "connected",
  );
  await Promise.resolve();
}

describe("串口自动重连身份匹配", () => {
  it("只用 VID、PID 和非空 USB 序列号冻结身份", () => {
    expect(createSerialReconnectTarget(USB_PORT)).toEqual({
      kind: "usb",
      vendorId: 0x1234,
      productId: 0x5678,
      serialNumber: "DEVICE-001",
    });
    expect(createSerialReconnectTarget({ ...USB_PORT, serialNumber: "   " })).toBeNull();
    expect(createSerialReconnectTarget({ ...USB_PORT, kind: "bluetooth" })).toBeNull();
    expect(createSerialReconnectTarget({ ...USB_PORT, vendorId: undefined })).toBeNull();
  });

  it("允许设备换端口名，但拒绝缺失或重复候选", () => {
    const target = createSerialReconnectTarget(USB_PORT);
    expect(target).not.toBeNull();
    if (!target) {
      return;
    }

    expect(
      matchSerialReconnectTarget([{ ...USB_PORT, name: "COM19" }], target),
    ).toMatchObject({ status: "matched", candidateCount: 1, port: { name: "COM19" } });
    expect(matchSerialReconnectTarget([], target)).toEqual({
      status: "missing",
      candidateCount: 0,
    });
    expect(
      matchSerialReconnectTarget(
        [
          { ...USB_PORT, name: "COM19" },
          { ...USB_PORT, name: "COM20" },
        ],
        target,
      ),
    ).toEqual({ status: "ambiguous", candidateCount: 2 });
  });
});

describe("SerialReconnectCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("按固定退避执行十次后停止", async () => {
    const harness = createHarness();
    await armAndLoseConnection(harness);

    for (const delayMs of SERIAL_RECOVERY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    expect(harness.listPorts).toHaveBeenCalledTimes(SERIAL_RECOVERY_DELAYS_MS.length);
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      phase: "exhausted",
      attempt: SERIAL_RECOVERY_DELAYS_MS.length,
      nextAttemptAt: undefined,
    });
    const report = harness.coordinator.exportDiagnostics({
      appVersion: "0.1.0",
      connectionStatus: "error",
      generation: 4,
      revision: 11,
      serialConfig: { ...DEFAULT_SERIAL_CONFIG, portName: USB_PORT.name },
    });
    expect(
      report.events
        .filter((event) => event.kind === "recovery_scheduled")
        .map((event) => event.delayMs),
    ).toEqual([...SERIAL_RECOVERY_DELAYS_MS]);
  });

  it("自动重连使用最后一次成功的运行时控制线配置", async () => {
    const harness = createHarness();
    harness.listPorts.mockResolvedValue([{ ...USB_PORT, name: "COM19" }]);
    harness.connect.mockResolvedValue({
      status: "connected",
      portName: "COM19",
      generation: 5,
      revision: 12,
    });
    await harness.coordinator.setEnabled(true, {
      status: "connected",
      generation: CONNECTED_STATE.generation,
      config: { ...DEFAULT_SERIAL_CONFIG, portName: USB_PORT.name, dtr: true, rts: true },
      port: USB_PORT,
    });
    harness.coordinator.updateConfig({
      ...DEFAULT_SERIAL_CONFIG,
      portName: USB_PORT.name,
      dtr: false,
      rts: false,
    });
    harness.coordinator.observeState(
      {
        status: "error",
        portName: USB_PORT.name,
        errorCode: "read-failed",
        generation: CONNECTED_STATE.generation,
        revision: CONNECTED_STATE.revision + 1,
      },
      "connected",
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(harness.connect).toHaveBeenCalledWith(
      expect.objectContaining({ portName: "COM19", dtr: false, rts: false }),
    );
  });

  it("捕获文件收尾失败时阻止重连", async () => {
    const harness = createHarness();
    harness.prepareCaptureBoundary.mockResolvedValue(false);

    await armAndLoseConnection(harness);

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      phase: "blocked",
      attempt: 0,
      message: "录制收尾失败，自动重连已停止",
    });
    expect(harness.listPorts).not.toHaveBeenCalled();
  });

  it("只在当前强身份故障真正启动恢复时接管捕获边界", async () => {
    const armed = createHarness();
    await armed.coordinator.setEnabled(true, {
      status: "connected",
      generation: CONNECTED_STATE.generation,
      config: { ...DEFAULT_SERIAL_CONFIG, portName: USB_PORT.name },
      port: USB_PORT,
    });

    const armedHandled = armed.coordinator.observeState(
      {
        status: "error",
        portName: USB_PORT.name,
        errorCode: "read-failed",
        generation: CONNECTED_STATE.generation,
        revision: CONNECTED_STATE.revision + 1,
      },
      "connected",
    );

    expect(armedHandled).toBe(true);
    expect(armed.prepareCaptureBoundary).toHaveBeenCalledOnce();

    const blocked = createHarness();
    await blocked.coordinator.setEnabled(true, {
      status: "connected",
      generation: CONNECTED_STATE.generation,
      config: { ...DEFAULT_SERIAL_CONFIG, portName: USB_PORT.name },
      port: { ...USB_PORT, serialNumber: undefined },
    });

    const blockedHandled = blocked.coordinator.observeState(
      {
        status: "error",
        portName: USB_PORT.name,
        errorCode: "read-failed",
        generation: CONNECTED_STATE.generation,
        revision: CONNECTED_STATE.revision + 1,
      },
      "connected",
    );

    expect(blockedHandled).toBe(false);
    expect(blocked.prepareCaptureBoundary).not.toHaveBeenCalled();
    expect(blocked.coordinator.getSnapshot().phase).toBe("blocked");
  });

  it("等待期间取消会清理定时器", async () => {
    const harness = createHarness();
    await armAndLoseConnection(harness);
    expect(harness.coordinator.getSnapshot().phase).toBe("waiting");

    await harness.coordinator.cancel("user-cancelled", true);
    await vi.runAllTimersAsync();

    expect(harness.listPorts).not.toHaveBeenCalled();
    expect(harness.cancelPendingConnection).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot().phase).toBe("idle");
  });

  it("扫描期间取消会丢弃迟到的端口列表", async () => {
    const harness = createHarness();
    const ports = deferred<SerialPortInfo[]>();
    harness.listPorts.mockReturnValue(ports.promise);
    await armAndLoseConnection(harness);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.coordinator.getSnapshot().phase).toBe("scanning");

    await harness.coordinator.cancel("user-cancelled", true);
    ports.resolve([{ ...USB_PORT, name: "COM19" }]);
    await Promise.resolve();

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.updatePorts).not.toHaveBeenCalled();
    expect(harness.updatePortName).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot().phase).toBe("idle");
  });

  it("连接期间取消后调用后端取消并丢弃迟到成功", async () => {
    const harness = createHarness();
    const connection = deferred<SerialStatePayload>();
    harness.listPorts.mockResolvedValue([{ ...USB_PORT, name: "COM19" }]);
    harness.connect.mockReturnValue(connection.promise);
    await armAndLoseConnection(harness);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.coordinator.getSnapshot().phase).toBe("connecting");

    await harness.coordinator.cancel("user-cancelled", true);
    connection.resolve({
      status: "connected",
      portName: "COM19",
      generation: 5,
      revision: 12,
    });
    await Promise.resolve();

    expect(harness.cancelPendingConnection).toHaveBeenCalledOnce();
    expect(harness.applyBackendState).not.toHaveBeenCalled();
    expect(harness.resetStreamAfterReconnect).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot().phase).toBe("idle");
  });

  it("快速关闭再开启不会被旧关闭操作覆盖", async () => {
    const harness = createHarness();
    const connection = deferred<SerialStatePayload>();
    const cancellation = deferred<void>();
    harness.listPorts.mockResolvedValue([{ ...USB_PORT, name: "COM19" }]);
    harness.connect.mockReturnValue(connection.promise);
    harness.cancelPendingConnection.mockReturnValue(cancellation.promise);
    await armAndLoseConnection(harness);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.coordinator.getSnapshot().phase).toBe("connecting");

    const disabling = harness.coordinator.setEnabled(false, {
      status: "connecting",
      generation: 5,
      config: { ...DEFAULT_SERIAL_CONFIG, portName: "COM19" },
      port: { ...USB_PORT, name: "COM19" },
    });
    await harness.coordinator.setEnabled(true, {
      status: "disconnected",
      generation: 6,
      config: { ...DEFAULT_SERIAL_CONFIG, portName: "COM19" },
      port: { ...USB_PORT, name: "COM19" },
    });
    cancellation.resolve(undefined);
    await disabling;

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      enabled: true,
      phase: "idle",
    });
    harness.coordinator.observeState(
      {
        status: "connected",
        portName: "COM19",
        generation: 7,
        revision: 12,
      },
      "connecting",
    );
    expect(harness.coordinator.getSnapshot().phase).toBe("armed");
  });

  it("唯一匹配连接成功后重置流状态但保留历史由 store 决定", async () => {
    const harness = createHarness();
    harness.listPorts.mockResolvedValue([{ ...USB_PORT, name: "COM19" }]);
    harness.connect.mockImplementation(async () => ({
      status: "connected",
      portName: "COM19",
      generation: 5,
      revision: 12,
    }));
    harness.applyBackendState.mockImplementation((payload) => {
      harness.coordinator.observeState(payload, "connecting");
    });
    await armAndLoseConnection(harness);

    await vi.advanceTimersByTimeAsync(0);

    expect(harness.updatePortName).toHaveBeenCalledWith("COM19");
    expect(harness.resetStreamAfterReconnect).toHaveBeenCalledOnce();
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      phase: "armed",
      attempt: 0,
    });
  });

  it("重复身份会立即阻断且不猜端口", async () => {
    const harness = createHarness();
    harness.listPorts.mockResolvedValue([
      { ...USB_PORT, name: "COM19" },
      { ...USB_PORT, name: "COM20" },
    ]);
    await armAndLoseConnection(harness);

    await vi.advanceTimersByTimeAsync(0);

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      phase: "blocked",
      attempt: 1,
    });
  });
});

describe("SerialDiagnosticLog", () => {
  it("只保留最近 256 条事件", () => {
    const log = new SerialDiagnosticLog(() => 1_000);
    for (let index = 0; index < 300; index += 1) {
      log.record({ kind: `event-${index}` });
    }

    const report = log.export({
      appVersion: "0.1.0",
      connectionStatus: "disconnected",
      generation: 0,
      revision: 0,
      serialConfig: DEFAULT_SERIAL_CONFIG,
      recoveryPhase: "off",
      attempt: 0,
      target: null,
    });
    expect(report.eventCount).toBe(256);
    expect(report.droppedEvents).toBe(44);
    expect(report.events[0]?.kind).toBe("event-44");
  });

  it("导出限制为 128 KiB", () => {
    const log = new SerialDiagnosticLog(() => 1_000);
    for (let index = 0; index < 256; index += 1) {
      log.record({ kind: `${index}-${"x".repeat(1_024)}` });
    }

    const report = log.export({
      appVersion: "0.1.0",
      connectionStatus: "error",
      generation: 4,
      revision: 11,
      serialConfig: DEFAULT_SERIAL_CONFIG,
      recoveryPhase: "exhausted",
      attempt: 10,
      target: null,
    });
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(report.droppedEvents).toBeGreaterThan(0);
  });

  it("不导出端口名、USB 序列号或原始错误", async () => {
    vi.useFakeTimers();
    const sentinel = "SENSITIVE-C:\\Users\\secret\\device-serial";
    const harness = createHarness();
    const sensitivePort = {
      ...USB_PORT,
      name: sentinel,
      serialNumber: sentinel,
    };
    harness.listPorts.mockRejectedValue(new Error(sentinel));
    await harness.coordinator.setEnabled(true, {
      status: "connected",
      generation: 4,
      config: { ...DEFAULT_SERIAL_CONFIG, portName: sentinel },
      port: sensitivePort,
    });
    harness.coordinator.observeState(
      {
        status: "error",
        portName: sentinel,
        message: sentinel,
        errorCode: "read-failed",
        generation: 4,
        revision: 11,
      },
      "connected",
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const report = harness.coordinator.exportDiagnostics({
      appVersion: "0.1.0",
      connectionStatus: "error",
      generation: 4,
      revision: 11,
      serialConfig: { ...DEFAULT_SERIAL_CONFIG, portName: sentinel },
    });
    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(report.target).toMatchObject({ serialPresent: true, matchPolicy: "usb-serial" });
    vi.useRealTimers();
  });
});
