import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { APP_DISPLAY_VERSION } from "./core/appMetadata";
import App from "./App";

vi.mock("./components/AttitudeScene", () => ({
  AttitudeScene: () => <div role="img" aria-label="三维姿态视图" />,
}));

afterEach(() => cleanup());

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
});
