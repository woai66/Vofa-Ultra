import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DISPLAY_VERSION } from "../core/appMetadata";
import { createInitialModbusPollSnapshot } from "../core/modbusPoller";
import { createEmptyProtocolHealth } from "../core/protocols";
import { useWorkbenchStore } from "../store/workbenchStore";
import { Sidebar } from "./Sidebar";

const originalRefreshPorts = useWorkbenchStore.getState().refreshPorts;
const originalSetSerialControlLine = useWorkbenchStore.getState().setSerialControlLine;

describe("Sidebar 串口恢复界面", () => {
  beforeEach(() => {
    useWorkbenchStore.getState().stopModbusPolling();
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "error",
      serialRuntimeError: "",
      isRefreshingPorts: false,
      serialPortDiscoveryStatus: "idle",
      serialPortDiscoveryMessage: "",
      connectionMessage: "设备已移除",
      statusMessage: "设备已移除",
      ports: [
        {
          name: "COM3",
          kind: "usb",
          manufacturer: "Acme Devices",
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
      simulatorConfig: {
        signal: "sine",
        channelCount: 3,
        sampleRate: 25,
      },
      serialControlLineOperation: "idle",
      serialModemStatus: {
        generation: 0,
        revision: 0,
        cts: null,
        dsr: null,
        ri: null,
        dcd: null,
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
      modbusPoll: createInitialModbusPollSnapshot(),
    });
  });

  afterEach(() => {
    useWorkbenchStore.getState().stopModbusPolling();
    cleanup();
    useWorkbenchStore.setState({
      refreshPorts: originalRefreshPorts,
      setSerialControlLine: originalSetSerialControlLine,
    });
  });

  it("提供侧栏关闭动作", () => {
    const onClose = vi.fn();
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={onClose}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("未连接时显示连接摘要而不复用其他模块的瞬时消息", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      connectionMessage: "COM3 已就绪",
      statusMessage: "回放已关闭",
      serialRuntimeError: "",
      refreshPorts: vi.fn().mockResolvedValue(undefined),
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const connection_status = screen.getByRole("status");
    expect(connection_status).toHaveTextContent("COM3 已就绪");
    expect(connection_status).not.toHaveTextContent("回放已关闭");
  });

  it("区分串口扫描中、未发现设备和扫描失败", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      isRefreshingPorts: true,
      connectionMessage: "等待连接",
      serialPortDiscoveryStatus: "idle",
      serialPortDiscoveryMessage: "",
      ports: [],
      serialConfig: { ...state.serialConfig, portName: "" },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    const props = {
      activePanel: "connection" as const,
      themePreference: "dark" as const,
      onClose: vi.fn(),
      onThemePreferenceChange: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...props} />);

    expect(screen.getByLabelText("串口设备")).toHaveDisplayValue("正在扫描设备");
    expect(screen.getByLabelText("串口设备")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "刷新串口列表" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在扫描串口设备");
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "connecting");
    expect(screen.getByRole("button", { name: "连接设备" })).toHaveAttribute(
      "title",
      "正在扫描串口设备",
    );

    useWorkbenchStore.setState({
      isRefreshingPorts: false,
      serialPortDiscoveryStatus: "empty",
      serialPortDiscoveryMessage: "未发现串口设备",
    });
    rerender(<Sidebar {...props} />);
    expect(screen.getByLabelText("串口设备")).toHaveDisplayValue("未发现设备");
    expect(screen.getByRole("status")).toHaveTextContent("未发现串口设备");
    expect(screen.getByRole("button", { name: "连接设备" })).toHaveAttribute(
      "title",
      "未发现串口设备，请连接设备后刷新",
    );

    useWorkbenchStore.setState({
      serialPortDiscoveryStatus: "error",
      serialPortDiscoveryMessage: "扫描串口失败：串口驱动不可用",
    });
    rerender(<Sidebar {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "扫描串口失败：串口驱动不可用",
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "error");
    expect(screen.getByRole("button", { name: "连接设备" })).toHaveAttribute(
      "title",
      "扫描串口失败：串口驱动不可用",
    );
    expect(screen.getByRole("button", { name: "连接设备" })).toHaveAttribute(
      "aria-describedby",
      "serial-connect-action-hint",
    );
    expect(screen.getByRole("button", { name: "连接设备" })).toHaveAccessibleDescription(
      "扫描串口失败：串口驱动不可用",
    );
  });

  it("连接错误后主动扫描时优先显示本次扫描进度和结果", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "error",
      connectionMessage: "COM3 打开失败：拒绝访问",
      isRefreshingPorts: true,
      serialPortDiscoveryStatus: "idle",
      serialPortDiscoveryMessage: "",
      ports: [],
      serialConfig: { ...state.serialConfig, portName: "" },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    const props = {
      activePanel: "connection" as const,
      themePreference: "dark" as const,
      onClose: vi.fn(),
      onThemePreferenceChange: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...props} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在扫描串口设备");
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "connecting");

    useWorkbenchStore.setState({
      isRefreshingPorts: false,
      serialPortDiscoveryStatus: "ready",
      serialPortDiscoveryMessage: "发现 1 个串口设备",
    });
    rerender(<Sidebar {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("发现 1 个串口设备");
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "disconnected");
  });

  it("已连接端口暂时不在枚举列表时标记为当前连接", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "connected",
      connectionMessage: "COM3 已连接",
      ports: [],
      serialConfig: { ...state.serialConfig, portName: "COM3" },
      serialRecovery: { ...state.serialRecovery, phase: "armed" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("串口设备")).toHaveDisplayValue("COM3 · 当前连接");
    expect(screen.getByRole("status")).toHaveTextContent("COM3 已连接");
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "connected");
  });

  it("为串口配置字段提供稳定表单标识", () => {
    const { container } = render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const fields = [...container.querySelectorAll("input, select")];
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => Boolean(field.id && field.getAttribute("name")))).toBe(true);
  });

  it("为模拟器配置字段提供稳定表单标识", () => {
    useWorkbenchStore.setState({ source: "simulator", connectionStatus: "disconnected" });
    const { container } = render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const fields = [...container.querySelectorAll("input, select")];
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => Boolean(field.id && field.getAttribute("name")))).toBe(true);
  });

  it("Modbus 轮询期间禁用串口控制线", () => {
    useWorkbenchStore.setState({
      connectionStatus: "connected",
      serialRecovery: {
        ...useWorkbenchStore.getState().serialRecovery,
        phase: "idle",
      },
      modbusPoll: {
        ...createInitialModbusPollSnapshot(),
        status: "running",
        request: {
          operation: "read-input-registers",
          unitId: 1,
          address: 0,
          quantity: 1,
        },
      },
    });

    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "DTR" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "RTS" })).toBeDisabled();
  });

  it("显示恢复阶段、尝试次数和诊断工具", () => {
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
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
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
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
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "正在取消" })).toBeDisabled();
  });

  it("显示 USB 摘要但不显示完整序列号", () => {
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const summary = screen.getByRole("group", { name: /已选端口信息/ });
    expect(summary).toHaveTextContent("Telemetry");
    expect(summary).toHaveTextContent("Acme Devices");
    expect(summary).toHaveTextContent("USB");
    expect(summary).toHaveTextContent("1234:5678");
    expect(summary).not.toHaveTextContent("唯一身份");
    expect(summary).toHaveAccessibleName(/支持唯一设备识别/);
    expect(summary).not.toHaveTextContent("DEVICE-001");
  });

  it("向辅助技术暴露当前数据源选项", () => {
    const { rerender } = render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "串口" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "模拟器" })).toHaveAttribute("aria-pressed", "false");

    useWorkbenchStore.setState({ source: "simulator" });
    rerender(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "串口" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "模拟器" })).toHaveAttribute("aria-pressed", "true");
  });

  it("配置十类模拟信号、通道数和固定采样率，并在连接后锁定", () => {
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "disconnected",
      serialRecovery: {
        ...useWorkbenchStore.getState().serialRecovery,
        phase: "off",
      },
    });
    const { rerender } = render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const signal = screen.getByLabelText("信号类型") as HTMLSelectElement;
    expect(Array.from(signal.options, (option) => option.textContent)).toEqual([
      "正弦波",
      "方波",
      "三角波",
      "锯齿波",
      "直流",
      "阶跃",
      "扫频",
      "多音",
      "均匀随机",
      "白噪声",
    ]);
    fireEvent.change(signal, { target: { value: "white-noise" } });
    fireEvent.change(screen.getByLabelText("模拟器通道数"), {
      target: { value: "16" },
    });
    fireEvent.change(screen.getByLabelText("模拟器采样率"), {
      target: { value: "200" },
    });

    expect(useWorkbenchStore.getState().simulatorConfig).toEqual({
      signal: "white-noise",
      channelCount: 16,
      sampleRate: 200,
    });

    useWorkbenchStore.setState({ connectionStatus: "connected" });
    rerender(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("信号类型")).toBeDisabled();
    expect(screen.getByLabelText("模拟器通道数")).toBeDisabled();
    expect(screen.getByLabelText("模拟器采样率")).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止模拟" })).toBeEnabled();
  });

  it("端口选项按名称自然排序并包含设备摘要", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "connected",
      ports: [
        { name: "COM10", kind: "usb", product: "Adapter B" },
        { name: "COM2", kind: "usb", product: "Adapter A" },
      ],
      serialConfig: { ...state.serialConfig, portName: "COM2" },
      serialRecovery: {
        ...state.serialRecovery,
        phase: "armed",
      },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const select = screen.getByLabelText("串口设备") as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      "COM2 · Adapter A",
      "COM10 · Adapter B",
    ]);
  });

  it("仅在选中可用串口时启用连接动作", () => {
    const refreshPorts = vi.fn().mockResolvedValue(undefined);
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      ports: [{ name: "COM4", kind: "usb", product: "Available Adapter" }],
      serialConfig: { ...state.serialConfig, portName: "COM3" },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
      refreshPorts,
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const connectButton = screen.getByRole("button", { name: "连接设备" });
    expect(connectButton).toBeDisabled();
    expect(connectButton).toHaveAttribute(
      "title",
      "COM3 当前不可用，请刷新或选择其他串口",
    );
    expect(screen.getByRole("status")).toHaveTextContent("COM3 当前不可用");

    fireEvent.change(screen.getByLabelText("串口设备"), { target: { value: "COM4" } });
    expect(connectButton).toBeEnabled();
    expect(connectButton).not.toHaveAttribute("title");
  });

  it("已有波特率时仍提供全部常用选项并立即应用选择", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      serialConfig: { ...state.serialConfig, baudRate: 115_200 },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const baud_rate = screen.getByRole("combobox", { name: "波特率" });
    expect(baud_rate).toHaveValue("115200");
    fireEvent.click(screen.getByRole("button", { name: "展开常用波特率" }));
    const baud_rate_presets = screen.getByRole("listbox", { name: "常用波特率" });
    expect(within(baud_rate_presets).getByRole("option", { name: "9600" })).toBeInTheDocument();
    expect(within(baud_rate_presets).getAllByRole("option")).toHaveLength(13);

    fireEvent.click(within(baud_rate_presets).getByRole("option", { name: "9600" }));
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(9_600);
    expect(baud_rate).toHaveValue("9600");
  });

  it("用方向键浏览常用波特率并用回车选择或 Escape 关闭", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      serialConfig: { ...state.serialConfig, baudRate: 115_200 },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const baud_rate = screen.getByRole("combobox", { name: "波特率" });
    fireEvent.keyDown(baud_rate, { key: "ArrowDown" });
    expect(baud_rate).toHaveAttribute(
      "aria-activedescendant",
      "baud-rate-option-230400",
    );
    fireEvent.keyDown(baud_rate, { key: "ArrowDown" });
    expect(baud_rate).toHaveAttribute(
      "aria-activedescendant",
      "baud-rate-option-460800",
    );
    fireEvent.keyDown(baud_rate, { key: "ArrowUp" });
    expect(baud_rate).toHaveAttribute(
      "aria-activedescendant",
      "baud-rate-option-230400",
    );
    fireEvent.keyDown(baud_rate, { key: "Enter" });
    expect(baud_rate).toHaveValue("230400");
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(230_400);
    expect(screen.queryByRole("listbox", { name: "常用波特率" })).not.toBeInTheDocument();

    fireEvent.keyDown(baud_rate, { key: "ArrowUp" });
    expect(screen.getByRole("listbox", { name: "常用波特率" })).toBeInTheDocument();
    fireEvent.keyDown(baud_rate, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "常用波特率" })).not.toBeInTheDocument();
    expect(baud_rate).toHaveValue("230400");
  });

  it("用无步进文本框提交自定义波特率并可从下拉切回预设", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      serialConfig: { ...state.serialConfig, baudRate: 115_200 },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const baud_rate = screen.getByRole("combobox", { name: "波特率" }) as HTMLInputElement;
    expect(baud_rate).toHaveAttribute("type", "text");
    expect(baud_rate).toHaveAttribute("inputmode", "numeric");

    fireEvent.change(baud_rate, { target: { value: "250000" } });
    fireEvent.wheel(baud_rate, { deltaY: -100 });
    expect(baud_rate).toHaveValue("250000");
    fireEvent.keyDown(baud_rate, { key: "Enter" });
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(250_000);

    fireEvent.change(baud_rate, { target: { value: "12000000" } });
    fireEvent.keyDown(baud_rate, { key: "Enter" });
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(12_000_000);

    fireEvent.change(baud_rate, { target: { value: "12000001" } });
    fireEvent.keyDown(baud_rate, { key: "Escape" });
    expect(baud_rate).toHaveValue("12000000");
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(12_000_000);

    fireEvent.click(screen.getByRole("button", { name: "展开常用波特率" }));
    fireEvent.click(screen.getByRole("option", { name: "115200" }));
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(115_200);
    expect(baud_rate).toHaveValue("115200");
  });

  it("非法波特率失焦后保持错误并阻止连接", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      serialConfig: { ...state.serialConfig, baudRate: 250_000 },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const baud_rate = screen.getByRole("combobox", { name: "波特率" });
    const connect_button = screen.getByRole("button", { name: "连接设备" });
    fireEvent.change(baud_rate, { target: { value: "0" } });
    expect(baud_rate).toHaveAttribute("aria-invalid", "true");
    expect(connect_button).toBeDisabled();
    expect(connect_button).toHaveAccessibleDescription("请先输入有效波特率");
    fireEvent.blur(baud_rate);

    expect(baud_rate).toHaveValue("0");
    expect(baud_rate).toHaveAttribute("aria-invalid", "true");
    expect(connect_button).toBeDisabled();
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(250_000);

    fireEvent.keyDown(baud_rate, { key: "Escape" });
    expect(baud_rate).toHaveValue("250000");
    expect(connect_button).toBeEnabled();
  });

  it("有效自定义波特率在焦点离开组合框时提交", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      serialConfig: { ...state.serialConfig, baudRate: 115_200 },
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const baud_rate = screen.getByRole("combobox", { name: "波特率" });
    fireEvent.change(baud_rate, { target: { value: "250000" } });
    fireEvent.blur(baud_rate, { relatedTarget: document.body });

    expect(baud_rate).toHaveValue("250000");
    expect(useWorkbenchStore.getState().serialConfig.baudRate).toBe(250_000);
  });

  it("串口核心监听故障时显示原因并阻止刷新和连接", () => {
    const runtime_error = "串口核心事件监听初始化失败：事件插件不可用";
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "disconnected",
      serialRuntimeError: runtime_error,
      statusMessage: runtime_error,
      serialRecovery: { ...state.serialRecovery, phase: "off" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "刷新串口列表" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "连接设备" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "连接设备" })).toHaveAttribute(
      "title",
      runtime_error,
    );
    expect(screen.getByRole("status")).toHaveTextContent(runtime_error);
  });

  it("连接期间同时锁定波特率输入和常用值下拉", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "connected",
      serialConfig: { ...state.serialConfig, baudRate: 115_200 },
      serialRecovery: { ...state.serialRecovery, phase: "armed" },
    }));
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "波特率" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "展开常用波特率" })).toBeDisabled();
  });

  it("打开桌面串口连接面板时请求后台刷新", () => {
    const refreshPorts = vi.fn().mockResolvedValue(undefined);
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "disconnected",
      serialRecovery: {
        enabled: false,
        phase: "off",
        attempt: 0,
        maxAttempts: 10,
        message: "自动重连未启用",
        diagnosticEventCount: 0,
        diagnosticDroppedEvents: 0,
      },
      refreshPorts,
    });
    render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(refreshPorts).toHaveBeenCalledWith("background");
  });

  it("连接后设置控制线并播报异步结果和 RTS 锁定原因", () => {
    const setSerialControlLine = vi.fn().mockResolvedValue(true);
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "connected",
      connectionMessage: "DTR 已设为有效",
      statusMessage: "DTR 已设为有效",
      serialRecovery: { ...state.serialRecovery, phase: "armed" },
      serialConfig: { ...state.serialConfig, dtr: true, rts: true, flowControl: "none" },
      setSerialControlLine,
    }));
    const { rerender } = render(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const dtr = screen.getByRole("checkbox", { name: "DTR" });
    const rts = screen.getByRole("checkbox", { name: "RTS" });
    expect(dtr).toBeEnabled();
    expect(rts).toBeEnabled();
    fireEvent.click(dtr);
    expect(setSerialControlLine).toHaveBeenCalledWith("dtr", false);

    useWorkbenchStore.setState((state) => ({
      serialConfig: { ...state.serialConfig, flowControl: "hardware" },
    }));
    rerender(
      <Sidebar
        activePanel="connection"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "DTR" })).toBeEnabled();
    const lockedRts = screen.getByRole("checkbox", { name: "RTS" });
    expect(lockedRts).toBeDisabled();
    expect(lockedRts).toHaveAccessibleDescription("硬件流控已接管 RTS，无法手动设置");
    expect(screen.getByRole("status")).toHaveTextContent("DTR 已设为有效");
  });

  it("连接时显示四路输入握手线三态，断开后隐藏", () => {
    useWorkbenchStore.setState((state) => ({
      connectionStatus: "connected",
      serialGeneration: 7,
      serialRecovery: { ...state.serialRecovery, phase: "armed" },
      serialModemStatus: {
        generation: 7,
        revision: 2,
        cts: true,
        dsr: false,
        ri: null,
        dcd: true,
      },
    }));
    const props = {
      activePanel: "connection" as const,
      themePreference: "dark" as const,
      onClose: vi.fn(),
      onThemePreferenceChange: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...props} />);

    const status = screen.getByLabelText("串口输入握手线状态");
    expect(within(status).getByText("CTS").parentElement).toHaveTextContent("CTS有效");
    expect(within(status).getByText("DSR").parentElement).toHaveTextContent("DSR无效");
    expect(within(status).getByText("RI").parentElement).toHaveTextContent("RI不可用");
    expect(within(status).getByText("DCD").parentElement).toHaveTextContent("DCD有效");
    expect(
      Array.from(
        status.querySelectorAll<HTMLElement>(".modem-status-item"),
        (item) => item.dataset.state,
      ),
    ).toEqual(["asserted", "deasserted", "unavailable", "asserted"]);

    useWorkbenchStore.setState({ connectionStatus: "disconnected" });
    rerender(<Sidebar {...props} />);
    expect(screen.queryByLabelText("串口输入握手线状态")).not.toBeInTheDocument();
  });
});

