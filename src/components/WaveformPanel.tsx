import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  CirclePause,
  Crosshair,
  LocateFixed,
  Play,
  RotateCcw,
  Ruler,
  SlidersHorizontal,
  Trash2,
  TrendingDown,
  TrendingUp,
  Waves,
  X,
} from "lucide-react";
import uPlot, { type AlignedData, type Options } from "uplot";
import type { ThemeMode } from "../App";
import { presentChannelSeries } from "../core/channelPresentation";
import type { SpectrumWindowSize } from "../core/spectrumConfig";
import {
  calculateWaveformMeasurement,
  createInitialMeasurementAnchors,
  getVisibleMeasurementPoints,
  snapToNearestMeasurementPoint,
  type WaveformMeasurementAnchors,
  type WaveformMeasurementCursor,
  type WaveformMeasurementResult,
} from "../core/waveformMeasurement";
import type {
  WaveformTriggerEdge,
  WaveformTriggerPhase,
} from "../core/waveformTrigger";
import {
  selectActiveProtocol,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type { ChannelSeries } from "../types/workbench";
import type { ChartWindowSeconds } from "../types/workspace";

const MeasurementStrip = lazy(() => import("./WaveformMeasurementStrip"));
const WaveformSpectrum = lazy(() => import("./WaveformSpectrum"));
const MIN_WAVEFORM_CHART_HEIGHT = 64;

interface WaveformPanelProps {
  theme: ThemeMode;
  onMeasurementModeChange?(enabled: boolean): void;
}

type WaveformScaleMode = "shared" | "independent";

interface WaveformFixedRange {
  minimum: number;
  maximum: number;
}

type IndependentWaveformFixedRanges = Record<string, WaveformFixedRange>;
type WaveformViewMode = "time" | "spectrum";

export function WaveformPanel({ theme, onMeasurementModeChange }: WaveformPanelProps) {
  const rawChannels = useWorkbenchStore((state) => state.channels);
  const processedChannels = useWorkbenchStore((state) => state.processedChannels);
  const extensionChannels = useWorkbenchStore((state) => state.extensionChannels);
  const channelPresentations = useWorkbenchStore((state) => state.channelPresentations);
  const activeProtocol = useWorkbenchStore(selectActiveProtocol);
  const presentedRawChannels = useMemo(
    () =>
      rawChannels.map((channel) =>
        presentChannelSeries(channel, activeProtocol, channelPresentations),
      ),
    [activeProtocol, channelPresentations, rawChannels],
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
  const channels = useMemo(
    () => [
      ...presentedRawChannels,
      ...presentedProcessedChannels,
      ...presentedExtensionChannels,
    ],
    [presentedExtensionChannels, presentedProcessedChannels, presentedRawChannels],
  );
  const emptyStateTitle = activeProtocol === "raw" ? "Raw Data 不生成波形" : "等待数据帧";
  const emptyStateDetail =
    activeProtocol === "raw" ? "原始字节保留在数据终端中" : "连接设备或启动模拟数据源";
  const triggerChannels = useMemo(
    () => [...presentedRawChannels, ...presentedProcessedChannels],
    [presentedProcessedChannels, presentedRawChannels],
  );
  const channelStructureSignature = channels
    .map((channel) => `${channel.id}:${channel.color}:${channel.visible}`)
    .join("|");
  const channelIdSignature = channels.map((channel) => channel.id).join("\u001f");
  const chartPaused = useWorkbenchStore((state) => state.chartPaused);
  const chartWindowSeconds = useWorkbenchStore((state) => state.chartWindowSeconds);
  const chartDataRevision = useWorkbenchStore((state) => state.chartDataRevision);
  const waveformTrigger = useWorkbenchStore((state) => state.waveformTrigger);
  const setChartPaused = useWorkbenchStore((state) => state.setChartPaused);
  const setChartWindowSeconds = useWorkbenchStore((state) => state.setChartWindowSeconds);
  const armWaveformTrigger = useWorkbenchStore((state) => state.armWaveformTrigger);
  const disarmWaveformTrigger = useWorkbenchStore((state) => state.disarmWaveformTrigger);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const runtimeTransitionStatus = useWorkbenchStore((state) => state.runtimeTransitionStatus);
  const isWorkspaceTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const clearChart = useWorkbenchStore((state) => state.clearChart);
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [viewMode, setViewMode] = useState<WaveformViewMode>("time");
  const [triggerControlsOpen, setTriggerControlsOpen] = useState(false);
  const [triggerChannelId, setTriggerChannelId] = useState("");
  const [triggerEdge, setTriggerEdge] = useState<WaveformTriggerEdge>("rising");
  const [triggerThreshold, setTriggerThreshold] = useState("");
  const [waveformFollowSuspended, setWaveformFollowSuspended] = useState(false);
  const [waveformScaleMode, setWaveformScaleMode] =
    useState<WaveformScaleMode>("shared");
  const [focusedScaleChannelId, setFocusedScaleChannelId] = useState("");
  const [sharedFixedRange, setSharedFixedRange] =
    useState<WaveformFixedRange | null>(null);
  const [independentFixedRanges, setIndependentFixedRanges] =
    useState<IndependentWaveformFixedRanges>({});
  const [rangeControlsOpen, setRangeControlsOpen] = useState(false);
  const [rangeMinimumDraft, setRangeMinimumDraft] = useState("");
  const [rangeMaximumDraft, setRangeMaximumDraft] = useState("");
  const [activeCursor, setActiveCursor] = useState<WaveformMeasurementCursor>("A");
  const [measurementChannelId, setMeasurementChannelId] = useState("");
  const [measurementAnchors, setMeasurementAnchors] =
    useState<WaveformMeasurementAnchors | null>(null);
  const rangeButtonRef = useRef<HTMLButtonElement>(null);
  const [spectrumChannelId, setSpectrumChannelId] = useState("");
  const [spectrumWindowSize, setSpectrumWindowSize] =
    useState<SpectrumWindowSize>(256);
  const [spectrumSampleRateInput, setSpectrumSampleRateInput] = useState("");
  const pausedBeforeMeasurementRef = useRef(false);
  const previousChartDataRevisionRef = useRef(chartDataRevision);
  const triggerConfig = waveformTrigger.config;
  const triggerRunning =
    waveformTrigger.phase === "armed" || waveformTrigger.phase === "triggered";
  const selectedTriggerChannel =
    triggerChannels.find((channel) => channel.id === triggerChannelId) ?? triggerChannels[0];
  const parsedTriggerThreshold = Number(triggerThreshold.trim());
  const canArmTrigger =
    connectionStatus === "connected" &&
    replayStatus === "idle" &&
    runtimeTransitionStatus === "idle" &&
    !isWorkspaceTransitioning &&
    selectedTriggerChannel !== undefined &&
    triggerThreshold.trim().length > 0 &&
    Number.isFinite(parsedTriggerThreshold) &&
    (!chartPaused || waveformTrigger.phase === "frozen");
  const liveState =
    replayStatus !== "idle" || chartPaused
      ? "history"
      : connectionStatus === "connected"
        ? "live"
        : connectionStatus === "connecting"
          ? "connecting"
          : "idle";
  const visibleScaleChannels = useMemo(
    () => channels.filter((channel) => channel.visible),
    [channels],
  );
  const focusedScaleChannel =
    visibleScaleChannels.find((channel) => channel.id === focusedScaleChannelId) ??
    visibleScaleChannels[0];
  const activeFixedRange =
    waveformScaleMode === "shared"
      ? sharedFixedRange
      : focusedScaleChannel
        ? independentFixedRanges[focusedScaleChannel.id] ?? null
        : null;
  const parsedRangeMinimum = parseWaveformRangeInput(rangeMinimumDraft);
  const parsedRangeMaximum = parseWaveformRangeInput(rangeMaximumDraft);
  const rangeValidationMessage = validateWaveformFixedRange(
    rangeMinimumDraft,
    rangeMaximumDraft,
  );
  const canApplyFixedRange =
    rangeValidationMessage === null &&
    parsedRangeMinimum !== null &&
    parsedRangeMaximum !== null;
  const canConfigureRange =
    waveformScaleMode === "shared"
      ? visibleScaleChannels.length > 0
      : focusedScaleChannel !== undefined;
  const measurementChannels =
    waveformScaleMode === "independent" ? visibleScaleChannels : channels;
  const selectedChannel =
    measurementChannels.find((channel) => channel.id === measurementChannelId) ??
    measurementChannels.find((channel) => channel.visible && channel.points.length > 0) ??
    measurementChannels.find((channel) => channel.points.length > 0);
  const visibleMeasurementPoints = useMemo(
    () => getVisibleMeasurementPoints(selectedChannel?.points ?? [], chartWindowSeconds),
    [chartWindowSeconds, selectedChannel?.points],
  );
  const initialMeasurementAnchors = useMemo(
    () =>
      createInitialMeasurementAnchors(
        selectedChannel?.points ?? [],
        chartWindowSeconds,
      ),
    [chartWindowSeconds, selectedChannel?.points],
  );
  const measurementResult = useMemo(
    () =>
      measurementAnchors && selectedChannel
        ? calculateWaveformMeasurement(
            selectedChannel.points,
            chartWindowSeconds,
            measurementAnchors,
          )
        : null,
    [chartWindowSeconds, measurementAnchors, selectedChannel],
  );

  useEffect(() => {
    if (triggerConfig) {
      setTriggerChannelId(triggerConfig.channelId);
      setTriggerEdge(triggerConfig.edge);
      setTriggerThreshold(formatTriggerThreshold(triggerConfig.threshold));
      setTriggerControlsOpen(true);
    }
  }, [triggerConfig]);

  useEffect(() => {
    if (waveformTrigger.phase !== "idle") {
      return;
    }
    if (triggerChannels.length === 0) {
      setTriggerChannelId("");
      return;
    }
    if (!triggerChannels.some((channel) => channel.id === triggerChannelId)) {
      const channel = triggerChannels[0];
      if (channel) {
        setTriggerChannelId(channel.id);
        setTriggerThreshold(formatTriggerThreshold(channel.lastValue));
      }
    }
  }, [triggerChannelId, triggerChannels, waveformTrigger.phase]);

  useEffect(() => {
    const nextFocusedChannelId = focusedScaleChannel?.id ?? "";
    if (focusedScaleChannelId !== nextFocusedChannelId) {
      setFocusedScaleChannelId(nextFocusedChannelId);
      setRangeControlsOpen(false);
    }
  }, [focusedScaleChannel?.id, focusedScaleChannelId]);

  useEffect(() => {
    const channelIds = new Set(
      channelIdSignature.length > 0 ? channelIdSignature.split("\u001f") : [],
    );
    setIndependentFixedRanges((current) =>
      pruneIndependentWaveformFixedRanges(current, channelIds),
    );
  }, [channelIdSignature]);

  const resetMeasurement = useCallback(
    (restorePause: boolean) => {
      setWaveformFollowSuspended(false);
      setMeasurementEnabled(false);
      onMeasurementModeChange?.(false);
      setMeasurementAnchors(null);
      setActiveCursor("A");
      if (restorePause && !pausedBeforeMeasurementRef.current) {
        setChartPaused(false);
      }
      pausedBeforeMeasurementRef.current = false;
    },
    [onMeasurementModeChange, setChartPaused],
  );

  useEffect(() => {
    if (previousChartDataRevisionRef.current === chartDataRevision) {
      return;
    }
    previousChartDataRevisionRef.current = chartDataRevision;
    setSharedFixedRange(null);
    setIndependentFixedRanges({});
    setRangeControlsOpen(false);
    if (measurementEnabled) {
      resetMeasurement(true);
    }
  }, [chartDataRevision, measurementEnabled, resetMeasurement]);

  useEffect(() => {
    setWaveformFollowSuspended(false);
  }, [
    channelStructureSignature,
    chartDataRevision,
    chartPaused,
    chartWindowSeconds,
    measurementEnabled,
    theme,
  ]);

  useEffect(() => {
    if (!measurementEnabled) {
      return;
    }
    if (!selectedChannel) {
      resetMeasurement(true);
      return;
    }
    if (selectedChannel.id !== measurementChannelId) {
      const anchors = createInitialMeasurementAnchors(
        selectedChannel.points,
        chartWindowSeconds,
      );
      if (!anchors) {
        resetMeasurement(true);
        return;
      }
      setMeasurementChannelId(selectedChannel.id);
      setMeasurementAnchors(anchors);
      setActiveCursor("A");
    }
  }, [
    chartWindowSeconds,
    measurementChannelId,
    measurementEnabled,
    resetMeasurement,
    selectedChannel,
  ]);

  const handleMeasurementToggle = () => {
    setWaveformFollowSuspended(false);
    setRangeControlsOpen(false);
    if (measurementEnabled) {
      resetMeasurement(true);
      return;
    }
    if (!selectedChannel || !initialMeasurementAnchors) {
      return;
    }
    pausedBeforeMeasurementRef.current = chartPaused;
    setTriggerControlsOpen(false);
    setChartPaused(true);
    setMeasurementChannelId(selectedChannel.id);
    setMeasurementAnchors(initialMeasurementAnchors);
    setActiveCursor("A");
    if (waveformScaleMode === "independent") {
      setFocusedScaleChannelId(selectedChannel.id);
    }
    setMeasurementEnabled(true);
    onMeasurementModeChange?.(true);
  };

  const handleChartPauseToggle = () => {
    setWaveformFollowSuspended(false);
    if (measurementEnabled && chartPaused) {
      resetMeasurement(false);
      setChartPaused(false);
      return;
    }
    setChartPaused(!chartPaused);
  };

  const handleWindowChange = (seconds: ChartWindowSeconds) => {
    setWaveformFollowSuspended(false);
    setChartWindowSeconds(seconds);
    if (!measurementEnabled || !selectedChannel) {
      return;
    }
    const anchors = createInitialMeasurementAnchors(selectedChannel.points, seconds);
    if (anchors) {
      setMeasurementAnchors(anchors);
      setActiveCursor("A");
    } else {
      resetMeasurement(true);
    }
  };

  const handleMeasurementChannelChange = (channelId: string) => {
    const channel = measurementChannels.find((candidate) => candidate.id === channelId);
    if (!channel) {
      return;
    }
    const anchors = createInitialMeasurementAnchors(channel.points, chartWindowSeconds);
    if (!anchors) {
      return;
    }
    setMeasurementChannelId(channel.id);
    setMeasurementAnchors(anchors);
    setActiveCursor("A");
    if (waveformScaleMode === "independent") {
      setWaveformFollowSuspended(false);
      setFocusedScaleChannelId(channel.id);
    }
  };

  const handleScaleModeChange = (mode: WaveformScaleMode) => {
    if (waveformScaleMode === mode) {
      return;
    }
    setWaveformFollowSuspended(false);
    setRangeControlsOpen(false);
    setWaveformScaleMode(mode);
  };

  const handleFocusedScaleChannelChange = (channelId: string) => {
    if (!visibleScaleChannels.some((channel) => channel.id === channelId)) {
      return;
    }
    setWaveformFollowSuspended(false);
    setRangeControlsOpen(false);
    setFocusedScaleChannelId(channelId);
  };

  const closeRangeControls = (restoreFocus = false) => {
    setRangeControlsOpen(false);
    if (restoreFocus) {
      globalThis.requestAnimationFrame(() => rangeButtonRef.current?.focus());
    }
  };

  const handleRangeControlsToggle = () => {
    if (rangeControlsOpen) {
      closeRangeControls(true);
      return;
    }
    if (!canConfigureRange || measurementEnabled || triggerRunning) {
      return;
    }
    setTriggerControlsOpen(false);
    setRangeMinimumDraft(
      activeFixedRange ? String(activeFixedRange.minimum) : "",
    );
    setRangeMaximumDraft(
      activeFixedRange ? String(activeFixedRange.maximum) : "",
    );
    setRangeControlsOpen(true);
  };

  const handleApplyFixedRange = () => {
    if (
      !canApplyFixedRange ||
      parsedRangeMinimum === null ||
      parsedRangeMaximum === null
    ) {
      return;
    }
    const nextRange = {
      minimum: parsedRangeMinimum,
      maximum: parsedRangeMaximum,
    };
    if (waveformScaleMode === "shared") {
      setSharedFixedRange(nextRange);
    } else if (focusedScaleChannel) {
      setIndependentFixedRanges((current) => ({
        ...current,
        [focusedScaleChannel.id]: nextRange,
      }));
    }
    closeRangeControls(true);
  };

  const handleRestoreAutomaticRange = () => {
    if (waveformScaleMode === "shared") {
      setSharedFixedRange(null);
    } else if (focusedScaleChannel) {
      setIndependentFixedRanges((current) => {
        const nextRanges = { ...current };
        delete nextRanges[focusedScaleChannel.id];
        return nextRanges;
      });
    }
    closeRangeControls(true);
  };

  const handleTriggerChannelChange = (channelId: string) => {
    const channel = triggerChannels.find((candidate) => candidate.id === channelId);
    if (!channel) {
      return;
    }
    setTriggerChannelId(channel.id);
    setTriggerThreshold(formatTriggerThreshold(channel.lastValue));
  };

  const handleTriggerAction = () => {
    if (triggerRunning) {
      disarmWaveformTrigger();
      return;
    }
    if (!selectedTriggerChannel || !canArmTrigger) {
      return;
    }
    armWaveformTrigger({
      channelId: selectedTriggerChannel.id,
      edge: triggerEdge,
      threshold: parsedTriggerThreshold,
    });
  };

  const setCursorToPoint = useCallback(
    (cursor: WaveformMeasurementCursor, timestampSeconds: number) => {
      const point = snapToNearestMeasurementPoint(
        visibleMeasurementPoints,
        timestampSeconds,
      );
      if (!point) {
        return;
      }
      setMeasurementAnchors((current) => {
        if (!current) {
          return current;
        }
        if (cursor === "A") {
          return {
            aTimestampSeconds: Math.min(
              point.timestampSeconds,
              current.bTimestampSeconds,
            ),
            bTimestampSeconds: current.bTimestampSeconds,
          };
        }
        return {
          aTimestampSeconds: current.aTimestampSeconds,
          bTimestampSeconds: Math.max(
            point.timestampSeconds,
            current.aTimestampSeconds,
          ),
        };
      });
    },
    [visibleMeasurementPoints],
  );

  const handleChartMeasurement = useCallback(
    (timestampSeconds: number) => {
      setCursorToPoint(activeCursor, timestampSeconds);
      setActiveCursor((cursor) => (cursor === "A" ? "B" : "A"));
    },
    [activeCursor, setCursorToPoint],
  );

  const handleCursorIndexChange = (
    cursor: WaveformMeasurementCursor,
    index: number,
  ) => {
    const point = visibleMeasurementPoints[index];
    if (point) {
      setCursorToPoint(cursor, point.timestampSeconds);
    }
  };

  const handleClearChart = () => {
    setWaveformFollowSuspended(false);
    setSharedFixedRange(null);
    setIndependentFixedRanges({});
    setRangeControlsOpen(false);
    if (measurementEnabled) {
      resetMeasurement(true);
    }
    clearChart();
  };

  const handleViewModeChange = (mode: WaveformViewMode) => {
    if (mode === viewMode) {
      return;
    }
    setWaveformFollowSuspended(false);
    if (mode === "spectrum") {
      if (measurementEnabled) {
        resetMeasurement(true);
      }
      setTriggerControlsOpen(false);
      setRangeControlsOpen(false);
    }
    setViewMode(mode);
  };

  return (
    <section
      className="workspace-panel waveform-panel"
      aria-labelledby="waveform-title"
      data-measuring={measurementEnabled}
      data-trigger-controls={triggerControlsOpen}
      data-trigger-phase={waveformTrigger.phase}
      data-follow-suspended={waveformFollowSuspended}
      data-scale-mode={waveformScaleMode}
      data-y-range-mode={activeFixedRange ? "fixed" : "auto"}
      data-y-range-target={
        waveformScaleMode === "shared" ? "shared" : focusedScaleChannel?.id
      }
      data-y-range-min={activeFixedRange?.minimum}
      data-y-range-max={activeFixedRange?.maximum}
      data-range-controls={rangeControlsOpen}
      data-view-mode={viewMode}
    >
      <header className="panel-toolbar">
        <div className="panel-title-group">
          <Waves size={17} />
          <div>
            <h2 id="waveform-title">{viewMode === "time" ? "实时波形" : "频谱分析"}</h2>
            <span className="panel-subtitle">{channels.length} 个通道</span>
          </div>
          <span className="live-state" data-state={liveState}>
            <span />
            {liveState.toUpperCase()}
          </span>
        </div>
        <div className="panel-actions">
          <div
            className="segmented-control compact-segments waveform-view-control"
            role="group"
            aria-label="波形视图"
          >
            <button
              type="button"
              data-active={viewMode === "time"}
              aria-pressed={viewMode === "time"}
              onClick={() => handleViewModeChange("time")}
            >
              时域
            </button>
            <button
              type="button"
              data-active={viewMode === "spectrum"}
              aria-pressed={viewMode === "spectrum"}
              onClick={() => handleViewModeChange("spectrum")}
            >
              频谱
            </button>
          </div>
          {viewMode === "time" && (
            <>
              <div className="time-window-control" role="group" aria-label="波形时间窗">
                {[5, 15, 30, 60].map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    aria-pressed={chartWindowSeconds === seconds}
                    data-active={chartWindowSeconds === seconds}
                    disabled={isWorkspaceTransitioning}
                    onClick={() => handleWindowChange(seconds as ChartWindowSeconds)}
                  >
                    {seconds}s
                  </button>
                ))}
              </div>
              <button
                className="icon-button waveform-follow-latest"
                type="button"
                aria-label="回到实时波形"
                aria-hidden={!waveformFollowSuspended}
                title={waveformFollowSuspended ? "回到实时波形" : undefined}
                data-active={waveformFollowSuspended}
                data-visible={waveformFollowSuspended}
                disabled={!waveformFollowSuspended}
                onClick={() => setWaveformFollowSuspended(false)}
              >
                <LocateFixed size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label={triggerControlsOpen ? "关闭触发设置" : "打开触发设置"}
                title={triggerControlsOpen ? "关闭触发设置" : "打开触发设置"}
                aria-expanded={triggerControlsOpen}
                aria-controls="waveform-trigger-controls"
                data-active={triggerControlsOpen || waveformTrigger.phase !== "idle"}
                disabled={measurementEnabled}
                onClick={() => {
                  setRangeControlsOpen(false);
                  setTriggerControlsOpen((open) => !open);
                }}
              >
                <Crosshair size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label={measurementEnabled ? "关闭波形测量" : "开启波形测量"}
                title={measurementEnabled ? "关闭波形测量" : "开启波形测量"}
                aria-pressed={measurementEnabled}
                data-active={measurementEnabled}
                disabled={!initialMeasurementAnchors || triggerRunning}
                onClick={handleMeasurementToggle}
              >
                <Ruler size={16} />
              </button>
            </>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label={chartPaused ? "继续波形显示" : "暂停波形显示"}
            title={chartPaused ? "继续波形显示" : "暂停波形显示"}
            onClick={handleChartPauseToggle}
          >
            {chartPaused ? <Play size={16} /> : <CirclePause size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="清空波形"
            title="清空波形"
            disabled={!channels.length}
            onClick={handleClearChart}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      {channels.length > 0 && (
        <div className="channel-strip" aria-label="通道实时值">
          <div className="waveform-scale-tools">
            <div className="waveform-scale-mode" role="group" aria-label="波形量程模式">
              <button
                type="button"
                aria-pressed={waveformScaleMode === "shared"}
                data-active={waveformScaleMode === "shared"}
                onClick={() => handleScaleModeChange("shared")}
              >
                共享
              </button>
              <button
                type="button"
                aria-pressed={waveformScaleMode === "independent"}
                data-active={waveformScaleMode === "independent"}
                onClick={() => handleScaleModeChange("independent")}
              >
                独立
              </button>
            </div>
            {waveformScaleMode === "independent" && (
              <label className="waveform-focus-channel">
                <span
                  style={{ backgroundColor: focusedScaleChannel?.color }}
                  aria-hidden="true"
                />
                <select
                  aria-label="独立量程焦点通道"
                  title="选择纵轴通道"
                  value={focusedScaleChannel?.id ?? ""}
                  disabled={visibleScaleChannels.length === 0}
                  onChange={(event) => handleFocusedScaleChannelChange(event.target.value)}
                >
                  {visibleScaleChannels.length === 0 && <option value="">无可见通道</option>}
                  {visibleScaleChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              ref={rangeButtonRef}
              className="icon-button waveform-range-button"
              type="button"
              aria-label={rangeControlsOpen ? "关闭 Y 轴量程设置" : "设置 Y 轴量程"}
              title={activeFixedRange ? "Y 轴使用固定量程" : "Y 轴使用自动量程"}
              aria-expanded={rangeControlsOpen}
              aria-controls="waveform-range-controls"
              aria-pressed={activeFixedRange !== null}
              data-active={rangeControlsOpen || activeFixedRange !== null}
              disabled={!canConfigureRange || measurementEnabled || triggerRunning}
              onClick={handleRangeControlsToggle}
            >
              <SlidersHorizontal size={15} />
            </button>
          </div>
          {channels.slice(0, 8).map((channel) => (
            <div
              key={channel.id}
              className="channel-readout"
              data-visible={channel.visible}
              data-focused={
                waveformScaleMode === "independent" &&
                channel.id === focusedScaleChannel?.id
              }
            >
              <span style={{ backgroundColor: channel.color }} />
              <small>{channel.displayName}</small>
              <strong>
                {formatValue(channel.lastValue)}
                {channel.unit && <span>{channel.unit}</span>}
              </strong>
            </div>
          ))}
        </div>
      )}

      {rangeControlsOpen && (
        <form
          id="waveform-range-controls"
          className="waveform-range-strip"
          aria-label="Y 轴量程设置"
          onSubmit={(event) => {
            event.preventDefault();
            handleApplyFixedRange();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeRangeControls(true);
            }
          }}
        >
          <div
            className="waveform-range-target"
            data-shared={waveformScaleMode === "shared"}
          >
            {waveformScaleMode === "independent" && (
              <span
                style={{ backgroundColor: focusedScaleChannel?.color }}
                aria-hidden="true"
              />
            )}
            <div>
              <strong>
                {waveformScaleMode === "shared"
                  ? "共享 Y 轴"
                  : focusedScaleChannel?.displayName ?? "无可见通道"}
              </strong>
              <small data-mode={activeFixedRange ? "fixed" : "auto"}>
                {activeFixedRange ? "FIXED" : "AUTO"}
              </small>
            </div>
          </div>
          <label className="waveform-range-field" data-field="minimum">
            <span>下限</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              aria-label="Y 轴下限"
              value={rangeMinimumDraft}
              autoFocus
              onChange={(event) => setRangeMinimumDraft(event.target.value)}
            />
          </label>
          <label className="waveform-range-field" data-field="maximum">
            <span>上限</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              aria-label="Y 轴上限"
              value={rangeMaximumDraft}
              onChange={(event) => setRangeMaximumDraft(event.target.value)}
            />
          </label>
          <span
            className="waveform-range-validation"
            role={rangeValidationMessage ? "alert" : "status"}
          >
            {rangeValidationMessage ?? "下限 < 上限"}
          </span>
          <div className="waveform-range-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={activeFixedRange === null}
              onClick={handleRestoreAutomaticRange}
            >
              <RotateCcw size={14} />
              自动
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={!canApplyFixedRange}
            >
              <Check size={14} />
              固定
            </button>
            <button
              className="icon-button compact"
              type="button"
              aria-label="关闭 Y 轴量程设置"
              title="关闭"
              onClick={() => closeRangeControls(true)}
            >
              <X size={14} />
            </button>
          </div>
        </form>
      )}

      {viewMode === "spectrum" && (
        <Suspense
          fallback={
            <>
              <div
                className="spectrum-control-strip"
                aria-label="频谱设置加载中"
                aria-busy="true"
              />
              <div className="waveform-canvas-wrap">
                <div className="panel-empty-state" role="status" aria-live="polite">
                  <Waves size={30} strokeWidth={1.4} />
                  <strong>正在加载频谱</strong>
                </div>
              </div>
            </>
          }
        >
          <WaveformSpectrum
            channels={channels}
            theme={theme}
            emptyStateTitle={emptyStateTitle}
            emptyStateDetail={emptyStateDetail}
            chartDataRevision={chartDataRevision}
            channelId={spectrumChannelId}
            windowSize={spectrumWindowSize}
            sampleRateInput={spectrumSampleRateInput}
            onChannelChange={setSpectrumChannelId}
            onWindowSizeChange={setSpectrumWindowSize}
            onSampleRateChange={setSpectrumSampleRateInput}
          />
        </Suspense>
      )}

      {viewMode === "time" && triggerControlsOpen && (
        <div
          id="waveform-trigger-controls"
          className="waveform-trigger-strip"
          data-phase={waveformTrigger.phase}
        >
          <div className="trigger-channel-control">
            <span
              className="trigger-channel-swatch"
              style={{ backgroundColor: selectedTriggerChannel?.color }}
              aria-hidden="true"
            />
            <select
              aria-label="触发通道"
              value={selectedTriggerChannel?.id ?? ""}
              disabled={triggerRunning || triggerChannels.length === 0}
              onChange={(event) => handleTriggerChannelChange(event.target.value)}
            >
              {triggerChannels.length === 0 && <option value="">无通道</option>}
              {triggerChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="trigger-edge-control" role="group" aria-label="触发边沿">
            <button
              type="button"
              aria-label="上升沿"
              title="上升沿"
              aria-pressed={triggerEdge === "rising"}
              data-active={triggerEdge === "rising"}
              disabled={triggerRunning}
              onClick={() => setTriggerEdge("rising")}
            >
              <TrendingUp size={15} />
            </button>
            <button
              type="button"
              aria-label="下降沿"
              title="下降沿"
              aria-pressed={triggerEdge === "falling"}
              data-active={triggerEdge === "falling"}
              disabled={triggerRunning}
              onClick={() => setTriggerEdge("falling")}
            >
              <TrendingDown size={15} />
            </button>
          </div>
          <label className="trigger-threshold-control">
            <span>{selectedTriggerChannel?.unit ? `阈值 (${selectedTriggerChannel.unit})` : "阈值"}</span>
            <input
              type="number"
              inputMode="decimal"
              aria-label="触发阈值"
              value={triggerThreshold}
              disabled={triggerRunning}
              onChange={(event) => setTriggerThreshold(event.target.value)}
            />
          </label>
          <span className="trigger-phase" aria-live="polite" data-phase={waveformTrigger.phase}>
            {triggerPhaseLabel(waveformTrigger.phase)}
          </span>
          <button
            className="trigger-action-button"
            type="button"
            disabled={!triggerRunning && !canArmTrigger}
            onClick={handleTriggerAction}
          >
            <Crosshair size={14} />
            {triggerActionLabel(waveformTrigger.phase)}
          </button>
        </div>
      )}

      {viewMode === "time" && measurementEnabled && selectedChannel && measurementResult && (
        <Suspense
          fallback={
            <div
              className="waveform-measurement-strip"
              aria-label="波形测量加载中"
              aria-busy="true"
            />
          }
        >
          <MeasurementStrip
            channels={measurementChannels}
            selectedChannel={selectedChannel}
            activeCursor={activeCursor}
            measurement={measurementResult}
            visiblePoints={visibleMeasurementPoints}
            onChannelChange={handleMeasurementChannelChange}
            onActiveCursorChange={setActiveCursor}
            onCursorIndexChange={handleCursorIndexChange}
          />
        </Suspense>
      )}

      {viewMode === "time" && (
        <div className="waveform-canvas-wrap">
          {channels.length === 0 ? (
            <div className="panel-empty-state">
              <Waves size={30} strokeWidth={1.4} />
              <strong>{emptyStateTitle}</strong>
              <span>{emptyStateDetail}</span>
            </div>
          ) : (
            <WaveformChart
              channels={channels}
              windowSeconds={chartWindowSeconds}
              theme={theme}
              scaleMode={waveformScaleMode}
              sharedFixedRange={sharedFixedRange}
              independentFixedRanges={independentFixedRanges}
              focusedChannelId={
                waveformScaleMode === "independent" ? focusedScaleChannel?.id ?? null : null
              }
              measurementChannelId={selectedChannel?.id ?? null}
              measurementEnabled={measurementEnabled}
              measurement={measurementResult}
              followSuspended={waveformFollowSuspended}
              canSuspendFollow={!chartPaused && !measurementEnabled}
              triggerTimestampSeconds={waveformTrigger.triggerTimestampSeconds}
              onFollowSuspend={() => {
                disarmWaveformTrigger();
                setWaveformFollowSuspended(true);
              }}
              onMeasurementSelect={handleChartMeasurement}
            />
          )}
        </div>
      )}
    </section>
  );
}

interface WaveformChartProps {
  channels: ChannelSeries[];
  windowSeconds: number;
  theme: ThemeMode;
  scaleMode: WaveformScaleMode;
  sharedFixedRange: WaveformFixedRange | null;
  independentFixedRanges: IndependentWaveformFixedRanges;
  focusedChannelId: string | null;
  measurementChannelId: string | null;
  measurementEnabled: boolean;
  measurement: WaveformMeasurementResult | null;
  followSuspended: boolean;
  canSuspendFollow: boolean;
  triggerTimestampSeconds: number | null;
  onFollowSuspend(): void;
  onMeasurementSelect(timestampSeconds: number): void;
}

interface WaveformOverlayElements {
  range: HTMLDivElement;
  cursorA: HTMLDivElement;
  cursorB: HTMLDivElement;
  pointA: HTMLSpanElement;
  pointB: HTMLSpanElement;
  triggerLine: HTMLDivElement;
}

function WaveformChart({
  channels,
  windowSeconds,
  theme,
  scaleMode,
  sharedFixedRange,
  independentFixedRanges,
  focusedChannelId,
  measurementChannelId,
  measurementEnabled,
  measurement,
  followSuspended,
  canSuspendFollow,
  triggerTimestampSeconds,
  onFollowSuspend,
  onMeasurementSelect,
}: WaveformChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const suspendedXRangeRef = useRef<[number, number] | null>(null);
  const overlayRef = useRef<WaveformOverlayElements | null>(null);
  const measurementScaleKey = waveformScaleKey(scaleMode, measurementChannelId);
  const measurementChannelColor =
    channels.find((channel) => channel.id === measurementChannelId)?.color ?? "#46d89c";
  const measurementRef = useRef({
    enabled: measurementEnabled,
    result: measurement,
    onSelect: onMeasurementSelect,
    scaleKey: measurementScaleKey,
    color: measurementChannelColor,
  });
  const followInteractionRef = useRef({ canSuspendFollow, onFollowSuspend });
  const followSuspendedRef = useRef(followSuspended);
  const triggerTimestampRef = useRef(triggerTimestampSeconds);
  const channelSignature = channels
    .map((channel) => `${channel.id}:${channel.color}:${channel.visible}`)
    .join("|");
  const fixedRangeSignature =
    scaleMode === "shared"
      ? formatWaveformFixedRangeSignature(sharedFixedRange)
      : channels
          .map((channel) =>
            `${channel.id}:${formatWaveformFixedRangeSignature(
              independentFixedRanges[channel.id] ?? null,
            )}`,
          )
          .join("|");
  const data = useMemo(
    () =>
      createAlignedData(
        channels,
        followSuspended ? Number.POSITIVE_INFINITY : windowSeconds,
      ),
    [channels, followSuspended, windowSeconds],
  );
  const channelMetadataRef = useRef(channels);
  const initialDataRef = useRef(data);
  channelMetadataRef.current = channels;
  initialDataRef.current = data;
  measurementRef.current = {
    enabled: measurementEnabled,
    result: measurement,
    onSelect: onMeasurementSelect,
    scaleKey: measurementScaleKey,
    color: measurementChannelColor,
  };
  followInteractionRef.current = { canSuspendFollow, onFollowSuspend };
  followSuspendedRef.current = followSuspended;
  triggerTimestampRef.current = triggerTimestampSeconds;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const syncWaveformOverlay = (chart: uPlot) => {
      updateWaveformOverlay(
        chart,
        overlayRef.current,
        measurementRef.current.enabled,
        measurementRef.current.result,
        measurementRef.current.scaleKey,
        measurementRef.current.color,
        triggerTimestampRef.current,
      );
    };
    let selectionCanSuspendFollow = false;
    let selectionExpiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const clearSelectionMarker = () => {
      selectionCanSuspendFollow = false;
      if (selectionExpiryTimer !== null) {
        globalThis.clearTimeout(selectionExpiryTimer);
        selectionExpiryTimer = null;
      }
    };
    const handleSelection = (chart: uPlot) => {
      clearSelectionMarker();
      selectionCanSuspendFollow =
        chart.select.width > 0 && followInteractionRef.current.canSuspendFollow;
      if (selectionCanSuspendFollow) {
        selectionExpiryTimer = globalThis.setTimeout(clearSelectionMarker, 0);
      }
      syncWaveformOverlay(chart);
    };
    const handleScale = (chart: uPlot, scaleKey: string) => {
      syncWaveformOverlay(chart);
      if (scaleKey !== "x" || !selectionCanSuspendFollow) {
        return;
      }
      clearSelectionMarker();
      followInteractionRef.current.onFollowSuspend();
    };
    const computed = getComputedStyle(container);
    const channelMetadata = channelMetadataRef.current;
    const focusedChannel = channelMetadata.find(
      (channel) => channel.visible && channel.id === focusedChannelId,
    );
    const focusedScaleKey =
      scaleMode === "shared"
        ? "y"
        : focusedChannel
          ? waveformScaleKey(scaleMode, focusedChannel.id)
          : null;
    const options: Options = {
      width: Math.max(container.clientWidth, 200),
      height: Math.max(container.clientHeight, MIN_WAVEFORM_CHART_HEIGHT),
      padding: [12, 14, 2, 0],
      cursor: {
        drag: {
          x: !measurementEnabled,
          y: false,
          setScale: !measurementEnabled,
        },
        focus: { prox: 24 },
        points: { size: 5, width: 1 },
      },
      legend: { show: false },
      scales:
        scaleMode === "shared"
          ? {
              x: { time: true },
              y: createWaveformScaleOptions(sharedFixedRange),
            }
          : {
              x: { time: true },
              ...Object.fromEntries(
                channelMetadata.map((channel) => [
                  waveformScaleKey(scaleMode, channel.id),
                  createWaveformScaleOptions(
                    independentFixedRanges[channel.id] ?? null,
                  ),
                ]),
              ),
            },
      axes: [
        {
          scale: "x",
          stroke: computed.getPropertyValue("--text-muted").trim(),
          grid: { stroke: computed.getPropertyValue("--chart-grid").trim(), width: 1 },
          ticks: { stroke: computed.getPropertyValue("--chart-grid-strong").trim(), width: 1 },
          font: "12px ui-monospace, SFMono-Regular, Consolas, monospace",
          size: 42,
        },
        ...(focusedScaleKey
          ? [
              {
                scale: focusedScaleKey,
                stroke:
                  scaleMode === "independent" && focusedChannel
                    ? focusedChannel.color
                    : computed.getPropertyValue("--text-muted").trim(),
                grid: {
                  stroke: computed.getPropertyValue("--chart-grid").trim(),
                  width: 1,
                },
                ticks: {
                  stroke: computed.getPropertyValue("--chart-grid-strong").trim(),
                  width: 1,
                },
                font: "12px ui-monospace, SFMono-Regular, Consolas, monospace",
                size: 56,
              },
            ]
          : []),
      ],
      series: [
        {},
        ...channelMetadata.map((channel) => ({
          label: channel.name,
          stroke: channel.color,
          scale: waveformScaleKey(scaleMode, channel.id),
          width: 1.8,
          show: channel.visible,
          spanGaps: true,
          points: { show: false },
        })),
      ],
      hooks: {
        draw: [syncWaveformOverlay],
        setData: [syncWaveformOverlay],
        setScale: [handleScale],
        setSelect: [handleSelection],
        setSize: [syncWaveformOverlay],
      },
    };

    const chart = new uPlot(options, initialDataRef.current, container);
    chartRef.current = chart;
    overlayRef.current = createWaveformOverlay(chart.over);
    const suspendedXRange = suspendedXRangeRef.current;
    if (followSuspendedRef.current && suspendedXRange) {
      chart.setScale("x", { min: suspendedXRange[0], max: suspendedXRange[1] });
    }
    syncWaveformOverlay(chart);
    let pointerStart: { id: number; x: number; y: number } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      if (!measurementRef.current.enabled || event.button !== 0) {
        return;
      }
      pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!measurementRef.current.enabled || pointerStart?.id !== event.pointerId) {
        pointerStart = null;
        return;
      }
      const distance = Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      );
      pointerStart = null;
      if (distance > 6) {
        return;
      }
      const rect = chart.over.getBoundingClientRect();
      const localX = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
      const timestampSeconds = chart.posToVal(localX, "x");
      if (Number.isFinite(timestampSeconds)) {
        measurementRef.current.onSelect(timestampSeconds);
      }
    };
    const handlePointerCancel = () => {
      pointerStart = null;
    };
    chart.over.addEventListener("pointerdown", handlePointerDown);
    chart.over.addEventListener("pointerup", handlePointerUp);
    chart.over.addEventListener("pointercancel", handlePointerCancel);

    const observer = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 200);
      const height = Math.max(container.clientHeight, MIN_WAVEFORM_CHART_HEIGHT);
      if (chart.width !== width || chart.height !== height) {
        chart.setSize({ width, height });
      }
    });
    observer.observe(container);

    return () => {
      clearSelectionMarker();
      observer.disconnect();
      chart.over.removeEventListener("pointerdown", handlePointerDown);
      chart.over.removeEventListener("pointerup", handlePointerUp);
      chart.over.removeEventListener("pointercancel", handlePointerCancel);
      const xMinimum = chart.scales.x?.min;
      const xMaximum = chart.scales.x?.max;
      suspendedXRangeRef.current =
        followSuspendedRef.current &&
        typeof xMinimum === "number" &&
        typeof xMaximum === "number" &&
        Number.isFinite(xMinimum) &&
        Number.isFinite(xMaximum) &&
        xMinimum < xMaximum
          ? [xMinimum, xMaximum]
          : null;
      chart.destroy();
      chartRef.current = null;
      overlayRef.current = null;
    };
  }, [
    channelSignature,
    fixedRangeSignature,
    focusedChannelId,
    independentFixedRanges,
    measurementEnabled,
    scaleMode,
    sharedFixedRange,
    theme,
  ]);

  useLayoutEffect(() => {
    chartRef.current?.setData(data, !followSuspended);
  }, [data, followSuspended]);

  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      updateWaveformOverlay(
        chart,
        overlayRef.current,
        measurementEnabled,
        measurement,
        measurementScaleKey,
        measurementChannelColor,
        triggerTimestampSeconds,
      );
    }
  }, [
    measurement,
    measurementChannelColor,
    measurementEnabled,
    measurementScaleKey,
    triggerTimestampSeconds,
  ]);

  return (
    <div
      ref={containerRef}
      className="waveform-chart"
      data-measuring={measurementEnabled}
      aria-label="实时波形图"
    />
  );
}

