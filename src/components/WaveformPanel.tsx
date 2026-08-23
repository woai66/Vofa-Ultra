import { useLayoutEffect, useMemo, useRef } from "react";
import { CirclePause, Play, Trash2, Waves } from "lucide-react";
import uPlot, { type AlignedData, type Options } from "uplot";
import type { ThemeMode } from "../App";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ChannelSeries } from "../types/workbench";
import type { ChartWindowSeconds } from "../types/workspace";

interface WaveformPanelProps {
  theme: ThemeMode;
}

export function WaveformPanel({ theme }: WaveformPanelProps) {
  const channels = useWorkbenchStore((state) => state.channels);
  const chartPaused = useWorkbenchStore((state) => state.chartPaused);
  const chartWindowSeconds = useWorkbenchStore((state) => state.chartWindowSeconds);
  const setChartPaused = useWorkbenchStore((state) => state.setChartPaused);
  const setChartWindowSeconds = useWorkbenchStore((state) => state.setChartWindowSeconds);
  const isWorkspaceTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const clearChart = useWorkbenchStore((state) => state.clearChart);

  return (
    <section className="workspace-panel waveform-panel" aria-labelledby="waveform-title">
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
              onClick={() => setChartWindowSeconds(seconds as ChartWindowSeconds)}
              >
                {seconds}s
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={chartPaused ? "继续波形显示" : "暂停波形显示"}
            title={chartPaused ? "继续波形显示" : "暂停波形显示"}
            onClick={() => setChartPaused(!chartPaused)}
          >
            {chartPaused ? <Play size={16} /> : <CirclePause size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="清空波形"
            title="清空波形"
            disabled={!channels.length}
            onClick={clearChart}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      {channels.length > 0 && (
        <div className="channel-strip" aria-label="通道实时值">
          {channels.slice(0, 8).map((channel) => (
            <div key={channel.id} className="channel-readout" data-visible={channel.visible}>
              <span style={{ backgroundColor: channel.color }} />
              <small>{channel.name}</small>
              <strong>{formatValue(channel.lastValue)}</strong>
            </div>
          ))}
        </div>
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
          />
        )}
      </div>
    </section>
  );
}

interface WaveformChartProps {
  channels: ChannelSeries[];
  windowSeconds: number;
  theme: ThemeMode;
}

function WaveformChart({ channels, windowSeconds, theme }: WaveformChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const channelSignature = channels
    .map((channel) => `${channel.id}:${channel.color}:${channel.visible}`)
    .join("|");
  const data = useMemo(
    () => createAlignedData(channels, windowSeconds),
    [channels, windowSeconds],
  );
  const channelMetadataRef = useRef(channels);
  const initialDataRef = useRef(data);
  channelMetadataRef.current = channels;
  initialDataRef.current = data;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const computed = getComputedStyle(container);
    const channelMetadata = channelMetadataRef.current;
    const options: Options = {
      width: Math.max(container.clientWidth, 200),
      height: Math.max(container.clientHeight, 180),
      padding: [12, 14, 2, 0],
      cursor: {
        drag: { x: true, y: false, setScale: true },
        focus: { prox: 24 },
        points: { size: 5, width: 1 },
      },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: { auto: true },
      },
      axes: [
        {
          stroke: computed.getPropertyValue("--text-muted").trim(),
          grid: { stroke: computed.getPropertyValue("--chart-grid").trim(), width: 1 },
          ticks: { stroke: computed.getPropertyValue("--chart-grid-strong").trim(), width: 1 },
          font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
          size: 32,
        },
        {
          stroke: computed.getPropertyValue("--text-muted").trim(),
          grid: { stroke: computed.getPropertyValue("--chart-grid").trim(), width: 1 },
          ticks: { stroke: computed.getPropertyValue("--chart-grid-strong").trim(), width: 1 },
          font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
          size: 50,
        },
      ],
      series: [
        {},
        ...channelMetadata.map((channel) => ({
          label: channel.name,
          stroke: channel.color,
          width: 1.8,
          show: channel.visible,
          spanGaps: true,
          points: { show: false },
        })),
      ],
    };

    const chart = new uPlot(options, initialDataRef.current, container);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 200);
      const height = Math.max(container.clientHeight, 180);
      if (chart.width !== width || chart.height !== height) {
        chart.setSize({ width, height });
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
  }, [channelSignature, theme]);

  useLayoutEffect(() => {
    chartRef.current?.setData(data);
  }, [data]);

  return <div ref={containerRef} className="waveform-chart" />;
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
