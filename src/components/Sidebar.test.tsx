import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProtocolHealth } from "../core/protocols";
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

  it("提供侧栏关闭动作", () => {
    const onClose = vi.fn();
    render(
      <Sidebar
        activePanel="connection"
        theme="dark"
        onClose={onClose}
        onThemeChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("显示恢复阶段、尝试次数和诊断工具", () => {
    render(
      <Sidebar
        activePanel="connection"
        theme="dark"
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
      />,
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
      <Sidebar
        activePanel="connection"
        theme="dark"
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
      />,
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
      <Sidebar
        activePanel="connection"
        theme="dark"
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "正在取消" })).toBeDisabled();
  });
});

describe("Sidebar 协议解析健康度", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      protocol: "firewater",
      replayStatus: "idle",
      replaySessionId: 0,
      replayHeader: undefined,
      protocolHealth: createEmptyProtocolHealth(),
      replayProtocolHealth: createEmptyProtocolHealth(),
      channels: [],
      processedChannels: [],
      workspaceTransitionStatus: "idle",
    });
    useWorkbenchStore.getState().setProtocol("firewater");
  });

  afterEach(() => {
    cleanup();
  });

  it("区分等待、健康与丢帧状态并提供可操作原因", () => {
    const props = {
      activePanel: "channels" as const,
      theme: "dark" as const,
      onClose: vi.fn(),
      onThemeChange: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...props} />);

    const health = screen.getByRole("region", { name: "协议解析健康度" });
    expect(health).toHaveTextContent("等待完整帧成功 0丢弃 0重同步 0");
    expect(screen.getByRole("button", { name: "清空解析统计" })).toBeDisabled();

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("1,2\n"), 1_000);
    rerender(<Sidebar {...props} />);
    expect(health).toHaveTextContent("解析正常成功 1丢弃 0重同步 0");

    useWorkbenchStore.getState().ingestBytes(new TextEncoder().encode("broken\n"), 1_100);
    rerender(<Sidebar {...props} />);
    expect(health).toHaveTextContent("已丢弃 1 帧");
    expect(health).toHaveTextContent("最近：包含非有限数值");
    expect(health).toHaveTextContent("FireWater：每行 1–16 个有限数值，命名字段使用 : 或 =");
    expect(screen.getByRole("button", { name: "清空解析统计" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "清空解析统计" }));
    expect(health).toHaveTextContent("等待完整帧成功 0丢弃 0重同步 0");
  });

  it("Raw Data 显示不适用", () => {
    useWorkbenchStore.getState().setProtocol("raw");
    render(
      <Sidebar
        activePanel="channels"
        theme="dark"
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "协议解析健康度" })).toHaveTextContent(
      "不适用Raw Data 不执行结构化解析",
    );
    expect(screen.getByRole("button", { name: "清空解析统计" })).toBeDisabled();
  });

  it("回放会话显示独立的回放诊断", () => {
    useWorkbenchStore.setState({
      protocolHealth: {
        ...createEmptyProtocolHealth(),
        acceptedFrames: 8,
      },
      replayProtocolHealth: {
        ...createEmptyProtocolHealth(),
        droppedFrames: 2,
        reasonCounts: {
          ...createEmptyProtocolHealth().reasonCounts,
          "misaligned-length": 2,
        },
        lastDropReason: "misaligned-length",
        lastDropAt: 1_000,
      },
      replayStatus: "paused",
      replaySessionId: 7,
      replayHeader: {
        source: "simulator",
        protocol: "justfloat",
        serialConfig: useWorkbenchStore.getState().serialConfig,
        startedAtUnixMs: 1_000,
        timeUnit: "microseconds",
      },
    });

    render(
      <Sidebar
        activePanel="channels"
        theme="dark"
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
      />,
    );

    const health = screen.getByRole("region", { name: "协议解析健康度" });
    expect(health).toHaveTextContent("已丢弃 2 帧");
    expect(health).toHaveTextContent("浮点帧长度未按 4 字节对齐");
    expect(health).toHaveTextContent("JustFloat：1–16 个小端 float32");
  });
});
