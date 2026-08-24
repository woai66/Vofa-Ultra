import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  Download,
  FileDown,
  FileUp,
  FolderCog,
  Save,
  SaveAll,
  Trash2,
} from "lucide-react";
import { getProtocolDefinition } from "../core/protocols";
import {
  MAX_WORKSPACE_FILE_BYTES,
  parseWorkspaceExport,
  serializeWorkspace,
} from "../core/workspaces";
import {
  selectActiveWorkspace,
  selectIsWorkspaceDirty,
  useWorkbenchStore,
} from "../store/workbenchStore";
import type { WorkspaceConfigV1, WorkspaceProfile } from "../types/workspace";

type PendingAction =
  | { type: "switch"; id: string; name: string }
  | { type: "delete"; id: string; name: string };

export function WorkspacePanel() {
  const workspaces = useWorkbenchStore((state) => state.workspaces);
  const activeWorkspace = useWorkbenchStore(selectActiveWorkspace);
  const isDirty = useWorkbenchStore(selectIsWorkspaceDirty);
  const saveActiveWorkspace = useWorkbenchStore((state) => state.saveActiveWorkspace);
  const saveWorkspaceAs = useWorkbenchStore((state) => state.saveWorkspaceAs);
  const switchWorkspace = useWorkbenchStore((state) => state.switchWorkspace);
  const deleteWorkspace = useWorkbenchStore((state) => state.deleteWorkspace);
  const importWorkspace = useWorkbenchStore((state) => state.importWorkspace);
  const isRefreshingPorts = useWorkbenchStore((state) => state.isRefreshingPorts);
  const workspaceStorageStatus = useWorkbenchStore((state) => state.workspaceStorageStatus);
  const incompatibleStorageVersion = useWorkbenchStore(
    (state) => state.incompatibleStorageVersion,
  );
  const workspaceTransitionStatus = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus,
  );
  const [nameDraft, setNameDraft] = useState(activeWorkspace?.name ?? "");
  const [feedback, setFeedback] = useState("");
  const [isError, setIsError] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [isLocalBusy, setIsLocalBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusOnCloseRef = useRef(true);
  const nameChanged = nameDraft.trim() !== (activeWorkspace?.name ?? "");
  const hasUnsavedChanges = isDirty || nameChanged;
  const isBusy =
    isLocalBusy || isRefreshingPorts || workspaceTransitionStatus !== "idle";
  const isStorageReadOnly = workspaceStorageStatus === "newer-version";

  useEffect(() => {
    setNameDraft(activeWorkspace?.name ?? "");
  }, [activeWorkspace?.id, activeWorkspace?.name]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !pendingAction) {
      return undefined;
    }
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreFocusOnCloseRef.current = true;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
      if (restoreFocusOnCloseRef.current) {
        const previousFocus = previousFocusRef.current;
        queueMicrotask(() => {
          if (previousFocus?.isConnected) {
            previousFocus.focus();
          }
        });
      }
    };
  }, [pendingAction]);

  const showFeedback = (message: string, error = false) => {
    setFeedback(message);
    setIsError(error);
  };

  const handleSave = () => {
    try {
      saveActiveWorkspace(nameDraft);
      showFeedback("工作区已保存");
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const handleSaveAs = () => {
    try {
      saveWorkspaceAs(nameDraft);
      showFeedback("新工作区已创建");
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const applyWorkspace = async (id: string) => {
    setIsLocalBusy(true);
    try {
      const applied = await switchWorkspace(id);
      showFeedback(applied ? "工作区已应用" : "工作区未切换", !applied);
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    } finally {
      setIsLocalBusy(false);
      focusWorkspaceControl(id);
    }
  };

  const requestWorkspaceSwitch = (id: string, name: string) => {
    if (id === activeWorkspace?.id && !hasUnsavedChanges) {
      return;
    }
    if (hasUnsavedChanges) {
      setPendingAction({ type: "switch", id, name });
      return;
    }
    void applyWorkspace(id);
  };

  const requestWorkspaceDelete = (id: string, name: string) => {
    setPendingAction({ type: "delete", id, name });
  };

  const confirmPendingAction = async () => {
    const action = pendingAction;
    if (!action) {
      return;
    }
    restoreFocusOnCloseRef.current = false;
    setPendingAction(null);
    if (action.type === "switch") {
      await applyWorkspace(action.id);
      return;
    }

    setIsLocalBusy(true);
    try {
      const deleted = await deleteWorkspace(action.id);
      showFeedback(deleted ? "工作区已删除" : "工作区未删除", !deleted);
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    } finally {
      setIsLocalBusy(false);
      focusWorkspaceControl(useWorkbenchStore.getState().activeWorkspaceId);
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_WORKSPACE_FILE_BYTES) {
      showFeedback(`工作区文件不能超过 ${MAX_WORKSPACE_FILE_BYTES / 1024} KiB`, true);
      return;
    }
    try {
      const imported = parseWorkspaceExport(await file.text());
      const id = importWorkspace(imported);
      const created = useWorkbenchStore
        .getState()
        .workspaces.find((workspace) => workspace.id === id);
      showFeedback(`已导入“${created?.name ?? imported.name}”`);
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const trapDialogFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>("button:not(:disabled)");
    const first = focusable?.[0];
    const last = focusable?.[focusable.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="sidebar-panel workspace-sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">WORKSPACES</span>
          <h1>工作区</h1>
        </div>
        <FolderCog size={20} />
      </div>

      <section className="sidebar-section workspace-editor">
        <label className="field-label" htmlFor="workspace-name">
          工作区名称
        </label>
        <input
          id="workspace-name"
          value={nameDraft}
          maxLength={64}
          disabled={!activeWorkspace || isBusy || isStorageReadOnly}
          onChange={(event) => setNameDraft(event.target.value)}
        />
        <div className="workspace-save-actions">
          <button
            className="primary-button"
            type="button"
            disabled={!activeWorkspace || isBusy || isStorageReadOnly || !hasUnsavedChanges}
            onClick={handleSave}
          >
            <Save size={15} />
            保存
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!nameDraft.trim() || isBusy || isStorageReadOnly}
            onClick={handleSaveAs}
          >
            <SaveAll size={15} />
            另存为
          </button>
        </div>
      </section>

      <div className="workspace-list-heading">
        <span>已保存</span>
        <strong>{workspaces.length}</strong>
      </div>
      <section className="workspace-list" aria-label="已保存工作区">
        {workspaces.map((workspace) => {
          const isActive = workspace.id === activeWorkspace?.id;
          return (
            <div
              key={workspace.id}
              className="workspace-row"
              data-active={isActive}
              data-workspace-id={workspace.id}
            >
              <button
                className="workspace-select"
                type="button"
                aria-current={isActive ? "true" : undefined}
                disabled={isBusy}
                onClick={() => requestWorkspaceSwitch(workspace.id, workspace.name)}
              >
                <span className="workspace-row-title">
                  <strong>{workspace.name}</strong>
                  {isActive && hasUnsavedChanges && <small>未保存</small>}
                </span>
                <span>{formatWorkspaceSummary(workspace.config)}</span>
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label={`导出工作区 ${workspace.name}`}
                title="导出工作区"
                disabled={isBusy}
                onClick={() => downloadWorkspace(workspace)}
              >
                <Download size={15} />
              </button>
              <button
                className="icon-button danger-icon-button"
                type="button"
                aria-label={`删除工作区 ${workspace.name}`}
                title="删除工作区"
                disabled={workspaces.length <= 1 || isBusy || isStorageReadOnly}
                onClick={() => requestWorkspaceDelete(workspace.id, workspace.name)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}
      </section>

      <div className="workspace-footer-actions">
        <input
          ref={fileInputRef}
          hidden
          type="file"
          accept="application/json,.json"
          aria-label="导入工作区文件"
          disabled={isStorageReadOnly}
          onChange={(event) => void handleImport(event)}
        />
        <button
          className="secondary-button"
          type="button"
          disabled={isBusy || isStorageReadOnly}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUp size={16} />
          导入
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!activeWorkspace || isBusy}
          onClick={() => activeWorkspace && downloadWorkspace(activeWorkspace)}
        >
          <FileDown size={16} />
          导出当前
        </button>
      </div>
      {isStorageReadOnly && (
        <div className="workspace-feedback" role="alert" data-error="true">
          检测到版本 {incompatibleStorageVersion ?? "未知"} 的较新配置。当前版本以只读模式运行，
          原数据不会被覆盖，请升级后再管理工作区。
        </div>
      )}
      {feedback && (
        <div className="workspace-feedback" role={isError ? "alert" : "status"} data-error={isError}>
          {feedback}
        </div>
      )}

      {pendingAction && (
        <dialog
          ref={dialogRef}
          className="confirm-dialog"
          aria-labelledby="workspace-confirm-title"
          onKeyDown={trapDialogFocus}
          onCancel={(event) => {
            event.preventDefault();
            setPendingAction(null);
          }}
        >
          <h2 id="workspace-confirm-title">
            {pendingAction.type === "switch" ? "放弃未保存更改？" : "删除工作区？"}
          </h2>
          <p>
            {pendingAction.type === "switch"
              ? `切换到“${pendingAction.name}”会丢弃当前未保存的配置。`
              : `“${pendingAction.name}”将从本机配置中删除。`}
          </p>
          <div className="confirm-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              autoFocus
              onClick={() => setPendingAction(null)}
            >
              取消
            </button>
            <button
              className={pendingAction.type === "delete" ? "danger-button" : "primary-button"}
              type="button"
              onClick={() => void confirmPendingAction()}
            >
              {pendingAction.type === "switch" ? "放弃并切换" : "确认删除"}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}

function formatWorkspaceSummary(config: WorkspaceConfigV1): string {
  const source = config.source === "serial" ? config.serialConfig.portName || "串口" : "模拟器";
  const protocol = getProtocolDefinition(config.protocol).displayName;
  return `${source} · ${protocol}`;
}

function downloadWorkspace(workspace: WorkspaceProfile): void {
  const blob = new Blob([serializeWorkspace(workspace)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sanitizeFileName(workspace.name)}.vofa-workspace.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function focusWorkspaceControl(workspaceId: string): void {
  requestAnimationFrame(() => {
    const workspaceRow = Array.from(
      document.querySelectorAll<HTMLElement>(".workspace-row"),
    ).find((row) => row.dataset.workspaceId === workspaceId);
    const target =
      workspaceRow?.querySelector<HTMLElement>(".workspace-select") ??
      document.querySelector<HTMLElement>('.rail-button[aria-label="工作区"]');
    target?.focus();
  });
}

function sanitizeFileName(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || /[<>:"/\\|?*]/.test(character) ? "_" : character;
  }).join("");
  return sanitized.slice(0, 64) || "workspace";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
