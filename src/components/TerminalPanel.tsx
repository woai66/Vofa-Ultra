import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  Blocks,
  Braces,
  CirclePause,
  Download,
  Eraser,
  History,
  Play,
  Search,
  SearchX,
  Send,
  Square,
  TerminalSquare,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import {
  COMMAND_VARIABLE_INSERTIONS,
  compileCommandTemplate,
  MAX_COMMAND_TEMPLATE_BYTES,
  renderCommandTemplate,
} from "../core/commandTemplate";
import {
  MAX_COMMAND_INTERVAL_MS,
  MAX_COMMAND_REPEAT_COUNT,
  MIN_COMMAND_INTERVAL_MS,
} from "../core/commandWorkflow";
import { isAutoResponderActive } from "../core/autoResponder";
import {
  filterTerminalEntries,
  findTerminalLiteralMatches,
  MAX_TERMINAL_SEARCH_CHARACTERS,
  terminalEntryPayload,
  type TerminalDirectionFilter,
} from "../core/terminalSearch";
import { formatModbusRtuFrame } from "../core/modbusRtu";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { DisplayMode, LineEnding } from "../types/serial";
import type {
  CommandHistoryEntry,
  CommandTaskSnapshot,
  TerminalEntry,
} from "../types/workbench";
import { ModbusRtuBuilder } from "./ModbusRtuBuilder";

type RepeatMode = "count" | "continuous";

interface CommandDraft {
  value: string;
  mode: DisplayMode;
  lineEnding: LineEnding;
}

interface CommandTemplatePreview {
  byteCount: number;
  variableCount: number;
  error: string;
}

