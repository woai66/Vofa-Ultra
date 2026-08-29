import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Waves } from "lucide-react";
import uPlot, { type AlignedData, type Options } from "uplot";
import type { ThemeMode } from "../App";
import type { PresentedChannelSeries } from "../core/channelPresentation";
import type { SpectrumAnalysisResult } from "../core/spectrum";
import {
  MAX_SPECTRUM_SAMPLE_RATE_HZ,
  MIN_SPECTRUM_SAMPLE_RATE_HZ,
  SPECTRUM_WINDOW_SIZES,
  type SpectrumWindowSize,
} from "../core/spectrumConfig";
import type { DataPoint } from "../types/workbench";

interface WaveformSpectrumProps {
  channels: PresentedChannelSeries[];
  theme: ThemeMode;
  emptyStateTitle: string;
  emptyStateDetail: string;
  chartDataRevision: number;
  channelId: string;
  windowSize: SpectrumWindowSize;
  sampleRateInput: string;
  onChannelChange(channelId: string): void;
  onWindowSizeChange(windowSize: SpectrumWindowSize): void;
  onSampleRateChange(value: string): void;
}

type SpectrumPanelAnalysisResult =
  | SpectrumAnalysisResult
  | { readonly status: "load-error" };
type SpectrumAnalyzer = typeof import("../core/spectrum").analyzeSpectrum;

const SPECTRUM_REFRESH_INTERVAL_MS = 100;
const MIN_SPECTRUM_CHART_HEIGHT = 64;
let spectrumAnalyzerPromise: Promise<SpectrumAnalyzer> | null = null;

export default function WaveformSpectrum({
  channels,
  theme,
  emptyStateTitle,
  emptyStateDetail,
  chartDataRevision,
  channelId,
  windowSize,
  sampleRateInput,
  onChannelChange,
  onWindowSizeChange,
  onSampleRateChange,
}: WaveformSpectrumProps) {
  const selectedChannel =
    channels.find((channel) => channel.id === channelId) ??
    channels.find((channel) => channel.visible && channel.points.length > 0) ??
    channels.find((channel) => channel.points.length > 0) ??
    channels[0];
  const sampleRateHz = parseSpectrumSampleRate(sampleRateInput);
  const analysisKey = [
    selectedChannel?.id ?? "none",
    windowSize,
    sampleRateHz ?? "invalid",
    chartDataRevision,
  ].join(":");
  const analysis = useThrottledSpectrumAnalysis(
    analysisKey,
    selectedChannel?.points,
    windowSize,
    sampleRateHz,
  );

  useEffect(() => {
    const nextChannelId = selectedChannel?.id ?? "";
    if (nextChannelId !== channelId) {
      onChannelChange(nextChannelId);
    }
  }, [channelId, onChannelChange, selectedChannel?.id]);

  return (
    <>
      <SpectrumControls
        channels={channels}
        selectedChannel={selectedChannel}
        sampleRateInput={sampleRateInput}
        sampleRateHz={sampleRateHz}
        windowSize={windowSize}
        analysis={analysis}
        onChannelChange={onChannelChange}
        onSampleRateChange={onSampleRateChange}
        onWindowSizeChange={onWindowSizeChange}
      />
      <div className="waveform-canvas-wrap">
        {channels.length === 0 ? (
          <div className="panel-empty-state">
            <Waves size={30} strokeWidth={1.4} />
            <strong>{emptyStateTitle}</strong>
            <span>{emptyStateDetail}</span>
          </div>
        ) : analysis?.status === "ok" && selectedChannel ? (
          <SpectrumChart
            analysis={analysis}
            channel={selectedChannel}
            theme={theme}
          />
        ) : (
          <SpectrumState
            analysis={analysis}
            sampleRateInput={sampleRateInput}
            sampleRateHz={sampleRateHz}
            selectedChannel={selectedChannel}
            windowSize={windowSize}
          />
        )}
      </div>
    </>
  );
}

interface SpectrumControlsProps {
  channels: PresentedChannelSeries[];
  selectedChannel: PresentedChannelSeries | undefined;
  sampleRateInput: string;
  sampleRateHz: number | null;
  windowSize: SpectrumWindowSize;
  analysis: SpectrumPanelAnalysisResult | null;
  onChannelChange(channelId: string): void;
  onSampleRateChange(value: string): void;
  onWindowSizeChange(windowSize: SpectrumWindowSize): void;
}

