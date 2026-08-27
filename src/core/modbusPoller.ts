import type { CommandTaskStopReason } from "./commandWorkflow";
import {
  buildModbusRtuRequest,
  isModbusRtuReadOperation,
  MAX_MODBUS_TRANSACTION_TIMEOUT_MS,
  MIN_MODBUS_TRANSACTION_TIMEOUT_MS,
  type ModbusRtuReadRequest,
  type ModbusRtuTransactionResult,
  type ModbusRtuTransactionTerminalStatus,
} from "./modbusRtu";

export const MIN_MODBUS_POLL_INTERVAL_MS = 100;
export const MAX_MODBUS_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MODBUS_POLL_INTERVAL_MS = 1_000;

export type ModbusPollLatestResult = Extract<
  ModbusRtuTransactionResult,
  { kind: "bits" | "registers" }
>;

export interface ModbusPollSnapshot {
  status: "idle" | "running" | "stopping" | "stopped" | "error";
  request: ModbusRtuReadRequest | null;
  timeoutMs: number;
  intervalMs: number;
  successCount: number;
  failureCount: number;
  activeTransactionId: number;
  latestResult: ModbusPollLatestResult | null;
  message: string;
  startedAt?: number;
  lastCompletedAt?: number;
  finishedAt?: number;
  lastError?: string;
}

export interface ModbusPollTerminalEvent {
  transactionId: number;
  status: ModbusRtuTransactionTerminalStatus;
  result: ModbusRtuTransactionResult | null;
  endedAt: number;
  message: string;
}

export interface ModbusPollerDependencies {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  dispatch(request: ModbusRtuReadRequest, timeoutMs: number): number;
  cancel(transactionId: number): Promise<boolean>;
  onSnapshot(snapshot: ModbusPollSnapshot): void;
}

interface ModbusPollTask {
  request: ModbusRtuReadRequest;
  timeoutMs: number;
  intervalMs: number;
}

export function createInitialModbusPollSnapshot(): ModbusPollSnapshot {
  return {
    status: "idle",
    request: null,
    timeoutMs: 1_000,
    intervalMs: DEFAULT_MODBUS_POLL_INTERVAL_MS,
    successCount: 0,
    failureCount: 0,
    activeTransactionId: 0,
    latestResult: null,
    message: "Modbus RTU 轮询未运行",
  };
}

export function isModbusPollActive(snapshot: ModbusPollSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "stopping";
}

export class ModbusPoller {
  private operation = 0;
  private timer: unknown;
  private task: ModbusPollTask | null = null;
  private pendingStopReason: CommandTaskStopReason = "user";
  private snapshot = createInitialModbusPollSnapshot();

  constructor(private readonly dependencies: ModbusPollerDependencies) {}

  getSnapshot(): ModbusPollSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  isActive(): boolean {
    return isModbusPollActive(this.snapshot);
  }

  start(request: ModbusRtuReadRequest, timeoutMs: number, intervalMs: number): void {
    validatePollRequest(request, timeoutMs, intervalMs);
    if (this.isActive()) {
      throw new Error("已有 Modbus RTU 轮询任务正在运行或停止中");
    }

    this.clearScheduledTimer();
    const operation = ++this.operation;
    const startedAt = this.dependencies.now();
    this.task = {
      request: { ...request },
      timeoutMs,
      intervalMs,
    };
    this.updateSnapshot({
      status: "running",
      request: { ...request },
      timeoutMs,
      intervalMs,
      successCount: 0,
      failureCount: 0,
      activeTransactionId: 0,
      latestResult: null,
      message: "正在启动 Modbus RTU 轮询",
      startedAt,
      lastCompletedAt: undefined,
      finishedAt: undefined,
      lastError: undefined,
    });
    this.dispatch(operation);
  }

