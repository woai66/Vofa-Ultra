import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleDot,
  CircleStop,
  Database,
  FileCheck2,
  FolderOpen,
  HardDrive,
  History,
  Pause,
  Play,
  RotateCcw,
  Timer,
  TriangleAlert,
  X,
} from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { CaptureUiStatus } from "../types/capture";
import type { ReplayUiStatus } from "../types/replay";

type SessionTab = "record" | "replay";

export function CapturePanel() {
  const isNativeRuntime = useWorkbenchStore((state) => state.isNativeRuntime);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const captureStatus = useWorkbenchStore((state) => state.captureStatus);
  const capturePath = useWorkbenchStore((state) => state.capturePath);
  const captureStartedAt = useWorkbenchStore((state) => state.captureStartedAt);
  const captureEndedAt = useWorkbenchStore((state) => state.captureEndedAt);
  const captureDataBytes = useWorkbenchStore((state) => state.captureDataBytes);
  const captureRecordCount = useWorkbenchStore((state) => state.captureRecordCount);
  const captureMessage = useWorkbenchStore((state) => state.captureMessage);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayPath = useWorkbenchStore((state) => state.replayPath);
  const replayHeader = useWorkbenchStore((state) => state.replayHeader);
  const replayComplete = useWorkbenchStore((state) => state.replayComplete);
  const replayPositionUs = useWorkbenchStore((state) => state.replayPositionUs);
  const replayDurationUs = useWorkbenchStore((state) => state.replayDurationUs);
  const replayDataBytes = useWorkbenchStore((state) => state.replayDataBytes);
  const replayRecordCount = useWorkbenchStore((state) => state.replayRecordCount);
  const replayMessage = useWorkbenchStore((state) => state.replayMessage);
  const workspaceTransitionStatus = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus,
  );
  const runtimeTransitionStatus = useWorkbenchStore(
    (state) => state.runtimeTransitionStatus,
  );
  const startCapture = useWorkbenchStore((state) => state.startCapture);
  const stopCapture = useWorkbenchStore((state) => state.stopCapture);
  const openReplayFile = useWorkbenchStore((state) => state.openReplayFile);
  const openRecentCapture = useWorkbenchStore((state) => state.openRecentCapture);
  const playReplay = useWorkbenchStore((state) => state.playReplay);
  const pauseReplay = useWorkbenchStore((state) => state.pauseReplay);
  const stopReplay = useWorkbenchStore((state) => state.stopReplay);
  const closeReplay = useWorkbenchStore((state) => state.closeReplay);
  const [activeTab, setActiveTab] = useState<SessionTab>(() =>
    replaySessionId > 0 ? "replay" : "record",
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (captureStatus !== "recording") {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [captureStatus]);

  const captureBusy = captureStatus === "starting" || captureStatus === "stopping";
  const isRecording = captureStatus === "recording";
  const runtimeBusy = runtimeTransitionStatus !== "idle";
  const replayLoaded = replaySessionId > 0 && replayStatus !== "idle";
  const replayRunning = ["starting", "playing", "pausing", "paused", "stopping"].includes(
    replayStatus,
  );
  const replayBusy = ["selecting", "loading", "starting", "pausing", "stopping", "closing"].includes(
    replayStatus,
  );
  const canStartCapture =
    isNativeRuntime &&
    connectionStatus === "connected" &&
    workspaceTransitionStatus === "idle" &&
    !runtimeBusy &&
    !captureBusy &&
    !replayLoaded;
  const canOpenReplay =
    isNativeRuntime && workspaceTransitionStatus === "idle" && !runtimeBusy && !captureBusy;
  const elapsedMs = captureStartedAt
    ? Math.max(0, (captureEndedAt ?? now) - captureStartedAt)
    : 0;

  return (
    <div className="sidebar-panel capture-sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">SESSION</span>
          <h1>会话记录</h1>
        </div>
        <Database size={20} />
      </div>

      <div className="session-tabs" role="tablist" aria-label="会话模式">
        <button
          id="record-tab"
          type="button"
          role="tab"
          aria-controls="record-panel"
          aria-selected={activeTab === "record"}
          data-active={activeTab === "record"}
          onClick={() => setActiveTab("record")}
        >
          录制
        </button>
        <button
          id="replay-tab"
          type="button"
          role="tab"
          aria-controls="replay-panel"
          aria-selected={activeTab === "replay"}
          data-active={activeTab === "replay"}
          onClick={() => setActiveTab("replay")}
        >
          回放
        </button>
      </div>

      {activeTab === "record" ? (
        <div id="record-panel" role="tabpanel" aria-labelledby="record-tab">
          <section className="capture-status-section" aria-label="录制状态">
            <SessionState
              status={captureStatus}
              title={captureStatusLabel(captureStatus)}
              subtitle={captureDestinationLabel(isNativeRuntime, capturePath)}
            />
            <SessionMetrics
              duration={formatDuration(elapsedMs)}
              dataBytes={captureDataBytes}
              recordCount={captureRecordCount}
            />
          </section>

          <section className="sidebar-section capture-action-section">
            {isRecording || captureStatus === "stopping" ? (
              <button
                className="danger-button capture-action-button"
                type="button"
                disabled={captureBusy || runtimeBusy}
                onClick={() => void stopCapture()}
              >
                <CircleStop size={16} />
                停止录制
              </button>
            ) : (
              <button
                className="primary-button capture-action-button"
                type="button"
                disabled={!canStartCapture}
                onClick={() => void startCapture()}
              >
                <CircleDot size={16} />
                开始录制
              </button>
            )}
            {!isNativeRuntime && (
              <span className="capture-availability">仅桌面应用支持文件录制</span>
            )}
            {isNativeRuntime && connectionStatus !== "connected" && (
              <span className="capture-availability">连接数据源后可开始录制</span>
            )}
            {replayLoaded && (
              <span className="capture-availability">关闭回放后可开始录制</span>
            )}
          </section>

          {capturePath && <SessionFile path={capturePath} />}
          {captureMessage && (
            <SessionFeedback message={captureMessage} isError={captureStatus === "error"} />
          )}
        </div>
      ) : (
        <div id="replay-panel" role="tabpanel" aria-labelledby="replay-tab">
          <section className="capture-status-section" aria-label="回放状态">
            <SessionState
              status={replayStatus}
              title={replayStatusLabel(replayStatus, runtimeTransitionStatus)}
              subtitle={replayHeader ? `${protocolName(replayHeader.protocol)} · 1×` : "VUCAP v1"}
            />
            <SessionMetrics
              duration={`${formatDurationUs(replayPositionUs)} / ${formatDurationUs(replayDurationUs)}`}
              dataBytes={replayDataBytes}
              recordCount={replayRecordCount}
            />
            {replayLoaded && (
              <progress
                className="replay-progress"
                max={Math.max(1, replayDurationUs)}
                value={Math.min(replayPositionUs, replayDurationUs)}
                aria-label="回放进度"
              />
            )}
          </section>

          <section className="sidebar-section replay-open-section">
            <button
              className="primary-button replay-open-button"
              type="button"
              disabled={!canOpenReplay}
              onClick={() => void openReplayFile()}
            >
              <FolderOpen size={16} />
              打开捕获文件
            </button>
            <button
              className="secondary-button replay-recent-button"
              type="button"
              disabled={!canOpenReplay || !capturePath}
              onClick={() => void openRecentCapture()}
            >
              <History size={16} />
              回放最近录制
            </button>
            {!isNativeRuntime && (
              <span className="capture-availability">仅桌面应用支持捕获文件回放</span>
            )}
          </section>

          {replayLoaded && (
            <section className="sidebar-section replay-control-section">
              <div className="replay-integrity" data-complete={replayComplete}>
                {replayComplete ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
                <span>{replayComplete ? "完整捕获" : "尾部不完整，仅回放有效记录"}</span>
              </div>
              <div className="replay-controls">
                {replayStatus === "playing" || replayStatus === "pausing" ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={replayBusy || runtimeBusy}
                    onClick={() => void pauseReplay()}
                  >
                    <Pause size={16} />
                    暂停
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={replayBusy || runtimeBusy || replayStatus === "error"}
                    onClick={() => void playReplay()}
                  >
                    {replayStatus === "completed" ? <RotateCcw size={16} /> : <Play size={16} />}
                    {replayStatus === "paused"
                      ? "继续"
                      : replayStatus === "completed"
                        ? "重新播放"
                        : "播放"}
                  </button>
                )}
                <button
                  className="icon-button replay-control-button"
                  type="button"
                  aria-label="停止回放"
                  title="停止回放"
                  disabled={!replayRunning || replayBusy || runtimeBusy}
                  onClick={() => void stopReplay()}
                >
                  <CircleStop size={17} />
                </button>
                <button
                  className="icon-button replay-control-button"
                  type="button"
                  aria-label="关闭回放"
                  title="关闭回放"
                  disabled={replayBusy || runtimeBusy}
                  onClick={() => void closeReplay()}
                >
                  <X size={18} />
                </button>
              </div>
            </section>
          )}

          {replayPath && <SessionFile path={replayPath} />}
          {replayMessage && (
            <SessionFeedback message={replayMessage} isError={replayStatus === "error"} />
          )}
        </div>
      )}
    </div>
  );
}

