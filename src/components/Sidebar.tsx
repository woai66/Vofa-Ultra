import {
  Cable,
  CircleStop,
  Download,
  Gauge,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { BUILTIN_PROTOCOLS } from "../core/protocols";
import { isRecoveryActivePhase } from "../core/serialRecovery";
import type { ThemeMode } from "../App";
import {
  BAUD_RATES,
  type SerialDiagnosticsReport,
  type SerialRecoveryPhase,
} from "../types/serial";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ChartWindowSeconds } from "../types/workspace";
import type { SidebarPanel } from "./ActivityRail";
import { CapturePanel } from "./CapturePanel";
import { WorkspacePanel } from "./WorkspacePanel";

interface SidebarProps {
  activePanel: SidebarPanel;
  theme: ThemeMode;
  onClose(): void;
  onThemeChange(theme: ThemeMode): void;
}

export function Sidebar({ activePanel, theme, onClose, onThemeChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <button
        className="icon-button sidebar-close"
        type="button"
        aria-label="关闭侧栏"
        title="关闭侧栏"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      {activePanel === "connection" && <ConnectionPanel />}
      {activePanel === "channels" && <ChannelPanel />}
      {activePanel === "capture" && <CapturePanel />}
      <div className="workspace-panel-host" hidden={activePanel !== "workspaces"}>
        <WorkspacePanel />
      </div>
      {activePanel === "settings" && (
        <SettingsPanel theme={theme} onThemeChange={onThemeChange} />
      )}
    </aside>
  );
}

