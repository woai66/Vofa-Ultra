import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Cable,
  Check,
  CircleCheck,
  CircleStop,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Gauge,
  Monitor,
  Moon,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Sun,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import {
  getChannelPresentationOverride,
  presentChannelSeries,
  type PresentedChannelSeries,
} from "../core/channelPresentation";
import { isModbusPollActive } from "../core/modbusPoller";
import {
  BUILTIN_PROTOCOLS,
  PROTOCOL_DROP_REASON_LABELS,
} from "../core/protocols";
import { isRecoveryActivePhase } from "../core/serialRecovery";
import { presentSerialPort, sortSerialPorts } from "../core/serialPorts";
import type { ThemePreference } from "../App";
import {
  BAUD_RATES,
  type ProtocolKind,
  type SerialDiagnosticsReport,
  type SerialRecoveryPhase,
} from "../types/serial";
import {
  selectActiveProtocol,
  selectActiveProtocolHealth,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type {
  BaseChannelId,
  ChannelPresentationOverride,
  ChannelPresentationProtocol,
  ChartWindowSeconds,
} from "../types/workspace";
import type { ProtocolHealthSnapshot } from "../types/workbench";
import type { SidebarPanel } from "./ActivityRail";
import { CapturePanel } from "./CapturePanel";
import { AutomationPanel } from "./AutomationPanel";
import { ProcessingPanel } from "./ProcessingPanel";
import { WorkspacePanel } from "./WorkspacePanel";

const ExtensionPanel = lazy(() =>
  import("./ExtensionPanel").then(({ ExtensionPanel }) => ({ default: ExtensionPanel })),
);

interface SidebarProps {
  activePanel: SidebarPanel;
  themePreference: ThemePreference;
  onClose(): void;
  onThemePreferenceChange(theme: ThemePreference): void;
}

export function Sidebar({
  activePanel,
  themePreference,
  onClose,
  onThemePreferenceChange,
}: SidebarProps) {
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
      {activePanel === "processing" && <ProcessingPanel />}
      {activePanel === "extensions" && (
        <Suspense
          fallback={
            <div className="sidebar-panel" aria-label="加载中" aria-busy="true" />
          }
        >
          <ExtensionPanel />
        </Suspense>
      )}
      {activePanel === "automation" && <AutomationPanel />}
      {activePanel === "capture" && <CapturePanel />}
      <div className="workspace-panel-host" hidden={activePanel !== "workspaces"}>
        <WorkspacePanel />
      </div>
      {activePanel === "settings" && (
        <SettingsPanel
          themePreference={themePreference}
          onThemePreferenceChange={onThemePreferenceChange}
        />
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
  const serialControlLineOperation = useWorkbenchStore(
    (state) => state.serialControlLineOperation,
  );
  const serialModemStatus = useWorkbenchStore((state) => state.serialModemStatus);
  const serialRecovery = useWorkbenchStore((state) => state.serialRecovery);
  const serialFileSendStatus = useWorkbenchStore((state) => state.serialFileSend.status);
  const modbusPoll = useWorkbenchStore((state) => state.modbusPoll);
  const modbusTransactionStatus = useWorkbenchStore(
    (state) => state.modbusTransaction.status,
  );
  const isCancellingSerialConnection = useWorkbenchStore(
    (state) => state.isCancellingSerialConnection,
  );
  const setSource = useWorkbenchStore((state) => state.setSource);
  const setProtocol = useWorkbenchStore((state) => state.setProtocol);
  const updateConfig = useWorkbenchStore((state) => state.updateSerialConfig);
  const setSerialControlLine = useWorkbenchStore((state) => state.setSerialControlLine);
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
  const numericLogStatus = useWorkbenchStore((state) => state.numericLogStatus);
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
  const controlLineDisabled =
    isCancellingSerialConnection ||
    isBusy ||
    isRecording ||
    isReplayLoaded ||
    serialControlLineOperation !== "idle" ||
    numericLogStatus === "starting" ||
    numericLogStatus === "recording" ||
    numericLogStatus === "stopping" ||
    serialFileSendStatus === "queued" ||
    serialFileSendStatus === "sending" ||
    serialFileSendStatus === "cancelling" ||
    isModbusPollActive(modbusPoll) ||
    modbusTransactionStatus !== "idle";
  const sortedPorts = useMemo(() => sortSerialPorts(ports), [ports]);
  const selectedPortPresentation = useMemo(() => {
    const selectedPort = ports.find((port) => port.name === config.portName);
    return selectedPort ? presentSerialPort(selectedPort) : null;
  }, [config.portName, ports]);

  useEffect(() => {
    if (isNativeRuntime && source === "serial") {
      void refreshPorts("background");
    }
  }, [isNativeRuntime, refreshPorts, source]);

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
            aria-pressed={source === "serial"}
            data-active={source === "serial"}
            disabled={!isNativeRuntime || configDisabled}
            title={isNativeRuntime ? "使用本机串口" : "浏览器预览不可访问串口"}
            onClick={() => void setSource("serial")}
          >
            串口
          </button>
          <button
            type="button"
            aria-pressed={source === "simulator"}
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
            {sortedPorts.map((port) => (
              <option key={port.name} value={port.name}>
                {presentSerialPort(port).optionLabel}
              </option>
            ))}
          </select>
          {selectedPortPresentation && (
            <div className="serial-port-summary" role="group" aria-label="已选端口信息">
              <div className="serial-port-summary-name">
                <Cable size={14} aria-hidden="true" />
                <strong title={selectedPortPresentation.primaryLabel}>
                  {selectedPortPresentation.primaryLabel}
                </strong>
              </div>
              {selectedPortPresentation.secondaryLabel && (
                <span title={selectedPortPresentation.secondaryLabel}>
                  {selectedPortPresentation.secondaryLabel}
                </span>
              )}
              <div className="serial-port-summary-meta">
                <span>{selectedPortPresentation.kindLabel}</span>
                {selectedPortPresentation.usbIdentifier && (
                  <code>{selectedPortPresentation.usbIdentifier}</code>
                )}
                {selectedPortPresentation.hasUniqueUsbIdentity && <span>唯一身份</span>}
              </div>
            </div>
          )}

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
                disabled={controlLineDisabled}
                aria-busy={serialControlLineOperation === "dtr"}
                onChange={(event) => {
                  if (isConnected) {
                    void setSerialControlLine("dtr", event.target.checked);
                  } else {
                    updateConfig("dtr", event.target.checked);
                  }
                }}
              />
            </label>
            <label
              className="toggle-row"
              title={config.flowControl === "hardware" ? "硬件流控已接管 RTS" : undefined}
            >
              <span>RTS</span>
              <input
                type="checkbox"
                checked={config.rts}
                disabled={controlLineDisabled || config.flowControl === "hardware"}
                aria-busy={serialControlLineOperation === "rts"}
                aria-describedby={config.flowControl === "hardware" ? "rl" : undefined}
                onChange={(event) => {
                  if (isConnected) {
                    void setSerialControlLine("rts", event.target.checked);
                  } else {
                    updateConfig("rts", event.target.checked);
                  }
                }}
              />
            </label>
            {config.flowControl === "hardware" && (
              <span id="rl" className="sr-only">
                硬件流控已接管 RTS，无法手动设置
              </span>
            )}
          </div>

          {isConnected && (
            <dl className="modem-status-grid" aria-label="串口输入握手线状态">
              {(
                [
                  ["CTS", serialModemStatus.cts],
                  ["DSR", serialModemStatus.dsr],
                  ["RI", serialModemStatus.ri],
                  ["DCD", serialModemStatus.dcd],
                ] as const
              ).map(([line, value]) => (
                <div className="modem-status-item" data-state={modemLineState(value)} key={line}>
                  <dt>{line}</dt>
                  <dd>
                    <span className="modem-status-dot" aria-hidden="true" />
                    {modemLineLabel(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
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
        <div
          className="connection-message"
          data-status={connectionStatus}
          role="status"
        >
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

function modemLineState(value: boolean | null): "asserted" | "deasserted" | "unavailable" {
  if (value === null) {
    return "unavailable";
  }
  return value ? "asserted" : "deasserted";
}

function modemLineLabel(value: boolean | null): "有效" | "无效" | "不可用" {
  if (value === null) {
    return "不可用";
  }
  return value ? "有效" : "无效";
}

function ChannelPanel() {
  const channels = useWorkbenchStore((state) => state.channels);
  const processedChannels = useWorkbenchStore((state) => state.processedChannels);
  const extensionChannels = useWorkbenchStore((state) => state.extensionChannels);
  const channelPresentations = useWorkbenchStore((state) => state.channelPresentations);
  const activeProtocol = useWorkbenchStore(selectActiveProtocol);
  const protocolHealth = useWorkbenchStore(selectActiveProtocolHealth);
  const toggleChannel = useWorkbenchStore((state) => state.toggleChannel);
  const toggleExtensionChannel = useWorkbenchStore((state) => state.toggleExtensionChannel);
  const setChannelPresentation = useWorkbenchStore(
    (state) => state.setChannelPresentation,
  );
  const clearChart = useWorkbenchStore((state) => state.clearChart);
  const clearProtocolHealth = useWorkbenchStore((state) => state.clearProtocolHealth);
  const isTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const presentationReadOnly = useWorkbenchStore(
    (state) => state.workspaceStorageStatus === "newer-version",
  );
  const presentationProtocol: ChannelPresentationProtocol | null =
    activeProtocol === "firewater" || activeProtocol === "justfloat"
      ? activeProtocol
      : null;
  const presentedChannels = useMemo(
    () =>
      channels.map((channel) =>
        presentChannelSeries(channel, activeProtocol, channelPresentations),
      ),
    [activeProtocol, channelPresentations, channels],
  );
  const presentedProcessedChannels = useMemo(
    () =>
      processedChannels.map((channel) =>
        presentChannelSeries(channel, activeProtocol, channelPresentations),
      ),
    [activeProtocol, channelPresentations, processedChannels],
  );
  const presentedExtensionChannels = useMemo(
    () =>
      extensionChannels.map((channel) =>
        presentChannelSeries(channel, activeProtocol, channelPresentations),
      ),
    [activeProtocol, channelPresentations, extensionChannels],
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
        <span>基础 {channels.length}</span>
        <span>派生 {processedChannels.length}</span>
        <strong>扩展 {extensionChannels.length}</strong>
      </div>
      <ProtocolHealthSection
        protocol={activeProtocol}
        health={protocolHealth}
        onClear={clearProtocolHealth}
      />
      <section className="channel-list" aria-label="数据通道列表">
        {channels.length === 0 &&
        processedChannels.length === 0 &&
        extensionChannels.length === 0 ? (
          <div className="sidebar-empty">
            <AudioEmptyIcon />
            <span>暂无可显示通道</span>
          </div>
        ) : (
          <>
            {channels.length > 0 && <span className="channel-group-label">基础通道</span>}
            {presentedChannels.map((channel, index) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                disabled={isTransitioning}
                onToggle={() => toggleChannel(channel.id)}
                presentation={
                  presentationProtocol
                    ? getChannelPresentationOverride(
                        channelPresentations,
                        presentationProtocol,
                        channel.id,
                      )
                    : null
                }
                presentationDisabled={isTransitioning || presentationReadOnly}
                originalColor={channels[index]?.color ?? channel.color}
                onPresentationChange={
                  presentationProtocol
                    ? (value) =>
                        setChannelPresentation(
                          presentationProtocol,
                          channel.id as BaseChannelId,
                          value,
                        )
                    : undefined
                }
              />
            ))}
            {processedChannels.length > 0 && (
              <span className="channel-group-label">派生通道</span>
            )}
            {presentedProcessedChannels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                disabled={isTransitioning}
                onToggle={() => toggleChannel(channel.id)}
              />
            ))}
            {extensionChannels.length > 0 && (
              <span className="channel-group-label">扩展通道</span>
            )}
            {presentedExtensionChannels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                disabled={isTransitioning}
                onToggle={() => toggleExtensionChannel(channel.id)}
              />
            ))}
          </>
        )}
      </section>
      <button
        className="secondary-button"
        type="button"
        onClick={clearChart}
        disabled={channels.length + processedChannels.length + extensionChannels.length === 0}
      >
        <RotateCcw size={16} />
        清空波形
      </button>
    </div>
  );
}

function ProtocolHealthSection({
  protocol,
  health,
  onClear,
}: {
  protocol: ProtocolKind;
  health: ProtocolHealthSnapshot;
  onClear(): void;
}) {
  const raw = protocol === "raw";
  const warning = !raw && health.droppedFrames > 0;
  const hasActivity =
    health.acceptedFrames > 0 || health.droppedFrames > 0 || health.resyncCount > 0;
  const status = raw
    ? "inactive"
    : warning
      ? "warning"
      : health.acceptedFrames > 0
        ? "healthy"
        : "waiting";

  return (
    <section className="protocol-health" data-status={status} aria-label="协议解析健康度">
      <div className="protocol-health-heading">
        <div>
          {warning ? <TriangleAlert size={15} /> : <CircleCheck size={15} />}
          <span>解析健康</span>
        </div>
        <strong>{protocolHealthLabel(status, health.droppedFrames)}</strong>
        <button
          className="icon-button compact"
          type="button"
          aria-label="清空解析统计"
          title="清空解析统计"
          disabled={raw || !hasActivity}
          onClick={onClear}
        >
          <Eraser size={14} />
        </button>
      </div>
      {raw ? (
        <span className="protocol-health-inactive">Raw Data 不执行结构化解析</span>
      ) : (
        <>
          <div className="protocol-health-counters" aria-label="协议解析计数">
            <span>成功 <strong>{health.acceptedFrames.toLocaleString()}</strong></span>
            <span>丢弃 <strong>{health.droppedFrames.toLocaleString()}</strong></span>
            <span>重同步 <strong>{health.resyncCount.toLocaleString()}</strong></span>
          </div>
          {health.lastDropReason && (
            <div className="protocol-health-detail">
              <span>
                最近：{PROTOCOL_DROP_REASON_LABELS[health.lastDropReason]}
                {health.lastDropAt === null ? "" : ` · ${formatProtocolDropTime(health.lastDropAt)}`}
              </span>
              <small>{protocolConstraint(protocol)}</small>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ChannelRow({
  channel,
  disabled,
  onToggle,
  presentation,
  presentationDisabled = false,
  originalColor = channel.color,
  onPresentationChange,
}: {
  channel: PresentedChannelSeries;
  disabled: boolean;
  onToggle(): void;
  presentation?: ChannelPresentationOverride | null;
  presentationDisabled?: boolean;
  originalColor?: string;
  onPresentationChange?(value: ChannelPresentationOverride | null): void;
}) {
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState(presentation?.alias ?? "");
  const [unit, setUnit] = useState(presentation?.unit ?? "");
  const [color, setColor] = useState(presentation?.color ?? originalColor);
  const [customColor, setCustomColor] = useState(
    presentation?.color !== null && presentation?.color !== undefined,
  );
  const [error, setError] = useState("");

  useEffect(() => {
    setAlias(presentation?.alias ?? "");
    setUnit(presentation?.unit ?? "");
    setColor(presentation?.color ?? originalColor);
    setCustomColor(
      presentation?.color !== null && presentation?.color !== undefined,
    );
    setError("");
  }, [originalColor, presentation]);

  const savePresentation = () => {
    if (!onPresentationChange) {
      return;
    }
    try {
      onPresentationChange({
        alias,
        unit,
        color: customColor ? color : null,
      });
      setEditing(false);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "通道展示配置无效");
    }
  };

  const resetPresentation = () => {
    if (!onPresentationChange) {
      return;
    }
    try {
      onPresentationChange(null);
      setEditing(false);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法恢复默认展示");
    }
  };

  return (
    <div className="channel-item" data-editing={editing}>
      <div className="channel-row" data-visible={channel.visible}>
        <button
          className="channel-visibility-button"
          type="button"
          aria-label={`${channel.visible ? "隐藏" : "显示"}通道 ${channel.displayName}`}
          aria-pressed={channel.visible}
          disabled={disabled}
          onClick={onToggle}
        >
          <span className="channel-swatch" style={{ backgroundColor: channel.color }} />
          {channel.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <span className="channel-labels">
          <span className="channel-name" title={channel.displayName}>
            {channel.displayName}
          </span>
          {channel.displayName !== channel.name && (
            <small title={`原始标签：${channel.name}`}>{channel.name}</small>
          )}
        </span>
        <strong>
          {formatChannelValue(channel.lastValue)}
          {channel.unit && <small>{channel.unit}</small>}
        </strong>
        {onPresentationChange && (
          <button
            className="icon-button compact channel-edit-button"
            type="button"
            aria-label={`编辑通道 ${channel.displayName}`}
            title="编辑展示"
            disabled={presentationDisabled}
            aria-expanded={editing}
            onClick={() => {
              setEditing((current) => !current);
              setError("");
            }}
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
      {editing && onPresentationChange && (
        <form
          className="channel-editor"
          aria-label={`${channel.name} 展示配置`}
          onSubmit={(event) => {
            event.preventDefault();
            savePresentation();
          }}
        >
          <div className="channel-editor-grid">
            <label>
              <span>别名</span>
              <input
                aria-label={`${channel.id} 通道别名`}
                maxLength={64}
                value={alias}
                disabled={presentationDisabled}
                onChange={(event) => setAlias(event.target.value)}
              />
            </label>
            <label>
              <span>单位</span>
              <input
                aria-label={`${channel.id} 通道单位`}
                maxLength={24}
                value={unit}
                disabled={presentationDisabled}
                onChange={(event) => setUnit(event.target.value)}
              />
            </label>
            <label className="channel-color-field">
              <span>颜色</span>
              <span>
                <input
                  type="color"
                  aria-label={`${channel.id} 通道颜色`}
                  value={color}
                  disabled={presentationDisabled}
                  onChange={(event) => {
                    setColor(event.target.value);
                    setCustomColor(true);
                  }}
                />
                <button
                  className="icon-button compact"
                  type="button"
                  aria-label={`${channel.id} 使用默认颜色`}
                  title="使用默认颜色"
                  disabled={presentationDisabled || !customColor}
                  onClick={() => {
                    setColor(originalColor);
                    setCustomColor(false);
                  }}
                >
                  <Undo2 size={13} />
                </button>
              </span>
            </label>
          </div>
          {error && <span className="inline-error channel-editor-error" role="alert">{error}</span>}
          <div className="channel-editor-actions">
            <button
              className="icon-button compact"
              type="button"
              aria-label={`取消编辑 ${channel.name}`}
              title="取消"
              onClick={() => {
                setAlias(presentation?.alias ?? "");
                setUnit(presentation?.unit ?? "");
                setColor(presentation?.color ?? originalColor);
                setCustomColor(
                  presentation?.color !== null && presentation?.color !== undefined,
                );
                setEditing(false);
                setError("");
              }}
            >
              <X size={14} />
            </button>
            <button
              className="icon-button compact"
              type="button"
              aria-label={`恢复 ${channel.name} 默认展示`}
              title="恢复默认"
              disabled={presentationDisabled || !presentation}
              onClick={resetPresentation}
            >
              <RotateCcw size={14} />
            </button>
            <button
              className="icon-button compact primary-icon-button"
              type="submit"
              aria-label={`保存 ${channel.name} 展示配置`}
              title="保存"
              disabled={presentationDisabled}
            >
              <Check size={14} />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SettingsPanel({
  themePreference,
  onThemePreferenceChange,
}: Pick<SidebarProps, "themePreference" | "onThemePreferenceChange">) {
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
          <button
            type="button"
            aria-pressed={themePreference === "system"}
            data-active={themePreference === "system"}
            onClick={() => onThemePreferenceChange("system")}
          >
            <Monitor size={15} /> 系统
          </button>
          <button
            type="button"
            aria-pressed={themePreference === "dark"}
            data-active={themePreference === "dark"}
            onClick={() => onThemePreferenceChange("dark")}
          >
            <Moon size={15} /> 深色
          </button>
          <button
            type="button"
            aria-pressed={themePreference === "light"}
            data-active={themePreference === "light"}
            onClick={() => onThemePreferenceChange("light")}
          >
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

type ProtocolHealthStatus = "inactive" | "waiting" | "healthy" | "warning";

function protocolHealthLabel(status: ProtocolHealthStatus, droppedFrames: number): string {
  switch (status) {
    case "inactive":
      return "不适用";
    case "healthy":
      return "解析正常";
    case "warning":
      return `已丢弃 ${droppedFrames.toLocaleString()} 帧`;
    default:
      return "等待完整帧";
  }
}

function protocolConstraint(protocol: ProtocolKind): string {
  if (protocol === "firewater") {
    return "FireWater：每行 1–16 个有限数值，命名字段使用 : 或 =";
  }
  if (protocol === "justfloat") {
    return "JustFloat：1–16 个小端 float32，帧尾 00 00 80 7F";
  }
  return "Raw Data 不执行结构化解析";
}

function formatProtocolDropTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
