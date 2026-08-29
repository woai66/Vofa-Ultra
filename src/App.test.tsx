import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { APP_BUILD_ID, APP_DISPLAY_BUILD_ID, APP_DISPLAY_VERSION } from "./core/appMetadata";
import { createEmptyProtocolHealth } from "./core/protocols";
import { useWorkbenchStore } from "./store/workbenchStore";
import App from "./App";

vi.mock("./components/AttitudeScene", () => ({
  AttitudeScene: () => <div role="img" aria-label="三维姿态视图" />,
}));

interface MatchMediaController {
  add_listener: ReturnType<typeof vi.fn>;
  remove_listener: ReturnType<typeof vi.fn>;
  set_matches(matches: boolean): void;
}

function installMatchMedia(
  initial_matches: boolean,
  use_legacy_listener = false,
): MatchMediaController {
  let matches = initial_matches;
  let change_listener: ((event: MediaQueryListEvent) => void) | undefined;
  const add_event_listener = vi.fn((_event: string, listener: unknown) => {
    change_listener = listener as (event: MediaQueryListEvent) => void;
  });
  const remove_event_listener = vi.fn((_event: string, listener: unknown) => {
    if (change_listener === listener) {
      change_listener = undefined;
    }
  });
  const add_listener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
    change_listener = listener;
  });
  const remove_listener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
    if (change_listener === listener) {
      change_listener = undefined;
    }
  });
  const media_query = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: light)",
    onchange: null,
    addEventListener: use_legacy_listener ? undefined : add_event_listener,
    removeEventListener: use_legacy_listener ? undefined : remove_event_listener,
    addListener: add_listener,
    removeListener: remove_listener,
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.mocked(window.matchMedia).mockReturnValue(media_query);

  return {
    add_listener,
    remove_listener,
    set_matches(next_matches: boolean) {
      matches = next_matches;
      change_listener?.({
        matches: next_matches,
        media: media_query.media,
      } as MediaQueryListEvent);
    },
  };
}

let system_theme: MatchMediaController;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.mocked(window.matchMedia).mockReset();
  system_theme = installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("vofa-ultra-workspace-split");
});