function SessionState({
  status,
  title,
  subtitle,
}: {
  status: CaptureUiStatus | ReplayUiStatus;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="capture-state" data-status={status} aria-live="polite">
      <span className="capture-state-dot" />
      <div>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
    </div>
  );
}

function SessionMetrics({
  duration,
  dataBytes,
  recordCount,
}: {
  duration: string;
  dataBytes: number;
  recordCount: number;
}) {
  return (
    <div className="capture-metrics" data-wide={duration.includes("/")}>
      <div>
        <Timer size={15} />
        <span>时长</span>
        <strong title={duration}>{duration}</strong>
      </div>
      <div>
        <HardDrive size={15} />
        <span>数据</span>
        <strong>{formatBytes(dataBytes)}</strong>
      </div>
      <div>
        <FileCheck2 size={15} />
        <span>记录</span>
        <strong>{recordCount.toLocaleString()}</strong>
      </div>
    </div>
  );
}

function SessionFile({ path }: { path: string }) {
  return (
    <section className="sidebar-section capture-file-section">
      <span className="field-label">捕获文件</span>
      <strong title={path}>{fileName(path)}</strong>
      <code title={path}>{path}</code>
    </section>
  );
}

function SessionFeedback({ message, isError }: { message: string; isError: boolean }) {
  return (
    <div
      className="workspace-feedback capture-feedback"
      role={isError ? "alert" : "status"}
      data-error={isError}
    >
      {message}
    </div>
  );
}

