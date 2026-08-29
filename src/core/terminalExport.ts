import type { DisplayMode } from "../types/serial";
import type { TerminalEntry } from "../types/workbench";

export function serializeTerminalEntries(
  entries: readonly TerminalEntry[],
  displayMode: DisplayMode,
): string {
  return entries
    .map((entry) => {
      const timestamp = new Date(entry.timestamp).toISOString();
      const payload =
        entry.direction === "system" || displayMode === "text"
          ? (entry.decodedText ?? entry.text)
          : entry.hex;
      return (
        `${timestamp}\t${entry.direction.toUpperCase()}\t${entry.byteCount}\t` +
        escapeTerminalPayload(payload)
      );
    })
    .join("\n");
}

function escapeTerminalPayload(payload: string): string {
  const escapedWhitespace = payload
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return Array.from(escapedWhitespace, (character) =>
    isTerminalControlCharacter(character) ? unicodeEscape(character) : character,
  ).join("");
}

function isTerminalControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0 && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

function unicodeEscape(character: string): string {
  return `\\u${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}
