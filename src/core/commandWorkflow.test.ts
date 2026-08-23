import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandHistoryEntry } from "../types/workbench";
import {
  appendCommandHistory,
  CommandScheduler,
  commandHistoryPayloadBytes,
  MAX_COMMAND_HISTORY_ENTRIES,
  MAX_COMMAND_HISTORY_PAYLOAD_BYTES,
  type CommandTaskRequest,
  type PreparedCommand,
} from "./commandWorkflow";

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

function historyEntry(
  value: string,
  overrides: Partial<Omit<CommandHistoryEntry, "repeatCount">> = {},
): Omit<CommandHistoryEntry, "repeatCount"> {
  return {
    value,
    mode: "text",
    lineEnding: "none",
    payloadBytes: commandHistoryPayloadBytes(value),
    encodedBytes: commandHistoryPayloadBytes(value),
    sentAt: 1_000,
    ...overrides,
  };
}

function task(overrides: Partial<CommandTaskRequest> = {}): CommandTaskRequest {
  return {
    value: "PING",
    mode: "text",
    lineEnding: "lf",
    bytes: new TextEncoder().encode("PING\n"),
    intervalMs: 100,
    repeatCount: 3,
    ...overrides,
  };
}

function schedulerHarness(send: (command: PreparedCommand) => Promise<void>) {
  const snapshots: ReturnType<CommandScheduler["getSnapshot"]>[] = [];
  const scheduler = new CommandScheduler({
    now: Date.now,
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    send,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return { scheduler, snapshots };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("command history", () => {
  it("仅合并连续且格式完全相同的命令", () => {
    let history = appendCommandHistory([], historyEntry("PING"));
    history = appendCommandHistory(history, historyEntry("PING", { sentAt: 2_000 }));

    expect(history).toEqual([
      expect.objectContaining({ value: "PING", repeatCount: 2, sentAt: 2_000 }),
    ]);

    history = appendCommandHistory(
      history,
      historyEntry("PING", { lineEnding: "lf", sentAt: 3_000 }),
    );
    history = appendCommandHistory(history, historyEntry("PING", { sentAt: 4_000 }));
    expect(history.map((entry) => entry.repeatCount)).toEqual([2, 1, 1]);
  });

  it("同时限制条目数和保存 payload 字节数", () => {
    let history: CommandHistoryEntry[] = [];
    for (let index = 0; index < MAX_COMMAND_HISTORY_ENTRIES + 5; index += 1) {
      history = appendCommandHistory(history, historyEntry(`command-${index}`));
    }
    expect(history).toHaveLength(MAX_COMMAND_HISTORY_ENTRIES);
    expect(history[0]?.value).toBe("command-5");

    history = [];
    for (const suffix of ["a", "b", "c"]) {
      const value = suffix.repeat(100 * 1024);
      history = appendCommandHistory(history, historyEntry(value));
    }
    expect(history).toHaveLength(2);
    expect(history.reduce((total, entry) => total + entry.payloadBytes, 0)).toBeLessThanOrEqual(
      MAX_COMMAND_HISTORY_PAYLOAD_BYTES,
    );
  });

  it("不保存单条就超过总预算的命令", () => {
    const existing = appendCommandHistory([], historyEntry("kept"));
    const oversized = "x".repeat(MAX_COMMAND_HISTORY_PAYLOAD_BYTES + 1);

    expect(appendCommandHistory(existing, historyEntry(oversized))).toEqual(existing);
  });
});

describe("CommandScheduler", () => {
  it("等待上一次发送完成后才计时，不追赶遗漏周期", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = deferred<void>();
    const send = vi
      .fn<(command: PreparedCommand) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const { scheduler } = schedulerHarness(send);

    scheduler.start(task({ repeatCount: null }));
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledOnce();

    first.resolve(undefined);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(99);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("有限次数完成后不再安排发送", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(command: PreparedCommand) => Promise<void>>().mockResolvedValue(undefined);
    const { scheduler } = schedulerHarness(send);

    scheduler.start(task({ repeatCount: 3 }));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(200);

    expect(send).toHaveBeenCalledTimes(3);
    expect(scheduler.getSnapshot()).toMatchObject({ status: "completed", sentCount: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("停止时隔离迟到成功，并在当前发送完成前拒绝新任务", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const send = vi
      .fn<(command: PreparedCommand) => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined);
    const { scheduler } = schedulerHarness(send);

    scheduler.start(task({ repeatCount: null }));
    expect(scheduler.stop("user")).toBe(true);
    expect(scheduler.getSnapshot().status).toBe("stopping");
    expect(() => scheduler.start(task())).toThrow("停止中");

    pending.resolve(undefined);
    await flushPromises();
    expect(scheduler.getSnapshot()).toMatchObject({ status: "stopped", sentCount: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledOnce();

    scheduler.start(task({ repeatCount: 1 }));
    await flushPromises();
    expect(scheduler.getSnapshot()).toMatchObject({ status: "completed", sentCount: 1 });
  });

  it("停止后的迟到失败不会覆盖停止状态", async () => {
    const pending = deferred<void>();
    const { scheduler } = schedulerHarness(() => pending.promise);

    scheduler.start(task({ repeatCount: null }));
    scheduler.stop("connection-lost");
    pending.reject(new Error("TX 队列已满"));
    await flushPromises();

    expect(scheduler.getSnapshot()).toMatchObject({
      status: "stopped",
      sentCount: 0,
      lastError: undefined,
    });
    expect(scheduler.getSnapshot().message).toContain("连接已中断");
  });

  it("发送失败时终止任务并保留最后错误", async () => {
    const { scheduler } = schedulerHarness(async () => {
      throw new Error("TX 队列已满");
    });

    scheduler.start(task({ repeatCount: null }));
    await flushPromises();

    expect(scheduler.getSnapshot()).toMatchObject({
      status: "error",
      sentCount: 0,
      lastError: "TX 队列已满",
    });
  });

  it("拒绝空 payload 和越界参数", () => {
    const { scheduler } = schedulerHarness(async () => undefined);

    expect(() => scheduler.start(task({ bytes: new Uint8Array() }))).toThrow("不能为空");
    expect(() => scheduler.start(task({ intervalMs: 19 }))).toThrow("发送间隔");
    expect(() => scheduler.start(task({ repeatCount: 100_001 }))).toThrow("发送次数");
  });
});
