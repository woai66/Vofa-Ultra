import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

class ResizeObserverStub implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;

globalThis.requestAnimationFrame ??= (callback) =>
  window.setTimeout(() => callback(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (requestId) => window.clearTimeout(requestId);

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
