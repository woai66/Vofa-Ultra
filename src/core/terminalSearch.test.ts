import { describe, expect, it } from "vitest";
import type { TerminalEntry } from "../types/workbench";
import {
  filterTerminalEntries,
  findTerminalLiteralMatches,
  MAX_TERMINAL_HIGHLIGHTS_PER_ENTRY,
} from "./terminalSearch";

const ENTRIES: TerminalEntry[] = [
  {
    id: 1,
    direction: "rx",
    timestamp: 1_000,
    text: "Temperature .* 23.5",
    hex: "54 65 6D 70",
    byteCount: 18,
  },
  {
    id: 2,
    direction: "tx",
    timestamp: 1_001,
    text: "SET RATE",
    hex: "53 45 54",
    byteCount: 8,
  },
  {
    id: 3,
    direction: "system",
    timestamp: 1_002,
    text: "Connected",
    hex: "",
    byteCount: 0,
  },
];

describe("终端字面量搜索", () => {
  it("无筛选时保留原有有界数组并包含 system 记录", () => {
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "all",
        displayMode: "text",
        query: "",
      }),
    ).toBe(ENTRIES);
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "all",
        displayMode: "text",
        query: "",
      }).map((entry) => entry.id),
    ).toEqual([1, 2, 3]);
  });

  it("把正则元字符作为普通文本并忽略大小写", () => {
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "all",
        displayMode: "text",
        query: ".*",
      }).map((entry) => entry.id),
    ).toEqual([1]);
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "all",
        displayMode: "text",
        query: "set rate",
      }).map((entry) => entry.id),
    ).toEqual([2]);
  });

  it("组合当前显示格式与 RX/TX 方向过滤", () => {
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "rx",
        displayMode: "hex",
        query: "54 65",
      }).map((entry) => entry.id),
    ).toEqual([1]);
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "tx",
        displayMode: "text",
        query: "",
      }).map((entry) => entry.id),
    ).toEqual([2]);
    expect(
      filterTerminalEntries(ENTRIES, {
        direction: "rx",
        displayMode: "text",
        query: "connected",
      }),
    ).toEqual([]);
  });

  it("返回有界的非重叠命中原文本范围", () => {
    expect(findTerminalLiteralMatches("Error ERROR error", "error")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
    expect(findTerminalLiteralMatches("unchanged", "")).toEqual([]);
  });

  it("限制单条记录的高亮节点数量", () => {
    const matches = findTerminalLiteralMatches(".".repeat(1_000), ".");
    expect(matches).toHaveLength(MAX_TERMINAL_HIGHLIGHTS_PER_ENTRY);
    expect(matches.at(-1)).toEqual({ start: 63, end: 64 });
  });
});
