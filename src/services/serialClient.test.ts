import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSerialFileSend,
  cancelSerialModbusTransaction,
  getSerialFileSendState,
  getSerialModemStatus,
  selectSerialFilePath,
  sendSerial,
  setSerialControlLine,
  startSerialFileSend,
  startSerialModbusTransaction,
  subscribeToSerialEvents,
} from "./serialClient";

const { invokeMock, listenMock, openDialogMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  openDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));

describe("serialClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    openDialogMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("选择文件后通过独立命令启动、查询和取消文件发送", async () => {
    const snapshot = {
      jobId: 21,
      revision: 4,
      generation: 3,
      status: "queued",
      fileName: "firmware.bin",
      totalBytes: 4_096,
      transmittedBytes: 0,
      message: "等待发送",
    };
    openDialogMock.mockResolvedValue("C:\\firmware\\firmware.bin");
    invokeMock
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(true);

    await expect(selectSerialFilePath()).resolves.toBe("C:\\firmware\\firmware.bin");
    await expect(startSerialFileSend("C:\\firmware\\firmware.bin")).resolves.toEqual(snapshot);
    await expect(getSerialFileSendState()).resolves.toEqual(snapshot);
    await expect(cancelSerialFileSend(21)).resolves.toBe(true);

    expect(openDialogMock).toHaveBeenCalledWith({
      title: "选择要发送的原始文件",
      directory: false,
      multiple: false,
    });
    expect(invokeMock.mock.calls).toEqual([
      ["start_serial_file_send", { path: "C:\\firmware\\firmware.bin" }],
      ["get_serial_file_send_state"],
      ["cancel_serial_file_send", { jobId: 21 }],
    ]);
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

  it("控制线命令携带连接代次且等待后端完成", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    await setSerialControlLine(7, "dtr", false);
    await setSerialControlLine(7, "rts", true);

    expect(invokeMock.mock.calls).toEqual([
      ["set_serial_control_line", { generation: 7, line: "dtr", asserted: false }],
      ["set_serial_control_line", { generation: 7, line: "rts", asserted: true }],
    ]);
  });

  it("发送命令把字节和可选文本编码传给 Tauri", async () => {
    invokeMock.mockResolvedValue(undefined);
    const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);

    await sendSerial(bytes, "gb18030");
    await sendSerial(Uint8Array.from([0xaa]));

    expect(invokeMock.mock.calls).toEqual([
      ["send_serial", { data: [0xd6, 0xd0, 0xce, 0xc4], textEncoding: "gb18030" }],
      ["send_serial", { data: [0xaa], textEncoding: undefined }],
    ]);
  });

  it("通过独立命令查询输入握手线快照", async () => {
    const snapshot = {
      generation: 7,
      revision: 3,
      cts: true,
      dsr: false,
      ri: null,
      dcd: true,
    };
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(getSerialModemStatus()).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("get_serial_modem_status");
  });

  it("统一订阅六路串口事件并完整释放", async () => {
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
      onModemStatus: vi.fn(),
      onTx: vi.fn(),
      onFileSend: vi.fn(),
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
    const fileSendPayload = {
      jobId: 21,
      revision: 5,
      generation: 3,
      status: "sending",
      fileName: "firmware.bin",
      totalBytes: 4_096,
      transmittedBytes: 2_048,
      message: "正在发送",
    };
    callbacks.get("serial://file-send")?.({ payload: fileSendPayload });
    const modemPayload = {
      generation: 3,
      revision: 2,
      cts: true,
      dsr: false,
      ri: null,
      dcd: true,
    };
    callbacks.get("serial://modem-status")?.({ payload: modemPayload });
    dispose();

    expect(handlers.onModbusTransaction).toHaveBeenCalledWith(modbusPayload);
    expect(handlers.onFileSend).toHaveBeenCalledWith(fileSendPayload);
    expect(handlers.onModemStatus).toHaveBeenCalledWith(modemPayload);
    expect([...disposers.values()].every((unlisten) => unlisten.mock.calls.length === 1)).toBe(
      true,
    );
    expect([...callbacks.keys()]).toEqual([
      "serial://data",
      "serial://state",
      "serial://tx",
      "serial://modem-status",
      "serial://file-send",
      "serial://modbus-transaction",
    ]);
  });

  it("核心事件注册失败时释放其他核心监听且不启动可选监听", async () => {
    const registrationError = new Error("状态监听注册失败");
    const disposers: ReturnType<typeof vi.fn>[] = [];
    listenMock.mockImplementation((event: string) => {
      if (event === "serial://state") {
        return Promise.reject(registrationError);
      }
      const dispose = vi.fn();
      disposers.push(dispose);
      return Promise.resolve(dispose);
    });
    const handlers = {
      onData: vi.fn(),
      onState: vi.fn(),
      onModemStatus: vi.fn(),
      onTx: vi.fn(),
      onFileSend: vi.fn(),
      onModbusTransaction: vi.fn(),
    };

    await expect(subscribeToSerialEvents(handlers)).rejects.toBe(registrationError);
    expect(disposers).toHaveLength(2);
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("可选事件注册失败时保留核心监听并完整释放其余监听", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const disposers: ReturnType<typeof vi.fn>[] = [];
    listenMock.mockImplementation((event: string) => {
      if (event === "serial://modem-status") {
        return Promise.reject(new Error("调制解调器状态监听不可用"));
      }
      const dispose = vi.fn();
      disposers.push(dispose);
      return Promise.resolve(dispose);
    });
    const handlers = {
      onData: vi.fn(),
      onState: vi.fn(),
      onModemStatus: vi.fn(),
      onTx: vi.fn(),
      onFileSend: vi.fn(),
      onModbusTransaction: vi.fn(),
    };

    const dispose = await subscribeToSerialEvents(handlers);

    expect(disposers).toHaveLength(5);
    expect(disposers.every((unlisten) => unlisten.mock.calls.length === 0)).toBe(true);
    expect(warning).toHaveBeenCalledWith("有 1 路可选串口事件监听不可用");
    dispose();
    expect(disposers.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
    warning.mockRestore();
  });
});
