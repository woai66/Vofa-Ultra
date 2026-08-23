import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkbenchStore } from "../store/workbenchStore";
import { Sidebar } from "./Sidebar";

describe("Sidebar 串口恢复界面", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "error",
      statusMessage: "设备已移除",
      ports: [
        {
          name: "COM3",
          kind: "usb",
          product: "Telemetry",
          serialNumber: "DEVICE-001",
          vendorId: 0x1234,
          productId: 0x5678,
        },
      ],
      serialConfig: {
        ...useWorkbenchStore.getState().serialConfig,
        portName: "COM3",
      },
      serialRecovery: {
        enabled: true,
        phase: "waiting",
        attempt: 3,
        maxAttempts: 10,
        nextAttemptAt: Date.now() + 2_000,
        message: "第 4 次重连将在 2 s 后开始",
        diagnosticEventCount: 8,
        diagnosticDroppedEvents: 2,
      },
      isCancellingSerialConnection: false,
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      captureStatus: "idle",
      replayStatus: "idle",
      replaySessionId: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("显示恢复阶段、尝试次数和诊断工具", () => {
    render(
      <Sidebar activePanel="connection" theme="dark" onThemeChange={vi.fn()} />,
    );

    expect(screen.getByRole("checkbox", { name: "自动重连" })).toBeChecked();
    expect(screen.getByRole("region", { name: "串口恢复" })).toHaveTextContent(
      "等待重试第 4 次重连将在 2 s 后开始3/10",
    );
    expect(screen.getByText(/诊断事件/)).toHaveTextContent("诊断事件 8 · 丢弃 2");
    expect(screen.getByRole("button", { name: "导出串口诊断" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "清空串口诊断" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消重连" })).toBeEnabled();
    expect(screen.getByLabelText("串口设备")).toBeDisabled();
  });

  it("手动打开串口时提供可用的取消连接动作", () => {
    useWorkbenchStore.setState({
      connectionStatus: "connecting",
      runtimeTransitionStatus: "connecting",
      serialRecovery: {
        enabled: true,
        phase: "idle",
        attempt: 0,
        maxAttempts: 10,
        message: "正在建立手动连接",
        diagnosticEventCount: 1,
        diagnosticDroppedEvents: 0,
      },
    });

    render(
      <Sidebar activePanel="connection" theme="dark" onThemeChange={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "取消连接" })).toBeEnabled();
  });

  it("取消命令竞速到已连接时保持取消按钮禁用", () => {
    useWorkbenchStore.setState({
      connectionStatus: "connected",
      isCancellingSerialConnection: true,
      serialRecovery: {
        enabled: true,
        phase: "armed",
        attempt: 0,
        maxAttempts: 10,
        message: "自动重连已待命",
        diagnosticEventCount: 2,
        diagnosticDroppedEvents: 0,
      },
    });

    render(
      <Sidebar activePanel="connection" theme="dark" onThemeChange={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "正在取消" })).toBeDisabled();
  });
});
