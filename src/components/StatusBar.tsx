import { useEffect, useState } from "react";
import { CircleGauge, CirclePlay, Database, Disc3, Radio, Rows3 } from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";

export function StatusBar() {
  const source = useWorkbenchStore((state) => state.source);
  const protocol = useWorkbenchStore((state) => state.protocol);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const serialConfig = useWorkbenchStore((state) => state.serialConfig);
  const stats = useWorkbenchStore((state) => state.stats);
  const channels = useWorkbenchStore((state) => state.channels);
  const captureStatus = useWorkbenchStore((state) => state.captureStatus);
  const captureDataBytes = useWorkbenchStore((state) => state.captureDataBytes);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayHeader = useWorkbenchStore((state) => state.replayHeader);
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
  const activeProtocol = replayHeader?.protocol ?? protocol;

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
        <span>{protocolName(activeProtocol)}</span>
      </div>
      <div className="status-spacer" />
      {captureStatus === "recording" && (
        <div className="status-item capture-status-item">
          <Disc3 size={13} />
          <span>REC {formatBytes(captureDataBytes)}</span>
        </div>
      )}
      {replayLoaded && (
        <div className="status-item replay-status-item">
          <CirclePlay size={13} />
          <span>
            1× {formatDuration(replayPositionUs)} / {formatDuration(replayDurationUs)}
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
        <span>{stats.rxFrames.toLocaleString()} 帧 · {channels.length} CH</span>
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

function protocolName(protocol: string): string {
  switch (protocol) {
    case "firewater":
      return "FireWater";
    case "justfloat":
      return "JustFloat";
    default:
      return "Raw Data";
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
