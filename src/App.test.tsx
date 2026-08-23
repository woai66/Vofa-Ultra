import { render, screen } from "@testing-library/react";
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
});
