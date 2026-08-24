import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessingGraphConfig } from "../types/processingGraph";
import { useWorkbenchStore } from "../store/workbenchStore";
import { ProcessingPanel } from "./ProcessingPanel";

const GRAPH_WITH_BRANCH: ProcessingGraphConfig = {
  enabled: true,
  nodes: [
    { id: "node-1", kind: "input", channelIndex: 0 },
    { id: "node-2", kind: "affine", input: "node-1", gain: 1, offset: 0 },
    { id: "node-3", kind: "affine", input: "node-2", gain: 2, offset: 1 },
    {
      id: "node-4",
      kind: "output",
      input: "node-3",
      name: "Filtered",
      color: "#46d89c",
    },
  ],
};

describe("ProcessingPanel", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ workspaceTransitionStatus: "idle" });
    useWorkbenchStore.getState().setProcessingGraph({ enabled: false, nodes: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("通过列表编辑器建立并启用处理链", async () => {
    const user = userEvent.setup();
    render(<ProcessingPanel />);

    const kindSelect = screen.getByRole("combobox", { name: "新增节点类型" });
    const addButton = screen.getByRole("button", { name: "添加处理节点" });
    await user.click(addButton);
    await user.selectOptions(kindSelect, "affine");
    await user.click(addButton);
    await user.selectOptions(kindSelect, "output");
    await user.click(addButton);
    await user.click(screen.getByRole("checkbox", { name: "启用处理图" }));

    expect(useWorkbenchStore.getState().processingGraph).toMatchObject({
      enabled: true,
      nodes: [
        { id: "node-1", kind: "input", channelIndex: 0 },
        { id: "node-2", kind: "affine", input: "node-1" },
        { id: "node-3", kind: "output", input: "node-2", name: "OUT 1" },
      ],
    });
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "node-2 增益" })).toBeInTheDocument();
  });

  it("允许字段中间态，仅在失焦时提交并拒绝越界值", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().setProcessingGraph(GRAPH_WITH_BRANCH);
    render(<ProcessingPanel />);

    const gainInput = screen.getByRole("spinbutton", { name: "node-2 增益" });
    await user.clear(gainInput);
    expect(nodeById("node-2")).toMatchObject({ gain: 1 });

    await user.type(gainInput, "2.5");
    expect(nodeById("node-2")).toMatchObject({ gain: 1 });
    await user.tab();

    expect(nodeById("node-2")).toMatchObject({ gain: 2.5 });

    await user.clear(gainInput);
    await user.type(gainInput, "1000000000001");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("绝对值不超过");
    expect(nodeById("node-2")).toMatchObject({ gain: 2.5 });

    const nameInput = screen.getByRole("textbox", { name: "node-4 输出名称" });
    await user.clear(nameInput);
    expect(nodeById("node-4")).toMatchObject({ name: "Filtered" });
    await user.type(nameInput, "  Smoothed  ");
    await user.tab();
    expect(nodeById("node-4")).toMatchObject({ name: "Smoothed" });
  });

  it("拒绝循环改线和删除被引用节点并保留旧图", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().setProcessingGraph(GRAPH_WITH_BRANCH);
    render(<ProcessingPanel />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "node-2 输入" }),
      "node-3",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("处理图存在循环");
    expect(nodeById("node-2")).toMatchObject({ input: "node-1" });

    await user.click(screen.getByRole("button", { name: "删除节点 node-1" }));
    expect(screen.getByRole("alert")).toHaveTextContent("节点 node-1 正被 node-2 引用");
    expect(useWorkbenchStore.getState().processingGraph.nodes).toHaveLength(4);
  });

  it("让默认 EMA 参数满足浏览器数字步进约束", () => {
    useWorkbenchStore.getState().setProcessingGraph({
      enabled: false,
      nodes: [
        { id: "node-1", kind: "input", channelIndex: 0 },
        { id: "node-2", kind: "ema", input: "node-1", alpha: 0.2 },
      ],
    });
    render(<ProcessingPanel />);

    expect(screen.getByRole("spinbutton", { name: "node-2 Alpha" })).toBeValid();
  });

  it("重试熔断运行时并在工作区切换期间禁用编辑", async () => {
    const user = userEvent.setup();
    useWorkbenchStore.getState().setProcessingGraph(GRAPH_WITH_BRANCH);
    useWorkbenchStore.setState({
      processedChannels: [
        {
          id: "derived:node-4",
          name: "Filtered",
          color: "#46d89c",
          visible: true,
          points: [],
          lastValue: 1,
        },
      ],
      processingStatus: {
        status: "suspended",
        processedFrames: 4,
        droppedFrames: 2,
        lastError: "测试熔断",
      },
    });
    const { rerender } = render(<ProcessingPanel />);

    await user.click(screen.getByRole("button", { name: "重试处理图" }));
    expect(useWorkbenchStore.getState().processedChannels).toEqual([]);
    expect(useWorkbenchStore.getState().processingStatus.status).toBe("ready");

    useWorkbenchStore.setState({
      workspaceTransitionStatus: "switching",
      processingStatus: {
        status: "suspended",
        processedFrames: 0,
        droppedFrames: 0,
        lastError: "等待工作区切换",
      },
    });
    rerender(<ProcessingPanel />);

    expect(screen.getByRole("checkbox", { name: "启用处理图" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加处理节点" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重试处理图" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除节点 node-1" })).toBeDisabled();
  });
});

function nodeById(id: string) {
  return useWorkbenchStore.getState().processingGraph.nodes.find((node) => node.id === id);
}
