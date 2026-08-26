import { useMemo } from "react";
import type { PresentedChannelSeries } from "../core/channelPresentation";
import {
  calculateWaveformIntervalStatistics,
  type WaveformIntervalStatistics,
} from "../core/waveformIntervalStatistics";
import type {
  WaveformMeasurementCursor,
  WaveformMeasurementPoint,
  WaveformMeasurementResult,
} from "../core/waveformMeasurement";

interface WaveformMeasurementStripProps {
  readonly channels: readonly PresentedChannelSeries[];
  readonly selectedChannel: PresentedChannelSeries;
  readonly activeCursor: WaveformMeasurementCursor;
  readonly measurement: WaveformMeasurementResult;
  readonly visiblePoints: readonly WaveformMeasurementPoint[];
  readonly onChannelChange: (channelId: string) => void;
  readonly onActiveCursorChange: (cursor: WaveformMeasurementCursor) => void;
  readonly onCursorIndexChange: (cursor: WaveformMeasurementCursor, index: number) => void;
}

export default function WaveformMeasurementStrip({
  channels,
  selectedChannel,
  activeCursor,
  measurement,
  visiblePoints,
  onChannelChange,
  onActiveCursorChange,
  onCursorIndexChange,
}: WaveformMeasurementStripProps) {
  const lastIndex = Math.max(0, visiblePoints.length - 1);
  const statistics = useMemo(
    () =>
      calculateWaveformIntervalStatistics(
        visiblePoints,
        measurement.pointA.timestampSeconds,
        measurement.pointB.timestampSeconds,
      ),
    [
      measurement.pointA.timestampSeconds,
      measurement.pointB.timestampSeconds,
      visiblePoints,
    ],
  );

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
      <div className="measurement-result-groups">
        <dl
          className="measurement-readouts measurement-primary-readouts"
          aria-label="波形测量结果"
          aria-live="polite"
        >
          <MeasurementReadout
            label="tA"
            value={formatCursorTime(measurement.pointA.timestampSeconds)}
          />
          <MeasurementReadout
            label="tB"
            value={formatCursorTime(measurement.pointB.timestampSeconds)}
          />
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
        <StatisticsReadouts statistics={statistics} unit={selectedChannel.unit} />
      </div>
    </div>
  );
}

function StatisticsReadouts({
  statistics,
  unit,
}: {
  statistics: WaveformIntervalStatistics | null;
  unit: string;
}) {
  return (
    <dl
      className="measurement-readouts measurement-statistics"
      aria-label="A/B 区间统计"
      aria-live="polite"
    >
      <MeasurementReadout label="样本数" value={statistics ? String(statistics.sampleCount) : "--"} />
      <MeasurementReadout label="最小值" value={formatStatistic(statistics?.minimum, unit)} />
      <MeasurementReadout label="最大值" value={formatStatistic(statistics?.maximum, unit)} />
      <MeasurementReadout label="均值" value={formatStatistic(statistics?.mean, unit)} />
      <MeasurementReadout label="RMS" value={formatStatistic(statistics?.rms, unit)} />
      <MeasurementReadout label="峰峰值" value={formatStatistic(statistics?.peakToPeak, unit)} />
    </dl>
  );
}

function MeasurementReadout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
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

function formatStatistic(value: number | null | undefined, unit: string): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "--"
    : formatValueWithUnit(value, unit);
}

function formatValueWithUnit(value: number, unit: string): string {
  const formatted = formatValue(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}