function createWaveformOverlay(over: HTMLDivElement): WaveformOverlayElements {
  const range = document.createElement("div");
  range.className = "waveform-measurement-range";
  const cursorA = createMeasurementCursor("A");
  const cursorB = createMeasurementCursor("B");
  const pointA = cursorA.querySelector(".waveform-measurement-point") as HTMLSpanElement;
  const pointB = cursorB.querySelector(".waveform-measurement-point") as HTMLSpanElement;
  const triggerLine = document.createElement("div");
  triggerLine.className = "waveform-trigger-line";
  const triggerLabel = document.createElement("span");
  triggerLabel.textContent = "T";
  triggerLine.append(triggerLabel);
  over.append(range, cursorA, cursorB, triggerLine);
  return { range, cursorA, cursorB, pointA, pointB, triggerLine };
}

function createMeasurementCursor(cursor: WaveformMeasurementCursor): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "waveform-measurement-cursor";
  element.dataset.cursor = cursor;
  const label = document.createElement("span");
  label.className = "waveform-measurement-label";
  label.textContent = cursor;
  const point = document.createElement("span");
  point.className = "waveform-measurement-point";
  element.append(label, point);
  return element;
}

function updateWaveformOverlay(
  chart: uPlot,
  elements: WaveformOverlayElements | null,
  enabled: boolean,
  measurement: WaveformMeasurementResult | null,
  measurementScaleKey: string,
  measurementColor: string,
  triggerTimestampSeconds: number | null,
): void {
  if (!elements) {
    return;
  }
  const triggerLeft =
    triggerTimestampSeconds === null
      ? Number.NaN
      : chart.valToPos(triggerTimestampSeconds, "x");
  elements.triggerLine.hidden = !Number.isFinite(triggerLeft);
  if (Number.isFinite(triggerLeft)) {
    elements.triggerLine.style.left = `${triggerLeft}px`;
  }
  const visible = enabled && measurement !== null;
  elements.range.hidden = !visible;
  elements.cursorA.hidden = !visible;
  elements.cursorB.hidden = !visible;
  if (!visible || !measurement) {
    return;
  }

  elements.range.style.setProperty("--measurement-channel-color", measurementColor);
  elements.cursorA.style.setProperty("--measurement-channel-color", measurementColor);
  elements.cursorB.style.setProperty("--measurement-channel-color", measurementColor);

  const leftA = chart.valToPos(measurement.pointA.timestampSeconds, "x");
  const leftB = chart.valToPos(measurement.pointB.timestampSeconds, "x");
  const topA = chart.valToPos(measurement.pointA.value, measurementScaleKey);
  const topB = chart.valToPos(measurement.pointB.value, measurementScaleKey);
  if (![leftA, leftB, topA, topB].every(Number.isFinite)) {
    elements.range.hidden = true;
    elements.cursorA.hidden = true;
    elements.cursorB.hidden = true;
    return;
  }

  elements.cursorA.style.left = `${leftA}px`;
  elements.cursorB.style.left = `${leftB}px`;
  elements.pointA.style.top = `${topA}px`;
  elements.pointB.style.top = `${topB}px`;
  elements.range.style.left = `${Math.min(leftA, leftB)}px`;
  elements.range.style.width = `${Math.abs(leftB - leftA)}px`;
}

