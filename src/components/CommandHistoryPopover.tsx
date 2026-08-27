import { History, Trash2 } from "lucide-react";
import type { LineEnding } from "../types/serial";
import type { CommandHistoryEntry } from "../types/workbench";

interface CommandHistoryPopoverProps {
  entries: readonly CommandHistoryEntry[];
  onRecall(index: number): void;
  onClear(): void;
}

export default function CommandHistoryPopover({
  entries,
  onRecall,
  onClear,
}: CommandHistoryPopoverProps) {
  return (
    <div className="command-history-popover" role="dialog" aria-label="命令历史">
      <div className="command-history-header">
        <div>
          <History size={14} />
          <strong>命令历史</strong>
          <span>{entries.length}/100</span>
        </div>
        <button
          className="icon-button compact"
          type="button"
          aria-label="清空命令历史"
          title="清空命令历史"
          onClick={onClear}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="command-history-list">
        {entries
          .map((entry, index) => ({ entry, index }))
          .reverse()
          .map(({ entry, index }) => (
            <button
              key={`${entry.sentAt}-${index}`}
              type="button"
              autoFocus={index === entries.length - 1}
              onClick={() => onRecall(index)}
            >
              <code>{historyPreview(entry)}</code>
              <span>
                {entry.mode.toUpperCase()} · {lineEndingLabel(entry.lineEnding)} ·{" "}
                {entry.checksumMode === "none"
                  ? "无校验"
                  : entry.checksumMode.toUpperCase()} ·{" "}
                {entry.variableCount > 0
                  ? `最近 ${entry.encodedBytes} B`
                  : `${entry.encodedBytes} B`}
                {entry.repeatCount > 1 ? ` · ×${entry.repeatCount}` : ""}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}

function historyPreview(entry: CommandHistoryEntry): string {
  const value = entry.value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return value || `<${lineEndingLabel(entry.lineEnding)}>`;
}

function lineEndingLabel(lineEnding: LineEnding): string {
  switch (lineEnding) {
    case "lf":
      return "LF";
    case "cr":
      return "CR";
    case "crlf":
      return "CRLF";
    default:
      return "无行尾";
  }
}
