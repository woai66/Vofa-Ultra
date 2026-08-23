import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortCapture,
  enqueueSimulatorCapture,
  flushSimulatorCaptureQueue,
  resetSimulatorCaptureQueue,
  startCapture,
  stopCapture,
} from "./captureClient";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

describe("captureClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    resetSimulatorCaptureQueue();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("开始录制时传递结构化元数据", async () => {
    const payload = {
      status: "recording" as const,
      sessionId: 1,
      revision: 1,
      path: "capture.vucap",
      dataBytes: 0,
      recordCount: 0,
    };
    invokeMock.mockResolvedValue(payload);
    const request = {
      source: "serial" as const,
      protocol: "firewater" as const,
      serialConfig: {
        portName: "COM3",
        baudRate: 115_200,
        dataBits: 8 as const,
        parity: "none" as const,
        stopBits: 1 as const,
        flowControl: "none" as const,
        dtr: true,
        rts: true,
      },
    };

    await expect(startCapture(request)).resolves.toEqual(payload);
    expect(invokeMock).toHaveBeenCalledWith("start_capture", { request });
  });

  it("模拟器写入按顺序串行提交", async () => {
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

    expect(enqueueSimulatorCapture(7, "rx", new Uint8Array([1, 2]), onError)).toBe(true);
    expect(enqueueSimulatorCapture(7, "tx", new Uint8Array([3]), onError)).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await flushSimulatorCaptureQueue();

    expect(invokeMock.mock.calls).toEqual([
      ["append_simulator_capture", { sessionId: 7, direction: "rx", data: [1, 2] }],
      ["append_simulator_capture", { sessionId: 7, direction: "tx", data: [3] }],
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("模拟器队列超过字节上限时明确中止", async () => {
    let resolveWrite: (() => void) | undefined;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const onError = vi.fn();

    expect(
      enqueueSimulatorCapture(1, "rx", new Uint8Array(1024 * 1024), onError),
    ).toBe(true);
    expect(enqueueSimulatorCapture(1, "rx", new Uint8Array([1]), onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/队列已满/) }),
    );

    invokeMock.mockResolvedValueOnce({
      status: "error",
      sessionId: 1,
      revision: 2,
      path: "capture.vucap",
      dataBytes: 0,
      recordCount: 0,
    });
    const abortPromise = abortCapture("队列已满");
    resolveWrite?.();
    await abortPromise;
  });

  it("队列重置后已发出的写入仍携带旧会话标识", async () => {
    let resolveOldWrite: (() => void) | undefined;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOldWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();

    expect(enqueueSimulatorCapture(3, "rx", new Uint8Array([1]), onError)).toBe(true);
    resetSimulatorCaptureQueue();
    expect(enqueueSimulatorCapture(4, "rx", new Uint8Array([2]), onError)).toBe(true);
    await flushSimulatorCaptureQueue();

    expect(invokeMock.mock.calls).toEqual([
      ["append_simulator_capture", { sessionId: 3, direction: "rx", data: [1] }],
      ["append_simulator_capture", { sessionId: 4, direction: "rx", data: [2] }],
    ]);
    resolveOldWrite?.();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it("停止录制时等待后台 writer 完成", async () => {
    invokeMock
      .mockResolvedValueOnce({
        status: "stopping",
        sessionId: 5,
        revision: 8,
        path: "capture.vucap",
        dataBytes: 4,
        recordCount: 1,
      })
      .mockResolvedValueOnce({
        status: "idle",
        sessionId: 5,
        revision: 9,
        path: "capture.vucap",
        endedAtUnixMs: 2_000,
        dataBytes: 4,
        recordCount: 1,
      });

    await expect(stopCapture()).resolves.toMatchObject({ status: "idle", revision: 9 });
    expect(invokeMock.mock.calls).toEqual([
      ["stop_capture"],
      ["get_capture_state"],
    ]);
  });
});
