import type {
  ExtensionBatchPayload,
  ExtensionQueueSnapshot,
  ExtensionStatePayload,
} from "../types/extensions";

export const MAX_EXTENSION_BATCH_BYTES = 64 * 1024;
export const MAX_EXTENSION_QUEUE_BATCHES = 8;
export const MAX_EXTENSION_QUEUE_BYTES = 512 * 1024;

interface QueuedExtensionBatch {
  data: Uint8Array;
  receivedAt: number;
  outputEpoch: number;
}

interface ExtensionCoordinatorDependencies {
  pushBatch(
    sessionId: number,
    generation: number,
    sequence: number,
    receivedAt: number,
    data: Uint8Array,
  ): Promise<ExtensionBatchPayload>;
  onBatch(payload: ExtensionBatchPayload, appendFrames: boolean): void;
  onFault(error: Error, sessionId: number): void;
  onQueueChange?(snapshot: ExtensionQueueSnapshot): void;
}

export class ExtensionCoordinator {
  private readonly queue: QueuedExtensionBatch[] = [];
  private queuedBytes = 0;
  private inFlightBytes = 0;
  private drainPromise: Promise<void> | null = null;
  private runId = 0;
  private outputEpoch = 0;
  private active = false;
  private sessionId = 0;
  private generation = 0;
  private nextSequence = 1;

  constructor(private readonly dependencies: ExtensionCoordinatorDependencies) {}

  activate(state: ExtensionStatePayload): void {
    if (
      state.status !== "active" ||
      state.sessionId <= 0 ||
      state.generation <= 0 ||
      state.nextSequence <= 0
    ) {
      throw new Error("无法启动无效的扩展会话");
    }
    this.invalidate();
    this.active = true;
    this.sessionId = state.sessionId;
    this.generation = state.generation;
    this.nextSequence = state.nextSequence;
    this.publishQueueState();
  }

  enqueue(bytes: Uint8Array, receivedAt: number): boolean {
    if (!this.active || bytes.length === 0) {
      return false;
    }
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      this.fail(new Error("协议扩展收到无效的接收时间，扩展已停用"));
      return false;
    }
    const chunks = Math.ceil(bytes.length / MAX_EXTENSION_BATCH_BYTES);
    const outstandingBatches = this.queue.length + (this.drainPromise ? 1 : 0);
    const outstandingBytes = this.queuedBytes + this.inFlightBytes;
    if (
      chunks > MAX_EXTENSION_QUEUE_BATCHES ||
      outstandingBatches + chunks > MAX_EXTENSION_QUEUE_BATCHES ||
      bytes.length > MAX_EXTENSION_QUEUE_BYTES ||
      outstandingBytes + bytes.length > MAX_EXTENSION_QUEUE_BYTES
    ) {
      this.fail(new Error("协议扩展队列已满，扩展已停用"));
      return false;
    }

    for (const data of copyExtensionInputBatches(bytes)) {
      this.queue.push({ data, receivedAt, outputEpoch: this.outputEpoch });
      this.queuedBytes += data.length;
    }
    this.publishQueueState();
    this.startDrain();
    return true;
  }

  discardPendingOutputs(): void {
    this.outputEpoch += 1;
  }

  async suspend(): Promise<void> {
    const pending = this.drainPromise;
    this.invalidate();
    this.publishQueueState();
    await pending;
  }

  deactivate(): void {
    this.invalidate();
    this.publishQueueState();
  }

  getSnapshot(): ExtensionQueueSnapshot {
    return {
      active: this.active,
      inFlight: this.drainPromise !== null,
      queuedBatches: this.queue.length,
      queuedBytes: this.queuedBytes,
    };
  }

  private startDrain(): void {
    if (this.drainPromise || !this.active) {
      return;
    }
    const runId = this.runId;
    const task = this.drain(runId).finally(() => {
      if (this.drainPromise !== task) {
        return;
      }
      this.drainPromise = null;
      this.inFlightBytes = 0;
      this.publishQueueState();
      if (this.active && this.queue.length > 0) {
        this.startDrain();
      }
    });
    this.drainPromise = task;
    this.publishQueueState();
  }

  private async drain(runId: number): Promise<void> {
    while (this.isCurrentRun(runId) && this.queue.length > 0) {
      const batch = this.queue.shift();
      if (!batch) {
        return;
      }
      this.queuedBytes -= batch.data.length;
      this.inFlightBytes = batch.data.length;
      const sessionId = this.sessionId;
      const generation = this.generation;
      const sequence = this.nextSequence;
      this.publishQueueState();
      try {
        const payload = await this.dependencies.pushBatch(
          sessionId,
          generation,
          sequence,
          batch.receivedAt,
          batch.data,
        );
        if (!this.isCurrentRun(runId)) {
          return;
        }
        this.validateResult(
          payload,
          batch.data.length,
          batch.receivedAt,
          sessionId,
          generation,
          sequence,
        );
        this.nextSequence = nextPositiveSequence(payload.sequence);
        this.dependencies.onBatch(payload, batch.outputEpoch === this.outputEpoch);
      } catch (error) {
        if (this.isCurrentRun(runId)) {
          this.fail(toError(error));
        }
        return;
      } finally {
        if (this.isCurrentRun(runId)) {
          this.inFlightBytes = 0;
          this.publishQueueState();
        }
      }
    }
  }

  private validateResult(
    payload: ExtensionBatchPayload,
    expectedBytes: number,
    expectedReceivedAt: number,
    sessionId: number,
    generation: number,
    sequence: number,
  ): void {
    if (
      payload.sessionId !== sessionId ||
      payload.generation !== generation ||
      payload.sequence !== sequence ||
      payload.receivedAt !== expectedReceivedAt ||
      payload.acceptedBytes !== expectedBytes
    ) {
      throw new Error("协议扩展返回了不匹配的会话结果");
    }
  }

  private isCurrentRun(runId: number): boolean {
    return this.active && runId === this.runId;
  }

  private fail(error: Error): void {
    const sessionId = this.sessionId;
    this.invalidate();
    this.publishQueueState();
    try {
      this.dependencies.onFault(error, sessionId);
    } catch {
      // 故障回调不得形成未处理的异步异常。
    }
  }

  private invalidate(): void {
    this.runId += 1;
    this.outputEpoch += 1;
    this.active = false;
    this.sessionId = 0;
    this.generation = 0;
    this.nextSequence = 1;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private publishQueueState(): void {
    this.dependencies.onQueueChange?.(this.getSnapshot());
  }
}

export function copyExtensionInputBatches(bytes: Uint8Array): Uint8Array[] {
  const batches: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_EXTENSION_BATCH_BYTES) {
    const end = Math.min(offset + MAX_EXTENSION_BATCH_BYTES, bytes.length);
    batches.push(Uint8Array.from(bytes.subarray(offset, end)));
  }
  return batches;
}

function nextPositiveSequence(sequence: number): number {
  return Number.isSafeInteger(sequence) && sequence > 0 && sequence < Number.MAX_SAFE_INTEGER
    ? sequence + 1
    : 1;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
