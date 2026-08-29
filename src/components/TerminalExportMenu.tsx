import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { serializeTerminalEntries } from "../core/terminalExport";
import type { DisplayMode } from "../types/serial";
import type { TerminalEntry } from "../types/workbench";

interface TerminalExportMenuProps {
  allEntries: readonly TerminalEntry[];
  currentViewEntries: readonly TerminalEntry[];
  displayMode: DisplayMode;
  filtersActive: boolean;
  onClose: () => void;
}

export default function TerminalExportMenu({
  allEntries,
  currentViewEntries,
  displayMode,
  filtersActive,
  onClose,
}: TerminalExportMenuProps) {
  const allRef = useRef<HTMLButtonElement>(null);
  const currentViewRef = useRef<HTMLButtonElement>(null);
  const [exportError, setExportError] = useState("");
  const canExportCurrentView = filtersActive && currentViewEntries.length > 0;

  useEffect(() => {
    allRef.current?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = [allRef.current, currentViewRef.current].filter(
      (item): item is HTMLButtonElement => item !== null && !item.disabled,
    );
    event.preventDefault();
    const currentIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const targetIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[targetIndex]?.focus({ preventScroll: true });
  };

  const exportEntries = (entries: readonly TerminalEntry[], scope: "all" | "view") => {
    setExportError("");
    try {
      downloadTerminalEntries(entries, displayMode, scope);
      onClose();
    } catch (error) {
      setExportError(`终端导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div
      id="terminal-export-menu"
      className="terminal-export-menu"
      role="menu"
      aria-label="终端导出范围"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        aria-label={`全部缓存 ${allEntries.length} 条`}
        ref={allRef}
        onClick={() => exportEntries(allEntries, "all")}
      >
        <span>全部缓存</span>
        <small>{allEntries.length} 条</small>
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label={`当前视图 ${currentViewEntries.length} 条`}
        ref={currentViewRef}
        disabled={!canExportCurrentView}
        title={
          !filtersActive
            ? "请先搜索或选择 RX/TX 方向筛选"
            : currentViewEntries.length === 0
              ? "当前视图没有可导出的记录"
              : "导出当前筛选视图"
        }
        onClick={() => exportEntries(currentViewEntries, "view")}
      >
        <span>当前视图</span>
        <small>{currentViewEntries.length} 条</small>
      </button>
      {exportError ? (
        <span className="terminal-export-error" role="alert">
          {exportError}
        </span>
      ) : null}
    </div>
  );
}

function downloadTerminalEntries(
  entries: readonly TerminalEntry[],
  displayMode: DisplayMode,
  scope: "all" | "view",
): void {
  const content = serializeTerminalEntries(entries, displayMode);
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vofa-ultra-terminal-${scope}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.log`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
