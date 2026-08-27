import { open } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime } from "./serialClient";

export async function selectRecordingDirectoryPath(): Promise<string | null> {
  requireTauriRuntime();
  const selection = await open({
    title: "选择记录目录",
    directory: true,
    multiple: false,
  });
  return typeof selection === "string" ? selection : null;
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error("浏览器预览不支持选择记录目录，请启动 Tauri 桌面应用");
  }
}
