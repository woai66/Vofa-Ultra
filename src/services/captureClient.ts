import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CaptureDirection,
  CaptureEventHandlers,
  CaptureMarkerColor,
  CaptureStartRequest,
  CaptureStatePayload,
} from "../types/capture";
import { isTauriRuntime } from "./serialClient";

const MAX_SIMULATOR_QUEUE_BYTES = 1024 * 1024;
const CAPTURE_SETTLE_POLL_MS = 50;
const CAPTURE_SETTLE_TIMEOUT_MS = 10_000;

interface QueuedRecord {
  kind: "record";
  sessionId: number;
  direction: CaptureDirection;
  data: number[];
  byteSize: number;
}

interface QueuedMarker {
  kind: "marker";
  sessionId: number;
  color: CaptureMarkerColor;
  label: string;
  byteSize: number;
  onRejected: (error: Error) => void;
}

type QueuedCaptureItem = QueuedRecord | QueuedMarker;

let s_simulator_queue: QueuedCaptureItem[] = [];
let s_simulator_queue_bytes = 0;
let s_drain_promise: Promise<void> | null = null;
let s_queue_error: Error | null = null;
let s_queue_generation = 0;

export async function startCapture(
  request: CaptureStartRequest,
): Promise<CaptureStatePayload> {
  requireTauriRuntime();
  resetSimulatorCaptureQueue();
  return invoke<CaptureStatePayload>("start_capture", { request });
}

export async function stopCapture(): Promise<CaptureStatePayload> {
  requireTauriRuntime();
  await flushSimulatorCaptureQueue();
  const payload = await invoke<CaptureStatePayload>("stop_capture");
  return waitForCaptureSettled(payload);
}

export async function abortCapture(message: string): Promise<CaptureStatePayload> {
  requireTauriRuntime();
  resetSimulatorCaptureQueue();
  return invoke<CaptureStatePayload>("abort_capture", { message });
}

export async function getCaptureState(): Promise<CaptureStatePayload> {
  requireTauriRuntime();
  return invoke<CaptureStatePayload>("get_capture_state");
}

export async function subscribeToCaptureEvents(
  handlers: CaptureEventHandlers,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<CaptureStatePayload>("capture://state", ({ payload }) => {
    handlers.onState(payload);
  });
}

export function enqueueSimulatorCapture(
  sessionId: number,
  direction: CaptureDirection,
  bytes: Uint8Array,
  onError: (error: Error) => void,
): boolean {
  if (!isTauriRuntime() || bytes.length === 0 || s_queue_error) {
    return false;
  }
  return enqueueCaptureItem(
    {
      kind: "record",
      sessionId,
      direction,
      data: Array.from(bytes),
      byteSize: bytes.length,
    },
    onError,
  );
}

export function enqueueCaptureMarker(
  sessionId: number,
  color: CaptureMarkerColor,
  label: string,
  onRejected: (error: Error) => void,
  onError: (error: Error) => void,
): boolean {
  if (!isTauriRuntime() || s_queue_error) {
    return false;
  }
  const normalizedLabel = label.trim();
  const byteSize = new TextEncoder().encode(normalizedLabel).length + 16;
  return enqueueCaptureItem(
    {
      kind: "marker",
      sessionId,
      color,
      label: normalizedLabel,
      byteSize,
      onRejected,
    },
    onError,
  );
}

export async function flushSimulatorCaptureQueue(): Promise<void> {
  await s_drain_promise;
  if (s_queue_error) {
    throw s_queue_error;
  }
}

export function resetSimulatorCaptureQueue(): void {
  s_queue_generation += 1;
  s_simulator_queue = [];
  s_simulator_queue_bytes = 0;
  s_drain_promise = null;
  s_queue_error = null;
}

async function drainSimulatorQueue(
  generation: number,
  onError: (error: Error) => void,
): Promise<void> {
  try {
    while (generation === s_queue_generation && s_simulator_queue.length > 0) {
      const chunk = s_simulator_queue.shift();
      if (!chunk) {
        break;
      }
      if (chunk.kind === "record") {
        await invoke<void>("append_simulator_capture", {
          sessionId: chunk.sessionId,
          direction: chunk.direction,
          data: chunk.data,
        });
      } else {
        try {
          await invoke<void>("append_capture_marker", {
            sessionId: chunk.sessionId,
            color: chunk.color,
            label: chunk.label,
          });
        } catch (error) {
          if (generation !== s_queue_generation) {
            return;
          }
          const markerError = toError(error);
          const state = await invoke<CaptureStatePayload>("get_capture_state");
          if (generation !== s_queue_generation) {
            return;
          }
          if (state.sessionId === chunk.sessionId && state.status === "recording") {
            s_simulator_queue_bytes -= chunk.byteSize;
            chunk.onRejected(markerError);
            continue;
          }
          throw markerError;
        }
      }
      if (generation !== s_queue_generation) {
        return;
      }
      s_simulator_queue_bytes -= chunk.byteSize;
    }
  } catch (error) {
    if (generation === s_queue_generation) {
      s_queue_error = toError(error);
      s_simulator_queue = [];
      s_simulator_queue_bytes = 0;
      onError(s_queue_error);
    }
  } finally {
    if (generation === s_queue_generation) {
      s_drain_promise = null;
    }
  }
}

function enqueueCaptureItem(
  item: QueuedCaptureItem,
  onError: (error: Error) => void,
): boolean {
  if (s_simulator_queue_bytes + item.byteSize > MAX_SIMULATOR_QUEUE_BYTES) {
    const error = new Error("录制写入队列已满，录制已中止");
    s_queue_error = error;
    onError(error);
    return false;
  }
  s_simulator_queue.push(item);
  s_simulator_queue_bytes += item.byteSize;
  if (!s_drain_promise) {
    const generation = s_queue_generation;
    s_drain_promise = drainSimulatorQueue(generation, onError);
  }
  return true;
}

async function waitForCaptureSettled(
  initialPayload: CaptureStatePayload,
): Promise<CaptureStatePayload> {
  let payload = initialPayload;
  const deadline = Date.now() + CAPTURE_SETTLE_TIMEOUT_MS;
  while (payload.status === "stopping" && Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, CAPTURE_SETTLE_POLL_MS));
    payload = await invoke<CaptureStatePayload>("get_capture_state");
  }
  return payload;
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持文件录制，请启动 Tauri 桌面应用");
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
