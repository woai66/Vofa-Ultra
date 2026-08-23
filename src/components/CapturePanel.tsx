import { useEffect, useState } from "react";
import {
  CircleDot,
  CircleStop,
  Database,
  FileCheck2,
  HardDrive,
  Timer,
} from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { CaptureUiStatus } from "../types/capture";

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
  const workspaceTransitionStatus = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus,
  );
  const startCapture = useWorkbenchStore((state) => state.startCapture);
  const stopCapture = useWorkbenchStore((state) => state.stopCapture);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (captureStatus !== "recording") {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [captureStatus]);

  const isBusy = captureStatus === "starting" || captureStatus === "stopping";
  const isRecording = captureStatus === "recording";
  const canStart =
    isNativeRuntime &&
    connectionStatus === "connected" &&
    workspaceTransitionStatus === "idle" &&
    !isBusy;
  const elapsedMs = captureStartedAt
    ? Math.max(0, (captureEndedAt ?? now) - captureStartedAt)
    : 0;

  return (
    <div className="sidebar-panel capture-sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">CAPTURE</span>
          <h1>采集记录</h1>
        </div>
        <Database size={20} />
      </div>

      <section className="capture-status-section" aria-label="录制状态">
        <div className="capture-state" data-status={captureStatus} aria-live="polite">
          <span className="capture-state-dot" />
          <div>
            <strong>{captureStatusLabel(captureStatus)}</strong>
            <span>{captureDestinationLabel(isNativeRuntime, capturePath)}</span>
          </div>
        </div>

        <div className="capture-metrics">
          <div>
            <Timer size={15} />
            <span>时长</span>
            <strong>{formatDuration(elapsedMs)}</strong>
          </div>
          <div>
            <HardDrive size={15} />
            <span>数据</span>
            <strong>{formatBytes(captureDataBytes)}</strong>
          </div>
          <div>
            <FileCheck2 size={15} />
            <span>记录</span>
            <strong>{captureRecordCount.toLocaleString()}</strong>
          </div>
        </div>
      </section>

      <section className="sidebar-section capture-action-section">
        {isRecording || captureStatus === "stopping" ? (
          <button
            className="danger-button capture-action-button"
            type="button"
            disabled={isBusy}
            onClick={() => void stopCapture()}
          >
            <CircleStop size={16} />
            停止录制
          </button>
        ) : (
          <button
            className="primary-button capture-action-button"
            type="button"
            disabled={!canStart}
            onClick={() => void startCapture()}
          >
            <CircleDot size={16} />
            开始录制
          </button>
        )}
        {!isNativeRuntime && <span className="capture-availability">仅桌面应用支持文件录制</span>}
        {isNativeRuntime && connectionStatus !== "connected" && (
          <span className="capture-availability">连接数据源后可开始录制</span>
        )}
      </section>

      {capturePath && (
        <section className="sidebar-section capture-file-section">
          <span className="field-label">捕获文件</span>
          <code title={capturePath}>{capturePath}</code>
        </section>
      )}

      {captureMessage && (
        <div
          className="workspace-feedback capture-feedback"
          role={captureStatus === "error" ? "alert" : "status"}
          data-error={captureStatus === "error"}
        >
          {captureMessage}
        </div>
      )}
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

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KiB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