function ConnectionPanel() {
  const isNativeRuntime = useWorkbenchStore((state) => state.isNativeRuntime);
  const source = useWorkbenchStore((state) => state.source);
  const protocol = useWorkbenchStore((state) => state.protocol);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const statusMessage = useWorkbenchStore((state) => state.statusMessage);
  const ports = useWorkbenchStore((state) => state.ports);
  const isRefreshingPorts = useWorkbenchStore((state) => state.isRefreshingPorts);
  const config = useWorkbenchStore((state) => state.serialConfig);
  const serialRecovery = useWorkbenchStore((state) => state.serialRecovery);
  const isCancellingSerialConnection = useWorkbenchStore(
    (state) => state.isCancellingSerialConnection,
  );
  const setSource = useWorkbenchStore((state) => state.setSource);
  const setProtocol = useWorkbenchStore((state) => state.setProtocol);
  const updateConfig = useWorkbenchStore((state) => state.updateSerialConfig);
  const refreshPorts = useWorkbenchStore((state) => state.refreshPorts);
  const connect = useWorkbenchStore((state) => state.connect);
  const disconnect = useWorkbenchStore((state) => state.disconnect);
  const setSerialRecoveryEnabled = useWorkbenchStore(
    (state) => state.setSerialRecoveryEnabled,
  );
  const cancelSerialConnection = useWorkbenchStore(
    (state) => state.cancelSerialConnection,
  );
  const clearSerialDiagnostics = useWorkbenchStore(
    (state) => state.clearSerialDiagnostics,
  );
  const getSerialDiagnostics = useWorkbenchStore(
    (state) => state.getSerialDiagnostics,
  );
  const workspaceTransitionStatus = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus,
  );
  const runtimeTransitionStatus = useWorkbenchStore(
    (state) => state.runtimeTransitionStatus,
  );
  const captureStatus = useWorkbenchStore((state) => state.captureStatus);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);

  const isConnected = connectionStatus === "connected";
  const isTransitioning = workspaceTransitionStatus !== "idle";
  const isRuntimeTransitioning = runtimeTransitionStatus !== "idle";
  const isCaptureTransitioning = captureStatus === "starting" || captureStatus === "stopping";
  const isRecording = captureStatus === "recording";
  const isReplayLoaded = replaySessionId > 0 && replayStatus !== "idle";
  const recoveryActive = isRecoveryActivePhase(serialRecovery.phase);
  const canCancelConnection =
    source === "serial" && (connectionStatus === "connecting" || recoveryActive);
  const showCancelAction = canCancelConnection || isCancellingSerialConnection;
  const isBusy =
    connectionStatus === "connecting" ||
    recoveryActive ||
    isTransitioning ||
    isRuntimeTransitioning ||
    isCaptureTransitioning;
  const configDisabled = isConnected || isBusy || isRecording || isReplayLoaded;

  return (
    <div className="sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">DATA SOURCE</span>
          <h1>设备连接</h1>
        </div>
        <Cable size={20} />
      </div>

      <section className="sidebar-section">
        <span className="field-label" id="data-source-label">数据源</span>
        <div className="segmented-control" role="group" aria-labelledby="data-source-label">
          <button
            type="button"
            data-active={source === "serial"}
            disabled={!isNativeRuntime || configDisabled}
            title={isNativeRuntime ? "使用本机串口" : "浏览器预览不可访问串口"}
            onClick={() => void setSource("serial")}
          >
            串口
          </button>
          <button
            type="button"
            data-active={source === "simulator"}
            disabled={configDisabled}
            onClick={() => void setSource("simulator")}
          >
            模拟器
          </button>
        </div>
      </section>

      {source === "serial" && (
        <section className="sidebar-section connection-fields">
          <div className="field-row-heading">
            <label className="field-label" htmlFor="serial-port">
              串口设备
            </label>
            <button
              className="icon-button compact"
              type="button"
              aria-label="刷新串口列表"
              title="刷新串口列表"
              disabled={isRefreshingPorts || configDisabled}
              onClick={() => void refreshPorts()}
            >
              <RefreshCw size={15} className={isRefreshingPorts ? "spin" : undefined} />
            </button>
          </div>
          <select
            id="serial-port"
            value={config.portName}
            disabled={configDisabled}
            onChange={(event) => updateConfig("portName", event.target.value)}
          >
            {ports.length === 0 && <option value="">未发现设备</option>}
            {config.portName && !ports.some((port) => port.name === config.portName) && (
              <option value={config.portName}>{config.portName} · 当前不可用</option>
            )}
            {ports.map((port) => (
              <option key={port.name} value={port.name}>
                {port.name}
                {port.product ? ` · ${port.product}` : ""}
              </option>
            ))}
          </select>

          <label className="field-label" htmlFor="baud-rate">
            波特率
          </label>
          <input
            id="baud-rate"
            type="number"
            min={1}
            max={12_000_000}
            step={1}
            list="baud-rate-presets"
            value={config.baudRate}
            disabled={configDisabled}
            onChange={(event) => updateConfig("baudRate", Number(event.target.value))}
          />
          <datalist id="baud-rate-presets">
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate} />
            ))}
          </datalist>

          <div className="field-grid three-columns">
            <label>
              <span className="field-label">数据位</span>
              <select
                value={config.dataBits}
                disabled={configDisabled}
                onChange={(event) =>
                  updateConfig("dataBits", Number(event.target.value) as 5 | 6 | 7 | 8)
                }
              >
                {[8, 7, 6, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">校验</span>
              <select
                value={config.parity}
                disabled={configDisabled}
                onChange={(event) =>
                  updateConfig("parity", event.target.value as "none" | "odd" | "even")
                }
              >
                <option value="none">无</option>
                <option value="odd">奇</option>
                <option value="even">偶</option>
              </select>
            </label>
            <label>
              <span className="field-label">停止位</span>
              <select
                value={config.stopBits}
                disabled={configDisabled}
                onChange={(event) => updateConfig("stopBits", Number(event.target.value) as 1 | 2)}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
          </div>

          <label>
            <span className="field-label">流控</span>
            <select
              value={config.flowControl}
              disabled={configDisabled}
              onChange={(event) =>
                updateConfig(
                  "flowControl",
                  event.target.value as "none" | "software" | "hardware",
                )
              }
            >
              <option value="none">无</option>
              <option value="software">软件</option>
              <option value="hardware">硬件</option>
            </select>
          </label>

          <div className="toggle-row-group">
            <label className="toggle-row">
              <span>DTR</span>
              <input
                type="checkbox"
                checked={config.dtr}
                disabled={configDisabled}
                onChange={(event) => updateConfig("dtr", event.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>RTS</span>
              <input
                type="checkbox"
                checked={config.rts}
                disabled={configDisabled}
                onChange={(event) => updateConfig("rts", event.target.checked)}
              />
            </label>
          </div>
        </section>
      )}

      {source === "serial" && (
        <section className="sidebar-section recovery-section" aria-label="串口恢复">
          <label className="toggle-row recovery-toggle">
            <span>自动重连</span>
            <input
              type="checkbox"
              checked={serialRecovery.enabled}
              disabled={isCancellingSerialConnection}
              onChange={(event) => void setSerialRecoveryEnabled(event.target.checked)}
            />
          </label>
          <div
            className="recovery-state"
            data-phase={serialRecovery.phase}
            aria-live="polite"
          >
            <span className="status-dot" />
            <div>
              <strong>{recoveryPhaseLabel(serialRecovery.phase)}</strong>
              <span>{serialRecovery.message}</span>
            </div>
            {serialRecovery.attempt > 0 && (
              <code>
                {serialRecovery.attempt}/{serialRecovery.maxAttempts}
              </code>
            )}
          </div>
          <div className="recovery-diagnostics">
            <span>
              诊断事件 <strong>{serialRecovery.diagnosticEventCount}</strong>
              {serialRecovery.diagnosticDroppedEvents > 0
                ? ` · 丢弃 ${serialRecovery.diagnosticDroppedEvents}`
                : ""}
            </span>
            <div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="导出串口诊断"
                title="导出串口诊断"
                disabled={serialRecovery.diagnosticEventCount === 0}
                onClick={() => downloadSerialDiagnostics(getSerialDiagnostics())}
              >
                <Download size={14} />
              </button>
              <button
                className="icon-button compact"
                type="button"
                aria-label="清空串口诊断"
                title="清空串口诊断"
                disabled={serialRecovery.diagnosticEventCount === 0}
                onClick={clearSerialDiagnostics}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="sidebar-section">
        <span className="field-label" id="protocol-parser-label">协议解析</span>
        <div
          className="protocol-list"
          role="radiogroup"
          aria-labelledby="protocol-parser-label"
        >
          {BUILTIN_PROTOCOLS.map(({ id, displayName, description }) => (
            <button
              key={id}
              className="protocol-option"
              type="button"
              role="radio"
              aria-checked={protocol === id}
              data-active={protocol === id}
              disabled={configDisabled}
              onClick={() => setProtocol(id)}
            >
              <span className="protocol-dot" />
              <span>
                <strong>{displayName}</strong>
                <small>{description}</small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="connection-action-area">
        <div className="connection-message" data-status={connectionStatus}>
          <span className="status-dot" />
          <span>{statusMessage}</span>
        </div>
        <button
          className="primary-button connect-button"
          type="button"
          data-action={showCancelAction ? "cancel" : "primary"}
          disabled={isCancellingSerialConnection || (!canCancelConnection && isBusy)}
          onClick={() =>
            void (canCancelConnection
              ? cancelSerialConnection()
              : isConnected
                ? disconnect()
                : connect())
          }
        >
          {showCancelAction ? (
            <X size={17} />
          ) : isConnected ? (
            <CircleStop size={17} />
          ) : (
            <Play size={17} />
          )}
          {isCancellingSerialConnection
            ? "正在取消"
            : canCancelConnection
              ? recoveryActive
                ? "取消重连"
                : "取消连接"
              : isBusy
                ? "处理中"
                : isConnected
                  ? "断开连接"
                  : isReplayLoaded
                    ? "退出回放并连接"
                    : source === "serial"
                      ? "连接设备"
                      : "启动模拟"}
        </button>
      </div>
    </div>
  );
}

function ChannelPanel() {
  const channels = useWorkbenchStore((state) => state.channels);
  const toggleChannel = useWorkbenchStore((state) => state.toggleChannel);
  const clearChart = useWorkbenchStore((state) => state.clearChart);
  const isTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );

  return (
    <div className="sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">SIGNALS</span>
          <h1>数据通道</h1>
        </div>
        <Gauge size={20} />
      </div>
      <div className="channel-summary">
        <span>已检测通道</span>
        <strong>{channels.length}</strong>
      </div>
      <section className="channel-list" aria-label="数据通道列表">
        {channels.length === 0 ? (
          <div className="sidebar-empty">
            <AudioEmptyIcon />
            <span>暂无可显示通道</span>
          </div>
        ) : (
          channels.map((channel) => (
            <button
              key={channel.id}
              className="channel-row"
              type="button"
              data-visible={channel.visible}
              aria-pressed={channel.visible}
              disabled={isTransitioning}
              onClick={() => toggleChannel(channel.id)}
            >
              <span className="channel-swatch" style={{ backgroundColor: channel.color }} />
              <span className="channel-name">{channel.name}</span>
              <strong>{formatChannelValue(channel.lastValue)}</strong>
            </button>
          ))
        )}
      </section>
      <button className="secondary-button" type="button" onClick={clearChart} disabled={!channels.length}>
        <RotateCcw size={16} />
        清空波形
      </button>
    </div>
  );
}

function SettingsPanel({ theme, onThemeChange }: Pick<SidebarProps, "theme" | "onThemeChange">) {
  const chartWindowSeconds = useWorkbenchStore((state) => state.chartWindowSeconds);
  const setChartWindowSeconds = useWorkbenchStore((state) => state.setChartWindowSeconds);
  const terminalAutoScroll = useWorkbenchStore((state) => state.terminalAutoScroll);
  const setTerminalAutoScroll = useWorkbenchStore((state) => state.setTerminalAutoScroll);
  const resetStats = useWorkbenchStore((state) => state.resetStats);
  const isTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );

  return (
    <div className="sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">PREFERENCES</span>
          <h1>工作台设置</h1>
        </div>
        <Settings size={20} />
      </div>
      <section className="sidebar-section">
        <span className="field-label" id="appearance-label">外观</span>
        <div
          className="segmented-control icon-segments"
          role="group"
          aria-labelledby="appearance-label"
        >
          <button type="button" data-active={theme === "dark"} onClick={() => onThemeChange("dark")}>
            <Moon size={15} /> 深色
          </button>
          <button type="button" data-active={theme === "light"} onClick={() => onThemeChange("light")}>
            <Sun size={15} /> 浅色
          </button>
        </div>
      </section>
      <section className="sidebar-section">
        <label className="field-label" htmlFor="chart-window-setting">
          波形时间窗
        </label>
        <select
          id="chart-window-setting"
          value={chartWindowSeconds}
          disabled={isTransitioning}
          onChange={(event) =>
            setChartWindowSeconds(Number(event.target.value) as ChartWindowSeconds)
          }
        >
          <option value={5}>5 秒</option>
          <option value={15}>15 秒</option>
          <option value={30}>30 秒</option>
          <option value={60}>60 秒</option>
        </select>
        <label className="toggle-row standalone">
          <span>终端自动滚动</span>
          <input
            type="checkbox"
            checked={terminalAutoScroll}
            disabled={isTransitioning}
            onChange={(event) => setTerminalAutoScroll(event.target.checked)}
          />
        </label>
      </section>
      <button className="secondary-button" type="button" onClick={resetStats}>
        <RotateCcw size={16} />
        重置传输统计
      </button>
    </div>
  );
}

function AudioEmptyIcon() {
  return <span className="empty-signal" aria-hidden="true">~</span>;
}

function formatChannelValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

function recoveryPhaseLabel(phase: SerialRecoveryPhase): string {
  switch (phase) {
    case "armed":
      return "恢复待命";
    case "waiting":
      return "等待重试";
    case "scanning":
      return "查找设备";
    case "connecting":
      return "恢复连接";
    case "blocked":
      return "恢复暂停";
    case "exhausted":
      return "重试结束";
    case "idle":
      return "等待连接";
    default:
      return "自动重连关闭";
  }
}

function downloadSerialDiagnostics(report: SerialDiagnosticsReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vofa-ultra-serial-diagnostics-${report.generatedAt}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