  stop(reason: CommandTaskStopReason = "user", cancelInFlight = true): boolean {
    if (!this.isActive()) {
      return false;
    }
    if (this.snapshot.status === "stopping") {
      if (cancelInFlight && this.snapshot.activeTransactionId !== 0) {
        void this.cancelInFlight(this.operation, this.snapshot.activeTransactionId);
      }
      return true;
    }

    const operation = ++this.operation;
    this.pendingStopReason = reason;
    this.clearScheduledTimer();
    if (this.snapshot.activeTransactionId === 0) {
      this.finishStopped();
      return true;
    }

    const transactionId = this.snapshot.activeTransactionId;
    this.updateSnapshot({
      ...this.snapshot,
      status: "stopping",
      message: "正在停止轮询并取消当前读取",
    });
    if (cancelInFlight) {
      void this.cancelInFlight(operation, transactionId);
    }
    return true;
  }

  handleDispatchError(transactionId: number, error: unknown): boolean {
    if (
      this.snapshot.activeTransactionId !== transactionId ||
      (this.snapshot.status !== "running" && this.snapshot.status !== "stopping")
    ) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (this.snapshot.status === "stopping") {
      this.updateSnapshot({
        ...this.snapshot,
        activeTransactionId: 0,
        failureCount: this.snapshot.failureCount + 1,
        lastError: message,
      });
      this.finishStopped();
    } else {
      this.finishError(message);
    }
    return true;
  }

  handleTerminal(event: ModbusPollTerminalEvent): boolean {
    if (
      event.transactionId !== this.snapshot.activeTransactionId ||
      (this.snapshot.status !== "running" && this.snapshot.status !== "stopping")
    ) {
      return false;
    }

    const operation = this.operation;
    const wasStopping = this.snapshot.status === "stopping";
    const latestResult = readResult(event.result);
    const completed = event.status === "completed" && latestResult !== null;
    const nextSnapshot: ModbusPollSnapshot = {
      ...this.snapshot,
      activeTransactionId: 0,
      successCount: this.snapshot.successCount + (completed ? 1 : 0),
      failureCount:
        this.snapshot.failureCount +
        (!completed && event.status !== "cancelled" ? 1 : 0),
      latestResult: completed ? cloneResult(latestResult) : this.snapshot.latestResult,
      lastCompletedAt: completed ? event.endedAt : this.snapshot.lastCompletedAt,
      lastError:
        completed || event.status === "cancelled" ? this.snapshot.lastError : event.message,
    };
    this.updateSnapshot(nextSnapshot);

    if (operation !== this.operation) {
      return true;
    }
    if (wasStopping) {
      this.finishStopped();
      return true;
    }
    if (this.snapshot.status !== "running") {
      return true;
    }
    if (!completed) {
      this.finishError(event.message, false);
      return true;
    }

    this.updateSnapshot({
      ...this.snapshot,
      message: `已完成 ${this.snapshot.successCount} 次读取，等待下一轮`,
    });
    if (operation === this.operation && this.snapshot.status === "running") {
      this.scheduleNext(operation);
    }
    return true;
  }

