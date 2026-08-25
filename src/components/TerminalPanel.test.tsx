import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialCommandTaskSnapshot } from "../core/commandWorkflow";
import {
  MAX_MODBUS_VALUE_TEXT_CHARACTERS,
  MAX_MODBUS_WRITE_COILS,
} from "../core/modbusRtu";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { TerminalEntry } from "../types/workbench";
import { TerminalPanel } from "./TerminalPanel";

const SEARCH_ENTRIES: TerminalEntry[] = [
  {
    id: 101,
    direction: "rx",
    timestamp: 1_000,
    text: "Temperature .* 23.5",
    hex: "54 65 6D 70",
    byteCount: 18,
  },
  {
    id: 102,
    direction: "rx",
    timestamp: 1_001,
    text: "Voltage 3.3",
    hex: "56 6F 6C 74",
    byteCount: 11,
  },
  {
    id: 103,
    direction: "tx",
    timestamp: 1_002,
    text: "SET RATE",
    hex: "53 45 54",
    byteCount: 8,
  },
];

describe("TerminalPanel", () => {
  beforeEach(() => {
    useWorkbenchStore.getState().stopPeriodicSend();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "connected",
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      replayStatus: "idle",
      replaySessionId: 0,
      terminalEntries: [],
      commandHistory: [],
      commandTask: createInitialCommandTaskSnapshot(),
      isSendingCommand: false,
      displayMode: "text",
      sendMode: "text",
      lineEnding: "none",
      terminalPaused: false,
      terminalAutoScroll: true,
    });
  });

  afterEach(() => {
    useWorkbenchStore.getState().stopPeriodicSend();
    cleanup();
  });

  it("区分空终端和已有记录但零匹配的状态", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    expect(screen.getByText("接收数据将在这里显示")).toBeVisible();
    expect(screen.queryByText("没有匹配的终端记录")).not.toBeInTheDocument();

    useWorkbenchStore.setState({ terminalEntries: SEARCH_ENTRIES });
    await user.type(screen.getByRole("searchbox", { name: "搜索终端记录" }), "not-found");
    expect(screen.queryByText("接收数据将在这里显示")).not.toBeInTheDocument();
    expect(screen.getByText("没有匹配的终端记录")).toBeVisible();
  });

  it("组合字面量搜索与 RX/TX 方向过滤且不修改原记录", async () => {
    useWorkbenchStore.setState({ terminalEntries: SEARCH_ENTRIES });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const search = screen.getByRole("searchbox", { name: "搜索终端记录" });
    const direction = screen.getByRole("group", { name: "终端方向筛选" });

    expect(search).toHaveAttribute("maxlength", "256");
    expect(screen.getByText("3 条记录")).toBeVisible();
    await user.type(search, ".*");
    expect(screen.getByText("1 / 3 条记录")).toBeVisible();
    expect(screen.getByRole("button", { name: "导出全部终端记录" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "清空全部终端记录" })).toBeEnabled();

    await user.click(within(direction).getByRole("button", { name: "TX" }));
    expect(within(direction).getByRole("button", { name: "TX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("0 / 3 条记录")).toBeVisible();
    expect(screen.getByText("没有匹配的终端记录")).toBeVisible();
    expect(useWorkbenchStore.getState().terminalEntries).toEqual(SEARCH_ENTRIES);

    await user.click(screen.getByRole("button", { name: "清空终端搜索" }));
    expect(search).toHaveValue("");
    expect(screen.getByText("1 / 3 条记录")).toBeVisible();
    await user.click(within(direction).getByRole("button", { name: "全部" }));
    expect(screen.getByText("3 条记录")).toBeVisible();
  });

  it("搜索当前显示格式并在 TEXT 与 HEX 间重新计算结果", async () => {
    useWorkbenchStore.setState({ terminalEntries: SEARCH_ENTRIES });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const search = screen.getByRole("searchbox", { name: "搜索终端记录" });

    await user.type(search, "54 65");
    expect(screen.getByText("0 / 3 条记录")).toBeVisible();
    await user.click(
      within(screen.getByRole("group", { name: "接收显示格式" })).getByRole("button", {
        name: "HEX",
      }),
    );
    expect(search).toHaveAttribute("placeholder", "搜索 HEX 内容");
    expect(screen.getByText("1 / 3 条记录")).toBeVisible();
  });

  it("用上下键恢复命令格式并在末尾返回原草稿", async () => {
    await useWorkbenchStore.getState().send("FIRST", "text", "lf");
    await useWorkbenchStore.getState().send("AA", "hex", "none");
    useWorkbenchStore.getState().setSendMode("hex");
    useWorkbenchStore.getState().setLineEnding("none");
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", {
      name: "发送内容",
    }) as HTMLTextAreaElement;
    const sendFormat = screen.getByRole("group", { name: "发送格式" });

    await user.type(input, "draft");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("AA");
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "data-active",
      "true",
    );

    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("FIRST");
    expect(within(sendFormat).getByRole("button", { name: "文本" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("lf");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(input).toHaveValue("draft");
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("none");
  });

  it("组合输入或文本选区存在时保留原生方向键行为", async () => {
    await useWorkbenchStore.getState().send("HISTORY", "text", "none");
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", {
      name: "发送内容",
    }) as HTMLTextAreaElement;

    await user.type(input, "draft");
    fireEvent.keyDown(input, { key: "ArrowUp", isComposing: true });
    expect(input).toHaveValue("draft");

    input.setSelectionRange(0, 5);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("draft");
  });

  it("从历史菜单恢复命令并清空会话历史", async () => {
    await useWorkbenchStore.getState().send("PING", "text", "crlf");
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "命令历史，1 条" }));
    const historyDialog = screen.getByRole("dialog", { name: "命令历史" });
    await user.click(within(historyDialog).getByRole("button", { name: /PING/ }));
    expect(screen.getByRole("textbox", { name: "发送内容" })).toHaveValue("PING");
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("crlf");

    await user.click(screen.getByRole("button", { name: "命令历史，1 条" }));
    await user.click(screen.getByRole("button", { name: "清空命令历史" }));
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(screen.getByRole("button", { name: "命令历史，0 条" })).toBeDisabled();
  });

  it("从变量菜单替换当前选区并展示最终字节数", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", {
      name: "发送内容",
    }) as HTMLTextAreaElement;

    await user.type(input, "ABCD");
    input.setSelectionRange(2, 4);
    fireEvent.select(input);
    const variableTrigger = screen.getByRole("button", { name: "插入命令变量" });
    await user.click(variableTrigger);
    const variableDialog = screen.getByRole("dialog", { name: "命令变量" });
    expect(within(variableDialog).getAllByRole("button")[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "命令变量" })).not.toBeInTheDocument();
    expect(variableTrigger).toHaveFocus();

    await user.click(variableTrigger);
    const reopenedVariableDialog = screen.getByRole("dialog", { name: "命令变量" });
    expect(
      within(reopenedVariableDialog).queryByRole("button", { name: /U16/ }),
    ).not.toBeInTheDocument();
    await user.click(
      within(reopenedVariableDialog).getByRole("button", { name: /插入发送序号/ }),
    );

    expect(input).toHaveValue("AB${seq}");
    expect(input.selectionStart).toBe("AB${seq}".length);
    expect(
      screen.getByLabelText("命令模板包含 1 个变量，最终 3 字节"),
    ).toHaveTextContent("1 个变量 · 3 B");

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().commandHistory[0]).toMatchObject({
        value: "AB${seq}",
        encodedBytes: 3,
        variableCount: 1,
      });
    });
    await user.click(screen.getByRole("button", { name: "命令历史，1 条" }));
    expect(screen.getByRole("dialog", { name: "命令历史" })).toHaveTextContent("最近 3 B");
  });

  it("HEX 变量菜单只提供定宽格式并发送原始字节", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const sendFormat = screen.getByRole("group", { name: "发送格式" });
    await user.click(within(sendFormat).getByRole("button", { name: "HEX" }));
    await user.click(screen.getByRole("button", { name: "插入命令变量" }));
    const variableDialog = screen.getByRole("dialog", { name: "命令变量" });

    expect(within(variableDialog).queryByRole("button", { name: /UTC 时间/ })).not.toBeInTheDocument();
    await user.click(
      within(variableDialog).getByRole("button", { name: /插入序号 U16 LE/ }),
    );
    expect(screen.getByRole("textbox", { name: "发送内容" })).toHaveValue("${seq:u16le}");
    expect(
      screen.getByLabelText("命令模板包含 1 个变量，最终 2 字节"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(
        useWorkbenchStore
          .getState()
          .terminalEntries.find((entry) => entry.direction === "tx")?.hex,
      ).toBe("01 00");
    });
  });

  it("将 Modbus RTU 帧填入 HEX 草稿但只通过原发送入口产生 TX", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = screen.getByRole("dialog", { name: "Modbus RTU 构帧器" });
    const operation = within(builder).getByRole("combobox", { name: "Modbus 功能" });
    expect(operation).toHaveFocus();
    expect(within(operation).getAllByRole("option")).toHaveLength(8);
    expect(within(builder).getByLabelText("Modbus RTU 帧预览")).toHaveTextContent(
      "01 03 00 00 00 01 84 0A",
    );
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);

    await user.click(within(builder).getByRole("button", { name: "填入发送框" }));
    expect(screen.queryByRole("dialog", { name: "Modbus RTU 构帧器" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "发送内容" })).toHaveValue(
      "01 03 00 00 00 01 84 0A",
    );
    expect(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "HEX",
      }),
    ).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("none");
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().commandHistory[0]).toMatchObject({
        mode: "hex",
        lineEnding: "none",
        encodedBytes: 8,
      });
      expect(
        useWorkbenchStore
          .getState()
          .terminalEntries.find((entry) => entry.direction === "tx")?.hex,
      ).toBe("01 03 00 00 00 01 84 0A");
    });
  });

  it("工作区切换期间关闭并禁用 Modbus RTU 构帧器", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const trigger = screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Modbus RTU 构帧器" })).toBeVisible();

    useWorkbenchStore.setState({ workspaceTransitionStatus: "switching" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Modbus RTU 构帧器" })).not.toBeInTheDocument();
      expect(trigger).toBeDisabled();
    });
    expect(screen.getByRole("textbox", { name: "发送内容" })).toHaveValue("");
    expect(useWorkbenchStore.getState()).toMatchObject({
      sendMode: "text",
      lineEnding: "none",
    });
  });

  it("允许输入带常见分隔符的最大多线圈请求", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = screen.getByRole("dialog", { name: "Modbus RTU 构帧器" });
    await user.selectOptions(
      within(builder).getByRole("combobox", { name: "Modbus 功能" }),
      "write-multiple-coils",
    );
    const input = within(builder).getByRole("textbox", {
      name: "Modbus 多线圈值",
    });
    const maximumValues = Array.from(
      { length: MAX_MODBUS_WRITE_COILS },
      (_, index) => (index % 2 === 0 ? "1" : "0"),
    ).join(", ");

    expect(maximumValues.length).toBeGreaterThan(4_096);
    expect(maximumValues.length).toBeLessThanOrEqual(MAX_MODBUS_VALUE_TEXT_CHARACTERS);
    expect(input).toHaveAttribute("maxlength", String(MAX_MODBUS_VALUE_TEXT_CHARACTERS));
    fireEvent.change(input, { target: { value: maximumValues } });
    expect(input).toHaveValue(maximumValues);
    expect(within(builder).getByRole("button", { name: "填入发送框" })).toBeEnabled();
  });

  it("在构帧器中拒绝读广播和越过末地址的范围并可用 Escape 关闭", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const trigger = screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" });

    await user.click(trigger);
    let builder = screen.getByRole("dialog", { name: "Modbus RTU 构帧器" });
    await user.clear(within(builder).getByRole("textbox", { name: "Modbus 站号" }));
    await user.type(within(builder).getByRole("textbox", { name: "Modbus 站号" }), "0");
    expect(within(builder).getByRole("status")).toHaveTextContent(
      "读取请求不能使用广播站号 0",
    );
    expect(within(builder).getByRole("button", { name: "填入发送框" })).toBeDisabled();

    await user.selectOptions(
      within(builder).getByRole("combobox", { name: "Modbus 功能" }),
      "write-multiple-registers",
    );
    expect(within(builder).getByText(/广播 · 无响应/)).toBeVisible();
    await user.clear(within(builder).getByRole("textbox", { name: "Modbus 起始地址" }));
    await user.type(
      within(builder).getByRole("textbox", { name: "Modbus 起始地址" }),
      "65535",
    );
    expect(within(builder).getByRole("status")).toHaveTextContent(
      "请求范围不能超过地址 65535",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Modbus RTU 构帧器" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    builder = screen.getByRole("dialog", { name: "Modbus RTU 构帧器" });
    expect(within(builder).getByRole("combobox", { name: "Modbus 功能" })).toHaveValue(
      "read-holding-registers",
    );
  });

  it("用相同变量替换原选区时仍恢复输入焦点和光标", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", {
      name: "发送内容",
    }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "${seq}" } });
    input.setSelectionRange(0, "${seq}".length);
    fireEvent.select(input);

    await user.click(screen.getByRole("button", { name: "插入命令变量" }));
    await user.click(
      screen.getByRole("button", { name: /插入发送序号/ }),
    );

    expect(input).toHaveValue("${seq}");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe("${seq}".length);
    expect(input.selectionEnd).toBe("${seq}".length);
  });

  it("非法模板显示错误并禁用手动和周期发送", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    fireEvent.change(input, { target: { value: "${globalThis.process}" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("命令变量名称无效");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "展开周期发送设置" }));
    expect(screen.getByRole("button", { name: "启动" })).toBeDisabled();
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);
  });

  it("周期任务运行时冻结输入副本并保留可达的停止按钮", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    await user.type(input, "PING");
    await user.click(screen.getByRole("button", { name: "展开周期发送设置" }));
    await user.click(screen.getByRole("button", { name: "持续" }));
    await user.click(screen.getByRole("button", { name: "启动" }));
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();

    await user.clear(input);
    await user.type(input, "CHANGED");
    expect(input).toHaveValue("CHANGED");
    expect(useWorkbenchStore.getState().commandHistory[0]?.value).toBe("PING");

    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().commandTask.status).toBe("stopped");
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible();
  });
});
