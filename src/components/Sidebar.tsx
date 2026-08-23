import {
  Cable,
  CircleStop,
  Gauge,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Sun,
} from "lucide-react";
import type { ThemeMode } from "../App";
import { BAUD_RATES } from "../types/serial";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { SidebarPanel } from "./ActivityRail";

interface SidebarProps {
  activePanel: SidebarPanel;
  theme: ThemeMode;
  onThemeChange(theme: ThemeMode): void;
}

export function Sidebar({ activePanel, theme, onThemeChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      {activePanel === "connection" && <ConnectionPanel />}
      {activePanel === "channels" && <ChannelPanel />}
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
  const setSource = useWorkbenchStore((state) => state.setSource);
  const setProtocol = useWorkbenchStore((state) => state.setProtocol);
  const updateConfig = useWorkbenchStore((state) => state.updateSerialConfig);
  const refreshPorts = useWorkbenchStore((state) => state.refreshPorts);
  const connect = useWorkbenchStore((state) => state.connect);
  const disconnect = useWorkbenchStore((state) => state.disconnect);

  const isConnected = connectionStatus === "connected";
  const isBusy = connectionStatus === "connecting";

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
        <label className="field-label">数据源</label>
        <div className="segmented-control" role="group" aria-label="数据源">
          <button
            type="button"
            data-active={source === "serial"}
            disabled={!isNativeRuntime}
            title={isNativeRuntime ? "使用本机串口" : "浏览器预览不可访问串口"}
            onClick={() => void setSource("serial")}
          >
            串口
          </button>
          <button
            type="button"
            data-active={source === "simulator"}
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
              disabled={isRefreshingPorts || isConnected}
              onClick={() => void refreshPorts()}
            >
              <RefreshCw size={15} className={isRefreshingPorts ? "spin" : undefined} />
            </button>
          </div>
          <select
            id="serial-port"
            value={config.portName}
            disabled={isConnected}
            onChange={(event) => updateConfig("portName", event.target.value)}
          >
            {ports.length === 0 && <option value="">未发现设备</option>}
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
            disabled={isConnected}
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
                disabled={isConnected}
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
                disabled={isConnected}
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
                disabled={isConnected}
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
              disabled={isConnected}
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
                disabled={isConnected}
                onChange={(event) => updateConfig("dtr", event.target.checked)}
              />
            </label>
            <label className="toggle-row">
              <span>RTS</span>
              <input
                type="checkbox"
                checked={config.rts}
                disabled={isConnected}
                onChange={(event) => updateConfig("rts", event.target.checked)}
              />
            </label>
          </div>
        </section>
      )}

      <section className="sidebar-section">
        <label className="field-label">协议解析</label>
        <div className="protocol-list" role="radiogroup" aria-label="协议解析">
          {(
            [
              ["firewater", "FireWater", "文本帧"],
              ["justfloat", "JustFloat", "浮点帧"],
              ["raw", "Raw Data", "原始字节"],
            ] as const
          ).map(([id, name, detail]) => (
            <button
              key={id}
              className="protocol-option"
              type="button"
              role="radio"
              aria-checked={protocol === id}
              data-active={protocol === id}
              onClick={() => setProtocol(id)}
            >
              <span className="protocol-dot" />
              <span>
                <strong>{name}</strong>
                <small>{detail}</small>
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
          disabled={isBusy}
          onClick={() => void (isConnected ? disconnect() : connect())}
        >
          {isConnected ? <CircleStop size={17} /> : <Play size={17} />}
          {isBusy ? "连接中" : isConnected ? "断开连接" : source === "serial" ? "连接设备" : "启动模拟"}
        </button>
      </div>
    </div>
  );
}

function ChannelPanel() {
  const channels = useWorkbenchStore((state) => state.channels);
  const toggleChannel = useWorkbenchStore((state) => state.toggleChannel);
  const clearChart = useWorkbenchStore((state) => state.clearChart);

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
        <label className="field-label">外观</label>
        <div className="segmented-control icon-segments" role="group" aria-label="外观主题">
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
          onChange={(event) => setChartWindowSeconds(Number(event.target.value))}
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
