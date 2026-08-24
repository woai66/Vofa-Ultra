import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ExtensionInspectionPayload, ExtensionStatePayload } from "../types/extensions";
import { ExtensionPanel } from "./ExtensionPanel";

const INSPECTION: ExtensionInspectionPayload = {
  format: "vofa-ultra-extension",
  schemaVersion: 1,
  manifest: {
    id: "io.vofa.example-parser",
    version: "1.2.3",
    name: "示例解析器",
    description: "解析设备遥测帧",
    license: "MIT",
    apiVersion: 1,
    kind: "protocol-parser",
    capabilities: ["live-rx.read"],
  },
  packageSha256: "a".repeat(64),
  moduleSha256: "b".repeat(64),
  packageBytes: 2_048,
  moduleBytes: 1_024,
};

function extensionState(status: ExtensionStatePayload["status"]): ExtensionStatePayload {
  return {
    status,
    sessionId: status === "idle" ? 0 : 7,
    generation: status === "idle" ? 0 : 3,
    revision: 1,
    nextSequence: 1,
    manifest: status === "idle" ? undefined : INSPECTION.manifest,
    packageSha256: status === "idle" ? undefined : INSPECTION.packageSha256,
    moduleSha256: status === "idle" ? undefined : INSPECTION.moduleSha256,
    authorizedCapabilities: status === "active" ? ["live-rx.read"] : [],
    processedBytes: status === "active" ? 4_096 : 0,
    emittedFrames: status === "active" ? 12 : 0,
  };
}

describe("ExtensionPanel", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      isNativeRuntime: false,
      connectionStatus: "disconnected",
      replaySessionId: 0,
      extensionInspection: null,
      extensionPackagePath: "",
      extensionAuthorizationRevision: 0,
      extensionState: extensionState("idle"),
      extensionOperation: "idle",
      extensionMessage: "选择 .vux 扩展包后检查",
      extensionChannels: [],
      extensionChannelVisibility: {},
      extensionQueue: {
        active: false,
        inFlight: false,
        queuedBatches: 0,
        queuedBytes: 0,
      },
    });
  });

  afterEach(() => cleanup());

  it("浏览器预览明确禁用协议扩展", () => {
    render(<ExtensionPanel />);

    expect(screen.getByRole("heading", { name: "协议扩展" })).toBeInTheDocument();
    expect(screen.getByText("仅桌面应用支持协议扩展")).toBeVisible();
    expect(screen.queryByRole("button", { name: "选择扩展包" })).not.toBeInTheDocument();
  });

  it("检查通过后要求本次会话显式授权", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      extensionInspection: INSPECTION,
      extensionPackagePath: "C:\\extensions\\parser.vux",
      extensionMessage: "格式与运行时校验通过，等待授权",
    });
    render(<ExtensionPanel />);

    expect(screen.getByRole("region", { name: "扩展清单" })).toHaveTextContent(
      "示例解析器v1.2.3io.vofa.example-parser",
    );
    const consent = screen.getByRole("checkbox", { name: /授权未签名扩展读取实时 RX/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByText("作者身份未验证，仅本次会话有效")).toBeVisible();
    expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();

    await user.click(consent);
    expect(screen.getByRole("button", { name: "启用" })).toBeEnabled();
  });

  it("授权边界变化后清除尚未启用的授权", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      extensionInspection: INSPECTION,
      extensionPackagePath: "C:\\extensions\\parser.vux",
    });
    render(<ExtensionPanel />);

    const consent = screen.getByRole("checkbox", { name: /授权未签名扩展读取实时 RX/ });
    await user.click(consent);
    expect(consent).toBeChecked();

    act(() => {
      useWorkbenchStore.setState({ extensionAuthorizationRevision: 1 });
    });

    expect(consent).not.toBeChecked();
    expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();
  });

  it("运行时显示处理计数、队列和会话控制", () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      connectionStatus: "connected",
      extensionInspection: INSPECTION,
      extensionState: extensionState("active"),
      extensionMessage: "协议扩展已启用",
      extensionQueue: {
        active: true,
        inFlight: true,
        queuedBatches: 2,
        queuedBytes: 128,
      },
    });
    render(<ExtensionPanel />);

    expect(screen.getByRole("region", { name: "扩展运行状态" })).toHaveTextContent(
      "运行中协议扩展已启用",
    );
    expect(screen.getByRole("region", { name: "扩展会话" })).toHaveTextContent(
      "RX 4.0 KiB输出 12队列 2+1",
    );
    expect(screen.getByRole("button", { name: "重置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停用" })).toBeEnabled();
  });
});
