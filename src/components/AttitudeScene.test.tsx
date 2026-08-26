import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AttitudeQuaternion } from "../types/attitude";
import { AttitudeScene } from "./AttitudeScene";

interface RendererDouble {
  setPixelRatio: Mock;
  setSize: Mock;
  render: Mock;
  renderLists: { dispose: Mock };
  dispose: Mock;
}

const rendererDoubles = vi.hoisted(() => ({
  failCreation: false,
  instances: [] as RendererDouble[],
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();

  class WebGLRendererDouble implements RendererDouble {
    outputColorSpace = "";
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    renderLists = { dispose: vi.fn() };
    dispose = vi.fn();

    constructor() {
      if (rendererDoubles.failCreation) {
        throw new Error("WebGL unavailable");
      }
      rendererDoubles.instances.push(this);
    }
  }

  return { ...actual, WebGLRenderer: WebGLRendererDouble };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class OrbitControlsDouble {
    enableDamping = false;
    dampingFactor = 0;
    enablePan = false;
    minDistance = 0;
    maxDistance = 0;
    minPolarAngle = 0;
    maxPolarAngle = 0;
    target = { copy: vi.fn() };
    update = vi.fn();
    dispose = vi.fn();
  },
}));

const IDENTITY_ORIENTATION: AttitudeQuaternion = { w: 1, x: 0, y: 0, z: 0 };

let requestFrame: Mock<(callback: FrameRequestCallback) => number>;
let cancelFrame: Mock<(handle: number) => void>;

describe("AttitudeScene", () => {
  beforeEach(() => {
    rendererDoubles.failCreation = false;
    rendererDoubles.instances.length = 0;
    let nextFrame = 1;
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      void callback;
      return nextFrame++;
    });
    cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("上下文丢失时暂停渲染，并在恢复后只重启一条动画循环", () => {
    const onRendererError = vi.fn<(message: string | null) => void>();
    const view = render(
      <AttitudeScene
        orientation={IDENTITY_ORIENTATION}
        coordinateFrame="enu-flu"
        theme="dark"
        resetToken={0}
        onRendererError={onRendererError}
      />,
    );
    const scene = screen.getByRole("img", { name: "三维姿态视图" });
    const canvas = view.container.querySelector("canvas");
    const renderer = rendererDoubles.instances[0];
    if (!canvas || !renderer) {
      throw new Error("测试未创建姿态画布或 renderer");
    }

    expect(scene).toHaveAttribute("data-renderer", "ready");
    expect(onRendererError).toHaveBeenLastCalledWith(null);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    const staleFrame = frameCallbackAt(0);

    const lostEvent = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(lostEvent);
    });

    expect(lostEvent.defaultPrevented).toBe(true);
    expect(scene).toHaveAttribute("data-renderer", "lost");
    expect(onRendererError).toHaveBeenLastCalledWith(
      "显卡上下文已丢失，正在等待自动恢复",
    );
    expect(cancelFrame).toHaveBeenCalledWith(1);

    act(() => {
      staleFrame(performance.now() + 16);
    });
    expect(renderer.render).not.toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(1);

    act(() => {
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      canvas.dispatchEvent(new Event("webglcontextrestored"));
    });

    expect(scene).toHaveAttribute("data-renderer", "ready");
    expect(onRendererError).toHaveBeenLastCalledWith(null);
    expect(renderer.setSize).toHaveBeenCalledTimes(2);
    expect(requestFrame).toHaveBeenCalledTimes(2);

    act(() => {
      frameCallbackAt(1)(performance.now() + 16);
    });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(requestFrame).toHaveBeenCalledTimes(3);

    const errorCallCount = onRendererError.mock.calls.length;
    view.unmount();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onRendererError).toHaveBeenCalledTimes(errorCallCount);
    expect(cancelFrame).toHaveBeenLastCalledWith(3);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("renderer 创建失败时保持稳定降级状态", () => {
    rendererDoubles.failCreation = true;
    const onRendererError = vi.fn<(message: string | null) => void>();

    render(
      <AttitudeScene
        orientation={IDENTITY_ORIENTATION}
        coordinateFrame="ned-frd"
        theme="light"
        resetToken={0}
        onRendererError={onRendererError}
      />,
    );

    expect(screen.getByRole("img", { name: "三维姿态视图" })).toHaveAttribute(
      "data-renderer",
      "error",
    );
    expect(onRendererError).toHaveBeenCalledWith("当前环境无法创建 WebGL 姿态视图");
    expect(requestFrame).not.toHaveBeenCalled();
  });
});

function frameCallbackAt(index: number): FrameRequestCallback {
  const callback = requestFrame.mock.calls[index]?.[0];
  if (!callback) {
    throw new Error(`缺少第 ${index + 1} 个动画帧回调`);
  }
  return callback;
}
