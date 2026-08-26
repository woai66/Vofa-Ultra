import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CirclePause,
  Crosshair,
  LocateFixed,
  Play,
  Ruler,
  Trash2,
  TrendingDown,
  TrendingUp,
  Waves,
} from "lucide-react";
import uPlot, { type AlignedData, type Options } from "uplot";
import type { ThemeMode } from "../App";
import {
  presentChannelSeries,
  type PresentedChannelSeries,
} from "../core/channelPresentation";
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

interface WaveformPanelProps {
  theme: ThemeMode;
  onMeasurementModeChange?(enabled: boolean): void;
}

type WaveformScaleMode = "shared" | "independent";

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
  const triggerChannels = useMemo(
    () => [...presentedRawChannels, ...presentedProcessedChannels],
    [presentedProcessedChannels, presentedRawChannels],
  );
  const channelStructureSignature = channels
    .map((channel) => `${channel.id}:${channel.color}:${channel.visible}`)
    .join("|");
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
  const [triggerControlsOpen, setTriggerControlsOpen] = useState(false);
  const [triggerChannelId, setTriggerChannelId] = useState("");
  const [triggerEdge, setTriggerEdge] = useState<WaveformTriggerEdge>("rising");
  const [triggerThreshold, setTriggerThreshold] = useState("");
  const [waveformFollowSuspended, setWaveformFollowSuspended] = useState(false);
  const [waveformScaleMode, setWaveformScaleMode] =
    useState<WaveformScaleMode>("shared");
  const [focusedScaleChannelId, setFocusedScaleChannelId] = useState("");
  const [activeCursor, setActiveCursor] = useState<WaveformMeasurementCursor>("A");
  const [measurementChannelId, setMeasurementChannelId] = useState("");
  const [measurementAnchors, setMeasurementAnchors] =
    useState<WaveformMeasurementAnchors | null>(null);
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
  const visibleScaleChannels = useMemo(
    () => channels.filter((channel) => channel.visible),
    [channels],
  );
  const focusedScaleChannel =
    visibleScaleChannels.find((channel) => channel.id === focusedScaleChannelId) ??
    visibleScaleChannels[0];
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
    }
  }, [focusedScaleChannel?.id, focusedScaleChannelId]);

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
    setWaveformScaleMode(mode);
  };

  const handleFocusedScaleChannelChange = (channelId: string) => {
    if (!visibleScaleChannels.some((channel) => channel.id === channelId)) {
      return;
    }
    setWaveformFollowSuspended(false);
    setFocusedScaleChannelId(channelId);
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
    if (measurementEnabled) {
      resetMeasurement(true);
    }
    clearChart();
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
    >
      <header className="panel-toolbar">
        <div className="panel-title-group">
          <Waves size={17} />
          <div>
            <h2 id="waveform-title">实时波形</h2>
            <span className="panel-subtitle">{channels.length} 个通道</span>
          </div>
          <span className="live-state" data-paused={chartPaused}>
            <span />
            {chartPaused ? "HISTORY" : "LIVE"}
          </span>
        </div>
        <div className="panel-actions">
          <div className="time-window-control" role="group" aria-label="波形时间窗">
            {[5, 15, 30, 60].map((seconds) => (
              <button
                key={seconds}
                type="button"
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
            onClick={() => setTriggerControlsOpen((open) => !open)}
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

      {triggerControlsOpen && (
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

      {measurementEnabled && selectedChannel && measurementResult && (
        <MeasurementStrip
          channels={measurementChannels}
          selectedChannel={selectedChannel}
          activeCursor={activeCursor}
          measurement={measurementResult}
          sampleCount={visibleMeasurementPoints.length}
          onChannelChange={handleMeasurementChannelChange}
          onActiveCursorChange={setActiveCursor}
          onCursorIndexChange={handleCursorIndexChange}
        />
      )}

      <div className="waveform-canvas-wrap">
        {channels.length === 0 ? (
          <div className="panel-empty-state">
            <Waves size={30} strokeWidth={1.4} />
            <strong>等待数据帧</strong>
            <span>连接设备或启动模拟数据源</span>
          </div>
        ) : (
          <WaveformChart
            channels={channels}
            windowSeconds={chartWindowSeconds}
            theme={theme}
            scaleMode={waveformScaleMode}
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
    </section>
  );
}

interface MeasurementStripProps {
  channels: PresentedChannelSeries[];
  selectedChannel: PresentedChannelSeries;
  activeCursor: WaveformMeasurementCursor;
  measurement: WaveformMeasurementResult;
  sampleCount: number;
  onChannelChange(channelId: string): void;
  onActiveCursorChange(cursor: WaveformMeasurementCursor): void;
  onCursorIndexChange(cursor: WaveformMeasurementCursor, index: number): void;
}

function MeasurementStrip({
  channels,
  selectedChannel,
  activeCursor,
  measurement,
  sampleCount,
  onChannelChange,
  onActiveCursorChange,
  onCursorIndexChange,
}: MeasurementStripProps) {
  const lastIndex = Math.max(0, sampleCount - 1);

  return (
    <div className="waveform-measurement-strip">
      <div className="measurement-controls">
        <div className="measurement-primary-controls">
          <span
            className="measurement-channel-swatch"
            style={{ backgroundColor: selectedChannel.color }}
            aria-hidden="true"
          />
          <select
            id="waveform-measurement-channel"
            name="waveform-measurement-channel"
            aria-label="测量通道"
            value={selectedChannel.id}
            onChange={(event) => onChannelChange(event.target.value)}
          >
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.displayName}
              </option>
            ))}
          </select>
          <div className="measurement-cursor-selector" role="group" aria-label="当前测量游标">
            {(["A", "B"] as const).map((cursor) => (
              <button
                key={cursor}
                type="button"
                aria-pressed={activeCursor === cursor}
                data-active={activeCursor === cursor}
                onClick={() => onActiveCursorChange(cursor)}
              >
                {cursor}
              </button>
            ))}
          </div>
        </div>
        <div className="measurement-range-controls">
          <label data-cursor="A">
            <span>A</span>
            <input
              id="waveform-cursor-a"
              name="waveform-cursor-a"
              type="range"
              aria-label="游标 A 采样点"
              min={0}
              max={measurement.pointB.index}
              step={1}
              value={measurement.pointA.index}
              onChange={(event) => onCursorIndexChange("A", Number(event.target.value))}
            />
          </label>
          <label data-cursor="B">
            <span>B</span>
            <input
              id="waveform-cursor-b"
              name="waveform-cursor-b"
              type="range"
              aria-label="游标 B 采样点"
              min={measurement.pointA.index}
              max={lastIndex}
              step={1}
              value={measurement.pointB.index}
              onChange={(event) => onCursorIndexChange("B", Number(event.target.value))}
            />
          </label>
        </div>
      </div>
      <dl className="measurement-readouts" aria-label="波形测量结果" aria-live="polite">
        <MeasurementReadout label="tA" value={formatCursorTime(measurement.pointA.timestampSeconds)} />
        <MeasurementReadout label="tB" value={formatCursorTime(measurement.pointB.timestampSeconds)} />
        <MeasurementReadout label="Δt" value={formatDuration(measurement.deltaTimeSeconds)} />
        <MeasurementReadout label="1/Δt" value={formatFrequency(measurement.frequencyHz)} />
        <MeasurementReadout
          label="yA"
          value={formatValueWithUnit(measurement.pointA.value, selectedChannel.unit)}
        />
        <MeasurementReadout
          label="yB"
          value={formatValueWithUnit(measurement.pointB.value, selectedChannel.unit)}
        />
        <MeasurementReadout
          label="Δy"
          value={formatValueWithUnit(measurement.deltaY, selectedChannel.unit)}
        />
      </dl>
    </div>
  );
}

function MeasurementReadout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface WaveformChartProps {
  channels: ChannelSeries[];
  windowSeconds: number;
  theme: ThemeMode;
  scaleMode: WaveformScaleMode;
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
  const triggerTimestampRef = useRef(triggerTimestampSeconds);
  const channelSignature = channels
    .map((channel) => `${channel.id}:${channel.color}:${channel.visible}`)
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
      height: Math.max(container.clientHeight, 180),
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
              y: { auto: true },
            }
          : {
              x: { time: true },
              ...Object.fromEntries(
                channelMetadata.map((channel) => [
                  waveformScaleKey(scaleMode, channel.id),
                  { auto: true },
                ]),
              ),
            },
      axes: [
        {
          scale: "x",
          stroke: computed.getPropertyValue("--text-muted").trim(),
          grid: { stroke: computed.getPropertyValue("--chart-grid").trim(), width: 1 },
          ticks: { stroke: computed.getPropertyValue("--chart-grid-strong").trim(), width: 1 },
          font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
          size: 32,
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
                font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
                size: 50,
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
      const height = Math.max(container.clientHeight, 180);
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
      chart.destroy();
      chartRef.current = null;
      overlayRef.current = null;
    };
  }, [channelSignature, focusedChannelId, measurementEnabled, scaleMode, theme]);

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

function formatCursorTime(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1_000);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatDuration(seconds: number): string {
  if (seconds >= 1) {
    return `${seconds.toFixed(3)} s`;
  }
  if (seconds >= 0.001) {
    return `${(seconds * 1_000).toFixed(3)} ms`;
  }
  if (seconds >= 0.000_001) {
    return `${(seconds * 1_000_000).toFixed(3)} us`;
  }
  return `${(seconds * 1_000_000_000).toFixed(3)} ns`;
}

function formatFrequency(frequencyHz: number | null): string {
  if (frequencyHz === null) {
    return "--";
  }
  if (frequencyHz >= 1_000_000) {
    return `${(frequencyHz / 1_000_000).toFixed(3)} MHz`;
  }
  if (frequencyHz >= 1_000) {
    return `${(frequencyHz / 1_000).toFixed(3)} kHz`;
  }
  return `${frequencyHz.toFixed(3)} Hz`;
}

function formatValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

function formatValueWithUnit(value: number, unit: string): string {
  const formatted = formatValue(value);
  return unit ? `${formatted} ${unit}` : formatted;
}
