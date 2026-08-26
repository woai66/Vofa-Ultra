import { useEffect, useState } from "react";
import {
  FileSearch,
  LoaderCircle,
  Power,
  Puzzle,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";

export function ExtensionPanel() {
  const isNativeRuntime = useWorkbenchStore((state) => state.isNativeRuntime);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const inspection = useWorkbenchStore((state) => state.extensionInspection);
  const packagePath = useWorkbenchStore((state) => state.extensionPackagePath);
  const authorizationRevision = useWorkbenchStore(
    (state) => state.extensionAuthorizationRevision,
  );
  const extensionState = useWorkbenchStore((state) => state.extensionState);
  const operation = useWorkbenchStore((state) => state.extensionOperation);
  const message = useWorkbenchStore((state) => state.extensionMessage);
  const queue = useWorkbenchStore((state) => state.extensionQueue);
  const inspectPackage = useWorkbenchStore((state) => state.inspectExtensionPackage);
  const activate = useWorkbenchStore((state) => state.activateInspectedExtension);
  const deactivate = useWorkbenchStore((state) => state.deactivateExtension);
  const reset = useWorkbenchStore((state) => state.resetExtension);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    setAuthorized(false);
  }, [authorizationRevision, extensionState.status, inspection?.packageSha256]);

  const busy = operation !== "idle";
  const active = extensionState.status === "active";
  const replayLoaded = replaySessionId > 0;
  const canActivate =
    isNativeRuntime &&
    connectionStatus === "connected" &&
    !replayLoaded &&
    !busy &&
    !active &&
    inspection !== null &&
    authorized;

  return (
    <div className="sidebar-panel extension-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">WASM RUNTIME</span>
          <h1>协议扩展</h1>
        </div>
        <Puzzle size={20} />
      </div>

      <section
        className="extension-runtime-state"
        data-status={extensionState.status}
        aria-label="扩展运行状态"
      >
        <div>
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : extensionState.status === "error" ? (
            <TriangleAlert size={16} />
          ) : active ? (
            <Power size={16} />
          ) : (
            <Puzzle size={16} />
          )}
          <strong>{extensionStatusLabel(extensionState.status, operation)}</strong>
        </div>
        <span role="status">{message}</span>
      </section>

      {!isNativeRuntime ? (
        <div className="sidebar-empty extension-empty">
          <Puzzle size={22} />
          <span>仅桌面应用支持协议扩展</span>
        </div>
      ) : (
        <>
          {(inspection || extensionState.manifest) && (
            <section className="extension-manifest" aria-label="扩展清单">
              <div className="extension-title-row">
                <div>
                  <strong>{(extensionState.manifest ?? inspection?.manifest)?.name}</strong>
                  <span
                    title={`v${(extensionState.manifest ?? inspection?.manifest)?.version}`}
                  >
                    v{(extensionState.manifest ?? inspection?.manifest)?.version}
                  </span>
                </div>
                <code>{(extensionState.manifest ?? inspection?.manifest)?.id}</code>
              </div>
              {(extensionState.manifest ?? inspection?.manifest)?.description && (
                <p>{(extensionState.manifest ?? inspection?.manifest)?.description}</p>
              )}
              <dl className="extension-metadata">
                <div>
                  <dt>许可证声明</dt>
                  <dd>{(extensionState.manifest ?? inspection?.manifest)?.license}</dd>
                </div>
                {inspection && (
                  <>
                    <div>
                      <dt>扩展包</dt>
                      <dd>{formatBytes(inspection.packageBytes)}</dd>
                    </div>
                    <div>
                      <dt>Wasm</dt>
                      <dd>{formatBytes(inspection.moduleBytes)}</dd>
                    </div>
                  </>
                )}
              </dl>
              {inspection && (
                <div className="extension-hashes">
                  <span title={inspection.packageSha256}>包 {shortHash(inspection.packageSha256)}</span>
                  <span title={inspection.moduleSha256}>模块 {shortHash(inspection.moduleSha256)}</span>
                </div>
              )}
              {packagePath && <small className="extension-file-name">{fileName(packagePath)}</small>}
            </section>
          )}

          {active ? (
            <section className="extension-session" aria-label="扩展会话">
              <div className="extension-session-stats">
                <span>
                  RX <strong>{formatBytes(extensionState.processedBytes)}</strong>
                </span>
                <span>
                  输出 <strong>{extensionState.emittedFrames.toLocaleString()}</strong>
                </span>
                <span>
                  队列 <strong>{queue.queuedBatches}{queue.inFlight ? "+1" : ""}</strong>
                </span>
              </div>
              <div className="extension-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void reset()}
                >
                  <RotateCcw size={15} />
                  重置
                </button>
                <button
                  className="secondary-button danger-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void deactivate()}
                >
                  <Power size={15} />
                  停用
                </button>
              </div>
            </section>
          ) : (
            <section className="extension-authorization" aria-label="扩展授权">
              {inspection && (
                <label className="toggle-row extension-consent">
                  <input
                    type="checkbox"
                    checked={authorized}
                    disabled={busy}
                    onChange={(event) => setAuthorized(event.target.checked)}
                  />
                  <span>
                    <strong>授权未签名扩展读取实时 RX</strong>
                    <small>作者身份未验证，仅本次会话有效</small>
                  </span>
                </label>
              )}
              {inspection && connectionStatus !== "connected" && (
                <span className="extension-requirement">连接实时数据源后可启用</span>
              )}
              {inspection && replayLoaded && (
                <span className="extension-requirement">回放期间不能启用实时扩展</span>
              )}
              <div className="extension-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void inspectPackage()}
                >
                  <FileSearch size={15} />
                  {inspection ? "重新选择" : "选择扩展包"}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canActivate}
                  onClick={() => void activate(authorized)}
                >
                  <Power size={15} />
                  启用
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function extensionStatusLabel(status: string, operation: string): string {
  if (operation !== "idle") {
    return {
      initializing: "初始化中",
      selecting: "选择文件",
      inspecting: "格式校验",
      activating: "正在启用",
      deactivating: "正在停用",
      resetting: "正在重置",
    }[operation] ?? "处理中";
  }
  if (status === "active") {
    return "运行中";
  }
  if (status === "error") {
    return "已停用 · 故障";
  }
  return "未启用";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || "extension.vux";
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KiB`;
}
