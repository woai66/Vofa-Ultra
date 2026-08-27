import { useEffect, useMemo, useRef, useState } from "react";
import { CirclePause, Eye, Gauge, Play } from "lucide-react";
import {
  CHANNEL_MONITOR_SAMPLE_LIMIT,
  calculateChannelMonitorStats,
  type ChannelMonitorStats,
} from "../core/channelMonitor";
import { presentChannelSeries } from "../core/channelPresentation";
import {
  selectActiveProtocol,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type { ChannelSeries } from "../types/workbench";

type ChannelMonitorScope = "visible" | "all";
type ChannelMonitorGroupKind = "base" | "derived" | "extension";

interface ChannelMonitorRow {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly color: string;
  readonly visible: boolean;
  readonly stats: ChannelMonitorStats;
}

interface ChannelMonitorGroup {
  readonly kind: ChannelMonitorGroupKind;
  readonly label: string;
  readonly rows: readonly ChannelMonitorRow[];
}

const GROUP_LABELS: Readonly<Record<ChannelMonitorGroupKind, string>> = {
  base: "基础通道",
  derived: "派生通道",
  extension: "扩展通道",
};

export function ChannelMonitorPanel() {
  const channels = useWorkbenchStore((state) => state.channels);
  const processedChannels = useWorkbenchStore((state) => state.processedChannels);
  const extensionChannels = useWorkbenchStore((state) => state.extensionChannels);
  const channelPresentations = useWorkbenchStore((state) => state.channelPresentations);
  const activeProtocol = useWorkbenchStore(selectActiveProtocol);
  const chartDataRevision = useWorkbenchStore((state) => state.chartDataRevision);
  const [scope, setScope] = useState<ChannelMonitorScope>("visible");
  const [frozenGroups, setFrozenGroups] = useState<readonly ChannelMonitorGroup[] | null>(null);
  const previousChartDataRevisionRef = useRef(chartDataRevision);
  const liveGroups = useMemo(
    () => [
      createMonitorGroup("base", channels, activeProtocol, channelPresentations),
      createMonitorGroup("derived", processedChannels, activeProtocol, channelPresentations),
      createMonitorGroup("extension", extensionChannels, activeProtocol, channelPresentations),
    ],
    [
      activeProtocol,
      channelPresentations,
      channels,
      extensionChannels,
      processedChannels,
    ],
  );
  const groups = frozenGroups ?? liveGroups;
  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          rows: scope === "visible" ? group.rows.filter((row) => row.visible) : group.rows,
        }))
        .filter((group) => group.rows.length > 0),
    [groups, scope],
  );
  const totalChannelCount = groups.reduce((count, group) => count + group.rows.length, 0);
  const visibleChannelCount = groups.reduce(
    (count, group) => count + group.rows.filter((row) => row.visible).length,
    0,
  );
  const displayedChannelCount = visibleGroups.reduce(
    (count, group) => count + group.rows.length,
    0,
  );
  const frozen = frozenGroups !== null;

  useEffect(() => {
    if (previousChartDataRevisionRef.current === chartDataRevision) {
      return;
    }
    previousChartDataRevisionRef.current = chartDataRevision;
    setFrozenGroups(null);
  }, [chartDataRevision]);

  const toggleFrozen = () => {
    setFrozenGroups((current) => (current ? null : liveGroups));
  };

  return (
    <section className="workspace-panel channel-monitor-panel" data-frozen={frozen}>
      <header className="panel-toolbar">
        <div className="panel-title-group">
          <Gauge size={17} />
          <div>
            <h2>通道监视</h2>
            <span className="panel-subtitle">
              {displayedChannelCount} 个通道 · 最近 {CHANNEL_MONITOR_SAMPLE_LIMIT} 点
            </span>
          </div>
          <span className="live-state" data-paused={frozen || displayedChannelCount === 0}>
            <span />
            {frozen ? "HOLD" : displayedChannelCount > 0 ? "LIVE" : "EMPTY"}
          </span>
        </div>
        <div className="panel-actions channel-monitor-actions">
          <div
            className="segmented-control channel-monitor-scope"
            role="group"
            aria-label="监视通道范围"
          >
            <button
              type="button"
              data-active={scope === "visible"}
              aria-pressed={scope === "visible"}
              onClick={() => setScope("visible")}
            >
              可见
            </button>
            <button
              type="button"
              data-active={scope === "all"}
              aria-pressed={scope === "all"}
              onClick={() => setScope("all")}
            >
              全部
            </button>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={frozen ? "继续通道监视" : "冻结通道监视"}
            title={frozen ? "继续通道监视" : "冻结通道监视"}
            aria-pressed={frozen}
            data-active={frozen}
            disabled={!frozen && displayedChannelCount === 0}
            onClick={toggleFrozen}
          >
            {frozen ? <Play size={16} /> : <CirclePause size={16} />}
          </button>
        </div>
      </header>

      {displayedChannelCount > 0 ? (
        <div className="channel-monitor-scroll">
          <table className="channel-monitor-table" aria-label="通道实时统计">
            <colgroup>
              <col className="channel-monitor-name-column" />
              <col />
              <col className="channel-monitor-delta-column" />
              <col className="channel-monitor-minimum-column" />
              <col className="channel-monitor-maximum-column" />
              <col className="channel-monitor-mean-column" />
              <col className="channel-monitor-rms-column" />
              <col className="channel-monitor-samples-column" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">通道</th>
                <th scope="col">当前</th>
                <th className="channel-monitor-delta-cell" scope="col">变化</th>
                <th className="channel-monitor-minimum-cell" scope="col">最小</th>
                <th className="channel-monitor-maximum-cell" scope="col">最大</th>
                <th className="channel-monitor-mean-cell" scope="col">均值</th>
                <th className="channel-monitor-rms-cell" scope="col">RMS</th>
                <th className="channel-monitor-samples-cell" scope="col">样本</th>
              </tr>
            </thead>
            {visibleGroups.map((group) => (
              <tbody key={group.kind} aria-label={group.label}>
                <tr className="channel-monitor-group-row">
                  <th scope="rowgroup" colSpan={8}>
                    <span>{group.label}</span>
                    <small>{group.rows.length}</small>
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <ChannelMonitorTableRow key={row.id} row={row} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : (
        <div className="panel-empty-state channel-monitor-empty-state">
          <Gauge size={30} />
          <strong>{totalChannelCount > 0 ? "没有可见通道" : "等待数值通道"}</strong>
          <span>
            {totalChannelCount > 0
              ? `已有 ${totalChannelCount} 个通道处于隐藏状态`
              : "当前数据源尚未产生有效数值"}
          </span>
          {totalChannelCount > 0 && (
            <button className="secondary-button" type="button" onClick={() => setScope("all")}>
              <Eye size={15} />
              查看全部
            </button>
          )}
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {frozen
          ? `已冻结 ${displayedChannelCount} 个通道的监视快照`
          : `正在监视 ${scope === "visible" ? visibleChannelCount : totalChannelCount} 个通道`}
      </span>
    </section>
  );
}

function ChannelMonitorTableRow({ row }: { row: ChannelMonitorRow }) {
  const deltaTrend =
    row.stats.delta === null || row.stats.delta === 0
      ? "steady"
      : row.stats.delta > 0
        ? "up"
        : "down";
  return (
    <tr className="channel-monitor-data-row">
      <th scope="row">
        <span className="channel-monitor-channel">
          <span
            className="channel-monitor-swatch"
            style={{ backgroundColor: row.color }}
            aria-hidden="true"
          />
          <span className="channel-monitor-channel-label">
            <strong>{row.name}</strong>
            <small title={row.id}>{row.unit || row.id}</small>
          </span>
        </span>
      </th>
      <td className="channel-monitor-current-cell">
        {formatMonitorValue(row.stats.current, row.unit)}
      </td>
      <td className="channel-monitor-delta-cell" data-trend={deltaTrend}>
        {formatMonitorDelta(row.stats.delta, row.unit)}
      </td>
      <td className="channel-monitor-minimum-cell">
        {formatMonitorValue(row.stats.minimum, row.unit)}
      </td>
      <td className="channel-monitor-maximum-cell">
        {formatMonitorValue(row.stats.maximum, row.unit)}
      </td>
      <td className="channel-monitor-mean-cell">
        {formatMonitorValue(row.stats.mean, row.unit)}
      </td>
      <td className="channel-monitor-rms-cell">
        {formatMonitorValue(row.stats.rms, row.unit)}
      </td>
      <td
        className="channel-monitor-samples-cell"
        title={formatSampleWindowTitle(row.stats)}
      >
        {row.stats.sampleCount}
      </td>
    </tr>
  );
}

function createMonitorGroup(
  kind: ChannelMonitorGroupKind,
  channels: readonly ChannelSeries[],
  protocol: Parameters<typeof presentChannelSeries>[1],
  presentations: Parameters<typeof presentChannelSeries>[2],
): ChannelMonitorGroup {
  const rows: ChannelMonitorRow[] = [];
  for (const channel of channels) {
    const stats = calculateChannelMonitorStats(channel);
    if (!stats) {
      continue;
    }
    const presented = presentChannelSeries(channel, protocol, presentations);
    rows.push({
      id: presented.id,
      name: presented.displayName,
      unit: presented.unit,
      color: presented.color,
      visible: presented.visible,
      stats,
    });
  }
  return { kind, label: GROUP_LABELS[kind], rows };
}

function formatMonitorValue(value: number, unit: string): string {
  const formatted = formatMonitorNumber(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatMonitorDelta(value: number | null, unit: string): string {
  if (value === null) {
    return "--";
  }
  const prefix = value > 0 ? "+" : "";
  const formatted = `${prefix}${formatMonitorNumber(value)}`;
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatMonitorNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const absolute = Math.abs(normalized);
  if (absolute >= 10_000 || (absolute > 0 && absolute < 0.001)) {
    return normalized.toExponential(2);
  }
  return normalized.toFixed(3);
}

function formatSampleWindowTitle(stats: ChannelMonitorStats): string {
  if (stats.spanSeconds === null) {
    return `${stats.sampleCount} 个有效样本`;
  }
  return `${stats.sampleCount} 个有效样本，时间跨度 ${formatDuration(stats.spanSeconds)}`;
}

function formatDuration(seconds: number): string {
  const absolute = Math.abs(seconds);
  if (absolute >= 1) {
    return `${seconds.toFixed(3)} s`;
  }
  if (absolute >= 0.001) {
    return `${(seconds * 1_000).toFixed(3)} ms`;
  }
  return `${(seconds * 1_000_000).toFixed(3)} us`;
}
