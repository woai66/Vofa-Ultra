import { describe, expect, it, vi } from "vitest";
import type { ModbusRtuReadRequest } from "./modbusRtu";
import {
  MAX_MODBUS_POLL_INTERVAL_MS,
  MIN_MODBUS_POLL_INTERVAL_MS,
  ModbusPoller,
  type ModbusPollSnapshot,
} from "./modbusPoller";

const REQUEST: ModbusRtuReadRequest = {
  operation: "read-holding-registers",
  unitId: 1,
  address: 10,
  quantity: 2,
};

function createHarness() {
  let now = 1_000;
  let nextTransactionId = 10;
  const snapshots: ModbusPollSnapshot[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const dispatch = vi.fn<(request: ModbusRtuReadRequest, timeoutMs: number) => number>(() => {
    nextTransactionId += 1;
    return nextTransactionId;
  });
  const cancel = vi.fn(async () => true);
  const clearTimer = vi.fn();
  const poller = new ModbusPoller({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimer,
    dispatch,
    cancel,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return {
    poller,
    snapshots,
    timers,
    dispatch,
    cancel,
    clearTimer,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("ModbusPoller", () => {
  it("立即发出首轮且只在成功终态后按固定间隔调度下一轮", () => {
    const harness = createHarness();

    harness.poller.start(REQUEST, 500, 750);

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).toHaveBeenLastCalledWith(REQUEST, 500);
    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "running",
      activeTransactionId: 11,
      successCount: 0,
    });
    expect(harness.timers).toHaveLength(0);

    harness.setNow(1_040);
    expect(
      harness.poller.handleTerminal({
        transactionId: 11,
        status: "completed",
        result: { kind: "registers", values: [10, 11] },
        endedAt: 1_040,
        message: "读取完成",
      }),
    ).toBe(true);

    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "running",
      activeTransactionId: 0,
      successCount: 1,
      failureCount: 0,
      latestResult: { kind: "registers", values: [10, 11] },
      lastCompletedAt: 1_040,
    });
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(750);
    expect(harness.dispatch).toHaveBeenCalledTimes(1);

    harness.timers[0]?.callback();
    expect(harness.dispatch).toHaveBeenCalledTimes(2);
    expect(harness.poller.getSnapshot().activeTransactionId).toBe(12);
  });

  it("冻结启动参数并拒绝写功能、重复启动和越界间隔", () => {
    const harness = createHarness();
    const request = { ...REQUEST };

    harness.poller.start(request, 1_000, MIN_MODBUS_POLL_INTERVAL_MS);
    request.address = 99;

    expect(harness.poller.getSnapshot().request?.address).toBe(10);
    expect(harness.dispatch.mock.calls[0]?.[0].address).toBe(10);
    expect(() => harness.poller.start(REQUEST, 1_000, 1_000)).toThrow("正在运行或停止中");

    const writeRequest = {
      operation: "write-single-register",
      unitId: 1,
      address: 0,
      quantity: 1,
    } as unknown as ModbusRtuReadRequest;
    const idleHarness = createHarness();
    expect(() => idleHarness.poller.start(writeRequest, 1_000, 1_000)).toThrow(
      "只支持 Modbus RTU 01/02/03/04",
    );
    expect(() =>
      idleHarness.poller.start(REQUEST, 1_000, MIN_MODBUS_POLL_INTERVAL_MS - 1),
    ).toThrow("轮询间隔必须是");
    expect(() =>
      idleHarness.poller.start(REQUEST, 1_000, MAX_MODBUS_POLL_INTERVAL_MS + 1),
    ).toThrow("轮询间隔必须是");
  });

  it("设备异常、超时或协议错误立即停机且不安排重试", () => {
    const harness = createHarness();
    harness.poller.start(REQUEST, 1_000, 1_000);

    harness.setNow(1_025);
    harness.poller.handleTerminal({
      transactionId: 11,
      status: "exception",
      result: { kind: "exception", exceptionCode: 2, exceptionName: "非法数据地址" },
      endedAt: 1_025,
      message: "设备返回非法数据地址",
    });

    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "error",
      successCount: 0,
      failureCount: 1,
      lastError: "设备返回非法数据地址",
    });
    expect(harness.timers).toHaveLength(0);
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it("等待下一轮时停止会清除定时器且不取消已完成事务", () => {
    const harness = createHarness();
    harness.poller.start(REQUEST, 1_000, 1_000);
    harness.poller.handleTerminal({
      transactionId: 11,
      status: "completed",
      result: { kind: "registers", values: [10, 11] },
      endedAt: 1_020,
      message: "读取完成",
    });
    const timer = harness.timers[0];

    expect(harness.poller.stop("user")).toBe(true);
    expect(harness.clearTimer).toHaveBeenCalledWith(timer);
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "stopped",
      successCount: 1,
      message: "已手动停止轮询，成功 1 次，失败 0 次",
    });

    timer?.callback();
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it("在途停止进入 stopping 并在取消终态后结束", async () => {
    const harness = createHarness();
    harness.poller.start(REQUEST, 1_000, 1_000);

    expect(harness.poller.stop("source-change")).toBe(true);
    expect(harness.poller.getSnapshot().status).toBe("stopping");
    expect(harness.cancel).toHaveBeenCalledWith(11);
    await Promise.resolve();

    harness.poller.handleTerminal({
      transactionId: 11,
      status: "cancelled",
      result: null,
      endedAt: 1_010,
      message: "已取消",
    });
    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "stopped",
      successCount: 0,
      failureCount: 0,
      message: "数据源已切换，轮询已停止，成功 0 次，失败 0 次",
    });
  });

  it("生命周期可先标记停止，再由外部取消链路提交终态", () => {
    const harness = createHarness();
    harness.poller.start(REQUEST, 1_000, 1_000);

    expect(harness.poller.stop("connection-lost", false)).toBe(true);
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.poller.stop("connection-change")).toBe(true);
    expect(harness.cancel).toHaveBeenCalledWith(11);
    harness.poller.handleTerminal({
      transactionId: 11,
      status: "error",
      result: null,
      endedAt: 1_010,
      message: "串口已断开",
    });

    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "stopped",
      failureCount: 1,
      message: "连接已中断，轮询已停止，成功 0 次，失败 1 次",
    });
  });

  it("忽略陈旧事务终态与过期调度代次", () => {
    const harness = createHarness();
    harness.poller.start(REQUEST, 1_000, 1_000);

    expect(
      harness.poller.handleTerminal({
        transactionId: 99,
        status: "completed",
        result: { kind: "registers", values: [99] },
        endedAt: 1_020,
        message: "迟到响应",
      }),
    ).toBe(false);
    expect(harness.poller.getSnapshot().successCount).toBe(0);

    harness.poller.handleTerminal({
      transactionId: 11,
      status: "completed",
      result: { kind: "registers", values: [10, 11] },
      endedAt: 1_030,
      message: "读取完成",
    });
    const oldTimer = harness.timers[0];
    harness.poller.stop();
    harness.poller.start(REQUEST, 1_000, 2_000);
    oldTimer?.callback();

    expect(harness.dispatch).toHaveBeenCalledTimes(2);
    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "running",
      activeTransactionId: 12,
      intervalMs: 2_000,
    });
  });

  it("后端启动失败只终结匹配中的事务", () => {
    const harness = createHarness();
    harness.poller.start(REQUEST, 1_000, 1_000);

    expect(harness.poller.handleDispatchError(99, new Error("迟到失败"))).toBe(false);
    expect(harness.poller.handleDispatchError(11, new Error("串口繁忙"))).toBe(true);
    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "error",
      failureCount: 1,
      lastError: "串口繁忙",
    });
  });

  it("终态快照回调同步停止时不会为旧任务继续调度", () => {
    const setTimer = vi.fn();
    const poller = new ModbusPoller({
      now: () => 1_000,
      setTimer,
      clearTimer: vi.fn(),
      dispatch: () => 11,
      cancel: async () => true,
      onSnapshot: (snapshot) => {
        if (
          snapshot.status === "running" &&
          snapshot.successCount === 1 &&
          snapshot.activeTransactionId === 0
        ) {
          poller.stop();
        }
      },
    });
    poller.start(REQUEST, 1_000, 1_000);

    poller.handleTerminal({
      transactionId: 11,
      status: "completed",
      result: { kind: "registers", values: [10, 11] },
      endedAt: 1_010,
      message: "读取完成",
    });

    expect(poller.getSnapshot().status).toBe("stopped");
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("dispatch 内同步停止会取消已经启动但尚未登记的事务", async () => {
    const cancel = vi.fn(async () => true);
    const poller = new ModbusPoller({
      now: () => 1_000,
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
      dispatch: () => {
        poller.stop();
        return 11;
      },
      cancel,
      onSnapshot: vi.fn(),
    });

    poller.start(REQUEST, 1_000, 1_000);
    await Promise.resolve();

    expect(poller.getSnapshot().status).toBe("stopped");
    expect(cancel).toHaveBeenCalledWith(11);
  });

  it("取消被拒绝时保留 stopping 和事务标识以便重试", async () => {
    const harness = createHarness();
    harness.cancel.mockResolvedValue(false);
    harness.poller.start(REQUEST, 1_000, 1_000);

    harness.poller.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.poller.getSnapshot()).toMatchObject({
      status: "stopping",
      activeTransactionId: 11,
      lastError: "无法取消当前 Modbus RTU 读取事务",
    });
    harness.poller.stop();
    expect(harness.cancel).toHaveBeenCalledTimes(2);
  });
});
