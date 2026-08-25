import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  SerialConfig,
  SerialDataPayload,
  SerialModbusTransactionPayload,
  SerialPortInfo,
  SerialStatePayload,
  SerialTxPayload,
} from "../types/serial";

export interface SerialEventHandlers {
  onData(payload: SerialDataPayload): void;
  onState(payload: SerialStatePayload): void;
  onTx(payload: SerialTxPayload): void;
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
