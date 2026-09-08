import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChartNoAxesCombined,
  LoaderCircle,
  Menu,
  Orbit,
  PanelBottom,
  PanelTop,
  Rows2,
  Table2,
} from "lucide-react";
import { getHorizontalTabTarget } from "./core/tabNavigation";
import { ActivityRail, type SidebarPanel } from "./components/ActivityRail";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { WaveformPanel } from "./components/WaveformPanel";
import { useWorkbenchRuntime } from "./hooks/useWorkbenchRuntime";
import {
  selectActiveWorkspace,
  selectIsWorkspaceDirty,
  useWorkbenchStore,
} from "./store/workbenchStore";

export type ThemeMode = "dark" | "light";
export type ThemePreference = "system" | ThemeMode;

const WORKSPACE_VIEW_TABS = [
  ["waveform", "波形", ChartNoAxesCombined],
  ["monitor", "监视", Table2],
  ["attitude", "姿态", Orbit],
] as const;
type WorkspaceView = (typeof WORKSPACE_VIEW_TABS)[number][0];
const WORKSPACE_VIEWS: readonly WorkspaceView[] = WORKSPACE_VIEW_TABS.map(([view]) => view);
type WorkspaceLayoutMode = "split" | "primary" | "terminal";

const WORKSPACE_LAYOUT_STORAGE_KEY = "vofa-ultra-workspace-layout";
const SIDEBAR_PANELS: readonly SidebarPanel[] = [
  "connection", "channels", "processing", "extensions", "automation", "capture", "workspaces", "settings",
];
interface WorkspaceLayoutPreferences {
  workspaceView: WorkspaceView;
  workspaceLayoutMode: WorkspaceLayoutMode;
  sidebarPanel: SidebarPanel;
  sidebarOpen: boolean;
}
const DEFAULT_LAYOUT_PREFERENCES: WorkspaceLayoutPreferences = {
  workspaceView: "waveform",
  workspaceLayoutMode: "split",
  sidebarPanel: "connection",
  sidebarOpen: true,
};

const WORKSPACE_SPLIT_STORAGE_KEY = "vofa-ultra-workspace-split";
const DEFAULT_WORKSPACE_SPLIT = 1.35 / (1.35 + 0.85);
const MIN_WORKSPACE_SPLIT = 0.4;
const MAX_WORKSPACE_SPLIT = 0.66;
const WORKSPACE_SPLIT_STEP = 0.02;
const SIDEBAR_OVERLAY_MAX_WIDTH = 980;

interface WorkspaceResizeState {
  pointerId: number;
  contentTop: number;
  separatorHeight: number;
  usableHeight: number;
}

const THEME_STORAGE_KEY = "vofa-ultra-theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: light)";

function readThemePreference(): ThemePreference {
  const savedTheme = readLocalPreference(THEME_STORAGE_KEY);
  return savedTheme === "dark" || savedTheme === "light" || savedTheme === "system"
    ? savedTheme
    : "system";
}

function readSystemTheme(): ThemeMode {
  return window.matchMedia(SYSTEM_THEME_QUERY).matches ? "light" : "dark";
}

const loadAttitudePanel = () => import("./components/AttitudePanel");
const preloadAttitudePanel = () => void loadAttitudePanel();
const AttitudePanel = lazy(() =>
  loadAttitudePanel().then(({ AttitudePanel }) => ({ default: AttitudePanel })),
);
const ChannelMonitorPanel = lazy(() =>
  import("./components/ChannelMonitorPanel").then(({ ChannelMonitorPanel }) => ({
    default: ChannelMonitorPanel,
  })),
);