function triggerPhaseLabel(phase: WaveformTriggerPhase): string {
  switch (phase) {
    case "idle":
      return "待机";
    case "armed":
      return "已布防";
    case "triggered":
      return "已触发";
    case "frozen":
      return "已冻结";
  }
}

function triggerActionLabel(phase: WaveformTriggerPhase): string {
  return phase === "armed" || phase === "triggered"
    ? "解除"
    : phase === "frozen"
      ? "重新布防"
      : "布防";
}

function formatTriggerThreshold(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function waveformScaleKey(
  mode: WaveformScaleMode,
  channelId: string | null,
): string {
  return mode === "independent" && channelId ? `channel:${channelId}` : "y";
}

function createWaveformScaleOptions(fixedRange: WaveformFixedRange | null) {
  if (!fixedRange) {
    return { auto: true };
  }
  return {
    auto: false,
    range: [fixedRange.minimum, fixedRange.maximum] as [number, number],
  };
}

function parseWaveformRangeInput(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateWaveformFixedRange(
  minimumDraft: string,
  maximumDraft: string,
): string | null {
  const minimum = parseWaveformRangeInput(minimumDraft);
  const maximum = parseWaveformRangeInput(maximumDraft);
  if (minimum === null || maximum === null) {
    return "请输入有限上下限";
  }
  if (minimum >= maximum) {
    return "下限必须小于上限";
  }
  return null;
}

function formatWaveformFixedRangeSignature(
  fixedRange: WaveformFixedRange | null,
): string {
  return fixedRange ? `${fixedRange.minimum}:${fixedRange.maximum}` : "auto";
}

function pruneIndependentWaveformFixedRanges(
  ranges: IndependentWaveformFixedRanges,
  channelIds: ReadonlySet<string>,
): IndependentWaveformFixedRanges {
  const entries = Object.entries(ranges);
  if (entries.every(([channelId]) => channelIds.has(channelId))) {
    return ranges;
  }
  return Object.fromEntries(
    entries.filter(([channelId]) => channelIds.has(channelId)),
  );
}

function createAlignedData(channels: ChannelSeries[], windowSeconds: number): AlignedData {
  const referencePoints = channels[0]?.points ?? [];
  const latestTime = referencePoints.at(-1)?.x ?? 0;
  const visiblePoints = referencePoints.filter((point) => point.x >= latestTime - windowSeconds);
  const timestamps = visiblePoints.map((point) => point.x);
  const values = channels.map((channel) => {
    const valueByTime = new Map(channel.points.map((point) => [point.x, point.y]));
    return timestamps.map((timestamp) => valueByTime.get(timestamp) ?? null);
  });
  return [timestamps, ...values] as AlignedData;
}

function formatValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}
