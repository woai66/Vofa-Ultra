import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Cable,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
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
import { APP_BUILD_ID, APP_DISPLAY_VERSION } from "../core/appMetadata";
import { isModbusPollActive } from "../core/modbusPoller";
import {
  BUILTIN_PROTOCOLS,
  PROTOCOL_DROP_REASON_LABELS,
} from "../core/protocols";
import { SIMULATOR_SIGNAL_DEFINITIONS } from "../core/simulator";
import { isRecoveryActivePhase } from "../core/serialRecovery";
import { presentSerialPort, sortSerialPorts } from "../core/serialPorts";
import type { ThemePreference } from "../App";
import {
  BAUD_RATES,
  type ConnectionStatus,
  type DataSource,
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
import {
  MAX_SIMULATOR_CHANNELS,
  MIN_SIMULATOR_CHANNELS,
  SIMULATOR_SAMPLE_RATES,
  type SimulatorSampleRate,
  type SimulatorSignalType,
} from "../types/simulator";
import type { SidebarPanel } from "./ActivityRail";
import { WorkspacePanel } from "./WorkspacePanel";

const CapturePanel = lazy(() =>
  import("./CapturePanel").then(({ CapturePanel }) => ({ default: CapturePanel })),
);
const AutomationPanel = lazy(() =>
  import("./AutomationPanel").then(({ AutomationPanel }) => ({ default: AutomationPanel })),
);
const ProcessingPanel = lazy(() =>
  import("./ProcessingPanel").then(({ ProcessingPanel }) => ({ default: ProcessingPanel })),
);
const ExtensionPanel = lazy(() =>
  import("./ExtensionPanel").then(({ ExtensionPanel }) => ({ default: ExtensionPanel })),
);

const MIN_BAUD_RATE = 1;
const MAX_BAUD_RATE = 12_000_000;
const MAX_BAUD_RATE_OPTIONS_HEIGHT = 260;
const MIN_BAUD_RATE_OPTIONS_HEIGHT = 42;
// 能完整展示至少四个常用值时，向下展开更符合字段阅读顺序。
const PREFERRED_BAUD_RATE_OPTIONS_HEIGHT = 152;
const BAUD_RATE_OPTIONS_GAP = 6;

interface SidebarProps {
  activePanel: SidebarPanel;
  themePreference: ThemePreference;
  onClose(): void;
  onThemePreferenceChange(theme: ThemePreference): void;
}

interface BaudRateFieldProps {
  value: number;
  disabled: boolean;
  onChange(value: number): void;
  onValidityChange(valid: boolean): void;
}

function BaudRateField({ value, disabled, onChange, onValidityChange }: BaudRateFieldProps) {
  const [draftValue, setDraftValue] = useState(String(value));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [optionsPlacement, setOptionsPlacement] = useState<"top" | "bottom">("bottom");
  const [optionsMaxHeight, setOptionsMaxHeight] = useState(MAX_BAUD_RATE_OPTIONS_HEIGHT);
  const inputRef = useRef<HTMLInputElement>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const parsedDraftValue = parseBaudRate(draftValue);

  useEffect(() => {
    setDraftValue(String(value));
    onValidityChange(true);
  }, [onValidityChange, value]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useLayoutEffect(() => {
    const combobox = comboboxRef.current;
    const options = optionsRef.current;
    const scroller = combobox?.closest<HTMLElement>(".connection-panel-scroll");
    if (!open || !combobox || !options || !scroller) {
      return;
    }

    const updatePlacement = () => {
      const comboboxRect = combobox.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const spaceAbove = Math.max(
        0,
        comboboxRect.top - scrollerRect.top - BAUD_RATE_OPTIONS_GAP - 1,
      );
      const spaceBelow = Math.max(
        0,
        scrollerRect.bottom - comboboxRect.bottom - BAUD_RATE_OPTIONS_GAP - 1,
      );
      const placement =
        spaceBelow >= PREFERRED_BAUD_RATE_OPTIONS_HEIGHT ||
        (spaceBelow >= MIN_BAUD_RATE_OPTIONS_HEIGHT && spaceBelow >= spaceAbove) ||
        spaceAbove < MIN_BAUD_RATE_OPTIONS_HEIGHT
          ? "bottom"
          : "top";
      const availableHeight = placement === "bottom" ? spaceBelow : spaceAbove;
      setOptionsPlacement(placement);
      setOptionsMaxHeight(
        Math.max(
          MIN_BAUD_RATE_OPTIONS_HEIGHT,
          Math.min(MAX_BAUD_RATE_OPTIONS_HEIGHT, Math.floor(availableHeight)),
        ),
      );
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    scroller.addEventListener("scroll", updatePlacement, { passive: true });
    return () => {
      window.removeEventListener("resize", updatePlacement);
      scroller.removeEventListener("scroll", updatePlacement);
    };
  }, [open]);

  useEffect(() => {
    const options = optionsRef.current;
    const activeOption = activeOptionRef.current;
    if (!open || !options || !activeOption) {
      return;
    }
    const optionTop = activeOption.offsetTop;
    const optionBottom = optionTop + activeOption.offsetHeight;
    if (optionTop < options.scrollTop) {
      options.scrollTop = optionTop;
    } else if (optionBottom > options.scrollTop + options.clientHeight) {
      options.scrollTop = optionBottom - options.clientHeight;
    }
  }, [activeIndex, open, optionsMaxHeight]);

  const commitDraftValue = () => {
    const parsed = parseBaudRate(draftValue);
    if (parsed === null) {
      onValidityChange(false);
      return;
    }
    setDraftValue(String(parsed));
    onValidityChange(true);
    if (parsed !== value) {
      onChange(parsed);
    }
  };

  const openPresetList = (direction: "first" | "last" | "current" = "current") => {
    const currentIndex = BAUD_RATES.findIndex((rate) => rate === value);
    setActiveIndex(
      direction === "first"
        ? 0
        : direction === "last"
          ? BAUD_RATES.length - 1
          : Math.max(0, currentIndex),
    );
    setOpen(true);
  };

  const selectPreset = (baudRate: number) => {
    setDraftValue(String(baudRate));
    onValidityChange(true);
    setOpen(false);
    if (baudRate !== value) {
      onChange(baudRate);
    }
    inputRef.current?.focus({ preventScroll: true });
  };

  const moveActivePreset = (direction: 1 | -1) => {
    if (!open) {
      const currentIndex = BAUD_RATES.findIndex((rate) => rate === value);
      const fallbackIndex = direction === 1 ? 0 : BAUD_RATES.length - 1;
      setActiveIndex(
        currentIndex < 0
          ? fallbackIndex
          : Math.min(BAUD_RATES.length - 1, Math.max(0, currentIndex + direction)),
      );
      setOpen(true);
      return;
    }
    setActiveIndex((index) =>
      Math.min(BAUD_RATES.length - 1, Math.max(0, index + direction)),
    );
  };

  return (
    <div
      className="baud-rate-field"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          commitDraftValue();
        }
      }}
    >
      <label className="field-label" htmlFor="baud-rate">
        波特率
      </label>
      <div
        ref={comboboxRef}
        className="baud-rate-combobox"
        data-invalid={parsedDraftValue === null}
        data-open={open}
      >
        <input
          ref={inputRef}
          id="baud-rate"
          name="baud-rate"
          aria-describedby="baud-rate-hint"
          aria-invalid={parsedDraftValue === null}
          aria-autocomplete="none"
          aria-controls="baud-rate-options"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-activedescendant={open ? `baud-rate-option-${BAUD_RATES[activeIndex]}` : undefined}
          role="combobox"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          autoComplete="off"
          spellCheck={false}
          value={draftValue}
          disabled={disabled}
          onChange={(event) => {
            const nextValue = event.target.value;
            setDraftValue(nextValue);
            onValidityChange(parseBaudRate(nextValue) !== null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActivePreset(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActivePreset(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (open) {
                const activeRate = BAUD_RATES[activeIndex];
                if (activeRate !== undefined) {
                  selectPreset(activeRate);
                }
              } else {
                commitDraftValue();
              }
            } else if (event.key === "Tab") {
              if (open) {
                setOpen(false);
              }
              commitDraftValue();
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (open) {
                setOpen(false);
              } else {
                setDraftValue(String(value));
                onValidityChange(true);
              }
            }
          }}
        />
        <button
          className="baud-rate-toggle"
          type="button"
          tabIndex={-1}
          aria-label={open ? "收起常用波特率" : "展开常用波特率"}
          title={open ? "收起常用波特率" : "选择常用波特率"}
          aria-controls="baud-rate-options"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              openPresetList();
            }
            inputRef.current?.focus({ preventScroll: true });
          }}
        >
          <ChevronDown aria-hidden="true" size={17} />
        </button>
        {open && (
          <div
            ref={optionsRef}
            className="baud-rate-options"
            id="baud-rate-options"
            role="listbox"
            aria-label="常用波特率"
            data-placement={optionsPlacement}
            style={{ maxHeight: `${optionsMaxHeight}px` }}
          >
            {BAUD_RATES.map((rate) => (
              <button
                key={rate}
                ref={rate === BAUD_RATES[activeIndex] ? activeOptionRef : undefined}
                id={`baud-rate-option-${rate}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={rate === value}
                data-active={rate === BAUD_RATES[activeIndex]}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(BAUD_RATES.indexOf(rate))}
                onClick={() => selectPreset(rate)}
              >
                {rate}
                {rate === value && <Check aria-hidden="true" size={15} />}
              </button>
            ))}
          </div>
        )}
      </div>
      <span
        className={parsedDraftValue === null ? "field-hint" : "sr-only"}
        id="baud-rate-hint"
      >
        请输入 1 到 12000000 之间的整数
      </span>
    </div>
  );
}

function parseBaudRate(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < MIN_BAUD_RATE || parsed > MAX_BAUD_RATE) {
    return null;
  }
  return parsed;
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
      {activePanel === "processing" && (
        <Suspense
          fallback={
            <div className="sidebar-panel" aria-label="加载中" aria-busy="true" />
          }
        >
          <ProcessingPanel />
        </Suspense>
      )}
      {activePanel === "extensions" && (
        <Suspense
          fallback={
            <div className="sidebar-panel" aria-label="加载中" aria-busy="true" />
          }
        >
          <ExtensionPanel />
        </Suspense>
      )}
      {activePanel === "automation" && (
        <Suspense
          fallback={
            <div className="sidebar-panel" aria-label="加载中" aria-busy="true" />
          }
        >
          <AutomationPanel />
        </Suspense>
      )}
      {activePanel === "capture" && (
        <Suspense
          fallback={<div className="sidebar-panel" aria-label="加载中" aria-busy="true" />}
        >
          <CapturePanel />
        </Suspense>
      )}
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
  const connectionActionError = useWorkbenchStore((state) => state.connectionActionError);
  const connectionStatusMessage = useWorkbenchStore((state) => state.connectionMessage);
  const ports = useWorkbenchStore((state) => state.ports);
  const isRefreshingPorts = useWorkbenchStore((state) => state.isRefreshingPorts);
  const serialPortDiscoveryStatus = useWorkbenchStore(
    (state) => state.serialPortDiscoveryStatus,
  );
  const serialPortDiscoveryMessage = useWorkbenchStore(
    (state) => state.serialPortDiscoveryMessage,
  );
  const config = useWorkbenchStore((state) => state.serialConfig);
  const simulatorConfig = useWorkbenchStore((state) => state.simulatorConfig);
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
  const serialRuntimeError = useWorkbenchStore((state) => state.serialRuntimeError);
  const setSource = useWorkbenchStore((state) => state.setSource);
  const setProtocol = useWorkbenchStore((state) => state.setProtocol);
  const updateConfig = useWorkbenchStore((state) => state.updateSerialConfig);
  const updateSimulatorConfig = useWorkbenchStore(
    (state) => state.updateSimulatorConfig,
  );
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
  const [baudRateDraftValid, setBaudRateDraftValid] = useState(true);

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
  const selectedPortDescription = selectedPortPresentation
    ? [
        selectedPortPresentation.primaryLabel,
        selectedPortPresentation.secondaryLabel,
        [
          selectedPortPresentation.kindLabel,
          selectedPortPresentation.usbIdentifier,
        ].filter(Boolean).join(" "),
        selectedPortPresentation.hasUniqueUsbIdentity ? "支持唯一设备识别" : "",
      ].filter(Boolean).join(" · ")
    : "";
  const serialConnectUnavailable =
    source === "serial" &&
    (selectedPortPresentation === null || !baudRateDraftValid || Boolean(serialRuntimeError));
  const simulatorConnectUnavailable = source === "simulator" && protocol === "raw";
  const connectUnavailable = serialConnectUnavailable || simulatorConnectUnavailable;
  const primaryActionDisabled =
    isCancellingSerialConnection ||
    (!canCancelConnection &&
      (isBusy || (!isConnected && connectUnavailable)));
  const connectionMessage = serialRuntimeError
    ? serialRuntimeError
    : connectionActionError
      ? connectionActionError
      : simulatorConnectUnavailable && !isConnected
        ? "Raw Data 不提供模拟，请选择串口或回放"
        : resolveConnectionMessage({
            source,
            connectionStatus,
            portName: config.portName,
            portAvailable: selectedPortPresentation !== null,
            connectionStatusMessage,
            serialRuntimeError,
            isRefreshingPorts,
            serialPortDiscoveryStatus,
            serialPortDiscoveryMessage,
            isCancelling: isCancellingSerialConnection,
            recoveryActive,
            recoveryMessage: serialRecovery.message,
          });
  const connectionMessageStatus: ConnectionStatus =
    serialRuntimeError || connectionActionError
    ? "error"
    : isCancellingSerialConnection || recoveryActive
      ? "connecting"
      : connectionStatus === "connected" || connectionStatus === "connecting"
        ? connectionStatus
        : source === "serial" && isRefreshingPorts
          ? "connecting"
          : source === "serial" && serialPortDiscoveryStatus === "error"
            ? "error"
            : source === "serial" && serialPortDiscoveryStatus !== "idle"
              ? "disconnected"
              : connectionStatus;
  let connectButtonTitle: string | undefined;
  if (!isConnected && !canCancelConnection && connectUnavailable) {
    if (simulatorConnectUnavailable) {
      connectButtonTitle = "Raw Data 不提供模拟，请选择串口或回放";
    } else if (serialRuntimeError) {
      connectButtonTitle = serialRuntimeError;
    } else if (!baudRateDraftValid) {
      connectButtonTitle = "请先输入有效波特率";
    } else if (isRefreshingPorts) {
      connectButtonTitle = "正在扫描串口设备";
    } else if (serialPortDiscoveryStatus === "error") {
      connectButtonTitle = serialPortDiscoveryMessage;
    } else if (config.portName) {
      connectButtonTitle = `${config.portName} 当前不可用，请刷新或选择其他串口`;
    } else if (serialPortDiscoveryStatus === "empty") {
      connectButtonTitle = "未发现串口设备，请连接设备后刷新";
    } else {
      connectButtonTitle = "请选择串口设备后连接";
    }
  }

  useEffect(() => {
    if (isNativeRuntime && source === "serial") {
      void refreshPorts("background");
    }
  }, [isNativeRuntime, refreshPorts, source]);

  return (
    <div className="sidebar-panel connection-panel">
      <div className="sidebar-heading">
        <div>
          <h1>设备连接</h1>
        </div>
        <Cable size={20} />
      </div>

      <div className="connection-panel-scroll">
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

      {source === "simulator" && protocol !== "raw" && (
        <section
          className="sidebar-section connection-fields simulator-fields"
          aria-label="模拟器配置"
        >
          <label className="field-label" htmlFor="simulator-signal">
            信号类型
          </label>
          <select
            id="simulator-signal"
            name="simulator-signal"
            value={simulatorConfig.signal}
            disabled={configDisabled}
            onChange={(event) =>
              updateSimulatorConfig("signal", event.target.value as SimulatorSignalType)
            }
          >
            {SIMULATOR_SIGNAL_DEFINITIONS.map(({ id, displayName }) => (
              <option key={id} value={id}>
                {displayName}
              </option>
            ))}
          </select>
          <div className="field-grid simulator-config-grid">
            <label htmlFor="simulator-channel-count">
              <span className="field-label">通道数</span>
              <input
                id="simulator-channel-count"
                name="simulator-channel-count"
                aria-label="模拟器通道数"
                type="number"
                min={MIN_SIMULATOR_CHANNELS}
                max={MAX_SIMULATOR_CHANNELS}
                step={1}
                value={simulatorConfig.channelCount}
                disabled={configDisabled}
                onChange={(event) => {
                  const channelCount = Number(event.target.value);
                  if (
                    Number.isInteger(channelCount) &&
                    channelCount >= MIN_SIMULATOR_CHANNELS &&
                    channelCount <= MAX_SIMULATOR_CHANNELS
                  ) {
                    updateSimulatorConfig("channelCount", channelCount);
                  }
                }}
              />
            </label>
            <label htmlFor="simulator-sample-rate">
              <span className="field-label">采样率</span>
              <select
                id="simulator-sample-rate"
                name="simulator-sample-rate"
                aria-label="模拟器采样率"
                value={simulatorConfig.sampleRate}
                disabled={configDisabled}
                onChange={(event) =>
                  updateSimulatorConfig(
                    "sampleRate",
                    Number(event.target.value) as SimulatorSampleRate,
                  )
                }
              >
                {SIMULATOR_SAMPLE_RATES.map((sampleRate) => (
                  <option key={sampleRate} value={sampleRate}>
                    {sampleRate} Hz
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

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
              aria-busy={isRefreshingPorts}
              title={isRefreshingPorts ? "正在刷新串口列表" : "刷新串口列表"}
              disabled={isRefreshingPorts || configDisabled || Boolean(serialRuntimeError)}
              onClick={() => void refreshPorts()}
            >
              <RefreshCw size={15} className={isRefreshingPorts ? "spin" : undefined} />
            </button>
          </div>
          <select
            id="serial-port"
            name="serial-port"
            value={config.portName}
            aria-busy={isRefreshingPorts}
            disabled={configDisabled}
            onChange={(event) => updateConfig("portName", event.target.value)}
          >
            {ports.length === 0 && (
              <option value="">{isRefreshingPorts ? "正在扫描设备" : "未发现设备"}</option>
            )}
            {config.portName && !ports.some((port) => port.name === config.portName) && (
              <option value={config.portName}>
                {config.portName} · {isConnected ? "当前连接" : "当前不可用"}
              </option>
            )}
            {sortedPorts.map((port) => (
              <option key={port.name} value={port.name}>
                {presentSerialPort(port).optionLabel}
              </option>
            ))}
          </select>
          {selectedPortPresentation && (
            <div
              className="serial-port-summary"
              role="group"
              aria-label={`已选端口信息：${selectedPortDescription}`}
              title={selectedPortDescription}
            >
              <div className="serial-port-summary-name">
                <Cable size={14} aria-hidden="true" />
                <strong>{selectedPortPresentation.primaryLabel}</strong>
              </div>
              <div className="serial-port-summary-meta">
                {selectedPortPresentation.secondaryLabel && (
                  <span>{selectedPortPresentation.secondaryLabel}</span>
                )}
                <span>
                  {selectedPortPresentation.kindLabel}
                  {selectedPortPresentation.usbIdentifier && (
                    <code>{` ${selectedPortPresentation.usbIdentifier}`}</code>
                  )}
                </span>
              </div>
            </div>
          )}

          <BaudRateField
            value={config.baudRate}
            disabled={configDisabled}
            onChange={(baudRate) => updateConfig("baudRate", baudRate)}
            onValidityChange={setBaudRateDraftValid}
          />
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

      {source === "serial" && (
        <details className="sidebar-section serial-advanced-section">
          <summary>
            <span>高级串口设置</span>
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <div className="connection-fields serial-advanced-fields">

          <div className="field-grid three-columns">
            <label htmlFor="serial-data-bits">
              <span className="field-label">数据位</span>
              <select
                id="serial-data-bits"
                name="serial-data-bits"
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
            <label htmlFor="serial-parity">
              <span className="field-label">校验</span>
              <select
                id="serial-parity"
                name="serial-parity"
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
            <label htmlFor="serial-stop-bits">
              <span className="field-label">停止位</span>
              <select
                id="serial-stop-bits"
                name="serial-stop-bits"
                value={config.stopBits}
                disabled={configDisabled}
                onChange={(event) => updateConfig("stopBits", Number(event.target.value) as 1 | 2)}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
          </div>

          <label htmlFor="serial-flow-control">
            <span className="field-label">流控</span>
            <select
              id="serial-flow-control"
              name="serial-flow-control"
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
                id="serial-dtr"
                name="serial-dtr"
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
                id="serial-rts"
                name="serial-rts"
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
          </div>
        </details>
      )}

      {source === "serial" && (
        <section className="sidebar-section recovery-section" aria-label="串口恢复">
          <label className="toggle-row recovery-toggle">
            <span>自动重连</span>
            <input
              id="serial-auto-reconnect"
              name="serial-auto-reconnect"
              type="checkbox"
              checked={serialRecovery.enabled}
              disabled={isCancellingSerialConnection || Boolean(serialRuntimeError)}
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

      </div>

      <div className="connection-action-area">
        <div
          id="serial-connection-status"
          className="connection-message"
          data-status={connectionMessageStatus}
          role="status"
        >
          <span className="status-dot" />
          <span>{connectionMessage}</span>
        </div>
        {connectButtonTitle && (
          <span id="connection-action-hint" className="sr-only">
            {connectButtonTitle}
          </span>
        )}
        <button
          className="primary-button connect-button"
          type="button"
          data-action={showCancelAction ? "cancel" : "primary"}
          aria-describedby={
            connectButtonTitle
              ? "connection-action-hint"
              : source === "serial"
                ? "serial-connection-status"
                : undefined
          }
          disabled={primaryActionDisabled}
          title={connectButtonTitle}
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
                  ? source === "serial"
                    ? "断开连接"
                    : "停止模拟"
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

interface ConnectionMessageInput {
  source: DataSource;
  connectionStatus: ConnectionStatus;
  portName: string;
  portAvailable: boolean;
  connectionStatusMessage: string;
  serialRuntimeError: string;
  isRefreshingPorts: boolean;
  serialPortDiscoveryStatus: "idle" | "ready" | "empty" | "error";
  serialPortDiscoveryMessage: string;
  isCancelling: boolean;
  recoveryActive: boolean;
  recoveryMessage: string;
}

function resolveConnectionMessage(input: ConnectionMessageInput): string {
  if (input.serialRuntimeError) {
    return input.serialRuntimeError;
  }
  if (input.isCancelling) {
    return input.recoveryActive ? "正在取消自动重连" : "正在取消串口连接";
  }
  if (input.recoveryActive) {
    return input.recoveryMessage;
  }
  if (input.connectionStatus === "connecting") {
    return (
      input.connectionStatusMessage ||
      (input.source === "serial" && input.portName
        ? `正在打开 ${input.portName}`
        : "正在启动模拟数据")
    );
  }
  if (input.connectionStatus === "connected") {
    return (
      input.connectionStatusMessage ||
      (input.source === "serial"
        ? input.portName
          ? `${input.portName} 已连接`
          : "串口已连接"
        : "模拟数据正在运行")
    );
  }
  if (input.source === "serial" && input.isRefreshingPorts) {
    return "正在扫描串口设备";
  }
  if (input.source === "simulator") {
    if (input.connectionStatus === "error") {
      return input.connectionStatusMessage || "模拟数据发生错误";
    }
    return input.connectionStatusMessage || "模拟数据源已就绪";
  }
  if (input.serialPortDiscoveryStatus !== "idle" && input.serialPortDiscoveryMessage) {
    return input.serialPortDiscoveryMessage;
  }
  if (input.connectionStatus === "error") {
    return input.connectionStatusMessage || "串口连接发生错误";
  }
  if (!input.portName) {
    return "选择设备后连接";
  }
  if (!input.portAvailable) {
    return `${input.portName} 当前不可用`;
  }
  return (
    input.connectionStatusMessage ||
    `${input.portName} 已就绪`
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
                name={`channel-${channel.id}-alias`}
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
                name={`channel-${channel.id}-unit`}
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
                  name={`channel-${channel.id}-color`}
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
    <div className="sidebar-panel settings-sidebar-panel">
      <div className="sidebar-heading">
        <div>
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
          name="chart-window-setting"
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
        <label className="toggle-row standalone" htmlFor="terminal-auto-scroll">
          <span>终端自动滚动</span>
          <input
            id="terminal-auto-scroll"
            name="terminal-auto-scroll"
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
      <section className="sidebar-section about-section" aria-labelledby="about-product-name">
        <span className="field-label">关于</span>
        <div className="about-product-line">
          <strong id="about-product-name">Vofa-Ultra</strong>
          <code>{APP_DISPLAY_VERSION}</code>
        </div>
        <p>面向嵌入式开发者的 Windows 串口与实时波形工作台。</p>
        <dl className="about-meta">
          <div>
            <dt>支持平台</dt>
            <dd>Windows 10/11 x64</dd>
          </div>
          <div>
            <dt>许可证</dt>
            <dd>MIT</dd>
          </div>
          <div>
            <dt>构建</dt>
            <dd>
              <code>{APP_BUILD_ID}</code>
            </dd>
          </div>
        </dl>
      </section>
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
  return <ChartNoAxesCombined className="empty-signal" aria-hidden="true" size={28} />;
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
