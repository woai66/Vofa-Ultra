import type { DisplayMode, LineEnding } from "../types/serial";
import type { CommandHistoryEntry, CommandTaskSnapshot } from "../types/workbench";
import type {
  CommandTemplateContext,
  CompiledCommandTemplate,
} from "./commandTemplate";
import type { CommandChecksumMode } from "./checksum";

export const MAX_COMMAND_HISTORY_ENTRIES = 100;
export const MAX_COMMAND_HISTORY_PAYLOAD_BYTES = 256 * 1024;
export const MIN_COMMAND_INTERVAL_MS = 20;
export const MAX_COMMAND_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_COMMAND_REPEAT_COUNT = 100_000;

export type CommandTaskStopReason =
  | "user"
  | "connection-change"
  | "connection-lost"
  | "source-change"
  | "workspace-change"
  | "replay-open"
  | "runtime-dispose";

export interface PreparedCommand {
  value: string;
  mode: DisplayMode;
  lineEnding: LineEnding;
  checksumMode: CommandChecksumMode;
  bytes: Uint8Array;
  variableCount: number;
}

export interface CommandTaskRequest {
  template: CompiledCommandTemplate;
  lineEnding: LineEnding;
  checksumMode: CommandChecksumMode;
  intervalMs: number;
  repeatCount: number | null;
}

export interface CommandSchedulerDependencies {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  prepare(
    template: CompiledCommandTemplate,
    lineEnding: LineEnding,
    checksumMode: CommandChecksumMode,
    context: CommandTemplateContext,
  ): PreparedCommand;
  send(command: PreparedCommand): Promise<void>;
  onSnapshot(snapshot: CommandTaskSnapshot): void;
}

interface ScheduledCommandTask extends CommandTaskRequest {
  taskStartedAtMs: number;
}

export function createInitialCommandTaskSnapshot(): CommandTaskSnapshot {
  return {
    status: "idle",
    intervalMs: 1_000,
    repeatCount: 10,
    sentCount: 0,
    message: "周期发送未运行",
  };
}

export function commandHistoryPayloadBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function appendCommandHistory(
  history: readonly CommandHistoryEntry[],
  entry: Omit<CommandHistoryEntry, "repeatCount">,
): CommandHistoryEntry[] {
  if (entry.payloadBytes > MAX_COMMAND_HISTORY_PAYLOAD_BYTES) {
    return [...history];
  }

  const last = history.at(-1);
  if (
    last &&
    last.value === entry.value &&
    last.mode === entry.mode &&
    last.lineEnding === entry.lineEnding &&
    last.checksumMode === entry.checksumMode
  ) {
    return [
      ...history.slice(0, -1),
      {
        ...last,
        encodedBytes: entry.encodedBytes,
        variableCount: entry.variableCount,
        sentAt: entry.sentAt,
        repeatCount: last.repeatCount + 1,
      },
    ];
  }

  const next: CommandHistoryEntry[] = [...history, { ...entry, repeatCount: 1 }];
  let payloadBytes = next.reduce((total, item) => total + item.payloadBytes, 0);
  let firstKeptIndex = Math.max(0, next.length - MAX_COMMAND_HISTORY_ENTRIES);

  for (let index = 0; index < firstKeptIndex; index += 1) {
    payloadBytes -= next[index]?.payloadBytes ?? 0;
  }
  while (
    firstKeptIndex < next.length &&
    payloadBytes > MAX_COMMAND_HISTORY_PAYLOAD_BYTES
  ) {
    payloadBytes -= next[firstKeptIndex]?.payloadBytes ?? 0;
    firstKeptIndex += 1;
  }
  return next.slice(firstKeptIndex);
}

export class CommandScheduler {
  private operation = 0;
  private timer: unknown;
  private inFlight = false;
  private pendingStopReason: CommandTaskStopReason = "user";
  private snapshot = createInitialCommandTaskSnapshot();

  constructor(private readonly dependencies: CommandSchedulerDependencies) {}

  getSnapshot(): CommandTaskSnapshot {
    return { ...this.snapshot };
  }

  isActive(): boolean {
    return this.snapshot.status === "running" || this.snapshot.status === "stopping";
  }

  start(request: CommandTaskRequest): void {
    validateCommandTaskRequest(request);
    if (this.isActive() || this.inFlight) {
      throw new Error("已有发送任务正在运行或停止中");
    }

    this.clearScheduledTimer();
    const operation = ++this.operation;
    const taskStartedAtMs = this.dependencies.now();
    const task: ScheduledCommandTask = {
      ...request,
      taskStartedAtMs,
    };
    const firstCommand = this.prepareCommand(task, 1, taskStartedAtMs);
    this.updateSnapshot({
      status: "running",
      intervalMs: task.intervalMs,
      repeatCount: task.repeatCount,
      sentCount: 0,
      message: "周期发送运行中",
      startedAt: taskStartedAtMs,
      finishedAt: undefined,
      lastError: undefined,
    });
    void this.dispatch(operation, task, firstCommand);
  }

