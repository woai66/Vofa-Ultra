import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  CirclePause,
  Download,
  Eraser,
  Play,
  Send,
  TerminalSquare,
} from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { DisplayMode, LineEnding } from "../types/serial";
import type { TerminalEntry } from "../types/workbench";

export function TerminalPanel() {
  const entries = useWorkbenchStore((state) => state.terminalEntries);
  const displayMode = useWorkbenchStore((state) => state.displayMode);
  const terminalPaused = useWorkbenchStore((state) => state.terminalPaused);
  const terminalAutoScroll = useWorkbenchStore((state) => state.terminalAutoScroll);
  const connectionStatus = useWorkbenchStore((state) => state.connectionStatus);
  const setDisplayMode = useWorkbenchStore((state) => state.setDisplayMode);
  const setTerminalPaused = useWorkbenchStore((state) => state.setTerminalPaused);
  const clearTerminal = useWorkbenchStore((state) => state.clearTerminal);
  const send = useWorkbenchStore((state) => state.send);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [sendMode, setSendMode] = useState<DisplayMode>("text");
  const [lineEnding, setLineEnding] = useState<LineEnding>("none");
  const [message, setMessage] = useState("");
  const [sendError, setSendError] = useState("");
  const hasPayload = message.length > 0 || lineEnding !== "none";
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 24,
    overscan: 12,
  });

  useEffect(() => {
    if (terminalAutoScroll && !terminalPaused && entries.length > 0) {
      rowVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries.length, rowVirtualizer, terminalAutoScroll, terminalPaused]);

  const submit = async () => {
    if (!hasPayload) {
      return;
    }
    setSendError("");
    try {
      await send(message, sendMode, lineEnding);
      setMessage("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="workspace-panel terminal-panel" aria-labelledby="terminal-title">
      <header className="panel-toolbar terminal-toolbar">
        <div className="panel-title-group">
          <TerminalSquare size={17} />
          <div>
            <h2 id="terminal-title">数据终端</h2>
            <span className="panel-subtitle">{entries.length} 条记录</span>
          </div>
        </div>
        <div className="panel-actions">
          <div className="segmented-control compact-segments" role="group" aria-label="接收显示格式">
            <button type="button" data-active={displayMode === "text"} onClick={() => setDisplayMode("text")}>
              TEXT
            </button>
            <button type="button" data-active={displayMode === "hex"} onClick={() => setDisplayMode("hex")}>
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
            aria-label="导出终端记录"
            title="导出终端记录"
            disabled={!entries.length}
            onClick={() => exportTerminalEntries(entries, displayMode)}
          >
            <Download size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="清空终端"
            title="清空终端"
            disabled={!entries.length}
            onClick={clearTerminal}
          >
            <Eraser size={16} />
          </button>
        </div>
      </header>

      <div ref={viewportRef} className="terminal-viewport" role="log" aria-live="off">
        {entries.length === 0 ? (
          <div className="terminal-empty">
            <ArrowDownToLine size={24} />
            <span>接收数据将在这里显示</span>
          </div>
        ) : (
          <div
            className="terminal-virtualizer"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = entries[virtualRow.index];
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
                  <code>{displayMode === "text" ? entry.text : entry.hex}</code>
                  <small>{entry.byteCount} B</small>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="send-composer">
        <div className="send-options">
          <div className="segmented-control compact-segments" role="group" aria-label="发送格式">
            <button type="button" data-active={sendMode === "text"} onClick={() => setSendMode("text")}>
              文本
            </button>
            <button type="button" data-active={sendMode === "hex"} onClick={() => setSendMode("hex")}>
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
              onChange={(event) => setLineEnding(event.target.value as LineEnding)}
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
            id="send-payload"
            name="send-payload"
            aria-label="发送内容"
            rows={1}
            value={message}
            spellCheck={false}
            placeholder={sendMode === "hex" ? "01 03 00 00 00 02 C4 0B" : "输入要发送的内容"}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <button
          className="primary-button send-button"
          type="button"
          disabled={connectionStatus !== "connected" || !hasPayload}
          onClick={() => void submit()}
        >
          <Send size={16} />
          发送
        </button>
        {sendError && <span className="send-error">{sendError}</span>}
      </div>
    </section>
  );
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
