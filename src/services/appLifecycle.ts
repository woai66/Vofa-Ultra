import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./serialClient";

const APP_CLOSE_TIMEOUT_MS = 12_000;

export async function installAppCloseHandler(
  finalizeWorkbench: () => Promise<void>,
  timeoutMs = APP_CLOSE_TIMEOUT_MS,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const appWindow = getCurrentWindow();
  let closeOperation: Promise<void> | null = null;
  return appWindow.onCloseRequested((event) => {
    event.preventDefault();
    if (!closeOperation) {
      closeOperation = finalizeAndDestroyWindow(appWindow, finalizeWorkbench, timeoutMs).finally(
        () => {
          closeOperation = null;
        },
      );
    }
    return closeOperation;
  });
}

async function finalizeAndDestroyWindow(
  appWindow: ReturnType<typeof getCurrentWindow>,
  finalizeWorkbench: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  try {
    await settleWithin(finalizeWorkbench, timeoutMs);
  } catch (error) {
    console.error("应用关闭收尾失败，将保留未完成文件", error);
  }

  try {
    await appWindow.destroy();
  } catch (error) {
    console.error("关闭应用窗口失败", error);
  }
}

async function settleWithin(task: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new Error(`应用关闭收尾超过 ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([task(), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}
