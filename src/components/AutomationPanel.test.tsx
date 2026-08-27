import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultAutoResponderRule,
  createInitialAutoResponderSnapshot,
} from "../core/autoResponder";
import { createInitialCommandTaskSnapshot } from "../core/commandWorkflow";
import { useWorkbenchStore } from "../store/workbenchStore";
import { AutomationPanel } from "./AutomationPanel";

describe("AutomationPanel", () => {
  beforeEach(() => {
    useWorkbenchStore.getState().stopAutoResponder();
    useWorkbenchStore.setState({
      source: "simulator",
      connectionStatus: "disconnected",
      autoResponderRules: [],
      autoResponder: createInitialAutoResponderSnapshot(),
      serialControlLineOperation: "idle",
      commandTask: createInitialCommandTaskSnapshot(),
      isSendingCommand: false,
      commandSendOrigin: null,
      workspaceTransitionStatus: "idle",
      runtimeTransitionStatus: "idle",
      workspaceStorageStatus: "writable",
      terminalEntries: [],
      commandHistory: [],
      stats: { rxBytes: 0, txBytes: 0, rxFrames: 0 },
    });
  });

  afterEach(() => {
    useWorkbenchStore.getState().stopAutoResponder();
    cleanup();
  });

  it("添加、编辑并保存一条严格规则", async () => {
    const user = userEvent.setup();
    render(<AutomationPanel />);

    expect(screen.getByText("暂无自动应答规则")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加自动应答规则" }));
    await user.clear(screen.getByLabelText("规则名称"));
    await user.type(screen.getByLabelText("规则名称"), "设备就绪");
    await user.click(within(screen.getByRole("group", { name: "触发格式" })).getByText("TEXT"));
    await user.clear(screen.getByLabelText("触发内容"));
    await user.type(screen.getByLabelText("触发内容"), "READY");
    await user.clear(screen.getByLabelText("响应模板"));
    fireEvent.change(screen.getByLabelText("响应模板"), {
      target: { value: "ACK ${seq}" },
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "响应行尾" }), "cr");
    await user.clear(screen.getByRole("spinbutton", { name: "冷却时间（毫秒）" }));
    await user.type(screen.getByRole("spinbutton", { name: "冷却时间（毫秒）" }), "250");
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    expect(useWorkbenchStore.getState().autoResponderRules).toEqual([
      expect.objectContaining({
        name: "设备就绪",
        triggerMode: "text",
        trigger: "READY",
        response: "ACK ${seq}",
        lineEnding: "cr",
        cooldownMs: 250,
      }),
    ]);
    expect(screen.getByText("规则已保存")).toBeInTheDocument();
  });

  it("保留非法草稿并显示校验错误", async () => {
    const user = userEvent.setup();
    render(<AutomationPanel />);
    await user.click(screen.getByRole("button", { name: "添加自动应答规则" }));
    await user.click(within(screen.getByRole("group", { name: "响应格式" })).getByText("HEX"));
    await user.clear(screen.getByLabelText("响应模板"));
    await user.type(screen.getByLabelText("响应模板"), "GG");
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    expect(screen.getByRole("alert")).toHaveTextContent("HEX 数据只能包含");
    expect(screen.getByLabelText("响应模板")).toHaveValue("GG");
    expect(useWorkbenchStore.getState().autoResponderRules[0]?.response).toBe("ACK");
  });

  it("运行时锁定规则编辑并呈现实时计数", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      connectionStatus: "connected",
      autoResponderRules: [createDefaultAutoResponderRule("line-ready", "行结束")],
    });
    render(<AutomationPanel />);

    await user.click(screen.getByRole("checkbox", { name: "启用自动应答" }));
    expect(screen.getByText("等待触发")).toBeInTheDocument();
    expect(screen.getByLabelText("规则名称")).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加自动应答规则" })).toBeDisabled();

    act(() => {
      useWorkbenchStore.getState().ingestBytes(Uint8Array.from([0x0a]), Date.now());
    });
    await waitFor(() => {
      expect(useWorkbenchStore.getState().autoResponder.sentCount).toBe(1);
    });
    expect(screen.getByLabelText("自动应答计数")).toHaveTextContent("命中 1队列 0发送 1");
    expect(useWorkbenchStore.getState().commandHistory).toEqual([]);

    await user.click(screen.getByRole("checkbox", { name: "启用自动应答" }));
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.getByLabelText("规则名称")).toBeEnabled();
  });

  it("控制线操作期间禁用自动应答启动", () => {
    useWorkbenchStore.setState({
      connectionStatus: "connected",
      serialControlLineOperation: "dtr",
      autoResponderRules: [createDefaultAutoResponderRule("line-ready", "行结束")],
    });

    render(<AutomationPanel />);

    expect(screen.getByRole("checkbox", { name: "启用自动应答" })).toBeDisabled();
  });

  it("支持独立停用和删除规则", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.setState({
      autoResponderRules: [
        createDefaultAutoResponderRule("rule-1", "规则一"),
        createDefaultAutoResponderRule("rule-2", "规则二"),
      ],
    });
    render(<AutomationPanel />);

    await user.click(screen.getByRole("checkbox", { name: "启用规则 规则一" }));
    expect(useWorkbenchStore.getState().autoResponderRules[0]?.enabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "删除规则 规则一" }));

    expect(useWorkbenchStore.getState().autoResponderRules).toEqual([
      expect.objectContaining({ id: "rule-2", name: "规则二" }),
    ]);
    expect(screen.getByLabelText("规则名称")).toHaveValue("规则二");
  });
});
