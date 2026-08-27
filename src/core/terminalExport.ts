import type { DisplayMode } from "../types/serial";
import type { TerminalEntry } from "../types/workbench";

export function serializeTerminalEntries(
  entries: readonly TerminalEntry[],
  displayMode: DisplayMode,
): string {
  return entries
    .map((entry) => {
      const timestamp = new Date(entry.timestamp).toISOString();
      const payload = displayMode === "text" ? entry.text : entry.hex;
      return (
        `${timestamp}\t${entry.direction.toUpperCase()}\t${entry.byteCount}\t` +
        escapeTerminalPayload(payload)
      );
    })
    .join("\n");
}

function escapeTerminalPayload(payload: string): string {
  return payload
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}