  stop(reason: CommandTaskStopReason = "user"): boolean {
    if (!this.isActive()) {
      return false;
    }

    this.operation += 1;
    this.pendingStopReason = reason;
    this.clearScheduledTimer();
    if (this.inFlight) {
      this.updateSnapshot({
        ...this.snapshot,
        status: "stopping",
        message: "正在停止，等待当前发送完成",
      });
      return true;
    }
    this.finishStopped(false);
    return true;
  }

  private async dispatch(
    operation: number,
    task: ScheduledCommandTask,
    preparedCommand?: PreparedCommand,
  ): Promise<void> {
    if (operation !== this.operation || this.snapshot.status !== "running") {
      return;
    }

    this.inFlight = true;
    try {
      const command =
        preparedCommand ??
        this.prepareCommand(
          task,
          this.snapshot.sentCount + 1,
          this.dependencies.now(),
        );
      await this.dependencies.send(command);
    } catch (error) {
      this.inFlight = false;
      if (operation !== this.operation) {
        this.finishStopped(false);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.updateSnapshot({
        ...this.snapshot,
        status: "error",
        message: `周期发送已停止：${message}`,
        finishedAt: this.dependencies.now(),
        lastError: message,
      });
      return;
    }

    this.inFlight = false;
    if (operation !== this.operation) {
      this.finishStopped(true);
      return;
    }

    const sentCount = this.snapshot.sentCount + 1;
    if (task.repeatCount !== null && sentCount >= task.repeatCount) {
      this.updateSnapshot({
        ...this.snapshot,
        status: "completed",
        sentCount,
        message: `已完成 ${sentCount} 次发送`,
        finishedAt: this.dependencies.now(),
      });
      return;
    }

    this.updateSnapshot({
      ...this.snapshot,
      sentCount,
      message: "周期发送运行中",
    });
    if (operation !== this.operation || this.snapshot.status !== "running") {
      return;
    }
    const timer = this.dependencies.setTimer(() => {
      if (this.timer === timer) {
        this.timer = undefined;
      }
      void this.dispatch(operation, task);
    }, task.intervalMs);
    this.timer = timer;
  }

  private finishStopped(includeInFlightSuccess: boolean): void {
    if (this.snapshot.status !== "stopping" && this.snapshot.status !== "running") {
      return;
    }
    const sentCount = this.snapshot.sentCount + (includeInFlightSuccess ? 1 : 0);
    this.updateSnapshot({
      ...this.snapshot,
      status: "stopped",
      sentCount,
      message: stopMessage(this.pendingStopReason, sentCount),
      finishedAt: this.dependencies.now(),
      lastError: undefined,
    });
  }

  private clearScheduledTimer(): void {
    if (this.timer !== undefined) {
      this.dependencies.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private prepareCommand(
    task: ScheduledCommandTask,
    sequence: number,
    nowMs: number,
  ): PreparedCommand {
    const command = this.dependencies.prepare(
      task.template,
      task.lineEnding,
      task.checksumMode,
      {
        sequence,
        nowMs,
        taskStartedAtMs: task.taskStartedAtMs,
      },
    );
    if (command.bytes.length === 0) {
      throw new Error("发送内容不能为空");
    }
    return {
      ...command,
      bytes: Uint8Array.from(command.bytes),
    };
  }

  private updateSnapshot(snapshot: CommandTaskSnapshot): void {
    this.snapshot = snapshot;
    this.dependencies.onSnapshot({ ...snapshot });
  }
}

function validateCommandTaskRequest(request: CommandTaskRequest): void {
  if (
    !Number.isInteger(request.intervalMs) ||
    request.intervalMs < MIN_COMMAND_INTERVAL_MS ||
    request.intervalMs > MAX_COMMAND_INTERVAL_MS
  ) {
    throw new Error(
      `发送间隔必须是 ${MIN_COMMAND_INTERVAL_MS} 到 ${MAX_COMMAND_INTERVAL_MS} 毫秒的整数`,
    );
  }
  if (
    request.repeatCount !== null &&
    (!Number.isInteger(request.repeatCount) ||
      request.repeatCount < 1 ||
      request.repeatCount > MAX_COMMAND_REPEAT_COUNT)
  ) {
    throw new Error(`发送次数必须是 1 到 ${MAX_COMMAND_REPEAT_COUNT} 的整数`);
  }
}

function stopMessage(reason: CommandTaskStopReason, sentCount: number): string {
  const prefix: Record<CommandTaskStopReason, string> = {
    user: "已手动停止",
    "connection-change": "连接状态变更，任务已停止",
    "connection-lost": "连接已中断，任务已停止",
    "source-change": "数据源已切换，任务已停止",
    "workspace-change": "工作区已切换，任务已停止",
    "replay-open": "已进入回放流程，任务已停止",
    "runtime-dispose": "运行环境已卸载，任务已停止",
  };
  return `${prefix[reason]}，成功发送 ${sentCount} 次`;
}