function SpectrumControls({
  channels,
  selectedChannel,
  sampleRateInput,
  sampleRateHz,
  windowSize,
  analysis,
  onChannelChange,
  onSampleRateChange,
  onWindowSizeChange,
}: SpectrumControlsProps) {
  const ready = analysis?.status === "ok" ? analysis : null;
  const sampleRateInvalid = sampleRateInput.trim().length > 0 && sampleRateHz === null;

  return (
    <div className="spectrum-control-strip" aria-label="频谱设置">
      <label className="spectrum-channel-control">
        <span
          className="spectrum-channel-swatch"
          style={{ backgroundColor: selectedChannel?.color }}
          aria-hidden="true"
        />
        <span className="sr-only">频谱通道</span>
        <select
          id="spectrum-channel"
          name="spectrum-channel"
          aria-label="频谱通道"
          value={selectedChannel?.id ?? ""}
          onChange={(event) => onChannelChange(event.target.value)}
        >
          {channels.length === 0 && <option value="">无通道</option>}
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="spectrum-sample-rate-control">
        <span>采样率</span>
        <input
          id="spectrum-sample-rate"
          name="spectrum-sample-rate"
          type="number"
          inputMode="decimal"
          min={MIN_SPECTRUM_SAMPLE_RATE_HZ}
          max={MAX_SPECTRUM_SAMPLE_RATE_HZ}
          step="any"
          aria-label="频谱采样率"
          aria-invalid={sampleRateInvalid}
          value={sampleRateInput}
          onChange={(event) => onSampleRateChange(event.target.value)}
        />
        <small>Hz</small>
      </label>
      <div className="spectrum-window-control" role="group" aria-label="频谱点数">
        {SPECTRUM_WINDOW_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={windowSize === size}
            data-active={windowSize === size}
            onClick={() => onWindowSizeChange(size)}
          >
            {size}
          </button>
        ))}
      </div>
      <dl className="spectrum-readouts" aria-label="频谱分析结果">
        <SpectrumReadout
          label="Fs"
          value={formatFrequency(ready?.sampleRateHz ?? sampleRateHz)}
        />
        <SpectrumReadout
          label="Δf"
          value={formatFrequency(ready?.frequencyResolutionHz ?? null)}
        />
        <SpectrumReadout
          label="Peak"
          value={formatFrequency(ready?.peakFrequencyHz ?? null)}
        />
        <SpectrumReadout
          label="Amp"
          value={ready ? formatValue(ready.peakAmplitude) : "--"}
        />
      </dl>
    </div>
  );
}

function SpectrumReadout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface SpectrumStateProps {
  analysis: SpectrumPanelAnalysisResult | null;
  sampleRateInput: string;
  sampleRateHz: number | null;
  selectedChannel: PresentedChannelSeries | undefined;
  windowSize: SpectrumWindowSize;
}

function SpectrumState({
  analysis,
  sampleRateInput,
  sampleRateHz,
  selectedChannel,
  windowSize,
}: SpectrumStateProps) {
  let title = "正在计算频谱";
  let detail = selectedChannel?.displayName ?? "";
  if (!selectedChannel) {
    title = "没有可分析通道";
    detail = "";
  } else if (sampleRateInput.trim().length === 0) {
    title = "未设置采样率";
    detail = `${MIN_SPECTRUM_SAMPLE_RATE_HZ} Hz - 1 MHz`;
  } else if (sampleRateHz === null) {
    title = "采样率超出范围";
    detail = `${MIN_SPECTRUM_SAMPLE_RATE_HZ} Hz - 1 MHz`;
  } else if (analysis?.status === "insufficient") {
    title = "样本不足";
    detail = `${analysis.availablePointCount} / ${analysis.requiredPointCount}`;
  } else if (analysis?.status === "invalid-data") {
    title = "通道数据无效";
    detail = "所选窗口包含非有限数值";
  } else if (analysis?.status === "load-error") {
    title = "频谱模块加载失败";
    detail = "FFT 计算模块不可用";
  } else if (analysis === null) {
    detail = `${selectedChannel.displayName} · ${windowSize} 点`;
  }

  return (
    <div className="panel-empty-state spectrum-state" role="status" aria-live="polite">
      <Waves size={30} strokeWidth={1.4} />
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

interface SpectrumChartProps {
  analysis: Extract<SpectrumAnalysisResult, { status: "ok" }>;
  channel: PresentedChannelSeries;
  theme: ThemeMode;
}

function SpectrumChart({ analysis, channel, theme }: SpectrumChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const data = useMemo(
    () => [analysis.frequenciesHz, analysis.amplitudes] as AlignedData,
    [analysis.amplitudes, analysis.frequenciesHz],
  );
  const initialDataRef = useRef(data);
  initialDataRef.current = data;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const computed = getComputedStyle(container);
    const options: Options = {
      width: Math.max(container.clientWidth, 200),
      height: Math.max(container.clientHeight, MIN_SPECTRUM_CHART_HEIGHT),
      padding: [12, 14, 2, 0],
      cursor: {
        drag: { x: false, y: false, setScale: false },
        focus: { prox: 24 },
        points: { size: 5, width: 1 },
      },
      legend: { show: false },
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        {
          label: "频率 (Hz)",
          stroke: computed.getPropertyValue("--text-muted").trim(),
          grid: { stroke: computed.getPropertyValue("--chart-grid").trim(), width: 1 },
          ticks: {
            stroke: computed.getPropertyValue("--chart-grid-strong").trim(),
            width: 1,
          },
          font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
          size: 42,
        },
        {
          label: "幅值",
          stroke: computed.getPropertyValue("--text-muted").trim(),
          grid: { stroke: computed.getPropertyValue("--chart-grid").trim(), width: 1 },
          ticks: {
            stroke: computed.getPropertyValue("--chart-grid-strong").trim(),
            width: 1,
          },
          font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
          size: 58,
        },
      ],
      series: [
        {},
        {
          label: channel.displayName,
          stroke: channel.color,
          width: 1.8,
          points: { show: false },
        },
      ],
    };
    const chart = new uPlot(options, initialDataRef.current, container);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 200);
      const height = Math.max(container.clientHeight, MIN_SPECTRUM_CHART_HEIGHT);
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
  }, [channel.color, channel.displayName, channel.id, theme]);

  useLayoutEffect(() => {
    chartRef.current?.setData(data, true);
  }, [data]);

  return (
    <div
      ref={containerRef}
      className="waveform-chart spectrum-chart"
      aria-label={`${channel.displayName} 频谱图`}
    />
  );
}

