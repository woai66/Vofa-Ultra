import { describe, expect, it } from "vitest";
import type { TerminalEntry } from "../types/workbench";
import { serializeTerminalEntries } from "./terminalExport";

const ENTRIES: TerminalEntry[] = [
  {
    id: 7,
    direction: "tx",
    timestamp: 1_700_000_000_123,
    text: "设置速率",
    hex: "E8 AE BE E7 BD AE E9 80 9F E7 8E 87",
    byteCount: 12,
  },
  {
    id: 3,
    direction: "rx",
    timestamp: 1_700_000_001_456,
    text: "温度 23.5 C",
    hex: "E6 B8 A9 E5 BA A6 20 32 33 2E 35 20 43",
    byteCount: 13,
  },
  {
    id: 11,
    direction: "system",
    timestamp: 1_700_000_002_789,
    text: "已连接",
    hex: "",
    byteCount: 0,
  },
];

describe("终端导出序列化", () => {
  it("按输入顺序写入 ISO 绝对时间、方向、字节数与 TEXT payload", () => {
    expect(serializeTerminalEntries(ENTRIES, "text")).toBe(
      [
        "2023-11-14T22:13:20.123Z\tTX\t12\t设置速率",
        "2023-11-14T22:13:21.456Z\tRX\t13\t温度 23.5 C",
        "2023-11-14T22:13:22.789Z\tSYSTEM\t0\t已连接",
      ].join("\n"),
    );
  });

  it("仅由当前显示模式选择 HEX payload", () => {
    expect(serializeTerminalEntries(ENTRIES, "hex")).toBe(
      [
        "2023-11-14T22:13:20.123Z\tTX\t12\tE8 AE BE E7 BD AE E9 80 9F E7 8E 87",
        "2023-11-14T22:13:21.456Z\tRX\t13\tE6 B8 A9 E5 BA A6 20 32 33 2E 35 20 43",
        "2023-11-14T22:13:22.789Z\tSYSTEM\t0\t已连接",
      ].join("\n"),
    );
  });

  it("空集序列化为空字符串", () => {
    expect(serializeTerminalEntries([], "text")).toBe("");
    expect(serializeTerminalEntries([], "hex")).toBe("");
  });

  it("保留 UTF-8 文本并转义换行、制表符与反斜杠", () => {
    const entry: TerminalEntry = {
      id: 1,
      direction: "rx",
      timestamp: Date.UTC(2025, 0, 2, 3, 4, 5, 6),
      text: "温度\t23 ℃\r\n路径 C:\\设备\\日志\n完成 ✅",
      hex: "00 09 0D 0A FF",
      byteCount: 5,
    };

    expect(serializeTerminalEntries([entry], "text")).toBe(
      "2025-01-02T03:04:05.006Z\tRX\t5\t" +
        "温度\\t23 ℃\\r\\n路径 C:\\\\设备\\\\日志\\n完成 ✅",
    );
    expect(serializeTerminalEntries([entry], "text").split("\n")).toHaveLength(1);
  });

  it("优先导出解码原文，避免把界面转义结果再次转义", () => {
    const entry: TerminalEntry = {
      id: 12,
      direction: "rx",
      timestamp: Date.UTC(2025, 0, 2, 3, 4, 5, 6),
      text: "line 1\\nliteral \\n\\tend\\r\\n",
      decodedText: "line 1\nliteral \\n\tend\r\n",
      hex: "",
      byteCount: 24,
    };

    expect(serializeTerminalEntries([entry], "text")).toBe(
      "2025-01-02T03:04:05.006Z\tRX\t24\tline 1\\nliteral \\\\n\\tend\\r\\n",
    );
  });

  it("转义 C0、C1 和 Unicode 行分隔符以保持单条记录单行", () => {
    const entry: TerminalEntry = {
      id: 13,
      direction: "rx",
      timestamp: Date.UTC(2025, 0, 2, 3, 4, 5, 6),
      text: "A·B\\u0085C\\u2028D\\u2029E",
      decodedText: "A\0B\u0085C\u2028D\u2029E",
      hex: "",
      byteCount: 14,
    };

    const exported = serializeTerminalEntries([entry], "text");
    expect(exported).toBe(
      "2025-01-02T03:04:05.006Z\tRX\t14\tA\\u0000B\\u0085C\\u2028D\\u2029E",
    );
    for (const code of [0x00, 0x85, 0x2028, 0x2029]) {
      expect(exported).not.toContain(String.fromCodePoint(code));
    }
  });
});
