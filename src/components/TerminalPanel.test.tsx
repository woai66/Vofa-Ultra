import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialCommandTaskSnapshot } from "../core/commandWorkflow";
import { createInitialModbusPollSnapshot } from "../core/modbusPoller";
import {
  createInitialModbusRtuTransactionSnapshot,
  MAX_MODBUS_VALUE_TEXT_CHARACTERS,
  MAX_MODBUS_WRITE_COILS,
} from "../core/modbusRtu";
import { TERMINAL_TIME_MODE_STORAGE_KEY } from "../core/terminalTime";
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

const DEFAULT_SEND = useWorkbenchStore.getState().send;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("TerminalPanel", () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_TIME_MODE_STORAGE_KEY);
    useWorkbenchStore.getState().stopModbusPolling();
    useWorkbenchStore.getState().stopPeriodicSend();
    useWorkbenchStore.getState().clearTerminal();
    useWorkbenchStore.setState({
      source: "simulator",
      isNativeRuntime: false,
      connectionStatus: "connected",
      workspaceTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      incompatibleStorageVersion: null,
      runtimeTransitionStatus: "idle",
      replayStatus: "idle",
      replaySessionId: 0,
      terminalEntries: [],
      commandHistory: [],
      quickCommands: [],
      modbusPoll: createInitialModbusPollSnapshot(),
      modbusTransaction: createInitialModbusRtuTransactionSnapshot(),
      modbusTransactions: [],
      serialFileSend: {
        jobId: 0,
        revision: 0,
        generation: 0,
        status: "idle",
        fileName: "",
        totalBytes: 0,
        transmittedBytes: 0,
        message: "",
      },
      serialControlLineOperation: "idle",
      commandTask: createInitialCommandTaskSnapshot(),
      isSendingCommand: false,
      displayMode: "text",
      sendMode: "text",
      lineEnding: "none",
      commandChecksum: "none",
      terminalRxRecordMode: "chunk",
      terminalRxLineEnding: "lf",
      terminalRxTextEncoding: "utf-8",
      terminalTxTextEncoding: "utf-8",
      terminalPaused: false,
      terminalAutoScroll: true,
      send: DEFAULT_SEND,
    });
  });

  afterEach(() => {
    useWorkbenchStore.getState().stopModbusPolling();
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

  it("切换绝对、缓存相对和可见记录间隔时间并恢复独立偏好", async () => {
    const viewportHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(240);
    useWorkbenchStore.setState({
      terminalEntries: [
        { id: 201, direction: "rx", timestamp: 1_000, text: "first", hex: "01", byteCount: 1 },
        { id: 202, direction: "tx", timestamp: 1_100, text: "second", hex: "02", byteCount: 1 },
        { id: 203, direction: "rx", timestamp: 900, text: "late line", hex: "03", byteCount: 1 },
        { id: 204, direction: "tx", timestamp: 1_500, text: "fourth", hex: "04", byteCount: 1 },
      ],
    });
    const user = userEvent.setup();
    const firstRender = render(<TerminalPanel />);
    const modeGroup = screen.getByRole("group", { name: "终端时间基准" });
    const timeLabels = () =>
      [...screen.getByRole("log", { name: "终端记录" }).querySelectorAll("time")].map(
        (time) => time.textContent,
      );

    expect(within(modeGroup).getByRole("button", { name: "ABS，绝对时间" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(modeGroup).getByRole("button", { name: "REL，相对缓存起点" }));
    await waitFor(() => {
      expect(timeLabels()).toEqual([
        "+00:00:00.000",
        "+00:00:00.100",
        "-00:00:00.100",
        "+00:00:00.500",
      ]);
    });
    expect(localStorage.getItem(TERMINAL_TIME_MODE_STORAGE_KEY)).toBe("relative");

    await user.click(within(modeGroup).getByRole("button", { name: "ΔT，距上一条可见记录" }));
    await waitFor(() => {
      expect(timeLabels()).toEqual([
        "--",
        "+00:00:00.100",
        "-00:00:00.200",
        "+00:00:00.600",
      ]);
    });
    await user.click(
      within(screen.getByRole("group", { name: "终端方向筛选" })).getByRole("button", {
        name: "TX",
      }),
    );
    await waitFor(() => {
      expect(timeLabels()).toEqual(["--", "+00:00:00.400"]);
    });
    expect(localStorage.getItem(TERMINAL_TIME_MODE_STORAGE_KEY)).toBe("interval");

    firstRender.unmount();
    render(<TerminalPanel />);
    expect(screen.getByRole("button", { name: "ΔT，距上一条可见记录" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    viewportHeight.mockRestore();
  });

  it("切换接收记录方式并独立选择 RX 行尾与文本编码", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const recordMode = screen.getByRole("group", { name: "接收记录方式" });
    const lineEnding = screen.getByRole("combobox", { name: "接收行尾" });
    const textEncoding = screen.getByRole("combobox", { name: "接收文本编码" });

    expect(within(recordMode).getByRole("button", { name: "按读取块记录" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(lineEnding).toBeDisabled();
    expect(lineEnding).toHaveAttribute("id", "terminal-rx-line-ending");
    expect(lineEnding).toHaveAttribute("name", "terminal-rx-line-ending");
    expect(textEncoding).toHaveValue("utf-8");
    expect(textEncoding).toHaveAttribute("id", "terminal-rx-text-encoding");
    expect(textEncoding).toHaveAttribute("name", "terminal-rx-text-encoding");

    await user.click(within(recordMode).getByRole("button", { name: "按文本行记录" }));
    expect(lineEnding).toBeEnabled();
    await user.selectOptions(lineEnding, "cr");
    await user.selectOptions(textEncoding, "gb18030");

    expect(useWorkbenchStore.getState()).toMatchObject({
      terminalRxRecordMode: "line",
      terminalRxLineEnding: "cr",
      terminalRxTextEncoding: "gb18030",
    });
  });

  it("显示未结束 RX 行的边界警示且不改变原始载荷", async () => {
    const viewportHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(240);
    useWorkbenchStore.setState({
      terminalEntries: [
        {
          id: 150,
          direction: "rx",
          timestamp: 100,
          text: "partial",
          hex: "70 61 72 74 69 61 6C",
          byteCount: 7,
          rxBoundary: "unterminated",
        },
      ],
    });
    render(<TerminalPanel />);

    await waitFor(() => {
      expect(screen.getByText("partial")).toBeVisible();
      const warning = screen.getByRole("img", {
        name: "记录已在边界处结束，未包含配置的接收行尾",
      });
      expect(warning).toBeVisible();
      expect(warning.parentElement).toHaveAttribute(
        "title",
        "记录已在边界处结束，未包含配置的接收行尾",
      );
    });
    expect(useWorkbenchStore.getState().terminalEntries).toMatchObject([
      { text: "partial", hex: "70 61 72 74 69 61 6C", byteCount: 7 },
    ]);
    viewportHeight.mockRestore();
  });

  it("上滚时挂起自动跟随且回到最新后继续接收记录", async () => {
    const initialEntries = Array.from(
      { length: 20 },
      (_, index): TerminalEntry => ({
        id: 200 + index,
        direction: "rx",
        timestamp: 2_000 + index,
        text: `sample ${index}`,
        hex: "73 61 6D 70 6C 65",
        byteCount: 8,
      }),
    );
    useWorkbenchStore.setState({ terminalEntries: initialEntries });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const viewport = screen.getByRole("log", { name: "终端记录" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 480 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });

    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "回到最新记录" })).toBeVisible();
    expect(useWorkbenchStore.getState()).toMatchObject({
      terminalAutoScroll: true,
      terminalPaused: false,
    });

    useWorkbenchStore.setState({
      terminalEntries: [
        ...initialEntries,
        {
          id: 220,
          direction: "rx",
          timestamp: 2_020,
          text: "latest sample",
          hex: "6C 61 74 65 73 74",
          byteCount: 13,
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByText("21 条记录")).toBeVisible();
    });
    expect(viewport.scrollTop).toBe(120);
    expect(screen.getByRole("button", { name: "回到最新记录" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "回到最新记录" }));
    expect(screen.queryByRole("button", { name: "回到最新记录" })).not.toBeInTheDocument();
    expect(viewport).toHaveFocus();
    expect(useWorkbenchStore.getState().terminalEntries).toHaveLength(21);
  });

  it("手动滚回底部时恢复跟随且禁用自动滚动时只提供单次跳转", async () => {
    useWorkbenchStore.setState({ terminalEntries: SEARCH_ENTRIES });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const viewport = screen.getByRole("log", { name: "终端记录" });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 480 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });

    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "回到最新记录" })).toBeVisible();
    viewport.scrollTop = 360;
    fireEvent.scroll(viewport);
    expect(screen.queryByRole("button", { name: "回到最新记录" })).not.toBeInTheDocument();

    useWorkbenchStore.setState({ terminalAutoScroll: false });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 528 });
    useWorkbenchStore.setState({
      terminalEntries: [
        ...SEARCH_ENTRIES,
        {
          id: 104,
          direction: "rx",
          timestamp: 1_003,
          text: "latest",
          hex: "6C 61 74 65 73 74",
          byteCount: 6,
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "回到最新记录" })).toBeVisible();
    });
    await user.click(screen.getByRole("button", { name: "回到最新记录" }));
    expect(screen.queryByRole("button", { name: "回到最新记录" })).not.toBeInTheDocument();
    expect(useWorkbenchStore.getState().terminalAutoScroll).toBe(false);

    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "回到最新记录" })).toBeVisible();
    useWorkbenchStore.setState({ terminalAutoScroll: true });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "回到最新记录" })).not.toBeInTheDocument();
    });
  });

  it("组合字面量搜索与 RX/TX 方向过滤且不修改原记录", async () => {
    useWorkbenchStore.setState({ terminalEntries: SEARCH_ENTRIES });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const search = screen.getByRole("searchbox", { name: "搜索终端记录" });
    const direction = screen.getByRole("group", { name: "终端方向筛选" });

    expect(search).toHaveAttribute("id", "terminal-search-query");
    expect(search).toHaveAttribute("name", "terminal-search-query");
    expect(search).toHaveAttribute("maxlength", "256");
    expect(screen.getByText("3 条记录")).toBeVisible();
    await user.type(search, ".*");
    expect(screen.getByText("1 / 3 条记录")).toBeVisible();
    const exportTrigger = screen.getByRole("button", { name: "导出终端记录" });
    await user.click(exportTrigger);
    const exportMenu = await screen.findByRole("menu", { name: "终端导出范围" });
    const exportAll = within(exportMenu).getByRole("menuitem", { name: "全部缓存 3 条" });
    const exportView = within(exportMenu).getByRole("menuitem", { name: "当前视图 1 条" });
    expect(exportAll).toBeEnabled();
    expect(exportAll).toHaveFocus();
    expect(exportView).toBeEnabled();
    await user.keyboard("{ArrowDown}");
    expect(exportView).toHaveFocus();
    await user.keyboard("{Home}");
    expect(exportAll).toHaveFocus();
    await user.keyboard("{End}");
    expect(exportView).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(exportAll).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(exportView).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "终端导出范围" })).not.toBeInTheDocument();
    expect(exportTrigger).toHaveFocus();
    await user.click(exportTrigger);
    await user.click(search);
    expect(screen.queryByRole("menu", { name: "终端导出范围" })).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    expect(screen.getByRole("button", { name: "清空全部终端记录" })).toBeEnabled();

    await user.click(within(direction).getByRole("button", { name: "TX" }));
    expect(within(direction).getByRole("button", { name: "TX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("0 / 3 条记录")).toBeVisible();
    expect(screen.getByText("没有匹配的终端记录")).toBeVisible();
    expect(useWorkbenchStore.getState().terminalEntries).toEqual(SEARCH_ENTRIES);

    await user.click(exportTrigger);
    expect(
      within(screen.getByRole("menu", { name: "终端导出范围" })).getByRole("menuitem", {
        name: "全部缓存 3 条",
      }),
    ).toBeEnabled();
    expect(
      within(screen.getByRole("menu", { name: "终端导出范围" })).getByRole("menuitem", {
        name: "当前视图 0 条",
      }),
    ).toBeDisabled();
    await user.click(exportTrigger);

    await user.click(screen.getByRole("button", { name: "清空终端搜索" }));
    expect(search).toHaveValue("");
    expect(screen.getByText("1 / 3 条记录")).toBeVisible();
    await user.click(within(direction).getByRole("button", { name: "全部" }));
    expect(screen.getByText("3 条记录")).toBeVisible();
    await user.click(exportTrigger);
    expect(
      within(screen.getByRole("menu", { name: "终端导出范围" })).getByRole("menuitem", {
        name: "当前视图 3 条",
      }),
    ).toBeDisabled();
  });

  it("搜索当前显示格式并在 TEXT 与 HEX 间重新计算结果", async () => {
    useWorkbenchStore.setState({ terminalEntries: SEARCH_ENTRIES });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const search = screen.getByRole("searchbox", { name: "搜索终端记录" });
    const displayFormat = screen.getByRole("group", { name: "接收显示格式" });

    expect(within(displayFormat).getByRole("button", { name: "TEXT" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(displayFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.type(search, "54 65");
    expect(screen.getByText("0 / 3 条记录")).toBeVisible();
    await user.click(within(displayFormat).getByRole("button", { name: "HEX" }));
    expect(within(displayFormat).getByRole("button", { name: "TEXT" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(displayFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(search).toHaveAttribute("placeholder", "搜索 HEX 内容");
    expect(screen.getByText("1 / 3 条记录")).toBeVisible();
  });

  it("用上下键恢复命令格式并在末尾返回原草稿", async () => {
    useWorkbenchStore.getState().setCommandChecksum("sum8");
    useWorkbenchStore.getState().setTerminalTxTextEncoding("gb18030");
    await useWorkbenchStore.getState().send("FIRST", "text", "lf");
    useWorkbenchStore.getState().setCommandChecksum("xor8");
    useWorkbenchStore.getState().setTerminalTxTextEncoding("utf-8");
    await useWorkbenchStore.getState().send("AA", "hex", "none");
    useWorkbenchStore.getState().setSendMode("hex");
    useWorkbenchStore.getState().setLineEnding("none");
    useWorkbenchStore.getState().setCommandChecksum("crc32-be");
    useWorkbenchStore.getState().setTerminalTxTextEncoding("windows-1252");
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", {
      name: "发送内容",
    }) as HTMLTextAreaElement;
    const sendFormat = screen.getByRole("group", { name: "发送格式" });
    const textEncoding = screen.getByRole("combobox", { name: "发送文本编码" });

    expect(within(sendFormat).getByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.type(input, "draft");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("AA");
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "校验" })).toHaveValue("xor8");

    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("FIRST");
    expect(within(sendFormat).getByRole("button", { name: "文本" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(sendFormat).getByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("lf");
    expect(screen.getByRole("combobox", { name: "校验" })).toHaveValue("sum8");
    expect(textEncoding).toHaveValue("gb18030");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(input).toHaveValue("draft");
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(sendFormat).getByRole("button", { name: "HEX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("none");
    expect(screen.getByRole("combobox", { name: "校验" })).toHaveValue("crc32-be");
    expect(textEncoding).toHaveValue("windows-1252");
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
    useWorkbenchStore.getState().setCommandChecksum("crc32-le");
    await useWorkbenchStore.getState().send("PING", "text", "crlf");
    useWorkbenchStore.getState().setCommandChecksum("none");
    const user = userEvent.setup();
    render(<TerminalPanel />);

    const historyTrigger = screen.getByRole("button", { name: "命令历史，1 条" });
    await user.click(historyTrigger);
    let historyDialog = await screen.findByRole("dialog", { name: "命令历史" });
    expect(historyDialog).toHaveTextContent("CRC32-LE");
    expect(within(historyDialog).getByRole("button", { name: /PING/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "命令历史" })).not.toBeInTheDocument();
    expect(historyTrigger).toHaveFocus();

    await user.click(historyTrigger);
    historyDialog = await screen.findByRole("dialog", { name: "命令历史" });
    await user.click(within(historyDialog).getByRole("button", { name: /PING/ }));
    expect(screen.getByRole("textbox", { name: "发送内容" })).toHaveValue("PING");
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("crlf");
    expect(screen.getByRole("combobox", { name: "校验" })).toHaveValue("crc32-le");

    await user.click(historyTrigger);
    await user.click(screen.getByRole("button", { name: "清空命令历史" }));
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(screen.getByRole("button", { name: "命令历史，0 条" })).toBeDisabled();
  });

  it("在 TEXT 和 HEX 发送中追加单字节 CR", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });
    const lineEnding = screen.getByRole("combobox", { name: "行尾" });

    await user.selectOptions(lineEnding, "cr");
    await user.type(input, "AT");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().terminalEntries.at(-1)?.hex).toBe("41 54 0D");
    });

    await user.click(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "HEX",
      }),
    );
    await user.clear(input);
    await user.type(input, "01 FF");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().terminalEntries.at(-1)?.hex).toBe("01 FF 0D");
    });
  });

  it("发送完成前编辑新草稿时保留新内容", async () => {
    const deferred = createDeferred<void>();
    const send = vi.fn(() => deferred.promise);
    useWorkbenchStore.setState({ send });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    await user.type(input, "FIRST");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(send).toHaveBeenCalledWith("FIRST", "text", "none");
    await user.clear(input);
    await user.type(input, "SECOND");
    deferred.resolve();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    });
    expect(input).toHaveValue("SECOND");
  });

  it("旧发送失败时不把错误显示到新草稿", async () => {
    const deferred = createDeferred<void>();
    useWorkbenchStore.setState({ send: vi.fn(() => deferred.promise) });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    await user.type(input, "FIRST");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.clear(input);
    await user.type(input, "SECOND");
    deferred.reject(new Error("串口写入失败"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    });
    expect(input).toHaveValue("SECOND");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("发送期间草稿未变化时仍在成功后清空", async () => {
    const deferred = createDeferred<void>();
    useWorkbenchStore.setState({ send: vi.fn(() => deferred.promise) });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    await user.type(input, "PING");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "文本",
      }),
    );
    deferred.resolve();

    await waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("发送完成前外部切换行尾时保留原 payload", async () => {
    const deferred = createDeferred<void>();
    useWorkbenchStore.setState({ send: vi.fn(() => deferred.promise) });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    await user.type(input, "PING");
    await user.click(screen.getByRole("button", { name: "发送" }));
    useWorkbenchStore.getState().setLineEnding("cr");
    deferred.resolve();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    });
    expect(input).toHaveValue("PING");
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("cr");
  });

  it("草稿未变化且发送失败时显示对应错误", async () => {
    const deferred = createDeferred<void>();
    useWorkbenchStore.setState({ send: vi.fn(() => deferred.promise) });
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.type(screen.getByRole("textbox", { name: "发送内容" }), "PING");
    await user.click(screen.getByRole("button", { name: "发送" }));
    deferred.reject(new Error("串口写入失败"));

    expect(await screen.findByRole("alert")).toHaveTextContent("串口写入失败");
  });

  it("选择 GB18030 后按实际字节预览、发送并从历史恢复编码", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });
    const encoding = screen.getByRole("combobox", { name: "发送文本编码" });
    const send = screen.getByRole("button", { name: "发送" });

    expect(within(encoding).getAllByRole("option")).toHaveLength(3);
    await user.selectOptions(encoding, "gb18030");
    await user.type(input, "中文€");
    await waitFor(() => {
      expect(screen.getByLabelText("命令模板包含 0 个变量，最终 6 字节")).toBeVisible();
      expect(send).toBeEnabled();
    });

    await user.click(send);
    await waitFor(() => {
      expect(useWorkbenchStore.getState().terminalEntries.at(-1)).toMatchObject({
        text: "中文€",
        hex: "D6 D0 CE C4 A2 E3",
      });
    });
    expect(useWorkbenchStore.getState().commandHistory[0]).toMatchObject({
      textEncoding: "gb18030",
      encodedBytes: 6,
    });

    await user.selectOptions(encoding, "utf-8");
    await user.click(screen.getByRole("button", { name: "命令历史，1 条" }));
    const historyDialog = await screen.findByRole("dialog", { name: "命令历史" });
    await user.click(within(historyDialog).getByRole("button", { name: /中文/ }));
    expect(encoding).toHaveValue("gb18030");
  });

  it("自动附加所选校验尾并在预览中展示最终帧", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const checksum = screen.getByRole("combobox", { name: "校验" });
    const input = screen.getByRole("textbox", { name: "发送内容" });

    expect(within(checksum).getAllByRole("option")).toHaveLength(7);
    await user.click(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "HEX",
      }),
    );
    await user.selectOptions(checksum, "crc16-modbus-le");
    await user.selectOptions(screen.getByRole("combobox", { name: "行尾" }), "cr");
    await user.type(input, "31 32 33 34 35 36 37 38 39");

    expect(
      screen.getByLabelText("命令模板包含 0 个变量，最终 12 字节，校验尾 37 4B"),
    ).toHaveTextContent("0 个变量 · 12 B · 校验 37 4B");

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().terminalEntries.at(-1)?.hex).toBe(
        "31 32 33 34 35 36 37 38 39 37 4B 0D",
      );
    });
    expect(useWorkbenchStore.getState().commandHistory[0]).toMatchObject({
      checksumMode: "crc16-modbus-le",
      encodedBytes: 12,
    });
  });

  it("允许空 payload 仅发送校验尾", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.selectOptions(screen.getByRole("combobox", { name: "校验" }), "sum8");
    expect(
      screen.getByLabelText("命令模板包含 0 个变量，最终 1 字节，校验尾 00"),
    ).toHaveTextContent("0 个变量 · 1 B · 校验 00");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(useWorkbenchStore.getState().terminalEntries.at(-1)?.hex).toBe("00");
    });
    expect(useWorkbenchStore.getState().commandHistory[0]).toMatchObject({
      value: "",
      lineEnding: "none",
      checksumMode: "sum8",
      encodedBytes: 1,
    });
  });

  it("文件发送入口展示准确进度并锁定其他发送动作", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 7,
      serialFileSend: {
        jobId: 21,
        revision: 2,
        generation: 7,
        status: "sending",
        fileName: "firmware.bin",
        totalBytes: 4_096,
        transmittedBytes: 2_048,
        message: "正在发送 firmware.bin",
      },
    });
    const user = userEvent.setup();
    render(<TerminalPanel />);

    const trigger = screen.getByRole("button", { name: "打开文件发送" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "原始文件发送" });
    expect(within(dialog).getByText("正在发送")).toBeVisible();
    expect(within(dialog).getByText("50.0%")).toBeVisible();
    expect(within(dialog).getByText("2.0 KiB / 4.0 KiB")).toBeVisible();
    expect(within(dialog).getByRole("progressbar", { name: "firmware.bin 发送进度" })).toHaveValue(
      2_048,
    );
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "展开周期发送设置" })).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "发送内容" }), "PING");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("空文件发送完成后展示完整进度", async () => {
    useWorkbenchStore.setState({
      isNativeRuntime: true,
      source: "serial",
      connectionStatus: "connected",
      serialGeneration: 7,
      serialFileSend: {
        jobId: 22,
        revision: 3,
        generation: 7,
        status: "completed",
        fileName: "empty.bin",
        totalBytes: 0,
        transmittedBytes: 0,
        message: "文件发送已完成",
      },
    });
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开文件发送" }));
    const dialog = screen.getByRole("dialog", { name: "原始文件发送" });
    expect(within(dialog).getByText("发送完成")).toBeVisible();
    expect(within(dialog).getByText("100.0%")).toBeVisible();
    expect(within(dialog).getByText("0 B / 0 B")).toBeVisible();
    expect(
      within(dialog).getByRole("progressbar", { name: "empty.bin 发送进度" }),
    ).toHaveValue(1);
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
    const variableTrigger = screen.getByRole("button", { name: "打开命令参考与校验" });
    await user.click(variableTrigger);
    const variableDialog = screen.getByRole("dialog", { name: "命令参考与校验" });
    expect(
      within(variableDialog).getByRole("button", { name: /插入发送序号/ }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "命令参考与校验" }),
    ).not.toBeInTheDocument();
    expect(variableTrigger).toHaveFocus();

    await user.click(variableTrigger);
    const reopenedVariableDialog = screen.getByRole("dialog", {
      name: "命令参考与校验",
    });
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
    expect(await screen.findByRole("dialog", { name: "命令历史" })).toHaveTextContent("最近 3 B");
  });

  it("HEX 变量菜单只提供定宽格式并发送原始字节", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const sendFormat = screen.getByRole("group", { name: "发送格式" });
    await user.click(within(sendFormat).getByRole("button", { name: "HEX" }));
    await user.click(screen.getByRole("button", { name: "打开命令参考与校验" }));
    const variableDialog = screen.getByRole("dialog", { name: "命令参考与校验" });

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

  it("ASCII 快查支持多种查询且不修改发送状态", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });
    await user.type(input, "KEEP");
    const variableTrigger = screen.getByRole("button", {
      name: "打开命令参考与校验",
    });

    await user.click(variableTrigger);
    const dialog = screen.getByRole("dialog", { name: "命令参考与校验" });
    await user.click(within(dialog).getByRole("tab", { name: "ASCII" }));
    const search = within(dialog).getByRole("searchbox", { name: "搜索 ASCII 字符" });
    expect(search).toHaveFocus();
    expect(within(dialog).getAllByRole("row")).toHaveLength(129);
    expect(within(dialog).getByRole("row", { name: "NUL 0 00 空字符" })).toBeVisible();
    expect(within(dialog).getByRole("row", { name: "DEL 127 7F 删除" })).toBeVisible();

    for (const query of ["CR", "0D", "13", "回车"]) {
      await user.clear(search);
      await user.type(search, query);
      expect(
        within(dialog).getByRole("row", { name: "CR 13 0D 回车" }),
      ).toBeVisible();
      expect(within(dialog).getAllByRole("row")).toHaveLength(2);
    }

    await user.clear(search);
    await user.type(search, "~");
    expect(
      within(dialog).getByRole("row", { name: "~ 126 7E 波浪号" }),
    ).toBeVisible();
    await user.clear(search);
    await user.type(search, "not-found");
    expect(within(dialog).getByRole("status")).toHaveTextContent("没有匹配的 ASCII 字符");
    expect(within(dialog).queryByRole("table", { name: "ASCII 字符表" })).not.toBeInTheDocument();

    expect(input).toHaveValue("KEEP");
    expect(useWorkbenchStore.getState().sendMode).toBe("text");
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(variableTrigger).toHaveFocus();
  });

  it("校验快算支持 TEXT 与 HEX 且不修改发送状态", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const sendInput = screen.getByRole("textbox", { name: "发送内容" });
    await user.type(sendInput, "KEEP");
    const trigger = screen.getByRole("button", { name: "打开命令参考与校验" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "命令参考与校验" });
    const variablesTab = within(dialog).getByRole("tab", { name: "变量" });
    variablesTab.focus();
    await user.keyboard("{ArrowLeft}");

    expect(within(dialog).getByRole("tab", { name: "校验" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const checksumInput = within(dialog).getByRole("textbox", { name: "校验输入" });
    expect(checksumInput).toHaveFocus();
    await user.type(checksumInput, "31 32 33 34 35 36 37 38 39");

    expect(within(dialog).getByLabelText("校验输入 9 字节")).toHaveTextContent("9 B");
    expect(within(dialog).getByText("0x4B37")).toBeVisible();
    expect(within(dialog).getByText("低字节在前 37 4B")).toBeVisible();
    expect(within(dialog).getByText("0xCBF43926")).toBeVisible();
    expect(within(dialog).getByText("0x31")).toBeVisible();
    expect(within(dialog).getByText("0xDD")).toBeVisible();

    const modeGroup = within(dialog).getByRole("group", { name: "校验输入格式" });
    await user.click(within(modeGroup).getByRole("button", { name: "TEXT" }));
    await user.clear(checksumInput);
    await user.type(checksumInput, "123456789");
    expect(within(dialog).getByText("0x4B37")).toBeVisible();

    await user.click(within(modeGroup).getByRole("button", { name: "HEX" }));
    await user.clear(checksumInput);
    await user.type(checksumInput, "123");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("完整字节");
    expect(within(dialog).queryByText("0x4B37")).not.toBeInTheDocument();

    expect(sendInput).toHaveValue("KEEP");
    expect(useWorkbenchStore.getState()).toMatchObject({
      sendMode: "text",
      lineEnding: "none",
      commandHistory: [],
    });
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("字节数值互转支持端序和复制且不产生发送副作用", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const sendInput = screen.getByRole("textbox", { name: "发送内容" });
    await user.type(sendInput, "KEEP");
    const txBytesBefore = useWorkbenchStore.getState().stats.txBytes;

    await user.click(screen.getByRole("button", { name: "打开命令参考与校验" }));
    const dialog = screen.getByRole("dialog", { name: "命令参考与校验" });
    await user.click(within(dialog).getByRole("tab", { name: "转换" }));
    const converterInput = within(dialog).getByRole("textbox", { name: "转换输入" });
    expect(converterInput).toHaveFocus();
    expect(within(dialog).getByRole("combobox", { name: "数值类型" })).toHaveValue("f32");

    await user.type(converterInput, "00 00 80 3F");
    expect(within(dialog).getByRole("textbox", { name: "规范化 HEX" })).toHaveValue(
      "00 00 80 3F",
    );
    expect(within(dialog).getByRole("textbox", { name: "数值结果" })).toHaveValue("1");
    expect(within(dialog).getByLabelText("转换结果 4 字节，1 个数值")).toHaveTextContent(
      "4 B · 1 个数值",
    );

    await user.click(within(dialog).getByRole("button", { name: "复制数值结果" }));
    expect(await navigator.clipboard.readText()).toBe("1");
    expect(within(dialog).getByRole("button", { name: "数值结果已复制" })).toBeVisible();

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "数值类型" }), "i16");
    const directionGroup = within(dialog).getByRole("group", { name: "转换方向" });
    await user.click(
      within(directionGroup).getByRole("button", {
        name: "数值转字节",
      }),
    );
    const endiannessGroup = within(dialog).getByRole("group", { name: "字节序" });
    await user.click(
      within(endiannessGroup).getByRole("button", {
        name: "大端 BE",
      }),
    );
    await user.clear(converterInput);
    await user.type(converterInput, "-2");
    expect(within(dialog).getByRole("textbox", { name: "规范化 HEX" })).toHaveValue("FF FE");
    await user.click(within(dialog).getByRole("button", { name: "复制 HEX 结果" }));
    expect(await navigator.clipboard.readText()).toBe("FF FE");

    await user.type(converterInput, ",");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("尾随分隔符");
    expect(within(dialog).getByRole("textbox", { name: "规范化 HEX" })).toHaveValue("");
    await user.clear(converterInput);
    await user.type(converterInput, "-2");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    const clipboardWrite = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("permission denied"));
    await user.click(within(dialog).getByRole("button", { name: "复制 HEX 结果" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("复制失败：permission denied");
    clipboardWrite.mockRestore();

    expect(sendInput).toHaveValue("KEEP");
    expect(useWorkbenchStore.getState()).toMatchObject({
      sendMode: "text",
      lineEnding: "none",
      commandHistory: [],
    });
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx"),
    ).toEqual([]);
    expect(useWorkbenchStore.getState().stats.txBytes).toBe(txBytesBefore);
  });

  it("将 Modbus RTU 帧填入 HEX 草稿但只通过原发送入口产生 TX", async () => {
    useWorkbenchStore.getState().setCommandChecksum("crc16-modbus-le");
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
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
    expect(screen.getByRole("combobox", { name: "校验" })).toHaveValue("none");
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

  it("直接执行 Modbus RTU 单事务并展开结构化结果与原始帧", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
    expect(within(builder).getByRole("spinbutton", { name: "Modbus 响应超时毫秒" })).toHaveValue(
      1000,
    );
    await user.click(within(builder).getByRole("button", { name: "执行一次" }));

    await waitFor(() => {
      expect(within(builder).getByText("完成")).toBeVisible();
    });
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
    expect(useWorkbenchStore.getState().modbusTransactions[0]).toMatchObject({
      status: "completed",
      result: { kind: "registers", values: [0] },
    });
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.map((entry) => entry.direction),
    ).toEqual(["tx", "rx"]);

    const summary = within(builder).getByText("完成").closest("summary");
    expect(summary).not.toBeNull();
    await user.click(summary!);
    const details = summary!.closest("details")!;
    expect(within(details).getByText("0:0")).toBeVisible();
    expect(within(details).getByText("01 03 00 00 00 01 84 0A")).toBeVisible();
    expect(within(details).getByText("01 03 02 00 00 B8 44")).toBeVisible();
    expect(screen.getByRole("button", { name: "命令历史，0 条" })).toBeDisabled();
  });

  it("运行只读轮询时冻结参数并允许关闭后重新打开停止", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.type(screen.getByRole("textbox", { name: "发送内容" }), "PING");
    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    let builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
    const address = within(builder).getByRole("textbox", { name: "Modbus 起始地址" });
    const quantity = within(builder).getByRole("textbox", { name: "Modbus 读取数量" });
    const timeout = within(builder).getByRole("spinbutton", {
      name: "Modbus 响应超时毫秒",
    });
    const interval = within(builder).getByRole("spinbutton", {
      name: "Modbus 轮询间隔毫秒",
    });
    await user.clear(address);
    await user.type(address, "7");
    await user.clear(quantity);
    await user.type(quantity, "2");
    await user.clear(timeout);
    await user.type(timeout, "500");
    await user.clear(interval);
    await user.type(interval, "100");
    await user.click(within(builder).getByRole("button", { name: "开始轮询" }));

    expect(within(builder).getByRole("combobox", { name: "Modbus 功能" })).toBeDisabled();
    expect(within(builder).getByRole("textbox", { name: "Modbus 站号" })).toBeDisabled();
    expect(address).toBeDisabled();
    expect(quantity).toBeDisabled();
    expect(timeout).toBeDisabled();
    expect(interval).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "展开周期发送设置" })).toBeDisabled();

    await user.click(within(builder).getByRole("button", { name: "关闭 Modbus RTU 构帧器" }));
    const trigger = screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" });
    expect(trigger.querySelector(".modbus-poll-activity-dot")).not.toBeNull();
    await user.click(trigger);
    builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
    expect(within(builder).getByRole("button", { name: "停止轮询" })).toBeEnabled();

    await waitFor(() => {
      expect(useWorkbenchStore.getState().modbusPoll.successCount).toBeGreaterThanOrEqual(2);
    });
    expect(within(builder).getByLabelText("Modbus RTU 只读轮询状态")).toHaveTextContent(
      /7:7\s+8:8/,
    );
    await user.click(within(builder).getByRole("button", { name: "停止轮询" }));
    const stoppedCount = useWorkbenchStore.getState().modbusPoll.successCount;
    expect(useWorkbenchStore.getState().modbusPoll.status).toBe("stopped");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 220));
    expect(useWorkbenchStore.getState().modbusPoll.successCount).toBe(stoppedCount);

    await user.click(within(builder).getByRole("button", { name: "关闭 Modbus RTU 构帧器" }));
    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
    expect(within(builder).getByRole("textbox", { name: "Modbus 起始地址" })).toHaveValue("7");
    expect(within(builder).getByRole("textbox", { name: "Modbus 读取数量" })).toHaveValue("2");
    expect(
      within(builder).getByRole("spinbutton", { name: "Modbus 响应超时毫秒" }),
    ).toHaveValue(500);
    expect(
      within(builder).getByRole("spinbutton", { name: "Modbus 轮询间隔毫秒" }),
    ).toHaveValue(100);
  });

  it("写功能保留单事务执行但不允许启动轮询", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
    await user.selectOptions(
      within(builder).getByRole("combobox", { name: "Modbus 功能" }),
      "write-single-register",
    );

    expect(within(builder).getByRole("button", { name: "执行一次" })).toBeEnabled();
    expect(within(builder).getByRole("button", { name: "开始轮询" })).toBeDisabled();
    expect(within(builder).getByRole("button", { name: "开始轮询" })).toHaveAttribute(
      "title",
      "轮询仅支持 01/02/03/04 读取功能",
    );
  });

  it("控制线操作期间禁用手动、周期和 Modbus RTU 发送", async () => {
    useWorkbenchStore.setState({ serialControlLineOperation: "dtr" });
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.type(screen.getByRole("textbox", { name: "发送内容" }), "PING");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "展开周期发送设置" }));
    expect(screen.getByRole("button", { name: "启动" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
    expect(within(builder).getByRole("button", { name: "执行一次" })).toBeDisabled();
  });

  it("工作区切换期间关闭并禁用 Modbus RTU 构帧器", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const trigger = screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" });

    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" })).toBeVisible();

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

  it("保存并载入快捷命令时保留模板格式且不产生 TX", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });

    fireEvent.change(input, { target: { value: "SET ${seq}" } });
    await user.selectOptions(screen.getByRole("combobox", { name: "行尾" }), "cr");
    await user.click(screen.getByRole("button", { name: "打开快捷命令" }));
    const dialog = screen.getByRole("dialog", { name: "快捷命令" });
    const nameInput = within(dialog).getByRole("textbox", { name: "快捷命令名称" });
    expect(nameInput).toHaveFocus();
    await user.type(nameInput, "启动采样");
    await user.click(
      within(dialog).getByRole("button", { name: "保存当前草稿为快捷命令" }),
    );

    expect(useWorkbenchStore.getState().quickCommands).toEqual([
      expect.objectContaining({
        name: "启动采样",
        template: "SET ${seq}",
        mode: "text",
        lineEnding: "cr",
      }),
    ]);
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "关闭快捷命令" }));
    await user.clear(input);
    await user.click(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "HEX",
      }),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "行尾" }), "none");
    await user.selectOptions(screen.getByRole("combobox", { name: "校验" }), "sum8");
    await user.click(screen.getByRole("button", { name: "打开快捷命令" }));
    await user.click(screen.getByRole("button", { name: "载入快捷命令 启动采样" }));

    expect(input).toHaveValue("SET ${seq}");
    expect(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "文本",
      }),
    ).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("combobox", { name: "行尾" })).toHaveValue("cr");
    expect(screen.getByRole("combobox", { name: "校验" })).toHaveValue("sum8");
    expect(input).toHaveFocus();
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
  });

  it.each([
    ["空草稿", "writable"],
    ["较新版本只读状态", "newer-version"],
  ] as const)("%s 下空列表聚焦关闭按钮并支持 Escape", async (_, storageStatus) => {
    useWorkbenchStore.setState({
      workspaceStorageStatus: storageStatus,
      incompatibleStorageVersion: storageStatus === "newer-version" ? 7 : null,
    });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const trigger = screen.getByRole("button", { name: "打开快捷命令" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "快捷命令" });
    expect(within(dialog).getByRole("button", { name: "关闭快捷命令" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "快捷命令" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("重命名、排序和删除快捷命令并用 Escape 恢复入口焦点", async () => {
    useWorkbenchStore.setState({
      quickCommands: [
        { id: "quick-first", name: "第一条", template: "A", mode: "text", lineEnding: "none" },
        { id: "quick-second", name: "第二条", template: "B", mode: "text", lineEnding: "lf" },
      ],
    });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const trigger = screen.getByRole("button", { name: "打开快捷命令" });

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "重命名快捷命令 第二条" }));
    const renameInput = screen.getByRole("textbox", { name: "重命名快捷命令 第二条" });
    await user.clear(renameInput);
    await user.type(renameInput, "状态查询");
    await user.click(screen.getByRole("button", { name: "保存重命名 第二条" }));
    expect(useWorkbenchStore.getState().quickCommands[1]?.name).toBe("状态查询");

    await user.click(screen.getByRole("button", { name: "上移快捷命令 状态查询" }));
    expect(useWorkbenchStore.getState().quickCommands.map((command) => command.id)).toEqual([
      "quick-second",
      "quick-first",
    ]);

    await user.click(screen.getByRole("button", { name: "删除快捷命令 第一条" }));
    expect(useWorkbenchStore.getState().quickCommands).toEqual([
      expect.objectContaining({ id: "quick-second", name: "状态查询" }),
    ]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "快捷命令" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("工作区切换期间关闭并禁用快捷命令且不产生混合草稿", async () => {
    useWorkbenchStore.setState({
      quickCommands: [
        { id: "quick-hex", name: "HEX 查询", template: "01 03", mode: "hex", lineEnding: "none" },
      ],
    });
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const trigger = screen.getByRole("button", { name: "打开快捷命令" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "快捷命令" })).toBeVisible();
    useWorkbenchStore.setState({ workspaceTransitionStatus: "switching" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "快捷命令" })).not.toBeInTheDocument();
      expect(trigger).toBeDisabled();
    });
    expect(screen.getByRole("textbox", { name: "发送内容" })).toHaveValue("");
    expect(useWorkbenchStore.getState()).toMatchObject({ sendMode: "text", lineEnding: "none" });
  });

  it("允许输入带常见分隔符的最大多线圈请求", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "打开 Modbus RTU 构帧器" }));
    const builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
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
    let builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
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
    builder = await screen.findByRole("dialog", { name: "Modbus RTU 构帧器" });
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

    await user.click(screen.getByRole("button", { name: "打开命令参考与校验" }));
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

  it("拒绝会被静默改写的 HEX 输入并禁用空字节帧", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);
    const input = screen.getByRole("textbox", { name: "发送内容" });
    const send = screen.getByRole("button", { name: "发送" });

    await user.click(
      within(screen.getByRole("group", { name: "发送格式" })).getByRole("button", {
        name: "HEX",
      }),
    );
    for (const malformed of ["10x2", "A0xB", "1 2", "0x1 0x2"]) {
      fireEvent.change(input, { target: { value: malformed } });
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toBeVisible();
      expect(send).toBeDisabled();
    }

    fireEvent.change(input, { target: { value: " , ; : _ - " } });
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(send).toBeDisabled();
    expect(useWorkbenchStore.getState().terminalEntries).toEqual([]);
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);
  });

  it("空输入选择 CR 后允许启动仅行尾的周期任务", async () => {
    const user = userEvent.setup();
    render(<TerminalPanel />);

    await user.click(screen.getByRole("button", { name: "展开周期发送设置" }));
    const startButton = screen.getByRole("button", { name: "启动" });
    expect(startButton).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: "行尾" }), "cr");
    await user.clear(screen.getByRole("spinbutton", { name: "发送次数" }));
    await user.type(screen.getByRole("spinbutton", { name: "发送次数" }), "1");
    expect(startButton).toBeEnabled();
    await user.click(startButton);

    await waitFor(() => {
      expect(useWorkbenchStore.getState().commandTask).toMatchObject({
        status: "completed",
        sentCount: 1,
      });
    });
    expect(
      useWorkbenchStore
        .getState()
        .terminalEntries.filter((entry) => entry.direction === "tx")
        .map((entry) => entry.hex),
    ).toEqual(["0D"]);
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
