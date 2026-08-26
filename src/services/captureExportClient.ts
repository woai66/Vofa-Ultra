import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  CaptureExportEventHandlers,
  CaptureExportFormat,
  CaptureExportRequest,
  CaptureExportStatePayload,
} from "../types/captureExport";
import { isTauriRuntime } from "./serialClient";

const FORMAT_OPTIONS: Record<
  CaptureExportFormat,
  { extension: string; filterName: string }
> = {
  csv: { extension: "csv", filterName: "CSV 数据文件" },
  jsonl: { extension: "jsonl", filterName: "JSON Lines 数据文件" },
  binary: { extension: "bin", filterName: "原始二进制文件" },
};

export async function selectCaptureExportSourcePath(): Promise<string | null> {
  requireTauriRuntime();
  const selection = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Vofa-Ultra 捕获文件", extensions: ["vucap"] }],
  });
  return typeof selection === "string" ? selection : null;
}

export async function selectCaptureExportDestinationPath(
  sourcePath: string,
  format: CaptureExportFormat,
): Promise<string | null> {
  requireTauriRuntime();
  const option = FORMAT_OPTIONS[format];
  const selection = await save({
    title: "导出捕获文件",
    defaultPath: buildDefaultDestinationPath(sourcePath, option.extension),
    filters: [{ name: option.filterName, extensions: [option.extension] }],
  });
  return typeof selection === "string" ? selection : null;
}

export async function startCaptureExport(
  request: CaptureExportRequest,
): Promise<CaptureExportStatePayload> {
  requireTauriRuntime();
  return invoke<CaptureExportStatePayload>("start_capture_export", { request });
}

export async function cancelCaptureExport(jobId: number): Promise<CaptureExportStatePayload> {
  requireTauriRuntime();
  return invoke<CaptureExportStatePayload>("cancel_capture_export", { jobId });
}

export async function clearCaptureExport(): Promise<CaptureExportStatePayload> {
  requireTauriRuntime();
  return invoke<CaptureExportStatePayload>("clear_capture_export");
}

export async function getCaptureExportState(): Promise<CaptureExportStatePayload> {
  requireTauriRuntime();
  return invoke<CaptureExportStatePayload>("get_capture_export_state");
}

export async function subscribeToCaptureExportEvents(
  handlers: CaptureExportEventHandlers,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return listen<CaptureExportStatePayload>("capture-export://state", ({ payload }) => {
    handlers.onState(payload);
  });
}

function buildDefaultDestinationPath(sourcePath: string, extension: string): string {
  const separatorIndex = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  const directory = sourcePath.slice(0, separatorIndex + 1);
  const fileName = sourcePath.slice(separatorIndex + 1);
  const stem = fileName.replace(/\.vucap$/i, "") || "capture";
  return `${directory}${stem}.${extension}`;
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持捕获文件导出，请启动 Tauri 桌面应用");
  }
}