export default function App() {
  const [initialLayout] = useState(readWorkspaceLayoutPreferences);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>(initialLayout.sidebarPanel);
  const [sidebarOpen, setSidebarOpen] = useState(initialLayout.sidebarOpen);
  const [sidebarOverlay, setSidebarOverlay] = useState(
    () => window.innerWidth <= SIDEBAR_OVERLAY_MAX_WIDTH,
  );
  const [waveformMeasuring, setWaveformMeasuring] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(initialLayout.workspaceView);
  const [workspaceLayoutMode, setWorkspaceLayoutMode] =
    useState<WorkspaceLayoutMode>(initialLayout.workspaceLayoutMode);
  const [workspaceSplit, setWorkspaceSplit] = useState(readWorkspaceSplit);
  const [workspaceResizing, setWorkspaceResizing] = useState(false);
  const workspaceTabRefs = useRef<Partial<Record<WorkspaceView, HTMLButtonElement>>>({});
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarReturnFocusRef = useRef<HTMLElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const workspaceContentRef = useRef<HTMLDivElement>(null);
  const workspaceResizeRef = useRef<WorkspaceResizeState | null>(null);
  const activeWorkspace = useWorkbenchStore(selectActiveWorkspace);
  const workspaceDirty = useWorkbenchStore(selectIsWorkspaceDirty);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayPath = useWorkbenchStore((state) => state.replayPath);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [systemTheme, setSystemTheme] = useState<ThemeMode>(readSystemTheme);
  const theme = themePreference === "system" ? systemTheme : themePreference;

  useWorkbenchRuntime();

  const replayLoaded = replaySessionId > 0 && replayStatus !== "idle";

  useEffect(() => {
    const media_query = window.matchMedia(SYSTEM_THEME_QUERY);
    const handle_change = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "light" : "dark");
    };

    setSystemTheme(media_query.matches ? "light" : "dark");
    if (typeof media_query.addEventListener === "function") {
      media_query.addEventListener("change", handle_change);
      return () => media_query.removeEventListener("change", handle_change);
    }

    media_query.addListener(handle_change);
    return () => media_query.removeListener(handle_change);
  }, []);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const closeButton = sidebar?.querySelector<HTMLButtonElement>(".sidebar-close");
    // 媒体查询可能在 resize 回调前隐藏控件，浏览器此时已经把焦点移到 body。
    const focused = document.activeElement === document.body
      ? lastFocusedElementRef.current
      : document.activeElement;
    if (!sidebar || !closeButton) {
      return;
    }
    if (sidebarOpen && sidebarOverlay) {
      if (!sidebar.contains(focused)) {
        sidebarReturnFocusRef.current =
          focused instanceof HTMLElement && focused !== document.body
            ? focused
            : sidebarToggleRef.current;
        closeButton.focus({ preventScroll: true });
      }
      return;
    }
    if (!sidebarOpen && (sidebar.contains(focused) || document.activeElement === document.body)) {
      const previousFocus = sidebarReturnFocusRef.current;
      const target =
        previousFocus?.isConnected && !previousFocus.closest("[inert], [hidden]")
          ? previousFocus
          : sidebarToggleRef.current;
      target?.focus({ preventScroll: true });
    } else if (!sidebarOverlay && focused === closeButton) {
      sidebarToggleRef.current?.focus({ preventScroll: true });
    }
  }, [sidebarOpen, sidebarOverlay, sidebarPanel]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    saveLocalPreference(WORKSPACE_SPLIT_STORAGE_KEY, workspaceSplit.toFixed(4));
  }, [workspaceSplit]);

  useEffect(() => {
    saveLocalPreference(THEME_STORAGE_KEY, themePreference);
  }, [themePreference]);

  useEffect(() => {
    saveLocalPreference(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      workspaceView,
      workspaceLayoutMode,
      sidebarPanel,
      sidebarOpen,
    }));
  }, [workspaceView, workspaceLayoutMode, sidebarPanel, sidebarOpen]);

  useEffect(() => {
    const updateSidebarLayout = () => {
      setSidebarOverlay(window.innerWidth <= SIDEBAR_OVERLAY_MAX_WIDTH);
    };
    window.addEventListener("resize", updateSidebarLayout);
    return () => window.removeEventListener("resize", updateSidebarLayout);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }

    const closeOverlaySidebar = (event: globalThis.KeyboardEvent) => {
      // 原生对话框在 keydown 之后处理取消，不能在这里拦截其 Escape。
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        window.innerWidth > SIDEBAR_OVERLAY_MAX_WIDTH ||
        document.querySelector("dialog[open]")
      ) {
        return;
      }
      event.preventDefault();
      setSidebarOpen(false);
    };

    document.addEventListener("keydown", closeOverlaySidebar);
    return () => document.removeEventListener("keydown", closeOverlaySidebar);
  }, [sidebarOpen]);

  const closeSidebar = () => {
    setSidebarOpen(false);
  };

  const toggleSidebar = () => {
    if (sidebarOpen) {
      closeSidebar();
      return;
    }
    setSidebarOpen(true);
  };

  const selectSidebarPanel = (panel: SidebarPanel) => {
    if (panel === sidebarPanel) {
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarPanel(panel);
    setSidebarOpen(true);
  };

  const selectWorkspaceView = (view: WorkspaceView) => {
    if (view !== "waveform") {
      setWaveformMeasuring(false);
    }
    setWorkspaceView(view);
  };

  const handleWorkspaceTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceView,
  ) => {
    const target = getHorizontalTabTarget(WORKSPACE_VIEWS, current, event.key);
    if (!target) {
      return;
    }
    event.preventDefault();
    selectWorkspaceView(target);
    workspaceTabRefs.current[target]?.focus();
  };

  const resizeWorkspaceFromPointer = (clientY: number) => {
    const resize = workspaceResizeRef.current;
    if (!resize) {
      return;
    }
    const primaryHeight = clientY - resize.contentTop - resize.separatorHeight / 2;
    setWorkspaceSplit(clampWorkspaceSplit(primaryHeight / resize.usableHeight));
  };

  const handleWorkspaceSeparatorPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (workspaceLayoutMode !== "split" || event.button !== 0) {
      return;
    }
    const content = workspaceContentRef.current;
    if (!content) {
      return;
    }
    const contentRect = content.getBoundingClientRect();
    const separatorHeight = event.currentTarget.getBoundingClientRect().height;
    workspaceResizeRef.current = {
      pointerId: event.pointerId,
      contentTop: contentRect.top,
      separatorHeight,
      usableHeight: Math.max(1, contentRect.height - separatorHeight),
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setWorkspaceResizing(true);
    resizeWorkspaceFromPointer(event.clientY);
  };

  const handleWorkspaceSeparatorPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (workspaceResizeRef.current?.pointerId === event.pointerId) {
      resizeWorkspaceFromPointer(event.clientY);
    }
  };

  const finishWorkspaceResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (workspaceResizeRef.current?.pointerId !== event.pointerId) {
      return;
    }
    resizeWorkspaceFromPointer(event.clientY);
    workspaceResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setWorkspaceResizing(false);
  };

  const cancelWorkspaceResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (workspaceResizeRef.current?.pointerId !== event.pointerId) {
      return;
    }
    workspaceResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setWorkspaceResizing(false);
  };

  const handleWorkspaceSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextSplit: number | null = null;
    if (event.key === "ArrowUp") {
      nextSplit = workspaceSplit - WORKSPACE_SPLIT_STEP;
    } else if (event.key === "ArrowDown") {
      nextSplit = workspaceSplit + WORKSPACE_SPLIT_STEP;
    } else if (event.key === "Home") {
      nextSplit = MIN_WORKSPACE_SPLIT;
    } else if (event.key === "End") {
      nextSplit = MAX_WORKSPACE_SPLIT;
    }
    if (nextSplit === null) {
      return;
    }
    event.preventDefault();
    setWorkspaceSplit(clampWorkspaceSplit(nextSplit));
  };

  const workspaceContentStyle = {
    "--workspace-primary-share": `${workspaceSplit * 100}fr`,
    "--workspace-terminal-share": `${(1 - workspaceSplit) * 100}fr`,
  } as CSSProperties;
  const primaryFocusLabel = `专注${
    workspaceView === "waveform" ? "波形" : workspaceView === "monitor" ? "监视" : "姿态"
  }视图`;

  return (
    <div
      className="app-shell"
      data-sidebar-open={sidebarOpen}
      onFocusCapture={(event) => {
        lastFocusedElementRef.current = event.target;
      }}
    >
      <ActivityRail
        activePanel={sidebarPanel}
        sidebarOpen={sidebarOpen}
        onSelect={selectSidebarPanel}
      />
      <Sidebar
        ref={sidebarRef}
        open={sidebarOpen}
        activePanel={sidebarPanel}
        themePreference={themePreference}
        onClose={closeSidebar}
        onThemePreferenceChange={setThemePreference}
      />
      <div
        className="sidebar-backdrop"
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault();
          closeSidebar();
        }}
      />

      <main
        className="workspace"
        aria-hidden={sidebarOpen && sidebarOverlay ? true : undefined}
        inert={sidebarOpen && sidebarOverlay}
      >
        <header className="workspace-header">
          <button
            ref={sidebarToggleRef}
            className="icon-button sidebar-toggle"
            type="button"
            aria-label="显示或隐藏侧栏"
            aria-controls="workbench-sidebar"
            aria-expanded={sidebarOpen}
            title="显示或隐藏侧栏"
            onClick={toggleSidebar}
          >
            <Menu size={18} />
          </button>
          <div className="workspace-title">
            <strong>{replayLoaded ? "会话回放" : "实时工作台"}</strong>
            <span>
              {replayLoaded
                ? replayPath.split(/[\\/]/).pop() || "捕获文件"
                : activeWorkspace?.name ?? "工作区不可用"}
              {!replayLoaded && workspaceDirty ? " · 未保存" : ""}
            </span>
          </div>
          <div
            className="workspace-view-tabs"
            role="tablist"
            aria-label="工作区视图"
          >
            {WORKSPACE_VIEW_TABS.map(([view, label, Icon]) => {
              const active = workspaceView === view;
              return (
                <button
                  key={view}
                  id={`workspace-${view}-tab`}
                  type="button"
                  role="tab"
                  aria-label={label}
                  aria-controls={`workspace-${view}-panel`}
                  aria-selected={active}
                  title={label}
                  tabIndex={active ? 0 : -1}
                  ref={(element) => {
                    workspaceTabRefs.current[view] = element ?? undefined;
                  }}
                  onKeyDown={(event) => handleWorkspaceTabKeyDown(event, view)}
                  onPointerEnter={view === "attitude" ? preloadAttitudePanel : undefined}
                  onClick={() => selectWorkspaceView(view)}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
          <div className="workspace-layout-controls" role="group" aria-label="工作区布局">
            <button
              type="button"
              aria-label={primaryFocusLabel}
              title={primaryFocusLabel}
              aria-pressed={workspaceLayoutMode === "primary"}
              data-active={workspaceLayoutMode === "primary"}
              onClick={() => setWorkspaceLayoutMode("primary")}
            >
              <PanelTop size={15} />
            </button>
            <button
              type="button"
              aria-label="分栏显示"
              title="分栏显示"
              aria-pressed={workspaceLayoutMode === "split"}
              data-active={workspaceLayoutMode === "split"}
              onClick={() => setWorkspaceLayoutMode("split")}
            >
              <Rows2 size={15} />
            </button>
            <button
              type="button"
              aria-label="专注终端"
              title="专注终端"
              aria-pressed={workspaceLayoutMode === "terminal"}
              data-active={workspaceLayoutMode === "terminal"}
              onClick={() => setWorkspaceLayoutMode("terminal")}
            >
              <PanelBottom size={15} />
            </button>
          </div>
        </header>

        <div
          ref={workspaceContentRef}
          className="workspace-content"
          data-waveform-measuring={waveformMeasuring}
          data-layout-mode={workspaceLayoutMode}
          data-resizing={workspaceResizing}
          style={workspaceContentStyle}
        >
          <WorkspaceTabPanel view="waveform" activeView={workspaceView}>
            <WaveformPanel theme={theme} onMeasurementModeChange={setWaveformMeasuring} />
          </WorkspaceTabPanel>
          <WorkspaceTabPanel view="monitor" activeView={workspaceView}>
            <Suspense fallback={<ChannelMonitorPanelFallback />}>
              <ChannelMonitorPanel />
            </Suspense>
          </WorkspaceTabPanel>
          <WorkspaceTabPanel view="attitude" activeView={workspaceView}>
            <Suspense fallback={<AttitudePanelFallback />}>
              <AttitudePanel theme={theme} />
            </Suspense>
          </WorkspaceTabPanel>
          <div
            className="workspace-layout-separator"
            role="separator"
            aria-label="调整主视图与终端高度"
            aria-controls={`workspace-${workspaceView}-panel workspace-terminal-panel`}
            aria-orientation="horizontal"
            aria-valuemin={Math.round(MIN_WORKSPACE_SPLIT * 100)}
            aria-valuemax={Math.round(MAX_WORKSPACE_SPLIT * 100)}
            aria-valuenow={Math.round(workspaceSplit * 100)}
            aria-valuetext={`主视图 ${Math.round(workspaceSplit * 100)}%`}
            tabIndex={0}
            onDoubleClick={() => setWorkspaceSplit(DEFAULT_WORKSPACE_SPLIT)}
            onKeyDown={handleWorkspaceSeparatorKeyDown}
            onPointerDown={handleWorkspaceSeparatorPointerDown}
            onPointerMove={handleWorkspaceSeparatorPointerMove}
            onPointerUp={finishWorkspaceResize}
            onPointerCancel={cancelWorkspaceResize}
            onLostPointerCapture={() => {
              workspaceResizeRef.current = null;
              setWorkspaceResizing(false);
            }}
          />
          <TerminalPanel />
        </div>
      </main>

      <StatusBar />
    </div>
  );
}

function readWorkspaceSplit(): number {
  const savedSplit = readLocalPreference(WORKSPACE_SPLIT_STORAGE_KEY);
  if (savedSplit === null) {
    return DEFAULT_WORKSPACE_SPLIT;
  }
  const parsedSplit = Number.parseFloat(savedSplit);
  return Number.isFinite(parsedSplit)
    ? clampWorkspaceSplit(parsedSplit)
    : DEFAULT_WORKSPACE_SPLIT;
}

function readLocalPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveLocalPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 界面偏好写入失败时，仍允许用户在当前会话调整布局和主题。
  }
}