function captureStatusLabel(status: CaptureUiStatus): string {
  switch (status) {
    case "starting":
      return "正在创建文件";
    case "recording":
      return "正在录制";
    case "stopping":
      return "正在完成文件";
    case "error":
      return "录制异常";
    default:
      return "未录制";
  }
}

function replayStatusLabel(status: ReplayUiStatus, runtimeStatus: string): string {
  if (runtimeStatus === "selecting-replay") {
    return "正在选择文件";
  }
  switch (status) {
    case "selecting":
      return "正在选择文件";
    case "loading":
      return "正在检查文件";
    case "ready":
      return "回放已就绪";
    case "starting":
      return "正在启动回放";
    case "playing":
      return "正在回放";
    case "pausing":
      return "正在暂停";
    case "paused":
      return "回放已暂停";
    case "stopping":
      return "正在停止";
    case "completed":
      return "回放已完成";
    case "closing":
      return "正在关闭";
    case "error":
      return "回放异常";
    default:
      return "未打开文件";
  }
}

function captureDestinationLabel(isNativeRuntime: boolean, path: string): string {
  if (!isNativeRuntime) {
    return "浏览器预览";
  }
  return path ? "VUCAP v1" : "桌面文件";
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

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
}

function formatDurationUs(microseconds: number): string {
  return formatDuration(microseconds / 1_000);
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KiB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
