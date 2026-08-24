import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleDot,
  CircleStop,
  Database,
  Download,
  FileCheck2,
  FileOutput,
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
import {
  getProtocolDefinition,
  protocolSupportsReplaySeek,
} from "../core/protocols";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { CaptureUiStatus } from "../types/capture";
import type {
  CaptureExportDirection,
  CaptureExportFormat,
  CaptureExportUiStatus,
} from "../types/captureExport";
import { REPLAY_SPEEDS, type ReplaySpeed, type ReplayUiStatus } from "../types/replay";
import type { ProtocolKind } from "../types/serial";

type SessionTab = "record" | "replay" | "export";

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
  const captureExportStatus = useWorkbenchStore((state) => state.captureExportStatus);
  const captureExportPhase = useWorkbenchStore((state) => state.captureExportPhase);
  const captureExportSourcePath = useWorkbenchStore(
    (state) => state.captureExportSourcePath,
  );
  const captureExportDestinationPath = useWorkbenchStore(
    (state) => state.captureExportDestinationPath,
  );
  const captureExportFormat = useWorkbenchStore((state) => state.captureExportFormat);
  const captureExportDirection = useWorkbenchStore(
    (state) => state.captureExportDirection,
  );
  const captureExportAllowIncomplete = useWorkbenchStore(
    (state) => state.captureExportAllowIncomplete,
  );
  const captureExportTotalInputBytes = useWorkbenchStore(
    (state) => state.captureExportTotalInputBytes,
  );
  const captureExportProcessedInputBytes = useWorkbenchStore(
    (state) => state.captureExportProcessedInputBytes,
  );
  const captureExportExportedDataBytes = useWorkbenchStore(
    (state) => state.captureExportExportedDataBytes,
  );
  const captureExportExportedRecords = useWorkbenchStore(
    (state) => state.captureExportExportedRecords,
  );
  const captureExportOutputBytes = useWorkbenchStore(
    (state) => state.captureExportOutputBytes,
  );
  const captureExportSourceComplete = useWorkbenchStore(
    (state) => state.captureExportSourceComplete,
  );
  const captureExportMessage = useWorkbenchStore((state) => state.captureExportMessage);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayPath = useWorkbenchStore((state) => state.replayPath);
  const replayHeader = useWorkbenchStore((state) => state.replayHeader);
  const replayComplete = useWorkbenchStore((state) => state.replayComplete);
  const replaySpeed = useWorkbenchStore((state) => state.replaySpeed);
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
  const selectCaptureExportSource = useWorkbenchStore(
    (state) => state.selectCaptureExportSource,
  );
  const useRecentCaptureForExport = useWorkbenchStore(
    (state) => state.useRecentCaptureForExport,
  );
  const setCaptureExportFormat = useWorkbenchStore(
    (state) => state.setCaptureExportFormat,
  );
  const setCaptureExportDirection = useWorkbenchStore(
    (state) => state.setCaptureExportDirection,
  );
  const setCaptureExportAllowIncomplete = useWorkbenchStore(
    (state) => state.setCaptureExportAllowIncomplete,
  );
  const startCaptureExport = useWorkbenchStore((state) => state.startCaptureExport);
  const cancelCaptureExport = useWorkbenchStore((state) => state.cancelCaptureExport);
  const clearCaptureExport = useWorkbenchStore((state) => state.clearCaptureExport);
  const openReplayFile = useWorkbenchStore((state) => state.openReplayFile);
  const openRecentCapture = useWorkbenchStore((state) => state.openRecentCapture);
  const playReplay = useWorkbenchStore((state) => state.playReplay);
  const pauseReplay = useWorkbenchStore((state) => state.pauseReplay);
  const seekReplay = useWorkbenchStore((state) => state.seekReplay);
  const setReplaySpeed = useWorkbenchStore((state) => state.setReplaySpeed);
  const stopReplay = useWorkbenchStore((state) => state.stopReplay);
  const closeReplay = useWorkbenchStore((state) => state.closeReplay);
  const [activeTab, setActiveTab] = useState<SessionTab>(() =>
    replaySessionId > 0 ? "replay" : "record",
  );
  const [now, setNow] = useState(Date.now());
  const [replaySeekDraftUs, setReplaySeekDraftUs] = useState(replayPositionUs);
  const replaySeekDraftRef = useRef(replayPositionUs);
  const replaySeekDirtyRef = useRef(false);

  useEffect(() => {
    if (captureStatus !== "recording") {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [captureStatus]);

  useEffect(() => {
    if (replayStatus === "seeking" || replaySeekDirtyRef.current) {
      return;
    }
    const positionUs = Math.min(replayPositionUs, replayDurationUs);
    replaySeekDraftRef.current = positionUs;
    setReplaySeekDraftUs(positionUs);
  }, [replayDurationUs, replayPositionUs, replaySessionId, replayStatus]);

  const captureBusy = captureStatus === "starting" || captureStatus === "stopping";
  const isRecording = captureStatus === "recording";
  const runtimeBusy = runtimeTransitionStatus !== "idle";
  const replayLoaded = replaySessionId > 0 && replayStatus !== "idle";
  const replayRunning = [
    "starting",
    "playing",
    "pausing",
    "paused",
    "seeking",
    "stopping",
  ].includes(replayStatus);
  const replayBusy = [
    "selecting",
    "loading",
    "starting",
    "pausing",
    "seeking",
    "stopping",
    "closing",
  ].includes(replayStatus);
  const canInterruptReplay = replayStatus === "seeking";
  const canSeekReplay =
    replayHeader !== undefined &&
    protocolSupportsReplaySeek(replayHeader.protocol) &&
    ["ready", "paused", "completed"].includes(replayStatus) &&
    !runtimeBusy;
  const canSetReplaySpeed =
    ["ready", "playing", "paused", "completed"].includes(replayStatus) && !runtimeBusy;
  const replaySeekStepUs = Math.max(1, Math.floor(replayDurationUs / 1_000));
  const replayDisplayPositionUs =
    replaySeekDirtyRef.current || replayStatus === "seeking"
      ? replaySeekDraftUs
      : replayPositionUs;
  const canStartCapture =
    isNativeRuntime &&
    connectionStatus === "connected" &&
    workspaceTransitionStatus === "idle" &&
    !runtimeBusy &&
    !captureBusy &&
    !replayLoaded;
  const canOpenReplay =
    isNativeRuntime && workspaceTransitionStatus === "idle" && !runtimeBusy && !captureBusy;
  const captureActive = isRecording || captureBusy;
  const exportBusy = [
    "selecting-source",
    "selecting-destination",
    "starting",
    "running",
    "cancelling",
  ].includes(captureExportStatus);
  const canChooseExportSource = isNativeRuntime && !captureActive && !exportBusy;
  const canStartExport = canChooseExportSource && Boolean(captureExportSourcePath);
  const exportHasResult = ["completed", "cancelled", "error"].includes(
    captureExportStatus,
  );
  const elapsedMs = captureStartedAt
    ? Math.max(0, (captureEndedAt ?? now) - captureStartedAt)
    : 0;

  const updateReplaySeekDraft = (value: string) => {
    const targetUs = Math.min(replayDurationUs, Math.max(0, Number(value)));
    replaySeekDirtyRef.current = true;
    replaySeekDraftRef.current = targetUs;
    setReplaySeekDraftUs(targetUs);
  };
  const commitReplaySeek = () => {
    if (!replaySeekDirtyRef.current || !canSeekReplay) {
      return;
    }
    replaySeekDirtyRef.current = false;
    void seekReplay(replaySeekDraftRef.current);
  };
  const cancelReplaySeekDraft = () => {
    replaySeekDirtyRef.current = false;
    replaySeekDraftRef.current = replayPositionUs;
    setReplaySeekDraftUs(replayPositionUs);
  };
  const updateReplaySpeed = (value: string) => {
    const nextSpeed = REPLAY_SPEEDS.find((speed) => speed === Number(value));
    if (nextSpeed !== undefined) {
      void setReplaySpeed(nextSpeed);
    }
  };

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
        <button
          id="export-tab"
          type="button"
          role="tab"
          aria-controls="export-panel"
          aria-selected={activeTab === "export"}
          data-active={activeTab === "export"}
          onClick={() => setActiveTab("export")}
        >
          导出
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
      ) : activeTab === "replay" ? (
        <div id="replay-panel" role="tabpanel" aria-labelledby="replay-tab">
          <section className="capture-status-section" aria-label="回放状态">
            <SessionState
              status={replayStatus}
              title={replayStatusLabel(replayStatus, runtimeTransitionStatus)}
              subtitle={
                replayHeader
                  ? `${getProtocolDefinition(replayHeader.protocol).displayName} · ${replaySpeed}×`
                  : "VUCAP v1"
              }
            />
            <SessionMetrics
              duration={`${formatDurationUs(replayDisplayPositionUs)} / ${formatDurationUs(replayDurationUs)}`}
              dataBytes={replayDataBytes}
              recordCount={replayRecordCount}
            />
            {replayLoaded && (
              <input
                className="replay-seek-slider"
                type="range"
                min={0}
                max={Math.max(1, replayDurationUs)}
                step={replaySeekStepUs}
                value={Math.min(replaySeekDraftUs, replayDurationUs)}
                aria-label="回放位置"
                aria-valuetext={`${formatDurationUs(replayDisplayPositionUs)} / ${formatDurationUs(replayDurationUs)}`}
                title={replaySeekTitle(replayHeader?.protocol, replayStatus)}
                disabled={!canSeekReplay}
                onChange={(event) => updateReplaySeekDraft(event.currentTarget.value)}
                onPointerUp={commitReplaySeek}
                onPointerCancel={cancelReplaySeekDraft}
                onKeyUp={commitReplaySeek}
                onBlur={commitReplaySeek}
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
              <label className="replay-speed-control" htmlFor="replay-speed">
                <span className="field-label">倍速</span>
                <select
                  id="replay-speed"
                  aria-label="回放倍速"
                  value={replaySpeed}
                  disabled={!canSetReplaySpeed}
                  onChange={(event) => updateReplaySpeed(event.currentTarget.value)}
                >
                  {REPLAY_SPEEDS.map((speed: ReplaySpeed) => (
                    <option key={speed} value={speed}>
                      {speed}×
                    </option>
                  ))}
                </select>
              </label>
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
                  disabled={
                    !replayRunning || (replayBusy && !canInterruptReplay) || runtimeBusy
                  }
                  onClick={() => void stopReplay()}
                >
                  <CircleStop size={17} />
                </button>
                <button
                  className="icon-button replay-control-button"
                  type="button"
                  aria-label="关闭回放"
                  title="关闭回放"
                  disabled={(replayBusy && !canInterruptReplay) || runtimeBusy}
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
      ) : (
        <div id="export-panel" role="tabpanel" aria-labelledby="export-tab">
          <section className="capture-status-section" aria-label="导出状态">
            <SessionState
              status={captureExportStatus}
              title={captureExportStatusLabel(captureExportStatus, captureExportPhase)}
              subtitle={`${captureExportFormatName(captureExportFormat)} · ${captureExportDirectionLabel(
                captureExportDirection,
              )}`}
            />
            <ExportMetrics
              inputBytes={captureExportProcessedInputBytes}
              totalInputBytes={captureExportTotalInputBytes}
              outputBytes={captureExportOutputBytes}
              dataBytes={captureExportExportedDataBytes}
              recordCount={captureExportExportedRecords}
            />
            {(exportBusy || exportHasResult) && captureExportTotalInputBytes > 0 && (
              <progress
                className="replay-progress export-progress"
                max={captureExportTotalInputBytes}
                value={Math.min(
                  captureExportProcessedInputBytes,
                  captureExportTotalInputBytes,
                )}
                aria-label="导出进度"
              />
            )}
          </section>

          <section className="sidebar-section export-source-section">
            <span className="field-label">源捕获文件</span>
            <button
              className="secondary-button export-source-button"
              type="button"
              disabled={!canChooseExportSource}
              onClick={() => void selectCaptureExportSource()}
            >
              <FolderOpen size={16} />
              选择捕获文件
            </button>
            <button
              className="secondary-button export-source-button"
              type="button"
              disabled={!canChooseExportSource || !capturePath}
              onClick={useRecentCaptureForExport}
            >
              <History size={16} />
              使用最近录制
            </button>
            {!isNativeRuntime && (
              <span className="capture-availability">仅桌面应用支持捕获文件导出</span>
            )}
            {captureActive && (
              <span className="capture-availability">完成当前录制后可开始导出</span>
            )}
          </section>

          {captureExportSourcePath && (
            <SessionFile label="源文件" path={captureExportSourcePath} />
          )}

          <section className="sidebar-section export-options-section">
            <span className="field-label" id="capture-export-format-label">
              导出格式
            </span>
            <div
              className="segmented-control export-format-control"
              role="radiogroup"
              aria-labelledby="capture-export-format-label"
            >
              {(["csv", "jsonl", "binary"] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  role="radio"
                  aria-checked={captureExportFormat === format}
                  data-active={captureExportFormat === format}
                  disabled={exportBusy}
                  onClick={() => setCaptureExportFormat(format)}
                >
                  {captureExportFormatName(format)}
                </button>
              ))}
            </div>

            <span className="field-label" id="capture-export-direction-label">
              数据方向
            </span>
            <div
              className="segmented-control export-direction-control"
              role="radiogroup"
              aria-labelledby="capture-export-direction-label"
            >
              {(
                [
                  ["both", "双向"],
                  ["rx", "RX"],
                  ["tx", "TX"],
                ] as const
              ).map(([direction, label]) => (
                <button
                  key={direction}
                  type="button"
                  role="radio"
                  aria-checked={captureExportDirection === direction}
                  data-active={captureExportDirection === direction}
                  disabled={
                    exportBusy ||
                    (captureExportFormat === "binary" && direction === "both")
                  }
                  title={
                    captureExportFormat === "binary" && direction === "both"
                      ? "二进制文件必须保留单一方向"
                      : undefined
                  }
                  onClick={() => setCaptureExportDirection(direction)}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="toggle-row standalone export-prefix-toggle">
              <span>允许导出不完整文件的有效前缀</span>
              <input
                type="checkbox"
                checked={captureExportAllowIncomplete}
                disabled={exportBusy}
                onChange={(event) =>
                  setCaptureExportAllowIncomplete(event.target.checked)
                }
              />
            </label>
          </section>

          <section className="sidebar-section export-action-section">
            {exportBusy && !["selecting-source", "selecting-destination"].includes(
              captureExportStatus,
            ) ? (
              <button
                className="danger-button export-action-button"
                type="button"
                disabled={
                  captureExportStatus === "starting" ||
                  captureExportStatus === "cancelling" ||
                  captureExportPhase === "committing"
                }
                onClick={() => void cancelCaptureExport()}
              >
                <CircleStop size={16} />
                {captureExportStatus === "starting"
                  ? "正在启动导出"
                  : captureExportPhase === "committing"
                    ? "正在提交文件"
                    : "取消导出"}
              </button>
            ) : (
              <button
                className="primary-button export-action-button"
                type="button"
                disabled={!canStartExport}
                onClick={() => void startCaptureExport()}
              >
                <Download size={16} />
                选择位置并导出
              </button>
            )}
            {exportHasResult && (
              <button
                className="secondary-button export-clear-button"
                type="button"
                onClick={() => void clearCaptureExport()}
              >
                <RotateCcw size={16} />
                清除导出结果
              </button>
            )}
          </section>

          {captureExportStatus === "completed" && (
            <section className="sidebar-section replay-control-section">
              <div
                className="replay-integrity"
                data-complete={captureExportSourceComplete}
              >
                {captureExportSourceComplete ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <TriangleAlert size={15} />
                )}
                <span>
                  {captureExportSourceComplete
                    ? "源捕获完整，导出已提交"
                    : "已提交源文件的有效记录前缀"}
                </span>
              </div>
            </section>
          )}

          {captureExportDestinationPath && (
            <SessionFile label="导出文件" path={captureExportDestinationPath} />
          )}
          {captureExportMessage && (
            <SessionFeedback
              message={captureExportMessage}
              isError={captureExportStatus === "error"}
            />
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
  status: CaptureUiStatus | ReplayUiStatus | CaptureExportUiStatus;
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

function ExportMetrics({
  inputBytes,
  totalInputBytes,
  outputBytes,
  dataBytes,
  recordCount,
}: {
  inputBytes: number;
  totalInputBytes: number;
  outputBytes: number;
  dataBytes: number;
  recordCount: number;
}) {
  const progress = totalInputBytes > 0
    ? Math.min(100, Math.round((inputBytes / totalInputBytes) * 100))
    : 0;
  return (
    <div className="capture-metrics export-metrics">
      <div>
        <HardDrive size={15} />
        <span>源进度</span>
        <strong title={`${formatBytes(inputBytes)} / ${formatBytes(totalInputBytes)}`}>
          {progress}%
        </strong>
      </div>
      <div>
        <FileOutput size={15} />
        <span>输出</span>
        <strong title={`有效载荷 ${formatBytes(dataBytes)}`}>
          {formatBytes(outputBytes)}
        </strong>
      </div>
      <div>
        <FileCheck2 size={15} />
        <span>记录</span>
        <strong>{recordCount.toLocaleString()}</strong>
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

function SessionFile({ path, label = "捕获文件" }: { path: string; label?: string }) {
  return (
    <section className="sidebar-section capture-file-section">
      <span className="field-label">{label}</span>
      <strong title={path}>{fileName(path)}</strong>
      <code title={path}>{path}</code>
    </section>
  );
}

function captureExportStatusLabel(
  status: CaptureExportUiStatus,
  phase: string,
): string {
  if (status === "running") {
    switch (phase) {
      case "preparing":
        return "正在准备导出";
      case "finalizing":
        return "正在刷新文件";
      case "committing":
        return "正在提交文件";
      default:
        return "正在流式导出";
    }
  }
  switch (status) {
    case "selecting-source":
      return "正在选择源文件";
    case "selecting-destination":
      return "正在选择导出位置";
    case "starting":
      return "正在启动导出";
    case "cancelling":
      return "正在取消导出";
    case "completed":
      return "导出已完成";
    case "cancelled":
      return "导出已取消";
    case "error":
      return "导出失败";
    default:
      return "等待导出";
  }
}

function captureExportFormatName(format: CaptureExportFormat): string {
  switch (format) {
    case "jsonl":
      return "JSONL";
    case "binary":
      return "BIN";
    default:
      return "CSV";
  }
}

function captureExportDirectionLabel(direction: CaptureExportDirection): string {
  switch (direction) {
    case "rx":
      return "仅 RX";
    case "tx":
      return "仅 TX";
    default:
      return "RX + TX";
  }
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
    case "seeking":
      return "正在定位";
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

function replaySeekTitle(protocol: ProtocolKind | undefined, status: ReplayUiStatus): string {
  if (!protocol || !protocolSupportsReplaySeek(protocol)) {
    return "结构化协议回放暂不支持定位";
  }
  if (status === "playing" || status === "pausing") {
    return "暂停回放后可定位";
  }
  if (status === "seeking") {
    return "正在定位回放";
  }
  return "拖动定位回放位置";
}

function captureDestinationLabel(isNativeRuntime: boolean, path: string): string {
  if (!isNativeRuntime) {
    return "浏览器预览";
  }
  return path ? "VUCAP v1" : "桌面文件";
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