describe("App", () => {
  it("默认跟随运行中的系统主题并保存系统偏好", () => {
    render(<App />);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("vofa-ultra-theme")).toBe("system");

    act(() => system_theme.set_matches(true));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("vofa-ultra-theme")).toBe("system");
  });

  it("把无效的历史主题配置恢复为系统偏好", () => {
    localStorage.setItem("vofa-ultra-theme", "contrast");
    system_theme = installMatchMedia(true);
    render(<App />);

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("vofa-ultra-theme")).toBe("system");
  });

  it("保留旧的固定主题配置且不受系统变化影响", () => {
    localStorage.setItem("vofa-ultra-theme", "dark");
    system_theme = installMatchMedia(true);
    render(<App />);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    act(() => system_theme.set_matches(false));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("vofa-ultra-theme")).toBe("dark");
  });

  it("从设置切换主题偏好并恢复系统跟随", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^设置$/ }));
    const system_button = screen.getByRole("button", { name: "系统" });
    const light_button = screen.getByRole("button", { name: "浅色" });
    expect(system_button).toHaveAttribute("aria-pressed", "true");

    await user.click(light_button);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("vofa-ultra-theme")).toBe("light");

    await user.click(system_button);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("vofa-ultra-theme")).toBe("system");
    act(() => system_theme.set_matches(true));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("在旧式媒体查询 API 上注册并清理主题监听", () => {
    system_theme = installMatchMedia(false, true);
    const { unmount } = render(<App />);

    expect(system_theme.add_listener).toHaveBeenCalledOnce();
    unmount();
    expect(system_theme.remove_listener).toHaveBeenCalledOnce();
  });

  it("呈现串口工作台的核心区域", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "设备连接" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "实时波形" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "数据终端" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动模拟" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "处理" })).toBeEnabled();
    expect(screen.getByText(APP_DISPLAY_VERSION, { selector: ".version-label" })).toBeVisible();
    expect(screen.getByText(APP_DISPLAY_BUILD_ID, { selector: ".build-id-label" })).toHaveAttribute(
      "title",
      `构建 ${APP_BUILD_ID}`,
    );
  });

  it("在桌面工作区收起并恢复侧栏", async () => {
    const user = userEvent.setup();
    render(<App />);

    const shell = document.querySelector(".app-shell");
    const toggle = screen.getByRole("button", { name: "显示或隐藏侧栏" });
    expect(shell).toHaveAttribute("data-sidebar-open", "true");

    await user.click(toggle);
    expect(shell).toHaveAttribute("data-sidebar-open", "false");

    await user.click(toggle);
    expect(shell).toHaveAttribute("data-sidebar-open", "true");

    await user.click(screen.getByRole("button", { name: /^连接$/ }));
    expect(shell).toHaveAttribute("data-sidebar-open", "false");
    await user.click(screen.getByRole("button", { name: /^通道$/ }));
    expect(shell).toHaveAttribute("data-sidebar-open", "true");
  });

  it("从活动导航打开处理图编辑器", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "处理" }));

    expect(await screen.findByRole("heading", { name: "数据处理" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "启用处理图" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "添加处理节点" })).toBeEnabled();
  });

  it("切换标签后按需加载监视与姿态视图", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("heading", { name: "通道监视" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "3D 姿态" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "监视" }));
    expect(await screen.findByRole("heading", { name: "通道监视" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "姿态" }));

    expect(await screen.findByRole("heading", { name: "3D 姿态" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "三维姿态视图" })).toBeInTheDocument();
  });

  it("工作区标签支持循环方向键、Home、End 和单一 Tab 停靠点", async () => {
    const user = userEvent.setup();
    render(<App />);

    const waveformTab = screen.getByRole("tab", { name: "波形" });
    const monitorTab = screen.getByRole("tab", { name: "监视" });
    const attitudeTab = screen.getByRole("tab", { name: "姿态" });
    const waveformPanel = document.getElementById("workspace-waveform-panel");
    const monitorPanel = document.getElementById("workspace-monitor-panel");
    const attitudePanel = document.getElementById("workspace-attitude-panel");
    expect(waveformTab).toHaveAttribute("tabindex", "0");
    expect(monitorTab).toHaveAttribute("tabindex", "-1");
    expect(attitudeTab).toHaveAttribute("tabindex", "-1");
    expect(waveformTab).toHaveAttribute("aria-controls", "workspace-waveform-panel");
    expect(monitorTab).toHaveAttribute("aria-controls", "workspace-monitor-panel");
    expect(attitudeTab).toHaveAttribute("aria-controls", "workspace-attitude-panel");
    expect(waveformPanel).not.toHaveAttribute("hidden");
    expect(monitorPanel).toHaveAttribute("hidden");
    expect(attitudePanel).toHaveAttribute("hidden");

    waveformTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(monitorTab).toHaveFocus();
    expect(monitorTab).toHaveAttribute("aria-selected", "true");
    expect(monitorPanel).not.toHaveAttribute("hidden");
    expect(waveformPanel).toHaveAttribute("hidden");
    expect(attitudePanel).toHaveAttribute("hidden");
    expect(monitorPanel).toContainElement(
      await screen.findByRole("heading", { name: "通道监视" }),
    );

    await user.keyboard("{ArrowRight}");
    expect(attitudeTab).toHaveFocus();
    expect(attitudeTab).toHaveAttribute("aria-selected", "true");
    expect(attitudeTab).toHaveAttribute("tabindex", "0");
    expect(waveformTab).toHaveAttribute("tabindex", "-1");
    expect(document.getElementById("workspace-attitude-panel")).toBe(attitudePanel);
    expect(attitudePanel).not.toHaveAttribute("hidden");
    expect(waveformPanel).toHaveAttribute("hidden");
    expect(monitorPanel).toHaveAttribute("hidden");
    expect(attitudePanel).toContainElement(
      await screen.findByRole("heading", { name: "3D 姿态" }),
    );

    await user.keyboard("{Home}");
    expect(waveformTab).toHaveFocus();
    expect(waveformTab).toHaveAttribute("aria-selected", "true");
    expect(waveformPanel).not.toHaveAttribute("hidden");
    expect(monitorPanel).toHaveAttribute("hidden");
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

    await user.click(screen.getByRole("tab", { name: "监视" }));
    expect(screen.getByRole("button", { name: "专注监视视图" })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-controls",
      "workspace-monitor-panel workspace-terminal-panel",
    );

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

    expect(await screen.findByRole("heading", { name: "会话记录" })).toBeInTheDocument();
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
