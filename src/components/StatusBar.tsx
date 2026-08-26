import { useEffect, useState } from "react";
import {
  CircleGauge,
  CirclePlay,
  Database,
  Disc3,
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
  selectActiveProtocol,
  selectActiveProtocolHealth,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type { SerialRecoveryPhase } from "../types/serial";

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
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replaySpeed = useWorkbenchStore((state) => state.replaySpeed);
  const replayPositionUs = useWorkbenchStore((state) => state.replayPositionUs);
  const replayDurationUs = useWorkbenchStore((state) => state.replayDurationUs);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedSeconds = stats.startedAt ? Math.max((now - stats.startedAt) / 1_000, 1) : 1;
  const receiveRate = stats.rxBytes / elapsedSeconds;
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
      <div className="status-item">
        <Radio size={13} />
        <span>
          {replayLoaded
            ? "VUCAP"
            : source === "simulator"
              ? "Simulator"
              : serialConfig.portName || "No port"}
        </span>
      </div>
      <div className="status-item">
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
      <div className="status-item" title="接收速率">
        <Database size={13} />
        <span>{formatBytes(receiveRate)}/s</span>
      </div>
      <div className="status-item transfer-stats">
        <span>RX {formatBytes(stats.rxBytes)}</span>
        <span>TX {formatBytes(stats.txBytes)}</span>
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
