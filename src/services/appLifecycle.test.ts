import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAppCloseHandler } from "./appLifecycle";

const {
  destroyMock,
  getCurrentWindowMock,
  onCloseRequestedMock,
  unlistenMock,
} = vi.hoisted(() => ({
  destroyMock: vi.fn(),
  getCurrentWindowMock: vi.fn(),
  onCloseRequestedMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

interface CloseEvent {
  preventDefault(): void;
}

type CloseHandler = (event: CloseEvent) => void | Promise<void>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("appLifecycle", () => {
  let closeHandler: CloseHandler | undefined;

  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    closeHandler = undefined;
    destroyMock.mockReset().mockResolvedValue(undefined);
    getCurrentWindowMock.mockReset().mockReturnValue({
      destroy: destroyMock,
      onCloseRequested: onCloseRequestedMock,
    });
    onCloseRequestedMock.mockReset().mockImplementation(async (handler: CloseHandler) => {
      closeHandler = handler;
      return unlistenMock;
    });
    unlistenMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("浏览器预览不注册窗口关闭监听", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    const unlisten = await installAppCloseHandler(vi.fn());
    unlisten();

    expect(getCurrentWindowMock).not.toHaveBeenCalled();
    expect(onCloseRequestedMock).not.toHaveBeenCalled();
  });

  it("重复关闭请求复用同一次收尾并只销毁一次窗口", async () => {
    const pending = deferred<void>();
    const finalizeWorkbench = vi.fn(() => pending.promise);
    const unlisten = await installAppCloseHandler(finalizeWorkbench);
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    const firstClose = closeHandler!(firstEvent);
    const secondClose = closeHandler!(secondEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(finalizeWorkbench).toHaveBeenCalledOnce();
    expect(destroyMock).not.toHaveBeenCalled();

    pending.resolve(undefined);
    await Promise.all([firstClose, secondClose]);

    expect(destroyMock).toHaveBeenCalledOnce();
    unlisten();
    expect(unlistenMock).toHaveBeenCalledOnce();
  });

  it("收尾失败仍关闭窗口并记录诊断", async () => {
    const error = new Error("flush failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await installAppCloseHandler(() => Promise.reject(error));

    await closeHandler!({ preventDefault: vi.fn() });

    expect(consoleError).toHaveBeenCalledWith(
      "应用关闭收尾失败，将保留未完成文件",
      error,
    );
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("收尾超时后有界关闭窗口", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await installAppCloseHandler(() => new Promise<void>(() => undefined), 100);

    const close = closeHandler!({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    await close;

    expect(consoleError).toHaveBeenCalledWith(
      "应用关闭收尾失败，将保留未完成文件",
      expect.objectContaining({ message: "应用关闭收尾超过 100 ms" }),
    );
    expect(destroyMock).toHaveBeenCalledOnce();
  });
});
