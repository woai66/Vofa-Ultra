import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  SerialConfig,
  SerialControlLine,
  SerialDataPayload,
  SerialFileSendPayload,
  SerialModbusTransactionPayload,
  SerialPortInfo,
  SerialStatePayload,
  SerialTxPayload,
} from "../types/serial";

export interface SerialEventHandlers {
  onData(payload: SerialDataPayload): void;
  onState(payload: SerialStatePayload): void;
  onTx(payload: SerialTxPayload): void;
  onFileSend(payload: SerialFileSendPayload): void;
  onModbusTransaction(payload: SerialModbusTransactionPayload): void;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  requireTauriRuntime();
  return invoke<SerialPortInfo[]>("list_serial_ports");
}

export async function getSerialState(): Promise<SerialStatePayload> {
  requireTauriRuntime();
  return invoke<SerialStatePayload>("get_serial_state");
}

export async function connectSerial(config: SerialConfig): Promise<SerialStatePayload> {
  requireTauriRuntime();
  return invoke<SerialStatePayload>("connect_serial", { config });
}

export async function cancelSerialConnect(): Promise<SerialStatePayload> {
  requireTauriRuntime();
  return invoke<SerialStatePayload>("cancel_serial_connect");
}

export async function disconnectSerial(): Promise<SerialStatePayload> {
  requireTauriRuntime();
  return invoke<SerialStatePayload>("disconnect_serial");
}

export async function sendSerial(data: Uint8Array): Promise<void> {
  requireTauriRuntime();
  await invoke("send_serial", { data: Array.from(data) });
}

export async function setSerialControlLine(
  generation: number,
  line: SerialControlLine,
  asserted: boolean,
): Promise<void> {
  requireTauriRuntime();
  await invoke("set_serial_control_line", { generation, line, asserted });
}

export async function selectSerialFilePath(): Promise<string | null> {
  requireTauriRuntime();
  const selection = await open({
    title: "选择要发送的原始文件",
    directory: false,
    multiple: false,
  });
  return typeof selection === "string" ? selection : null;
}

export async function getSerialFileSendState(): Promise<SerialFileSendPayload> {
  requireTauriRuntime();
  return invoke<SerialFileSendPayload>("get_serial_file_send_state");
}

export async function startSerialFileSend(path: string): Promise<SerialFileSendPayload> {
  requireTauriRuntime();
  return invoke<SerialFileSendPayload>("start_serial_file_send", { path });
}

export async function cancelSerialFileSend(jobId: number): Promise<boolean> {
  requireTauriRuntime();
  return invoke<boolean>("cancel_serial_file_send", { jobId });
}

export async function startSerialModbusTransaction(
  transactionId: number,
  request: Uint8Array,
  timeoutMs: number,
): Promise<void> {
  requireTauriRuntime();
  await invoke("start_modbus_transaction", {
    transactionId,
    request: Array.from(request),
    timeoutMs,
  });
}

export async function cancelSerialModbusTransaction(transactionId: number): Promise<boolean> {
  requireTauriRuntime();
  return invoke<boolean>("cancel_modbus_transaction", { transactionId });
}

export async function subscribeToSerialEvents(
  handlers: SerialEventHandlers,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const unlisten = await Promise.all([
    listen<SerialDataPayload>("serial://data", ({ payload }) => handlers.onData(payload)),
    listen<SerialStatePayload>("serial://state", ({ payload }) => handlers.onState(payload)),
    listen<SerialTxPayload>("serial://tx", ({ payload }) => handlers.onTx(payload)),
    listen<SerialFileSendPayload>("serial://file-send", ({ payload }) =>
      handlers.onFileSend(payload),
    ),
    listen<SerialModbusTransactionPayload>("serial://modbus-transaction", ({ payload }) =>
      handlers.onModbusTransaction(payload),
    ),
  ]);

  return () => {
    unlisten.forEach((dispose) => dispose());
  };
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持访问本机串口，请使用模拟数据源或启动 Tauri 应用");
  }
}
