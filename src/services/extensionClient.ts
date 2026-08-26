import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ExtensionBatchPayload,
  ExtensionInspectionPayload,
  ExtensionStatePayload,
} from "../types/extensions";
import { isTauriRuntime } from "./serialClient";

export async function selectExtensionPackagePath(): Promise<string | null> {
  requireTauriRuntime();
  const selection = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Vofa-Ultra 扩展包", extensions: ["vux"] }],
  });
  return typeof selection === "string" ? selection : null;
}

export async function inspectExtension(path: string): Promise<ExtensionInspectionPayload> {
  requireTauriRuntime();
  return invoke<ExtensionInspectionPayload>("inspect_extension", { path });
}

export async function activateExtension(
  path: string,
  expectedPackageSha256: string,
  authorizedCapabilities: readonly string[],
): Promise<ExtensionStatePayload> {
  requireTauriRuntime();
  return invoke<ExtensionStatePayload>("activate_extension", {
    path,
    expectedPackageSha256,
    authorizedCapabilities: [...authorizedCapabilities],
  });
}

export async function getExtensionState(): Promise<ExtensionStatePayload> {
  requireTauriRuntime();
  return invoke<ExtensionStatePayload>("get_extension_state");
}

export async function deactivateExtension(sessionId: number): Promise<ExtensionStatePayload> {
  requireTauriRuntime();
  return invoke<ExtensionStatePayload>("deactivate_extension", { sessionId });
}

export async function resetExtension(
  sessionId: number,
  generation: number,
): Promise<ExtensionStatePayload> {
  requireTauriRuntime();
  return invoke<ExtensionStatePayload>("reset_extension", { sessionId, generation });
}

export async function pushExtensionBatch(
  sessionId: number,
  generation: number,
  sequence: number,
  receivedAt: number,
  data: Uint8Array,
): Promise<ExtensionBatchPayload> {
  requireTauriRuntime();
  return invoke<ExtensionBatchPayload>("push_extension_batch", {
    sessionId,
    generation,
    sequence,
    receivedAt,
    data: Array.from(data),
  });
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持协议扩展，请启动 Tauri 桌面应用");
  }
}