  private dispatch(operation: number): void {
    if (operation !== this.operation || this.snapshot.status !== "running" || !this.task) {
      return;
    }

    try {
      const transactionId = this.dependencies.dispatch(
        { ...this.task.request },
        this.task.timeoutMs,
      );
      if (operation !== this.operation || this.snapshot.status !== "running") {
        void this.dependencies.cancel(transactionId).catch(() => undefined);
        return;
      }
      this.updateSnapshot({
        ...this.snapshot,
        activeTransactionId: transactionId,
        message: `正在执行第 ${this.snapshot.successCount + 1} 次读取`,
      });
    } catch (error) {
      this.finishError(error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleNext(operation: number): void {
    if (operation !== this.operation || this.snapshot.status !== "running" || !this.task) {
      return;
    }
    const timer = this.dependencies.setTimer(() => {
      if (this.timer === timer) {
        this.timer = undefined;
      }
      this.dispatch(operation);
    }, this.task.intervalMs);
    this.timer = timer;
  }

  private async cancelInFlight(operation: number, transactionId: number): Promise<void> {
    try {
      const accepted = await this.dependencies.cancel(transactionId);
      if (
        !accepted &&
        operation === this.operation &&
        this.snapshot.status === "stopping" &&
        this.snapshot.activeTransactionId === transactionId
      ) {
        this.updateSnapshot({
          ...this.snapshot,
          message: "停止失败，请重试取消当前读取",
          lastError: "无法取消当前 Modbus RTU 读取事务",
        });
      }
    } catch (error) {
      if (
        operation === this.operation &&
        this.snapshot.status === "stopping" &&
        this.snapshot.activeTransactionId === transactionId
      ) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateSnapshot({
          ...this.snapshot,
          message: `停止失败：${message}`,
          lastError: message,
        });
      }
    }
  }

  private finishStopped(): void {
    this.clearScheduledTimer();
    this.task = null;
    this.updateSnapshot({
      ...this.snapshot,
      status: "stopped",
      activeTransactionId: 0,
      message: stopMessage(
        this.pendingStopReason,
        this.snapshot.successCount,
        this.snapshot.failureCount,
      ),
      finishedAt: this.dependencies.now(),
    });
  }

  private finishError(message: string, incrementFailure = true): void {
    this.operation += 1;
    this.clearScheduledTimer();
    this.task = null;
    this.updateSnapshot({
      ...this.snapshot,
      status: "error",
      activeTransactionId: 0,
      failureCount: this.snapshot.failureCount + (incrementFailure ? 1 : 0),
      message: `轮询已停止：${message}`,
      finishedAt: this.dependencies.now(),
      lastError: message,
    });
  }

  private clearScheduledTimer(): void {
    if (this.timer !== undefined) {
      this.dependencies.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private updateSnapshot(snapshot: ModbusPollSnapshot): void {
    this.snapshot = snapshot;
    this.dependencies.onSnapshot(cloneSnapshot(snapshot));
  }
}

function validatePollRequest(
  request: ModbusRtuReadRequest,
  timeoutMs: number,
  intervalMs: number,
): void {
  if (!isModbusRtuReadOperation(request.operation)) {
    throw new Error("轮询只支持 Modbus RTU 01/02/03/04 读取功能");
  }
  buildModbusRtuRequest(request);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_MODBUS_TRANSACTION_TIMEOUT_MS ||
    timeoutMs > MAX_MODBUS_TRANSACTION_TIMEOUT_MS
  ) {
    throw new Error(
      `响应超时必须是 ${MIN_MODBUS_TRANSACTION_TIMEOUT_MS}-${MAX_MODBUS_TRANSACTION_TIMEOUT_MS} ms`,
    );
  }
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_MODBUS_POLL_INTERVAL_MS ||
    intervalMs > MAX_MODBUS_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `轮询间隔必须是 ${MIN_MODBUS_POLL_INTERVAL_MS}-${MAX_MODBUS_POLL_INTERVAL_MS} ms`,
    );
  }
}

function readResult(result: ModbusRtuTransactionResult | null): ModbusPollLatestResult | null {
  return result?.kind === "bits" || result?.kind === "registers" ? result : null;
}

function cloneResult(result: ModbusPollLatestResult): ModbusPollLatestResult {
  return result.kind === "bits"
    ? { kind: "bits", values: [...result.values] }
    : { kind: "registers", values: [...result.values] };
}

function cloneSnapshot(snapshot: ModbusPollSnapshot): ModbusPollSnapshot {
  return {
    ...snapshot,
    request: snapshot.request ? { ...snapshot.request } : null,
    latestResult: snapshot.latestResult ? cloneResult(snapshot.latestResult) : null,
  };
}

function stopMessage(
  reason: CommandTaskStopReason,
  successCount: number,
  failureCount: number,
): string {
  const prefix: Record<CommandTaskStopReason, string> = {
    user: "已手动停止轮询",
    "connection-change": "连接状态变更，轮询已停止",
    "connection-lost": "连接已中断，轮询已停止",
    "source-change": "数据源已切换，轮询已停止",
    "workspace-change": "工作区已切换，轮询已停止",
    "replay-open": "已进入回放流程，轮询已停止",
    "runtime-dispose": "运行环境已卸载，轮询已停止",
  };
  return `${prefix[reason]}，成功 ${successCount} 次，失败 ${failureCount} 次`;
}
