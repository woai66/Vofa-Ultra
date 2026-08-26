import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { APP_DISPLAY_VERSION } from "./core/appMetadata";
import { createEmptyProtocolHealth } from "./core/protocols";
import { useWorkbenchStore } from "./store/workbenchStore";
import App from "./App";

vi.mock("./components/AttitudeScene", () => ({
  AttitudeScene: () => <div role="img" aria-label="三维姿态视图" />,
}));

afterEach(() => {
  cleanup();
  localStorage.removeItem("vofa-ultra-workspace-split");
});

describe("App", () => {
  it("呈现串口工作台的核心区域", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "设备连接" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "实时波形" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "数据终端" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动模拟" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "处理" })).toBeEnabled();
    expect(screen.getByText(APP_DISPLAY_VERSION, { selector: ".version-label" })).toBeVisible();
  });

  it("从活动导航打开处理图编辑器", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "处理" }));

    expect(screen.getByRole("heading", { name: "数据处理" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "启用处理图" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "添加处理节点" })).toBeEnabled();
  });

  it("切换标签后按需加载姿态视图", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("heading", { name: "3D 姿态" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "姿态" }));

    expect(await screen.findByRole("heading", { name: "3D 姿态" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "三维姿态视图" })).toBeInTheDocument();
  });

  it("工作区标签支持循环方向键、Home、End 和单一 Tab 停靠点", async () => {
    const user = userEvent.setup();
    render(<App />);

    const waveformTab = screen.getByRole("tab", { name: "波形" });
    const attitudeTab = screen.getByRole("tab", { name: "姿态" });
    const waveformPanel = document.getElementById("workspace-waveform-panel");
    const attitudePanel = document.getElementById("workspace-attitude-panel");
    expect(waveformTab).toHaveAttribute("tabindex", "0");
    expect(attitudeTab).toHaveAttribute("tabindex", "-1");
    expect(waveformTab).toHaveAttribute("aria-controls", "workspace-waveform-panel");
    expect(attitudeTab).toHaveAttribute("aria-controls", "workspace-attitude-panel");
    expect(waveformPanel).not.toHaveAttribute("hidden");
    expect(attitudePanel).toHaveAttribute("hidden");

    waveformTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(attitudeTab).toHaveFocus();
    expect(attitudeTab).toHaveAttribute("aria-selected", "true");
    expect(attitudeTab).toHaveAttribute("tabindex", "0");
    expect(waveformTab).toHaveAttribute("tabindex", "-1");
    expect(document.getElementById("workspace-attitude-panel")).toBe(attitudePanel);
    expect(attitudePanel).not.toHaveAttribute("hidden");
    expect(waveformPanel).toHaveAttribute("hidden");
    expect(attitudePanel).toContainElement(
      await screen.findByRole("heading", { name: "3D 姿态" }),
    );

    await user.keyboard("{Home}");
    expect(waveformTab).toHaveFocus();
    expect(waveformTab).toHaveAttribute("aria-selected", "true");
    expect(waveformPanel).not.toHaveAttribute("hidden");
    expect(attitudePanel).toHaveAttribute("hidden");

    await user.keyboard("{ArrowLeft}");
    expect(attitudeTab).toHaveFocus();
    await user.keyboard("{End}");
    expect(attitudeTab).toHaveFocus();
  });

  it("分隔条支持键盘调节、边界定位、复位和本地持久化", async () => {
    localStorage.setItem("vofa-ultra-workspace-split", "0.4200");
    const user = userEvent.setup();
    render(<App />);

    const separator = screen.getByRole("separator", { name: "调整主视图与终端高度" });
    expect(separator).toHaveAttribute("aria-controls", "workspace-waveform-panel workspace-terminal-panel");
    expect(separator).toHaveAttribute("aria-valuemin", "40");
    expect(separator).toHaveAttribute("aria-valuemax", "66");
    expect(separator).toHaveAttribute("aria-valuenow", "42");

    separator.focus();
    await user.keyboard("{ArrowDown}");
    expect(separator).toHaveAttribute("aria-valuenow", "44");
    expect(Number.parseFloat(localStorage.getItem("vofa-ultra-workspace-split") ?? "0")).toBeCloseTo(
      0.44,
    );

    await user.keyboard("{Home}");
    expect(separator).toHaveAttribute("aria-valuenow", "40");
    await user.keyboard("{End}");
    expect(separator).toHaveAttribute("aria-valuenow", "66");
    await user.dblClick(separator);
    expect(separator).toHaveAttribute("aria-valuenow", "61");
    expect(Number.parseFloat(localStorage.getItem("vofa-ultra-workspace-split") ?? "0")).toBeCloseTo(
      1.35 / (1.35 + 0.85),
      3,
    );
  });

  it("布局分段控件在主视图、分栏和终端专注间切换", async () => {
    const user = userEvent.setup();
    render(<App />);

    const content = document.querySelector(".workspace-content");
    const split = screen.getByRole("button", { name: "分栏显示" });
    const primary = screen.getByRole("button", { name: "专注波形视图" });
    const terminal = screen.getByRole("button", { name: "专注终端" });
    expect(content).toHaveAttribute("data-layout-mode", "split");
    expect(split).toHaveAttribute("aria-pressed", "true");

    await user.click(terminal);
    expect(content).toHaveAttribute("data-layout-mode", "terminal");
    expect(terminal).toHaveAttribute("aria-pressed", "true");
    await user.click(primary);
    expect(content).toHaveAttribute("data-layout-mode", "primary");
    expect(primary).toHaveAttribute("aria-pressed", "true");
    await user.click(split);
    expect(content).toHaveAttribute("data-layout-mode", "split");

    await user.click(screen.getByRole("tab", { name: "姿态" }));
    expect(screen.getByRole("button", { name: "专注姿态视图" })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-controls",
      "workspace-attitude-panel workspace-terminal-panel",
    );
  });

  it("从侧栏保存命名工作区并更新标题", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "工作区" }));
    expect(screen.getByRole("heading", { name: "工作区" })).toBeInTheDocument();
    const nameInput = screen.getByRole("textbox", { name: "工作区名称" });
    await user.clear(nameInput);
    await user.type(nameInput, "实验台 A");
    await user.click(screen.getByRole("button", { name: /^保存$/ }));

    expect(screen.getByText("实验台 A", { selector: ".workspace-title span" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("工作区已保存");
  });

  it("浏览器预览明确禁用录制和回放文件操作", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "记录" }));

    expect(screen.getByRole("heading", { name: "会话记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始录制" })).toBeDisabled();
    expect(screen.getByText("仅桌面应用支持文件录制")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "回放" }));
    expect(screen.getByRole("button", { name: "打开捕获文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "回放最近录制" })).toBeDisabled();
    expect(screen.getByText("仅桌面应用支持捕获文件回放")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "导出" }));
    expect(screen.getByRole("button", { name: "选择捕获文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择位置并导出" })).toBeDisabled();
    expect(screen.getByText("仅桌面应用支持捕获文件导出")).toBeInTheDocument();
  });

  it("状态栏只在结构化协议发生丢帧时显示紧凑警告", () => {
    useWorkbenchStore.setState({
      protocol: "firewater",
      replayStatus: "idle",
      replaySessionId: 0,
      protocolHealth: {
        ...createEmptyProtocolHealth(),
        droppedFrames: 3,
        reasonCounts: {
          ...createEmptyProtocolHealth().reasonCounts,
          "invalid-format": 3,
        },
        lastDropReason: "invalid-format",
        lastDropAt: 1_000,
      },
    });
    render(<App />);

    expect(screen.getByText("丢帧 3", { selector: ".protocol-warning-status span" })).toBeVisible();
    act(() => useWorkbenchStore.setState({ protocolHealth: createEmptyProtocolHealth() }));
    expect(screen.queryByText("丢帧 3")).not.toBeInTheDocument();
  });
});
