import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  createQuickCommand,
  MAX_QUICK_COMMAND_NAME_LENGTH,
  MAX_QUICK_COMMANDS,
} from "../core/quickCommands";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { DisplayMode, LineEnding } from "../types/serial";
import type { QuickCommand } from "../types/workbench";

export interface QuickCommandDraft {
  template: string;
  mode: DisplayMode;
  lineEnding: LineEnding;
}

interface QuickCommandPopoverProps {
  draft: QuickCommandDraft;
  canSaveDraft: boolean;
  onApply(command: QuickCommand): void;
  onClose(): void;
}

export function QuickCommandPopover({
  draft,
  canSaveDraft,
  onApply,
  onClose,
}: QuickCommandPopoverProps) {
  const commands = useWorkbenchStore((state) => state.quickCommands);
  const setCommands = useWorkbenchStore((state) => state.setQuickCommands);
  const workspaceTransitionStatus = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus,
  );
  const workspaceStorageStatus = useWorkbenchStore(
    (state) => state.workspaceStorageStatus,
  );
  const nameInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const loadButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [feedback, setFeedback] = useState("");
  const [isError, setIsError] = useState(false);
  const firstCommandId = commands[0]?.id;
  const editorDisabled =
    workspaceTransitionStatus !== "idle" || workspaceStorageStatus === "newer-version";

  useEffect(() => {
    const canFocusName = !editorDisabled && canSaveDraft && commands.length < MAX_QUICK_COMMANDS;
    const firstLoadButton = workspaceTransitionStatus === "idle"
      ? loadButtonRefs.current.get(firstCommandId ?? "")
      : undefined;
    const target = canFocusName
      ? nameInputRef.current
      : firstLoadButton ?? closeButtonRef.current;
    target?.focus();
  }, [canSaveDraft, commands.length, editorDisabled, firstCommandId, workspaceTransitionStatus]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const showFeedback = (message: string, error = false) => {
    setFeedback(message);
    setIsError(error);
  };

  const saveCurrentDraft = () => {
    if (editorDisabled || !canSaveDraft || commands.length >= MAX_QUICK_COMMANDS) {
      return;
    }
    try {
      const command = createQuickCommand(
        name,
        draft.template,
        draft.mode,
        draft.lineEnding,
        commands,
      );
      setCommands([...commands, command]);
      setName("");
      showFeedback(`快捷命令“${command.name}”已保存`);
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const beginRename = (command: QuickCommand) => {
    setEditingId(command.id);
    setEditingName(command.name);
    setFeedback("");
  };

  const saveRename = () => {
    if (editorDisabled || !editingId) {
      return;
    }
    try {
      setCommands(commands.map((command) =>
        command.id === editingId ? { ...command, name: editingName } : command));
      const renamed = useWorkbenchStore.getState().quickCommands.find(
        (command) => command.id === editingId,
      );
      setEditingId("");
      setEditingName("");
      showFeedback(`快捷命令“${renamed?.name ?? ""}”已重命名`);
      requestAnimationFrame(() => loadButtonRefs.current.get(renamed?.id ?? "")?.focus());
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const deleteCommand = (command: QuickCommand) => {
    if (editorDisabled) {
      return;
    }
    const index = commands.findIndex((candidate) => candidate.id === command.id);
    const nextCommands = commands.filter((candidate) => candidate.id !== command.id);
    try {
      setCommands(nextCommands);
      setEditingId("");
      setEditingName("");
      showFeedback(`快捷命令“${command.name}”已删除`);
      const nextFocus = nextCommands[index] ?? nextCommands[index - 1];
      requestAnimationFrame(() => {
        if (nextFocus) {
          loadButtonRefs.current.get(nextFocus.id)?.focus();
        } else {
          nameInputRef.current?.focus();
        }
      });
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  const moveCommand = (index: number, direction: -1 | 1) => {
    if (editorDisabled) {
      return;
    }
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= commands.length) {
      return;
    }
    const command = commands[index];
    const targetCommand = commands[targetIndex];
    if (!command || !targetCommand) {
      return;
    }
    const nextCommands = [...commands];
    nextCommands[index] = targetCommand;
    nextCommands[targetIndex] = command;
    try {
      setCommands(nextCommands);
      showFeedback(`快捷命令“${command.name}”已${direction < 0 ? "上移" : "下移"}`);
      requestAnimationFrame(() => loadButtonRefs.current.get(command.id)?.focus());
    } catch (error) {
      showFeedback(getErrorMessage(error), true);
    }
  };

  return (
    <div
      className="quick-command-popover"
      role="dialog"
      aria-label="快捷命令"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="quick-command-header">
        <div>
          <Bookmark size={14} />
          <strong>快捷命令</strong>
          <span>{commands.length}/{MAX_QUICK_COMMANDS}</span>
        </div>
        <button
          ref={closeButtonRef}
          className="icon-button compact"
          type="button"
          aria-label="关闭快捷命令"
          title="关闭"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>

      <form
        className="quick-command-save-row"
        onSubmit={(event) => {
          event.preventDefault();
          saveCurrentDraft();
        }}
      >
        <label className="sr-only" htmlFor="quick-command-name">快捷命令名称</label>
        <input
          ref={nameInputRef}
          id="quick-command-name"
          name="quick-command-name"
          value={name}
          maxLength={MAX_QUICK_COMMAND_NAME_LENGTH}
          disabled={editorDisabled || !canSaveDraft || commands.length >= MAX_QUICK_COMMANDS}
          placeholder="快捷命令名称"
          onChange={(event) => {
            setName(event.target.value);
            setFeedback("");
          }}
        />
        <button
          className="icon-button compact"
          type="submit"
          aria-label="保存当前草稿为快捷命令"
          title="保存当前草稿"
          disabled={
            editorDisabled ||
            !canSaveDraft ||
            commands.length >= MAX_QUICK_COMMANDS ||
            name.trim().length === 0
          }
        >
          <Save size={14} />
        </button>
      </form>

      <div className="quick-command-list" role="list" aria-label="已保存的快捷命令">
        {commands.length === 0 && (
          <div className="quick-command-empty">
            <Bookmark size={20} />
            <span>暂无快捷命令</span>
          </div>
        )}
        {commands.map((command, index) => (
          <div
            key={command.id}
            className="quick-command-row"
            role="listitem"
            data-editing={editingId === command.id}
          >
            {editingId === command.id ? (
              <form
                className="quick-command-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveRename();
                }}
              >
                <label className="sr-only" htmlFor={`quick-command-rename-${command.id}`}>
                  重命名快捷命令 {command.name}
                </label>
                <input
                  ref={editInputRef}
                  id={`quick-command-rename-${command.id}`}
                  name={`quick-command-rename-${command.id}`}
                  value={editingName}
                  maxLength={MAX_QUICK_COMMAND_NAME_LENGTH}
                  disabled={editorDisabled}
                  onChange={(event) => setEditingName(event.target.value)}
                />
                <button
                  className="icon-button compact"
                  type="submit"
                  aria-label={`保存重命名 ${command.name}`}
                  title="保存重命名"
                  disabled={editorDisabled || editingName.trim().length === 0}
                >
                  <Check size={14} />
                </button>
                <button
                  className="icon-button compact"
                  type="button"
                  aria-label={`取消重命名 ${command.name}`}
                  title="取消"
                  onClick={() => {
                    setEditingId("");
                    setEditingName("");
                    requestAnimationFrame(() => loadButtonRefs.current.get(command.id)?.focus());
                  }}
                >
                  <X size={14} />
                </button>
              </form>
            ) : (
              <>
                <button
                  ref={(element) => {
                    if (element) {
                      loadButtonRefs.current.set(command.id, element);
                    } else {
                      loadButtonRefs.current.delete(command.id);
                    }
                  }}
                  className="quick-command-load"
                  type="button"
                  aria-label={`载入快捷命令 ${command.name}`}
                  disabled={workspaceTransitionStatus !== "idle"}
                  onClick={() => onApply(command)}
                >
                  <strong>{command.name}</strong>
                  <code>{quickCommandPreview(command)}</code>
                  <span>
                    {command.mode.toUpperCase()} · {lineEndingLabel(command.lineEnding)}
                  </span>
                </button>
                <div className="quick-command-actions">
                  <button
                    className="icon-button compact"
                    type="button"
                    aria-label={`重命名快捷命令 ${command.name}`}
                    title="重命名"
                    disabled={editorDisabled}
                    onClick={() => beginRename(command)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button compact"
                    type="button"
                    aria-label={`上移快捷命令 ${command.name}`}
                    title="上移"
                    disabled={editorDisabled || index === 0}
                    onClick={() => moveCommand(index, -1)}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    className="icon-button compact"
                    type="button"
                    aria-label={`下移快捷命令 ${command.name}`}
                    title="下移"
                    disabled={editorDisabled || index === commands.length - 1}
                    onClick={() => moveCommand(index, 1)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    className="icon-button compact danger-icon-button"
                    type="button"
                    aria-label={`删除快捷命令 ${command.name}`}
                    title="删除"
                    disabled={editorDisabled}
                    onClick={() => deleteCommand(command)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {feedback && (
        <div className="quick-command-feedback" role={isError ? "alert" : "status"}>
          {feedback}
        </div>
      )}
    </div>
  );
}

function quickCommandPreview(command: QuickCommand): string {
  const normalized = command.template.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return `纯 ${lineEndingLabel(command.lineEnding)}`;
  }
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}

function lineEndingLabel(lineEnding: LineEnding): string {
  if (lineEnding === "lf") {
    return "LF";
  }
  if (lineEnding === "cr") {
    return "CR";
  }
  if (lineEnding === "crlf") {
    return "CRLF";
  }
  return "无行尾";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
