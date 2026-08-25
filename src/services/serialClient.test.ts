import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSerialModbusTransaction,
  startSerialModbusTransaction,
  subscribeToSerialEvents,
} from "./serialClient";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

describe("serialClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("Modbus RTU 事务命令携带前端事务标识、原始帧和超时", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    const request = Uint8Array.from([1, 3, 0, 0, 0, 1, 0x84, 0x0a]);

    await startSerialModbusTransaction(17, request, 1_000);
    await expect(cancelSerialModbusTransaction(17)).resolves.toBe(true);

    expect(invokeMock.mock.calls).toEqual([
      [
        "start_modbus_transaction",
        { transactionId: 17, request: Array.from(request), timeoutMs: 1_000 },
      ],
      ["cancel_modbus_transaction", { transactionId: 17 }],
    ]);
  });

  it("统一订阅串口数据、状态、TX 和 Modbus 事务并完整释放", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const disposers = new Map<string, ReturnType<typeof vi.fn>>();
    listenMock.mockImplementation(
      (event: string, callback: (payload: { payload: unknown }) => void) => {
        const dispose = vi.fn();
        callbacks.set(event, callback);
        disposers.set(event, dispose);
        return Promise.resolve(dispose);
      },
    );
    const handlers = {
      onData: vi.fn(),
      onState: vi.fn(),
      onTx: vi.fn(),
      onModbusTransaction: vi.fn(),
    };

    const dispose = await subscribeToSerialEvents(handlers);
    const modbusPayload = {
      transactionId: 17,
      status: "waiting",
      request: "AQMAAAABhAo=",
      startedAt: 1_000,
      durationMs: 0,
      generation: 3,
      message: "等待响应",
    };
    callbacks.get("serial://modbus-transaction")?.({ payload: modbusPayload });
    dispose();

    expect(handlers.onModbusTransaction).toHaveBeenCalledWith(modbusPayload);
    expect([...disposers.values()].every((unlisten) => unlisten.mock.calls.length === 1)).toBe(
      true,
    );
    expect([...callbacks.keys()]).toEqual([
      "serial://data",
      "serial://state",
      "serial://tx",
      "serial://modbus-transaction",
    ]);
  });
});
