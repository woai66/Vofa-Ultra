import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  NumericLogEventHandlers,
  NumericLogSample,
  NumericLogStartRequest,
  NumericLogStatePayload,
} from "../types/numericLog";
import { isTauriRuntime } from "./serialClient";

const MAX_BATCH_SAMPLES = 256;
const MAX_QUEUE_SAMPLES = 2_048;
const MAX_QUEUE_BYTES = 1024 * 1024;
const SETTLE_POLL_MS = 50;
const SETTLE_TIMEOUT_MS = 10_000;
const UTF8_ENCODER = new TextEncoder();

interface QueuedBatch {
  sessionId: number;
  samples: NumericLogSample[];
  estimatedBytes: number;
}

let s_queue: QueuedBatch[] = [];
let s_queue_samples = 0;
let s_queue_bytes = 0;
let s_drain_promise: Promise<void> | null = null;
let s_queue_error: Error | null = null;
let s_queue_generation = 0;

export async function startNumericLog(
  request: NumericLogStartRequest,
): Promise<NumericLogStatePayload> {
  requireTauriRuntime();
  resetNumericLogQueue();
  return invoke<NumericLogStatePayload>("start_numeric_log", { request });
}

export async function stopNumericLog(): Promise<NumericLogStatePayload> {
  requireTauriRuntime();
  try {
    await flushNumericLogQueue();
  } catch (error) {
    return abortNumericLog(toError(error).message);
  }
  const payload = await invoke<NumericLogStatePayload>("stop_numeric_log");
  return waitForNumericLogSettled(payload);
}

export async function abortNumericLog(message: string): Promise<NumericLogStatePayload> {
  requireTauriRuntime();
  resetNumericLogQueue();
  return invoke<NumericLogStatePayload>("abort_numeric_log", { message });
}

export async function getNumericLogState(): Promise<NumericLogStatePayload> {
  requireTauriRuntime();
  return invoke<NumericLogStatePayload>("get_numeric_log_state");
}

export async function subscribeToNumericLogEvents(
  handlers: NumericLogEventHandlers,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<NumericLogStatePayload>("numeric-log://state", ({ payload }) => {
    handlers.onState(payload);
  });
}

export function enqueueNumericLogSamples(
  sessionId: number,
  samples: readonly NumericLogSample[],
  onError: (error: Error) => void,
): boolean {
  if (!isTauriRuntime() || samples.length === 0 || s_queue_error) {
    return false;
  }

  const estimatedBytes = samples.reduce(
    (total, sample) => total + estimateSampleBytes(sample),
    0,
  );
  if (
    samples.length > MAX_QUEUE_SAMPLES ||
    s_queue_samples + samples.length > MAX_QUEUE_SAMPLES ||
    estimatedBytes > MAX_QUEUE_BYTES ||
    s_queue_bytes + estimatedBytes > MAX_QUEUE_BYTES
  ) {
    const error = new Error("数值记录前端队列已满，记录已中止");
    s_queue_error = error;
    onError(error);
    return false;
  }

  let offset = 0;
  while (offset < samples.length) {
    const batchSamples = samples.slice(offset, offset + MAX_BATCH_SAMPLES);
    const batchBytes = batchSamples.reduce(
      (total, sample) => total + estimateSampleBytes(sample),
      0,
    );
    s_queue.push({
      sessionId,
      samples: batchSamples,
      estimatedBytes: batchBytes,
    });
    offset += batchSamples.length;
  }
  s_queue_samples += samples.length;
  s_queue_bytes += estimatedBytes;

  if (!s_drain_promise) {
    const generation = s_queue_generation;
    s_drain_promise = drainNumericLogQueue(generation, onError);
  }
  return true;
}

export async function flushNumericLogQueue(): Promise<void> {
  await s_drain_promise;
  if (s_queue_error) {
    throw s_queue_error;
  }
}

export function resetNumericLogQueue(): void {
  s_queue_generation += 1;
  s_queue = [];
  s_queue_samples = 0;
  s_queue_bytes = 0;
  s_drain_promise = null;
  s_queue_error = null;
}

async function drainNumericLogQueue(
  generation: number,
  onError: (error: Error) => void,
): Promise<void> {
  try {
    while (generation === s_queue_generation && s_queue.length > 0) {
      const batch = s_queue.shift();
      if (!batch) {
        break;
      }
      await invoke<void>("append_numeric_log", {
        sessionId: batch.sessionId,
        samples: batch.samples,
      });
      if (generation !== s_queue_generation) {
        return;
      }
      s_queue_samples -= batch.samples.length;
      s_queue_bytes -= batch.estimatedBytes;
    }
  } catch (error) {
    if (generation === s_queue_generation) {
      s_queue_error = toError(error);
      s_queue = [];
      s_queue_samples = 0;
      s_queue_bytes = 0;
      onError(s_queue_error);
    }
  } finally {
    if (generation === s_queue_generation) {
      s_drain_promise = null;
    }
  }
}

async function waitForNumericLogSettled(
  initialPayload: NumericLogStatePayload,
): Promise<NumericLogStatePayload> {
  let payload = initialPayload;
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (payload.status === "stopping" && Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, SETTLE_POLL_MS));
    payload = await invoke<NumericLogStatePayload>("get_numeric_log_state");
  }
  return payload;
}

function estimateSampleBytes(sample: NumericLogSample): number {
  return (
    96 +
    UTF8_ENCODER.encode(sample.channelId).length +
    UTF8_ENCODER.encode(sample.channelName).length
  );
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持数值文件记录，请启动 Tauri 桌面应用");
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
