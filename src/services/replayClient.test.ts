import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackReplayBatch,
  closeReplay,
  openReplay,
  pauseReplay,
  playReplay,
  selectReplayFilePath,
  seekReplay,
  setReplaySpeed,
  stopReplay,
  subscribeToReplayEvents,
} from "./replayClient";

const { invokeMock, listenMock, openDialogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  openDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));

describe("replayClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    openDialogMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("仅通过原生对话框选择 vucap 文件", async () => {
    openDialogMock.mockResolvedValue("C:\\captures\\session.vucap");

    await expect(selectReplayFilePath()).resolves.toBe("C:\\captures\\session.vucap");
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [{ name: "Vofa-Ultra 捕获文件", extensions: ["vucap"] }],
    });

    openDialogMock.mockResolvedValue(null);
    await expect(selectReplayFilePath()).resolves.toBeNull();
  });

  it("回放控制始终携带会话和代次标识", async () => {
    invokeMock.mockResolvedValue({ status: "ready" });

    await openReplay("C:\\captures\\session.vucap");
    await playReplay(7, 2);
    await pauseReplay(7, 3);
    await seekReplay(7, 4, 25_000);
    await setReplaySpeed(7, 4, 2);
    await stopReplay(7, 3);
    await ackReplayBatch(7, 3, 4);
    await closeReplay(7);

    expect(invokeMock.mock.calls).toEqual([
      ["open_replay", { path: "C:\\captures\\session.vucap" }],
      ["play_replay", { sessionId: 7, generation: 2 }],
      ["pause_replay", { sessionId: 7, generation: 3 }],
      ["seek_replay", { sessionId: 7, generation: 4, targetUs: 25_000 }],
      ["set_replay_speed", { sessionId: 7, generation: 4, speed: 2 }],
      ["stop_replay", { sessionId: 7, generation: 3 }],
      ["ack_replay_batch", { sessionId: 7, generation: 3, sequence: 4 }],
      ["close_replay", { sessionId: 7 }],
    ]);
  });

  it("订阅状态和批次事件并统一释放监听", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const disposeState = vi.fn();
    const disposeBatch = vi.fn();
    listenMock.mockImplementation(
      (event: string, callback: (payload: { payload: unknown }) => void) => {
        callbacks.set(event, callback);
        return Promise.resolve(event === "replay://state" ? disposeState : disposeBatch);
      },
    );
    const onState = vi.fn();
    const onBatch = vi.fn();

    const dispose = await subscribeToReplayEvents({ onState, onBatch });
    const statePayload = { status: "ready", sessionId: 7 };
    const batchPayload = { sessionId: 7, generation: 1, sequence: 1 };
    callbacks.get("replay://state")?.({ payload: statePayload });
    callbacks.get("replay://batch")?.({ payload: batchPayload });
    dispose();

    expect(onState).toHaveBeenCalledWith(statePayload);
    expect(onBatch).toHaveBeenCalledWith(batchPayload);
    expect(disposeState).toHaveBeenCalledOnce();
    expect(disposeBatch).toHaveBeenCalledOnce();
  });
});