export function TerminalPanel() {
  const entries = useWorkbenchStore((state) => state.terminalEntries);
  const displayMode = useWorkbenchStore((state) => state.displayMode);
  const sendMode = useWorkbenchStore((state) => state.sendMode);
  const lineEnding = useWorkbenchStore((state) => state.lineEnding);
  const commandHistory = useWorkbenchStore((state) => state.commandHistory);
  const commandTask = useWorkbenchStore((state) => state.commandTask);
  const autoResponder = useWorkbenchStore((state) => state.autoResponder);
  const isSendingCommand = useWorkbenchStore((state) => state.isSendingCommand);
  const commandSendOrigin = useWorkbenchStore((state) => state.commandSendOrigin);
  const terminalPaused = useWorkbenchStore((state) => state.terminalPaused);
  const terminalAutoScroll = useWorkbenchStore((state) => state.terminalAutoScroll);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const isWorkspaceTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );
  const setDisplayMode = useWorkbenchStore((state) => state.setDisplayMode);
  const setSendMode = useWorkbenchStore((state) => state.setSendMode);
  const setLineEnding = useWorkbenchStore((state) => state.setLineEnding);
  const setTerminalPaused = useWorkbenchStore((state) => state.setTerminalPaused);
  const clearTerminal = useWorkbenchStore((state) => state.clearTerminal);
  const clearCommandHistory = useWorkbenchStore((state) => state.clearCommandHistory);
  const send = useWorkbenchStore((state) => state.send);
  const startPeriodicSend = useWorkbenchStore((state) => state.startPeriodicSend);
  const stopPeriodicSend = useWorkbenchStore((state) => state.stopPeriodicSend);
  const viewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const modbusTriggerRef = useRef<HTMLButtonElement>(null);
  const variableTriggerRef = useRef<HTMLButtonElement>(null);
  const variableListRef = useRef<HTMLDivElement>(null);
  const historyCursorRef = useRef<number | null>(null);
  const historyDraftRef = useRef<CommandDraft | null>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const [message, setMessage] = useState("");
  const [sendError, setSendError] = useState("");
  const [manualSendPending, setManualSendPending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modbusOpen, setModbusOpen] = useState(false);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [intervalText, setIntervalText] = useState("1000");
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("count");
  const [repeatCountText, setRepeatCountText] = useState("10");
  const [searchQuery, setSearchQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<TerminalDirectionFilter>("all");
  const hasPayload = message.length > 0 || lineEnding !== "none";
  const templatePreview = useMemo(
    () => previewCommandTemplate(message, sendMode, lineEnding),
    [lineEnding, message, sendMode],
  );
  const availableVariables = useMemo(
    () => COMMAND_VARIABLE_INSERTIONS.filter((item) => item.mode === sendMode),
    [sendMode],
  );
  const visibleError = templatePreview.error || sendError;
  const taskActive = commandTask.status === "running" || commandTask.status === "stopping";
  const autoResponderActive = isAutoResponderActive(autoResponder);
  const manualSendBlocked =
    manualSendPending || (isSendingCommand && commandSendOrigin !== "auto-responder");
  const workflowVisible = workflowOpen || taskActive;
  const canStartPeriodic =
    connectionStatus === "connected" &&
    message.length > 0 &&
    !templatePreview.error &&
    templatePreview.byteCount > 0 &&
    !isWorkspaceTransitioning &&
    !isSendingCommand &&
    !autoResponderActive &&
    !taskActive;
  const visibleEntries = useMemo(
    () =>
      filterTerminalEntries(entries, {
        direction: directionFilter,
        displayMode,
        query: searchQuery,
      }),
    [directionFilter, displayMode, entries, searchQuery],
  );
  const filtersActive = searchQuery.length > 0 || directionFilter !== "all";
  const recordSummary = filtersActive
    ? `${visibleEntries.length} / ${entries.length} 条记录`
    : `${entries.length} 条记录`;
  const exportTerminalLabel = filtersActive ? "导出全部终端记录" : "导出终端记录";
  const clearTerminalLabel = filtersActive ? "清空全部终端记录" : "清空终端";
  const lastVisibleEntryId = visibleEntries.at(-1)?.id;
  const rowVirtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => visibleEntries[index]?.id ?? index,
    estimateSize: () => 24,
    overscan: 12,
    useFlushSync: false,
  });

  useEffect(() => {
    if (terminalAutoScroll && !terminalPaused && visibleEntries.length > 0) {
      rowVirtualizer.scrollToIndex(visibleEntries.length - 1, { align: "end" });
    }
  }, [lastVisibleEntryId, rowVirtualizer, terminalAutoScroll, terminalPaused, visibleEntries.length]);

  useEffect(() => {
    if (["running", "stopping", "error"].includes(commandTask.status)) {
      setWorkflowOpen(true);
    }
  }, [commandTask.status]);

  useEffect(() => {
    if (!historyOpen && !modbusOpen && !variablesOpen) {
      return undefined;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
        setModbusOpen(false);
        setVariablesOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [historyOpen, modbusOpen, variablesOpen]);

  useEffect(() => {
    const selection = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    if (selection === null || !textarea) {
      return;
    }
    pendingSelectionRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(selection, selection);
  }, [message, modbusOpen, variablesOpen]);

  useEffect(() => {
    if (variablesOpen) {
      variableListRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [variablesOpen]);

  useEffect(() => {
    if (isWorkspaceTransitioning) {
      setModbusOpen(false);
    }
  }, [isWorkspaceTransitioning]);

  const resetHistoryNavigation = () => {
    historyCursorRef.current = null;
    historyDraftRef.current = null;
  };

  const applyDraft = (draft: CommandDraft) => {
    setMessage(draft.value);
    setSendMode(draft.mode);
    setLineEnding(draft.lineEnding);
    setSendError("");
    setVariablesOpen(false);
  };

  const insertVariable = (token: string) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? message.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const nextMessage =
      message.slice(0, selectionStart) + token + message.slice(selectionEnd);
    pendingSelectionRef.current = selectionStart + token.length;
    setMessage(nextMessage);
    setSendError("");
    setVariablesOpen(false);
    resetHistoryNavigation();
  };

  const applyModbusFrame = (frame: Uint8Array) => {
    if (isWorkspaceTransitioning) {
      return;
    }
    const value = formatModbusRtuFrame(frame);
    pendingSelectionRef.current = value.length;
    resetHistoryNavigation();
    setHistoryOpen(false);
    setModbusOpen(false);
    applyDraft({ value, mode: "hex", lineEnding: "none" });
  };

  const recallHistory = (index: number) => {
    const entry = commandHistory[index];
    if (!entry) {
      return;
    }
    if (historyCursorRef.current === null) {
      historyDraftRef.current = { value: message, mode: sendMode, lineEnding };
    }
    historyCursorRef.current = index;
    applyDraft(entry);
  };

  const navigateHistory = (direction: "previous" | "next"): boolean => {
    if (commandHistory.length === 0) {
      return false;
    }
    const cursor = historyCursorRef.current;
    if (direction === "previous") {
      if (cursor === null) {
        historyDraftRef.current = { value: message, mode: sendMode, lineEnding };
        historyCursorRef.current = commandHistory.length - 1;
      } else {
        historyCursorRef.current = Math.max(0, cursor - 1);
      }
      const entry = commandHistory[historyCursorRef.current];
      if (entry) {
        applyDraft(entry);
      }
      return true;
    }
    if (cursor === null) {
      return false;
    }
    if (cursor < commandHistory.length - 1) {
      historyCursorRef.current = cursor + 1;
      const entry = commandHistory[historyCursorRef.current];
      if (entry) {
        applyDraft(entry);
      }
    } else {
      const draft = historyDraftRef.current;
      resetHistoryNavigation();
      if (draft) {
        applyDraft(draft);
      }
    }
    return true;
  };

  const submit = async () => {
    if (!hasPayload || templatePreview.error || taskActive || manualSendBlocked) {
      return;
    }
    setSendError("");
    setManualSendPending(true);
    try {
      await send(message, sendMode, lineEnding);
      setMessage("");
      resetHistoryNavigation();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setManualSendPending(false);
    }
  };

  const startTask = () => {
    setSendError("");
    try {
      startPeriodicSend(
        message,
        sendMode,
        lineEnding,
        Number(intervalText),
        repeatMode === "continuous" ? null : Number(repeatCountText),
      );
      setWorkflowOpen(true);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const textarea = event.currentTarget;
    if (textarea.selectionStart !== textarea.selectionEnd) {
      return;
    }
    const onFirstLine = message.lastIndexOf("\n", textarea.selectionStart - 1) < 0;
    const onLastLine = message.indexOf("\n", textarea.selectionEnd) < 0;
    if (
      (event.key === "ArrowUp" && onFirstLine && navigateHistory("previous")) ||
      (event.key === "ArrowDown" && onLastLine && navigateHistory("next"))
    ) {
      event.preventDefault();
    }
  };

  return (
    <section className="workspace-panel terminal-panel" aria-labelledby="terminal-title">
      <header className="panel-toolbar terminal-toolbar">
        <div className="panel-title-group">
          <TerminalSquare size={17} />
          <div>
            <h2 id="terminal-title">数据终端</h2>
            <span className="panel-subtitle">{recordSummary}</span>
          </div>
        </div>
        <div className="panel-actions">
          <div className="segmented-control compact-segments" role="group" aria-label="接收显示格式">
            <button
              type="button"
              data-active={displayMode === "text"}
              disabled={isWorkspaceTransitioning}
              onClick={() => setDisplayMode("text")}
            >
              TEXT
            </button>
            <button
              type="button"
              data-active={displayMode === "hex"}
              disabled={isWorkspaceTransitioning}
              onClick={() => setDisplayMode("hex")}
            >
              HEX
            </button>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={terminalPaused ? "继续终端显示" : "暂停终端显示"}
            title={terminalPaused ? "继续终端显示" : "暂停终端显示"}
            onClick={() => setTerminalPaused(!terminalPaused)}
          >
            {terminalPaused ? <Play size={16} /> : <CirclePause size={16} />}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={exportTerminalLabel}
            title={exportTerminalLabel}
            disabled={!entries.length}
            onClick={() => exportTerminalEntries(entries, displayMode)}
          >
            <Download size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={clearTerminalLabel}
            title={clearTerminalLabel}
            disabled={!entries.length}
            onClick={clearTerminal}
          >
            <Eraser size={16} />
          </button>
        </div>
      </header>

      <div className="terminal-filter-bar" role="search" aria-label="终端记录筛选">
        <div className="terminal-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            id="terminal-search-query"
            name="terminal-search-query"
            type="search"
            aria-label="搜索终端记录"
            aria-controls="terminal-record-list"
            maxLength={MAX_TERMINAL_SEARCH_CHARACTERS}
            value={searchQuery}
            spellCheck={false}
            placeholder={displayMode === "text" ? "搜索 TEXT 内容" : "搜索 HEX 内容"}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label="清空终端搜索"
            title="清空终端搜索"
            disabled={!searchQuery}
            onClick={() => setSearchQuery("")}
          >
            <X size={14} />
          </button>
        </div>
        <div
          className="segmented-control compact-segments terminal-direction-filter"
          role="group"
          aria-label="终端方向筛选"
        >
          <button
            type="button"
            data-active={directionFilter === "all"}
            aria-pressed={directionFilter === "all"}
            onClick={() => setDirectionFilter("all")}
          >
            全部
          </button>
          <button
            type="button"
            data-active={directionFilter === "rx"}
            aria-pressed={directionFilter === "rx"}
            onClick={() => setDirectionFilter("rx")}
          >
            RX
          </button>
          <button
            type="button"
            data-active={directionFilter === "tx"}
            aria-pressed={directionFilter === "tx"}
            onClick={() => setDirectionFilter("tx")}
          >
            TX
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        id="terminal-record-list"
        className="terminal-viewport"
        role="log"
        aria-live="off"
      >
        {entries.length === 0 ? (
          <div className="terminal-empty">
            <ArrowDownToLine size={24} />
            <span>接收数据将在这里显示</span>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="terminal-empty">
            <SearchX size={24} />
            <span>没有匹配的终端记录</span>
          </div>
        ) : (
          <div
            className="terminal-virtualizer"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = visibleEntries[virtualRow.index];
              if (!entry) {
                return null;
              }
              return (
                <div
                  key={entry.id}
                  ref={rowVirtualizer.measureElement}
                  className="terminal-line"
                  data-direction={entry.direction}
                  data-index={virtualRow.index}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <time>{formatTime(entry.timestamp)}</time>
                  <span className="direction-label">{entry.direction.toUpperCase()}</span>
                  <code>
                    <HighlightedTerminalPayload
                      value={terminalEntryPayload(entry, displayMode)}
                      query={searchQuery}
                    />
                  </code>
                  <small>{entry.byteCount} B</small>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div ref={composerRef} className="send-composer" data-workflow-open={workflowVisible}>
        <div className="send-main-row">
          <div className="send-options">
            <div className="segmented-control compact-segments" role="group" aria-label="发送格式">
              <button
                type="button"
                data-active={sendMode === "text"}
                disabled={isWorkspaceTransitioning}
                onClick={() => {
                  resetHistoryNavigation();
                  setSendError("");
                  setVariablesOpen(false);
                  setSendMode("text");
                }}
              >
                文本
              </button>
              <button
                type="button"
                data-active={sendMode === "hex"}
                disabled={isWorkspaceTransitioning}
                onClick={() => {
                  resetHistoryNavigation();
                  setSendError("");
                  setVariablesOpen(false);
                  setSendMode("hex");
                }}
              >
                HEX
              </button>
            </div>
            <div className="send-line-ending-field">
              <label className="send-field-caption" htmlFor="send-line-ending">
                行尾
              </label>
              <select
                id="send-line-ending"
                name="send-line-ending"
                aria-label="行尾"
                value={lineEnding}
                disabled={isWorkspaceTransitioning}
                onChange={(event) => {
                  resetHistoryNavigation();
                  setSendError("");
                  setLineEnding(event.target.value as LineEnding);
                }}
              >
                <option value="none">无行尾</option>
                <option value="lf">LF</option>
                <option value="crlf">CRLF</option>
              </select>
            </div>
          </div>
          <div className="send-payload-field">
            <label className="send-field-caption" htmlFor="send-payload">
              发送内容
            </label>
            <textarea
              ref={textareaRef}
              id="send-payload"
              name="send-payload"
              aria-label="发送内容"
              aria-invalid={Boolean(templatePreview.error)}
              aria-describedby={
                visibleError
                  ? "command-send-error"
                  : hasPayload
                    ? "command-template-summary"
                    : undefined
              }
              rows={1}
              maxLength={MAX_COMMAND_TEMPLATE_BYTES}
              value={message}
              spellCheck={false}
              placeholder={sendMode === "hex" ? "01 03 00 00 00 02 C4 0B" : "输入要发送的内容"}
              onChange={(event) => {
                setMessage(event.target.value);
                setSendError("");
                resetHistoryNavigation();
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <button
            ref={modbusTriggerRef}
            className="icon-button composer-icon-button command-modbus-trigger"
            type="button"
            aria-label={modbusOpen ? "关闭 Modbus RTU 构帧器" : "打开 Modbus RTU 构帧器"}
            title="Modbus RTU 构帧器"
            aria-haspopup="dialog"
            aria-expanded={modbusOpen}
            data-active={modbusOpen}
            disabled={isWorkspaceTransitioning}
            onClick={() => {
              setHistoryOpen(false);
              setVariablesOpen(false);
              setModbusOpen((open) => !open);
            }}
          >
            <Blocks size={16} />
          </button>
          <button
            ref={variableTriggerRef}
            className="icon-button composer-icon-button command-variable-trigger"
            type="button"
            aria-label="插入命令变量"
            title="插入命令变量"
            aria-haspopup="dialog"
            aria-controls="command-variable-popover"
            aria-expanded={variablesOpen}
            data-active={variablesOpen}
            onClick={() => {
              setHistoryOpen(false);
              setModbusOpen(false);
              setVariablesOpen((open) => !open);
            }}
          >
            <Braces size={16} />
          </button>
          <button
            className="icon-button composer-icon-button command-history-trigger"
            type="button"
            aria-label={`命令历史，${commandHistory.length} 条`}
            title="命令历史"
            aria-expanded={historyOpen}
            disabled={commandHistory.length === 0}
            onClick={() => {
              setModbusOpen(false);
              setVariablesOpen(false);
              setHistoryOpen((open) => !open);
            }}
          >
            <History size={16} />
            {commandHistory.length > 0 && (
              <span className="command-count-badge">{Math.min(commandHistory.length, 99)}</span>
            )}
          </button>
          <button
            className="icon-button composer-icon-button command-workflow-trigger"
            type="button"
            aria-label={workflowOpen ? "收起周期发送设置" : "展开周期发送设置"}
            title={workflowOpen ? "收起周期发送设置" : "周期发送设置"}
            aria-expanded={workflowVisible}
            data-active={workflowVisible}
            disabled={taskActive}
            onClick={() => {
              setHistoryOpen(false);
              setModbusOpen(false);
              setVariablesOpen(false);
              setWorkflowOpen((open) => !open);
            }}
          >
            <Timer size={16} />
          </button>
          {taskActive ? (
            <button
              className="primary-button send-button"
              type="button"
              data-action="stop"
              disabled={commandTask.status === "stopping"}
              onClick={stopPeriodicSend}
            >
              <Square size={15} />
              {commandTask.status === "stopping" ? "停止中" : "停止"}
            </button>
          ) : (
            <button
              className="primary-button send-button"
              type="button"
              disabled={
                connectionStatus !== "connected" ||
                !hasPayload ||
                Boolean(templatePreview.error) ||
                isWorkspaceTransitioning ||
                manualSendBlocked
              }
              onClick={() => void submit()}
            >
              <Send size={16} />
              发送
            </button>
          )}
        </div>

        {hasPayload && !templatePreview.error && (
          <span
            id="command-template-summary"
            className="command-template-summary"
            data-dynamic={templatePreview.variableCount > 0}
            aria-label={`命令模板包含 ${templatePreview.variableCount} 个变量，最终 ${templatePreview.byteCount} 字节`}
          >
            {templatePreview.variableCount} 个变量 · {templatePreview.byteCount} B
          </span>
        )}

        {modbusOpen && (
          <ModbusRtuBuilder
            onApply={applyModbusFrame}
            onClose={() => {
              setModbusOpen(false);
              modbusTriggerRef.current?.focus();
            }}
          />
        )}

        {workflowVisible && (
          <div className="command-workflow" aria-label="周期发送设置">
            <div className="command-interval-field">
              <label className="send-field-caption" htmlFor="command-interval">
                间隔
              </label>
              <input
                id="command-interval"
                type="number"
                inputMode="numeric"
                aria-label="发送间隔（毫秒）"
                min={MIN_COMMAND_INTERVAL_MS}
                max={MAX_COMMAND_INTERVAL_MS}
                step={1}
                value={intervalText}
                disabled={taskActive}
                onChange={(event) => setIntervalText(event.target.value)}
              />
              <span>ms</span>
              <small title="下一次发送在上一次完成后开始计时">非实时</small>
            </div>
            <div
              className="segmented-control compact-segments command-repeat-mode"
              role="group"
              aria-label="发送次数模式"
            >
              <button
                type="button"
                data-active={repeatMode === "count"}
                disabled={taskActive}
                onClick={() => setRepeatMode("count")}
              >
                次数
              </button>
              <button
                type="button"
                data-active={repeatMode === "continuous"}
                disabled={taskActive}
                onClick={() => setRepeatMode("continuous")}
              >
                持续
              </button>
            </div>
            {repeatMode === "count" && (
              <div className="command-repeat-count-field">
                <label className="send-field-caption" htmlFor="command-repeat-count">
                  次数
                </label>
                <input
                  id="command-repeat-count"
                  type="number"
                  inputMode="numeric"
                  aria-label="发送次数"
                  min={1}
                  max={MAX_COMMAND_REPEAT_COUNT}
                  step={1}
                  value={repeatCountText}
                  disabled={taskActive}
                  onChange={(event) => setRepeatCountText(event.target.value)}
                />
              </div>
            )}
            <div
              className="command-task-status"
              data-status={commandTask.status}
              role={commandTask.status === "error" ? "alert" : "status"}
              aria-label="周期发送状态"
            >
              <span className="command-task-dot" />
              <span>{formatTaskSummary(commandTask)}</span>
            </div>
            {!taskActive && (
              <button
                className="primary-button command-task-button"
                type="button"
                disabled={!canStartPeriodic}
                onClick={startTask}
              >
                <Play size={15} />
                启动
              </button>
            )}
          </div>
        )}

        {historyOpen && (
          <div className="command-history-popover" role="dialog" aria-label="命令历史">
            <div className="command-history-header">
              <div>
                <History size={14} />
                <strong>命令历史</strong>
                <span>{commandHistory.length}/100</span>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="清空命令历史"
                title="清空命令历史"
                onClick={() => {
                  clearCommandHistory();
                  resetHistoryNavigation();
                  setHistoryOpen(false);
                  textareaRef.current?.focus();
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="command-history-list">
              {commandHistory
                .map((entry, index) => ({ entry, index }))
                .reverse()
                .map(({ entry, index }) => (
                  <button
                    key={`${entry.sentAt}-${index}`}
                    type="button"
                    onClick={() => {
                      recallHistory(index);
                      setHistoryOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <code>{historyPreview(entry)}</code>
                    <span>
                      {entry.mode.toUpperCase()} · {lineEndingLabel(entry.lineEnding)} ·{" "}
                      {entry.variableCount > 0
                        ? `最近 ${entry.encodedBytes} B`
                        : `${entry.encodedBytes} B`}
                      {entry.repeatCount > 1 ? ` · ×${entry.repeatCount}` : ""}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {variablesOpen && (
          <div
            id="command-variable-popover"
            className="command-variable-popover"
            role="dialog"
            aria-label="命令变量"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setVariablesOpen(false);
                variableTriggerRef.current?.focus();
              }
            }}
          >
            <div className="command-variable-header">
              <div>
                <Braces size={14} />
                <strong>命令变量</strong>
                <span>{sendMode.toUpperCase()}</span>
              </div>
            </div>
            <div ref={variableListRef} className="command-variable-list">
              {availableVariables.map((item) => (
                <button
                  key={item.token}
                  type="button"
                  aria-label={`插入${item.label} ${item.token}`}
                  onClick={() => insertVariable(item.token)}
                >
                  <code>{item.token}</code>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {visibleError && (
          <span id="command-send-error" className="send-error" role="alert">
            {visibleError}
          </span>
        )}
      </div>
    </section>
  );
}

function HighlightedTerminalPayload({ value, query }: { value: string; query: string }) {
  const matches = findTerminalLiteralMatches(value, query);
  if (matches.length === 0) {
    return value;
  }
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      content.push(value.slice(cursor, match.start));
    }
    content.push(
      <mark className="terminal-search-match" key={`${match.start}-${match.end}`}>
        {value.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  }
  if (cursor < value.length) {
    content.push(value.slice(cursor));
  }
  return content;
}

function previewCommandTemplate(
  value: string,
  mode: DisplayMode,
  lineEnding: LineEnding,
): CommandTemplatePreview {
  try {
    const template = compileCommandTemplate(value, mode);
    const nowMs = Date.now();
    const rendered = renderCommandTemplate(
      template,
      { sequence: 1, nowMs, taskStartedAtMs: nowMs },
      lineEnding,
    );
    return {
      byteCount: rendered.bytes.length,
      variableCount: rendered.variableCount,
      error: "",
    };
  } catch (error) {
    return {
      byteCount: 0,
      variableCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatTaskSummary(task: CommandTaskSnapshot): string {
  if (task.status === "idle") {
    return "等待启动";
  }
  const progress =
    task.repeatCount === null ? `${task.sentCount} 次` : `${task.sentCount}/${task.repeatCount}`;
  if (task.status === "running") {
    return `运行中 · ${progress} · ${task.intervalMs} ms`;
  }
  if (task.status === "stopping") {
    return `停止中 · ${progress}`;
  }
  return `${task.message} · ${progress}`;
}

function historyPreview(entry: CommandHistoryEntry): string {
  const value = entry.value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return value || `<${lineEndingLabel(entry.lineEnding)}>`;
}

function lineEndingLabel(lineEnding: LineEnding): string {
  switch (lineEnding) {
    case "lf":
      return "LF";
    case "crlf":
      return "CRLF";
    default:
      return "无行尾";
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(timestamp);
}

function exportTerminalEntries(entries: TerminalEntry[], displayMode: DisplayMode): void {
  const content = entries
    .map((entry) => {
      const timestamp = new Date(entry.timestamp).toISOString();
      const payload = displayMode === "text" ? entry.text : entry.hex;
      return `${timestamp}\t${entry.direction.toUpperCase()}\t${entry.byteCount}\t${payload}`;
    })
    .join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vofa-ultra-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}
