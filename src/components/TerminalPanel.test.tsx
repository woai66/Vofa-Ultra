import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialCommandTaskSnapshot } from "../core/commandWorkflow";
import { useWorkbenchStore } from "../store/workbenchStore";
import { TerminalPanel } from "./TerminalPanel";

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
