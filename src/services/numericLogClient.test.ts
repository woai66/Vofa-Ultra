import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NumericLogSample } from "../types/numericLog";
import {
  abortNumericLog,
  enqueueNumericLogSamples,
  flushNumericLogQueue,
  resetNumericLogQueue,
  startNumericLog,
  stopNumericLog,
} from "./numericLogClient";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

function sample(index: number, name = `CH ${index + 1}`): NumericLogSample {
  return {
    timestampUnixUs: 1_700_000_000_000_000 + index,
    channelKind: "base",
    channelId: `channel-${index}`,
    channelName: name,
    value: index + 0.5,
  };
}

describe("numericLogClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    resetNumericLogQueue();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("开始记录时传递实时数据源和结构化协议", async () => {
    const payload = {
      status: "recording" as const,
      sessionId: 1,
      revision: 1,
      path: "numeric.csv",
      outputBytes: 0,
      sampleCount: 0,
    };
    invokeMock.mockResolvedValue(payload);

    await expect(
      startNumericLog({
        source: "serial",
        protocol: "firewater",
        destinationDirectory: "D:\\sessions",
      }),
    ).resolves.toEqual(payload);
    expect(invokeMock).toHaveBeenCalledWith("start_numeric_log", {
      request: {
        source: "serial",
        protocol: "firewater",
        destinationDirectory: "D:\\sessions",
      },
    });
  });

  it("按 256 条拆批并保持 IPC 串行顺序", async () => {
    let resolveFirst: (() => void) | undefined;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const samples = Array.from({ length: 300 }, (_, index) => sample(index));

    expect(enqueueNumericLogSamples(7, samples, onError)).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 7,
      samples: expect.arrayContaining([samples[0], samples[255]]),
    });
    expect((invokeMock.mock.calls[0]?.[1] as { samples: unknown[] }).samples).toHaveLength(256);

    resolveFirst?.();
    await flushNumericLogQueue();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect((invokeMock.mock.calls[1]?.[1] as { samples: unknown[] }).samples).toHaveLength(44);
    expect(onError).not.toHaveBeenCalled();
  });

  it("同时限制前端队列条数和估算字节数", () => {
    const onError = vi.fn();
    const tooMany = Array.from({ length: 2_049 }, (_, index) => sample(index));

    expect(enqueueNumericLogSamples(1, tooMany, onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/队列已满/) }),
    );
    expect(invokeMock).not.toHaveBeenCalled();

    resetNumericLogQueue();
    onError.mockClear();
    expect(
      enqueueNumericLogSamples(1, [sample(0, "x".repeat(1024 * 1024))], onError),
    ).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("停止前等待全部样本入队完成", async () => {
    let resolveAppend: (() => void) | undefined;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveAppend = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: "idle",
        sessionId: 3,
        revision: 4,
        path: "numeric.csv",
        outputBytes: 128,
        sampleCount: 1,
      });
    const onError = vi.fn();

    expect(enqueueNumericLogSamples(3, [sample(0)], onError)).toBe(true);
    const stopPromise = stopNumericLog();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveAppend?.();
    await expect(stopPromise).resolves.toMatchObject({ status: "idle", sampleCount: 1 });
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "append_numeric_log",
      "stop_numeric_log",
    ]);
  });

  it("停止排空失败时中止后端任务并保留部分文件", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("append failed"))
      .mockResolvedValueOnce({
        status: "error",
        sessionId: 3,
        revision: 4,
        path: "numeric.csv.part",
        outputBytes: 64,
        sampleCount: 1,
        message: "append failed",
      });
    const onError = vi.fn();

    expect(enqueueNumericLogSamples(3, [sample(0)], onError)).toBe(true);
    await expect(stopNumericLog()).resolves.toMatchObject({
      status: "error",
      path: "numeric.csv.part",
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "append failed" }),
    );
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "append_numeric_log",
      "abort_numeric_log",
    ]);
  });

  it("重置后旧会话完成不会消耗新会话队列", async () => {
    let resolveOldAppend: (() => void) | undefined;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldAppend = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();

    expect(enqueueNumericLogSamples(3, [sample(0)], onError)).toBe(true);
    resetNumericLogQueue();
    expect(enqueueNumericLogSamples(4, [sample(1)], onError)).toBe(true);
    await flushNumericLogQueue();

    expect(invokeMock.mock.calls.map(([, args]) => args.sessionId)).toEqual([3, 4]);
    resolveOldAppend?.();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it("显式中止会清空待提交样本", async () => {
    invokeMock.mockResolvedValue({
      status: "error",
      sessionId: 9,
      revision: 2,
      path: "numeric.csv.part",
      outputBytes: 64,
      sampleCount: 1,
    });

    await expect(abortNumericLog("队列已满")).resolves.toMatchObject({ status: "error" });
    expect(invokeMock).toHaveBeenCalledWith("abort_numeric_log", { message: "队列已满" });
  });
});
