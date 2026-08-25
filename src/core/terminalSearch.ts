import type { DisplayMode } from "../types/serial";
import type { TerminalEntry } from "../types/workbench";

export const MAX_TERMINAL_SEARCH_CHARACTERS = 256;
export const MAX_TERMINAL_HIGHLIGHTS_PER_ENTRY = 64;

export type TerminalDirectionFilter = "all" | "rx" | "tx";

export interface TerminalLiteralMatch {
  start: number;
  end: number;
}

interface TerminalSearchOptions {
  direction: TerminalDirectionFilter;
  displayMode: DisplayMode;
  query: string;
}

export function terminalEntryPayload(entry: TerminalEntry, displayMode: DisplayMode): string {
  return displayMode === "text" ? entry.text : entry.hex;
}

export function filterTerminalEntries(
  entries: readonly TerminalEntry[],
  options: TerminalSearchOptions,
): readonly TerminalEntry[] {
  if (options.direction === "all" && !options.query) {
    return entries;
  }
  const pattern = options.query ? createLiteralPattern(options.query, "iu") : null;
  return entries.filter((entry) => {
    if (options.direction !== "all" && entry.direction !== options.direction) {
      return false;
    }
    return !pattern || pattern.test(terminalEntryPayload(entry, options.displayMode));
  });
}

export function findTerminalLiteralMatches(value: string, query: string): TerminalLiteralMatch[] {
  if (!query) {
    return [];
  }
  const matches: TerminalLiteralMatch[] = [];
  for (const match of value.matchAll(createLiteralPattern(query, "giu"))) {
    if (match.index === undefined) {
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= MAX_TERMINAL_HIGHLIGHTS_PER_ENTRY) {
      break;
    }
  }
  return matches;
}

function createLiteralPattern(query: string, flags: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}
