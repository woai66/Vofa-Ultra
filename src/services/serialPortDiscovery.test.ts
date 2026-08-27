import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToSerialPortDiscoveryRefresh } from "./serialPortDiscovery";

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

afterEach(() => {
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

describe("serialPortDiscovery", () => {
  it("合并同一轮聚焦和可见事件，隐藏时不刷新并支持卸载", async () => {
    const refresh = vi.fn();
    const dispose = subscribeToSerialPortDiscoveryRefresh(refresh);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    window.dispatchEvent(new Event("focus"));
    dispose();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