function readWorkspaceLayoutPreferences(): WorkspaceLayoutPreferences {
  try {
    const saved: unknown = JSON.parse(readLocalPreference(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
      return DEFAULT_LAYOUT_PREFERENCES;
    }
    const preferences = saved as Record<string, unknown>;
    return {
      workspaceView: WORKSPACE_VIEWS.includes(preferences.workspaceView as WorkspaceView)
        ? preferences.workspaceView as WorkspaceView
        : DEFAULT_LAYOUT_PREFERENCES.workspaceView,
      workspaceLayoutMode:
        preferences.workspaceLayoutMode === "primary" ||
        preferences.workspaceLayoutMode === "terminal" ||
        preferences.workspaceLayoutMode === "split"
          ? preferences.workspaceLayoutMode
          : DEFAULT_LAYOUT_PREFERENCES.workspaceLayoutMode,
      sidebarPanel: SIDEBAR_PANELS.includes(preferences.sidebarPanel as SidebarPanel)
        ? preferences.sidebarPanel as SidebarPanel
        : DEFAULT_LAYOUT_PREFERENCES.sidebarPanel,
      sidebarOpen: typeof preferences.sidebarOpen === "boolean"
        ? preferences.sidebarOpen
        : DEFAULT_LAYOUT_PREFERENCES.sidebarOpen,
    };
  } catch {
    return DEFAULT_LAYOUT_PREFERENCES;
  }
}

function clampWorkspaceSplit(value: number): number {
  return Math.min(MAX_WORKSPACE_SPLIT, Math.max(MIN_WORKSPACE_SPLIT, value));
}

function WorkspaceTabPanel({
  view,
  activeView,
  children,
}: {
  view: WorkspaceView;
  activeView: WorkspaceView;
  children: ReactNode;
}) {
  return (
    <div
      id={`workspace-${view}-panel`}
      className="workspace-view-panel"
      role="tabpanel"
      aria-labelledby={`workspace-${view}-tab`}
      hidden={activeView !== view}
    >
      {activeView === view ? children : null}
    </div>
  );
}

function AttitudePanelFallback() {
  return (
    <section className="workspace-panel attitude-panel" aria-busy="true">
      <header className="panel-toolbar">
        <div className="panel-title-group">
          <Orbit size={17} />
          <div>
            <h2>3D 姿态</h2>
          </div>
        </div>
      </header>
      <div className="attitude-viewport">
        <div className="attitude-state-overlay" role="status">
          <LoaderCircle className="spin" size={24} />
          <strong>正在加载姿态视图</strong>
        </div>
      </div>
    </section>
  );
}

function ChannelMonitorPanelFallback() {
  return (
    <section
      className="workspace-panel channel-monitor-panel"
      aria-label="加载中"
      aria-busy="true"
    />
  );
}
