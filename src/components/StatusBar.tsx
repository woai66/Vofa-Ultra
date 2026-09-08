import { useEffect, useRef, useState } from "react";
import {
  CircleGauge,
  CirclePlay,
  Database,
  Disc3,
  FileSpreadsheet,
  Radio,
  RefreshCw,
  Rows3,
  TriangleAlert,
} from "lucide-react";
import {
  getProtocolDefinition,
  PROTOCOL_DROP_REASON_LABELS,
} from "../core/protocols";
import { isRecoveryActivePhase } from "../core/serialRecovery";
import {
  sampleTransferRates,
  ZERO_TRANSFER_RATES,
  type TransferRateSample,
  type TransferRates,
} from "../core/transferRate";
import {
  selectActiveProtocol,
  selectActiveProtocolHealth,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type { SerialRecoveryPhase } from "../types/serial";
import type { TransferStats } from "../types/workbench";

const TRANSFER_RATE_SAMPLE_INTERVAL_MS = 1_000;

export function StatusBar() {
  const source = useWorkbenchStore((state) => state.source);
  const activeProtocol = useWorkbenchStore(selectActiveProtocol);
  const protocolHealth = useWorkbenchStore(selectActiveProtocolHealth);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const serialConfig = useWorkbenchStore((state) => state.serialConfig);
  const serialRecovery = useWorkbenchStore((state) => state.serialRecovery);
  const stats = useWorkbenchStore((state) => state.stats);
  const channels = useWorkbenchStore((state) => state.channels);
  const processedChannels = useWorkbenchStore((state) => state.processedChannels);
  const extensionChannels = useWorkbenchStore((state) => state.extensionChannels);
  const captureStatus = useWorkbenchStore((state) => state.captureStatus);
  const captureDataBytes = useWorkbenchStore((state) => state.captureDataBytes);
  const captureMessage = useWorkbenchStore((state) => state.captureMessage);
  const numericLogStatus = useWorkbenchStore((state) => state.numericLogStatus);
  const numericLogOutputBytes = useWorkbenchStore((state) => state.numericLogOutputBytes);
  const numericLogMessage = useWorkbenchStore((state) => state.numericLogMessage);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replaySpeed = useWorkbenchStore((state) => state.replaySpeed);
  const replayPositionUs = useWorkbenchStore((state) => state.replayPositionUs);
  const replayDurationUs = useWorkbenchStore((state) => state.replayDurationUs);
  const transferRates = useTransferRates(stats);
  const replayLoaded = replaySessionId > 0 && replayStatus !== "idle";
  const recoveryActive = source === "serial" && isRecoveryActivePhase(serialRecovery.phase);
  const protocolWarning = activeProtocol !== "raw" && protocolHealth.droppedFrames > 0;

  return (
    <footer className="status-bar">
      <div
        className="status-item connection-status"
        data-status={replayLoaded ? "connected" : connectionStatus}
      >
        <span className="status-dot" />
        <span>{replayLoaded ? "回放" : connectionLabel(connectionStatus)}</span>
      </div>
      <div className="status-item source-status">
        <Radio size={13} />
        <span>
          {replayLoaded
            ? "VUCAP"
            : source === "simulator"
              ? "Simulator"
              : serialConfig.portName || "No port"}
        </span>
      </div>
      <div className="status-item protocol-status">
        <CircleGauge size={13} />
        <span>{getProtocolDefinition(activeProtocol).displayName}</span>
      </div>
      {protocolWarning && protocolHealth.lastDropReason && (
        <div
          className="status-item protocol-warning-status"
          aria-label={`协议解析已丢弃 ${protocolHealth.droppedFrames.toLocaleString()} 帧`}
          title={`最近：${PROTOCOL_DROP_REASON_LABELS[protocolHealth.lastDropReason]}`}
        >
          <TriangleAlert size={13} />
          <span>丢帧 {protocolHealth.droppedFrames.toLocaleString()}</span>
        </div>
      )}
      <div className="status-spacer" />
      {captureStatus === "recording" && (
        <div className="status-item capture-status-item">
          <Disc3 size={13} />
          <span>REC {formatBytes(captureDataBytes)}</span>
        </div>
      )}
      {captureStatus === "error" && (
        <div
          className="status-item recording-error-status"
          role="status"
          aria-label={`原始录制失败：${captureMessage || "请打开记录面板查看详情"}`}
          title={captureMessage || "原始录制失败"}
        >
          <TriangleAlert size={13} />
          <span>REC 失败</span>
        </div>
      )}
      {numericLogStatus === "recording" && (
        <div
          className="status-item numeric-log-status-item"
          aria-label={`数值 CSV 记录中：${formatBytes(numericLogOutputBytes)}`}
          title="数值 CSV 正在写入"
        >
          <FileSpreadsheet size={13} />
          <span>CSV {formatBytes(numericLogOutputBytes)}</span>
        </div>
      )}
      {numericLogStatus === "error" && (
        <div
          className="status-item recording-error-status"
          role="status"
          aria-label={`数值 CSV 记录失败：${numericLogMessage || "请打开记录面板查看详情"}`}
          title={numericLogMessage || "数值 CSV 记录失败"}
        >
          <TriangleAlert size={13} />
          <span>CSV 失败</span>
        </div>
      )}
      {recoveryActive && (
        <div className="status-item recovery-status-item" title={serialRecovery.message}>
          <RefreshCw
            size={13}
            className={serialRecovery.phase === "waiting" ? undefined : "spin"}
          />
          <span>
            {recoveryStatusLabel(serialRecovery.phase)} {serialRecovery.attempt}/
            {serialRecovery.maxAttempts}
          </span>
        </div>
      )}
      {replayLoaded && (
        <div className="status-item replay-status-item">
          <CirclePlay size={13} />
          <span>
            {replaySpeed}× {formatDuration(replayPositionUs)} / {formatDuration(replayDurationUs)}
          </span>
        </div>
      )}
      <div
        className="status-item transfer-summary"
        aria-label={transferSummaryLabel(transferRates, stats)}
        title={transferSummaryLabel(transferRates, stats)}
      >
        <Database size={13} />
        <span className="transfer-direction">
          <span>RX {formatBytes(transferRates.rxBytesPerSecond)}/s</span>
          <span className="transfer-total">· {formatBytes(stats.rxBytes)}</span>
        </span>
        <span className="transfer-direction">
          <span>TX {formatBytes(transferRates.txBytesPerSecond)}/s</span>
          <span className="transfer-total">· {formatBytes(stats.txBytes)}</span>
        </span>
      </div>
      <div className="status-item">
        <Rows3 size={13} />
        <span>
          {stats.rxFrames.toLocaleString()} 帧 ·{" "}
          {channels.length + processedChannels.length + extensionChannels.length} CH
        </span>
      </div>
    </footer>
  );
}

function useTransferRates(stats: TransferStats): TransferRates {
  const statsRef = useRef(stats);
  const sampleRef = useRef<TransferRateSample | null>(null);
  const [rates, setRates] = useState<TransferRates>(ZERO_TRANSFER_RATES);
  statsRef.current = stats;

  useEffect(() => {
    const sample = () => {
      const update = sampleTransferRates(statsRef.current, performance.now(), sampleRef.current);
      sampleRef.current = update.sample;
      setRates((current) =>
        current.rxBytesPerSecond === update.rates.rxBytesPerSecond &&
        current.txBytesPerSecond === update.rates.txBytesPerSecond
          ? current
          : update.rates,
      );
    };
    sample();
    const timer = window.setInterval(sample, TRANSFER_RATE_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const previous = sampleRef.current;
    if (
      previous &&
      (previous.startedAt !== stats.startedAt ||
        stats.rxBytes < previous.rxBytes ||
        stats.txBytes < previous.txBytes)
    ) {
      const update = sampleTransferRates(stats, performance.now(), previous);
      sampleRef.current = update.sample;
      setRates(ZERO_TRANSFER_RATES);
    }
  }, [stats]);

  return rates;
}

function transferSummaryLabel(rates: TransferRates, stats: TransferStats): string {
  return `实时传输：RX ${formatBytes(rates.rxBytesPerSecond)}/s，累计 ${formatBytes(
    stats.rxBytes,
  )}；TX ${formatBytes(rates.txBytesPerSecond)}/s，累计 ${formatBytes(stats.txBytes)}`;
}

function connectionLabel(status: string): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "error":
      return "故障";
    default:
      return "未连接";
  }
}

function recoveryStatusLabel(phase: SerialRecoveryPhase): string {
  switch (phase) {
    case "waiting":
      return "RETRY";
    case "scanning":
      return "SCAN";
    default:
      return "RECONNECT";
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatDuration(microseconds: number): string {
  const totalSeconds = Math.floor(microseconds / 1_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
