import { describe, expect, it, vi } from "vitest";
import type { ExtensionBatchPayload, ExtensionStatePayload } from "../types/extensions";
import {
  ExtensionCoordinator,
  MAX_EXTENSION_BATCH_BYTES,
  MAX_EXTENSION_QUEUE_BATCHES,
} from "./extensionCoordinator";

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

function activeState(overrides: Partial<ExtensionStatePayload> = {}): ExtensionStatePayload {
  return {
    status: "active",
    sessionId: 7,
    generation: 3,
    revision: 1,
    nextSequence: 1,
    authorizedCapabilities: ["live-rx.read"],
    processedBytes: 0,
    emittedFrames: 0,
    ...overrides,
  };
}

function result(
  sequence: number,
  acceptedBytes: number,
  overrides: Partial<ExtensionBatchPayload> = {},
): ExtensionBatchPayload {
  return {
    sessionId: 7,
    generation: 3,
    sequence,
    receivedAt: 1_000,
    acceptedBytes,
    frames: [],
    ...overrides,
  };
}

describe("ExtensionCoordinator", () => {
  it("复制并拆分输入，且后端调用始终单在途", async () => {
    let concurrent = 0;
    let maximumConcurrent = 0;
    const calls: Uint8Array[] = [];
    const onBatch = vi.fn();
    const coordinator = new ExtensionCoordinator({
      pushBatch: async (_session, _generation, sequence, _receivedAt, data) => {
        concurrent += 1;
        maximumConcurrent = Math.max(maximumConcurrent, concurrent);
        calls.push(data);
        await Promise.resolve();
        concurrent -= 1;
        return result(sequence, data.length);
      },
      onBatch,
      onFault: vi.fn(),
    });
    coordinator.activate(activeState());
    const bytes = new Uint8Array(MAX_EXTENSION_BATCH_BYTES + 5).fill(0x2a);

    expect(coordinator.enqueue(bytes, 1_000)).toBe(true);
    bytes.fill(0);

    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(2));
    expect(calls.map((data) => data.length)).toEqual([MAX_EXTENSION_BATCH_BYTES, 5]);
    expect(calls[0]?.[0]).toBe(0x2a);
    expect(maximumConcurrent).toBe(1);
  });

  it("队列溢出仅停用扩展并清空待处理批次", async () => {
    const pending = deferred<ExtensionBatchPayload>();
    const onFault = vi.fn();
    const coordinator = new ExtensionCoordinator({
      pushBatch: () => pending.promise,
      onBatch: vi.fn(),
      onFault,
    });
    coordinator.activate(activeState());
    expect(coordinator.enqueue(Uint8Array.of(1), 1_000)).toBe(true);
    for (let index = 1; index < MAX_EXTENSION_QUEUE_BATCHES; index += 1) {
      expect(coordinator.enqueue(Uint8Array.of(index), 1_000 + index)).toBe(true);
    }

    expect(coordinator.enqueue(Uint8Array.of(9), 2_000)).toBe(false);
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("队列已满") }), 7);
    expect(coordinator.getSnapshot()).toMatchObject({ active: false, queuedBatches: 0 });

    pending.resolve(result(1, 1));
    await Promise.resolve();
  });

  it("清图丢弃旧输出但保持 guest 输入序列连续", async () => {
    const pending: Array<Deferred<ExtensionBatchPayload>> = [];
    const onBatch = vi.fn();
    const coordinator = new ExtensionCoordinator({
      pushBatch: () => {
        const request = deferred<ExtensionBatchPayload>();
        pending.push(request);
        return request.promise;
      },
      onBatch,
      onFault: vi.fn(),
    });
    coordinator.activate(activeState());
    coordinator.enqueue(Uint8Array.of(1), 1_000);
    coordinator.discardPendingOutputs();
    coordinator.enqueue(Uint8Array.of(2), 1_001);

    pending[0]?.resolve(result(1, 1));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.resolve(result(2, 1, { receivedAt: 1_001 }));

    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(2));
    expect(onBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sequence: 1 }),
      false,
    );
    expect(onBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sequence: 2 }),
      true,
    );
  });

  it("拒绝非法接收时间且不调用后端", () => {
    const pushBatch = vi.fn();
    const onFault = vi.fn();
    const coordinator = new ExtensionCoordinator({
      pushBatch,
      onBatch: vi.fn(),
      onFault,
    });
    coordinator.activate(activeState());

    expect(coordinator.enqueue(Uint8Array.of(1), Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(pushBatch).not.toHaveBeenCalled();
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("接收时间") }),
      7,
    );
    expect(coordinator.getSnapshot().active).toBe(false);
  });

  it("后端返回不同接收时间时停止会话", async () => {
    const onBatch = vi.fn();
    const onFault = vi.fn();
    const coordinator = new ExtensionCoordinator({
      pushBatch: async () => result(1, 1, { receivedAt: 1_001 }),
      onBatch,
      onFault,
    });
    coordinator.activate(activeState());

    expect(coordinator.enqueue(Uint8Array.of(1), 1_000)).toBe(true);

    await vi.waitFor(() => expect(onFault).toHaveBeenCalledOnce());
    expect(onBatch).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().active).toBe(false);
  });

  it("停用后忽略迟到结果，并把不匹配结果视为故障", async () => {
    const first = deferred<ExtensionBatchPayload>();
    const onBatch = vi.fn();
    const onFault = vi.fn();
    const pushBatch = vi.fn(() => first.promise);
    const coordinator = new ExtensionCoordinator({ pushBatch, onBatch, onFault });
    coordinator.activate(activeState());
    coordinator.enqueue(Uint8Array.of(1), 1_000);
    coordinator.deactivate();
    first.resolve(result(1, 1));
    await Promise.resolve();
    await Promise.resolve();
    expect(onBatch).not.toHaveBeenCalled();

    const mismatch = new ExtensionCoordinator({
      pushBatch: async () => result(99, 1),
      onBatch,
      onFault,
    });
    mismatch.activate(activeState());
    mismatch.enqueue(Uint8Array.of(1), 1_000);
    await vi.waitFor(() => expect(onFault).toHaveBeenCalled());
    expect(mismatch.getSnapshot().active).toBe(false);
  });
});