describe("Sidebar 外观设置", () => {
  afterEach(() => {
    cleanup();
  });

  it("向辅助技术暴露当前主题选项", () => {
    render(
      <Sidebar
        activePanel="settings"
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /深色/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /浅色/ })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Sidebar 协议解析健康度", () => {
  beforeEach(() => {
    useWorkbenchStore.setState((state) => ({
      protocol: "firewater",
      replayStatus: "idle",
      replaySessionId: 0,
      replayHeader: undefined,
      protocolHealth: createEmptyProtocolHealth(),
      replayProtocolHealth: createEmptyProtocolHealth(),
      channels: [],
      processedChannels: [],
      workspaceTransitionStatus: "idle",
      serialRecovery: {
        ...state.serialRecovery,
        enabled: false,
        phase: "off",
      },
    }));
    useWorkbenchStore.getState().setProtocol("firewater");
  });

  afterEach(() => {
    cleanup();
  });

  it("区分等待、健康与丢帧状态并提供可操作原因", () => {
    const props = {
      activePanel: "channels" as const,
      themePreference: "dark" as const,
      onClose: vi.fn(),
      onThemePreferenceChange: vi.fn(),
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
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
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
        themePreference="dark"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const health = screen.getByRole("region", { name: "协议解析健康度" });
    expect(health).toHaveTextContent("已丢弃 2 帧");
    expect(health).toHaveTextContent("浮点帧长度未按 4 字节对齐");
    expect(health).toHaveTextContent("JustFloat：1–16 个小端 float32");
  });
});

describe("Sidebar 通道展示配置", () => {
  const props = {
    activePanel: "channels" as const,
    themePreference: "dark" as const,
    onClose: vi.fn(),
    onThemePreferenceChange: vi.fn(),
  };

  beforeEach(() => {
    useWorkbenchStore.setState({
      protocol: "firewater",
      replayStatus: "idle",
      replaySessionId: 0,
      replayHeader: undefined,
      channels: [
        {
          id: "channel-0",
          name: "voltage",
          color: "#46d89c",
          visible: true,
          points: [],
          lastValue: 12.5,
        },
      ],
      processedChannels: [
        {
          id: "derived:filtered",
          name: "Filtered",
          color: "#55bde8",
          visible: true,
          points: [],
          lastValue: 11.5,
        },
      ],
      extensionChannels: [
        {
          id: "extension:test:output",
          name: "Extension",
          color: "#f0b35a",
          visible: true,
          points: [],
          lastValue: 10.5,
        },
      ],
      channelPresentations: { firewater: {}, justfloat: {} },
      workspaceTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      protocolHealth: createEmptyProtocolHealth(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("编辑、取消、保存并恢复基础通道展示", () => {
    const { container } = render(<Sidebar {...props} />);

    expect(screen.getByRole("button", { name: "隐藏通道 voltage" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: /^编辑通道/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "编辑通道 voltage" }));
    expect(screen.getByRole("textbox", { name: "channel-0 通道别名" })).toHaveAttribute(
      "name",
      "channel-channel-0-alias",
    );
    expect(screen.getByRole("textbox", { name: "channel-0 通道单位" })).toHaveAttribute(
      "name",
      "channel-channel-0-unit",
    );
    expect(screen.getByLabelText("channel-0 通道颜色")).toHaveAttribute(
      "name",
      "channel-channel-0-color",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "channel-0 通道别名" }), {
      target: { value: "临时名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取消编辑 voltage" }));
    expect(useWorkbenchStore.getState().channelPresentations.firewater).toEqual({});

    fireEvent.click(screen.getByRole("button", { name: "编辑通道 voltage" }));
    fireEvent.change(screen.getByRole("textbox", { name: "channel-0 通道别名" }), {
      target: { value: "  母线电压  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "channel-0 通道单位" }), {
      target: { value: " V " },
    });
    fireEvent.change(screen.getByLabelText("channel-0 通道颜色"), {
      target: { value: "#ABCDEF" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 voltage 展示配置" }));

    expect(useWorkbenchStore.getState().channelPresentations.firewater).toEqual({
      "channel-0": { alias: "母线电压", unit: "V", color: "#abcdef" },
    });
    expect(screen.getByText("母线电压")).toBeInTheDocument();
    expect(screen.getByTitle("原始标签：voltage")).toHaveTextContent("voltage");
    expect(container.querySelector(".channel-row strong")).toHaveTextContent("12.500V");
    expect(container.querySelector(".channel-swatch")).toHaveStyle({
      backgroundColor: "#abcdef",
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑通道 母线电压" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复 voltage 默认展示" }));
    expect(useWorkbenchStore.getState().channelPresentations.firewater).toEqual({});
    expect(screen.getByText("voltage")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑通道 voltage" }));
    fireEvent.change(screen.getByRole("textbox", { name: "channel-0 通道别名" }), {
      target: { value: "仅别名" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 voltage 展示配置" }));
    expect(useWorkbenchStore.getState().channelPresentations.firewater).toEqual({
      "channel-0": { alias: "仅别名", unit: "", color: null },
    });
  });

  it("Raw Data、工作区切换和未来版本保护会禁用展示编辑", () => {
    useWorkbenchStore.setState({ protocol: "raw" });
    const { rerender } = render(<Sidebar {...props} />);
    expect(screen.queryByRole("button", { name: /^编辑通道/ })).not.toBeInTheDocument();

    useWorkbenchStore.setState({
      protocol: "firewater",
      workspaceTransitionStatus: "switching",
    });
    rerender(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: "编辑通道 voltage" })).toBeDisabled();

    useWorkbenchStore.setState({
      workspaceTransitionStatus: "idle",
      workspaceStorageStatus: "newer-version",
      incompatibleStorageVersion: 13,
    });
    rerender(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: "编辑通道 voltage" })).toBeDisabled();
  });
});

describe("Sidebar 主题偏好", () => {
  afterEach(() => {
    cleanup();
  });

  it("显示三种主题模式并提交用户选择", () => {
    const on_theme_preference_change = vi.fn();
    const { rerender } = render(
      <Sidebar
        activePanel="settings"
        themePreference="system"
        onClose={vi.fn()}
        onThemePreferenceChange={on_theme_preference_change}
      />,
    );
    const appearance = screen.getByRole("group", { name: "外观" });
    const system_button = within(appearance).getByRole("button", { name: "系统" });
    const dark_button = within(appearance).getByRole("button", { name: "深色" });
    const light_button = within(appearance).getByRole("button", { name: "浅色" });

    expect(system_button).toHaveAttribute("aria-pressed", "true");
    expect(dark_button).toHaveAttribute("aria-pressed", "false");
    expect(light_button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(light_button);
    expect(on_theme_preference_change).toHaveBeenCalledWith("light");

    rerender(
      <Sidebar
        activePanel="settings"
        themePreference="light"
        onClose={vi.fn()}
        onThemePreferenceChange={on_theme_preference_change}
      />,
    );
    expect(light_button).toHaveAttribute("aria-pressed", "true");
  });

  it("显示当前版本、Windows 支持范围和许可证", () => {
    render(
      <Sidebar
        activePanel="settings"
        themePreference="system"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    const about = screen.getByRole("region", { name: "Vofa-Ultra" });
    expect(about).toHaveTextContent(APP_DISPLAY_VERSION);
    expect(about).toHaveTextContent("Windows 10/11 x64");
    expect(about).toHaveTextContent("MIT");
  });

  it("为设置字段提供稳定表单标识", () => {
    render(
      <Sidebar
        activePanel="settings"
        themePreference="system"
        onClose={vi.fn()}
        onThemePreferenceChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("波形时间窗")).toHaveAttribute(
      "name",
      "chart-window-setting",
    );
    expect(screen.getByRole("checkbox", { name: "终端自动滚动" })).toHaveAttribute(
      "name",
      "terminal-auto-scroll",
    );
  });
});