interface SpectrumInput {
  key: string;
  points: readonly DataPoint[] | undefined;
  windowSize: SpectrumWindowSize;
  sampleRateHz: number | null;
}

function loadSpectrumAnalyzer(): Promise<SpectrumAnalyzer> {
  if (spectrumAnalyzerPromise === null) {
    spectrumAnalyzerPromise = import("../core/spectrum")
      .then((module) => module.analyzeSpectrum)
      .catch((error: unknown) => {
        spectrumAnalyzerPromise = null;
        throw error;
      });
  }
  return spectrumAnalyzerPromise;
}

function useThrottledSpectrumAnalysis(
  key: string,
  points: readonly DataPoint[] | undefined,
  windowSize: SpectrumWindowSize,
  sampleRateHz: number | null,
): SpectrumPanelAnalysisResult | null {
  const latestInputRef = useRef<SpectrumInput>({
    key,
    points,
    windowSize,
    sampleRateHz,
  });
  const lastAnalysisAtRef = useRef(Number.NEGATIVE_INFINITY);
  const analysisGenerationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    result: SpectrumPanelAnalysisResult;
  } | null>(null);
  latestInputRef.current = { key, points, windowSize, sampleRateHz };

  useEffect(() => {
    if (!points || sampleRateHz === null) {
      analysisGenerationRef.current += 1;
      if (timerRef.current !== null) {
        globalThis.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    const runAnalysis = () => {
      timerRef.current = null;
      const input = latestInputRef.current;
      if (!input.points || input.sampleRateHz === null) {
        return;
      }
      lastAnalysisAtRef.current = performance.now();
      const analysisGeneration = ++analysisGenerationRef.current;
      void loadSpectrumAnalyzer()
        .then((analyzeSpectrum) => {
          const latestInput = latestInputRef.current;
          if (
            analysisGeneration !== analysisGenerationRef.current ||
            !latestInput.points ||
            latestInput.sampleRateHz === null
          ) {
            return;
          }
          setSnapshot({
            key: latestInput.key,
            result: analyzeSpectrum(
              latestInput.points,
              latestInput.windowSize,
              latestInput.sampleRateHz,
            ),
          });
        })
        .catch(() => {
          if (analysisGeneration === analysisGenerationRef.current) {
            setSnapshot({ key: latestInputRef.current.key, result: { status: "load-error" } });
          }
        });
    };
    if (timerRef.current !== null) {
      return;
    }
    const elapsed = performance.now() - lastAnalysisAtRef.current;
    const delay = Math.max(0, SPECTRUM_REFRESH_INTERVAL_MS - elapsed);
    if (delay === 0) {
      runAnalysis();
      return;
    }
    timerRef.current = globalThis.setTimeout(runAnalysis, delay);
  }, [key, points, sampleRateHz, windowSize]);

  useEffect(
    () => () => {
      analysisGenerationRef.current += 1;
      if (timerRef.current !== null) {
        globalThis.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  return snapshot?.key === key ? snapshot.result : null;
}

function parseSpectrumSampleRate(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const sampleRateHz = Number(value);
  return Number.isFinite(sampleRateHz) &&
    sampleRateHz >= MIN_SPECTRUM_SAMPLE_RATE_HZ &&
    sampleRateHz <= MAX_SPECTRUM_SAMPLE_RATE_HZ
    ? sampleRateHz
    : null;
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
