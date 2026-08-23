import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import App from "./App";

afterEach(() => cleanup());

describe("App", () => {
  it("呈现串口工作台的核心区域", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "设备连接" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "实时波形" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "数据终端" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动模拟" })).toBeEnabled();
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
});
