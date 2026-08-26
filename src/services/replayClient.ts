import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ReplayBatchPayload,
  ReplayEventHandlers,
  ReplayMarkersPayload,
  ReplaySpeed,
  ReplayStatePayload,
} from "../types/replay";
import { isTauriRuntime } from "./serialClient";

export async function selectReplayFilePath(): Promise<string | null> {
  requireTauriRuntime();
  const selection = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Vofa-Ultra 捕获文件", extensions: ["vucap"] }],
  });
  return typeof selection === "string" ? selection : null;
}

export async function openReplay(path: string): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("open_replay", { path });
}

export async function playReplay(
  sessionId: number,
  generation: number,
): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("play_replay", { sessionId, generation });
}

export async function pauseReplay(
  sessionId: number,
  generation: number,
): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("pause_replay", { sessionId, generation });
}

export async function stopReplay(
  sessionId: number,
  generation: number,
): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("stop_replay", { sessionId, generation });
}

export async function seekReplay(
  sessionId: number,
  generation: number,
  targetUs: number,
): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("seek_replay", { sessionId, generation, targetUs });
}

export async function setReplaySpeed(
  sessionId: number,
  generation: number,
  speed: ReplaySpeed,
): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("set_replay_speed", { sessionId, generation, speed });
}

export async function closeReplay(sessionId: number): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("close_replay", { sessionId });
}

export async function ackReplayBatch(
  sessionId: number,
  generation: number,
  sequence: number,
): Promise<void> {
  requireTauriRuntime();
  await invoke("ack_replay_batch", { sessionId, generation, sequence });
}

export async function getReplayState(): Promise<ReplayStatePayload> {
  requireTauriRuntime();
  return invoke<ReplayStatePayload>("get_replay_state");
}

export async function getReplayMarkers(sessionId: number): Promise<ReplayMarkersPayload> {
  requireTauriRuntime();
  return invoke<ReplayMarkersPayload>("get_replay_markers", { sessionId });
}

export async function subscribeToReplayEvents(
  handlers: ReplayEventHandlers,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const unlisten = await Promise.all([
    listen<ReplayStatePayload>("replay://state", ({ payload }) => handlers.onState(payload)),
    listen<ReplayBatchPayload>("replay://batch", ({ payload }) => handlers.onBatch(payload)),
    listen<ReplayMarkersPayload>("replay://markers", ({ payload }) =>
      handlers.onMarkers(payload),
    ),
  ]);
  return () => unlisten.forEach((dispose) => dispose());
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持捕获文件回放，请启动 Tauri 桌面应用");
  }
}
