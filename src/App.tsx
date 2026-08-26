import {
  lazy,
  Suspense,
  useEffect,
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
} from "lucide-react";
import { APP_DISPLAY_VERSION } from "./core/appMetadata";
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

const WORKSPACE_VIEWS = ["waveform", "attitude"] as const;
type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];
type WorkspaceLayoutMode = "split" | "primary" | "terminal";

const WORKSPACE_SPLIT_STORAGE_KEY = "vofa-ultra-workspace-split";
const DEFAULT_WORKSPACE_SPLIT = 1.35 / (1.35 + 0.85);
const MIN_WORKSPACE_SPLIT = 0.4;
const MAX_WORKSPACE_SPLIT = 0.66;
const WORKSPACE_SPLIT_STEP = 0.02;

interface WorkspaceResizeState {
  pointerId: number;
  contentTop: number;
  separatorHeight: number;
  usableHeight: number;
}

const loadAttitudePanel = () => import("./components/AttitudePanel");
const AttitudePanel = lazy(async () => {
  const module = await loadAttitudePanel();
  return { default: module.AttitudePanel };
});

export default function App() {
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("connection");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [waveformMeasuring, setWaveformMeasuring] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("waveform");
  const [workspaceLayoutMode, setWorkspaceLayoutMode] =
    useState<WorkspaceLayoutMode>("split");
  const [workspaceSplit, setWorkspaceSplit] = useState(readWorkspaceSplit);
  const [workspaceResizing, setWorkspaceResizing] = useState(false);
  const workspaceTabRefs = useRef<Partial<Record<WorkspaceView, HTMLButtonElement>>>({});
  const workspaceContentRef = useRef<HTMLDivElement>(null);
  const workspaceResizeRef = useRef<WorkspaceResizeState | null>(null);
  const activeWorkspace = useWorkbenchStore(selectActiveWorkspace);
  const workspaceDirty = useWorkbenchStore(selectIsWorkspaceDirty);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayPath = useWorkbenchStore((state) => state.replayPath);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const savedTheme = localStorage.getItem("vofa-ultra-theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      return savedTheme;
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useWorkbenchRuntime();

  const replayLoaded = replaySessionId > 0 && replayStatus !== "idle";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("vofa-ultra-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, workspaceSplit.toFixed(4));
  }, [workspaceSplit]);

  const selectSidebarPanel = (panel: SidebarPanel) => {
    if (panel === sidebarPanel) {
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarPanel(panel);
    setSidebarOpen(true);
  };

  const selectWorkspaceView = (view: WorkspaceView) => {
    if (view === "attitude") {
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
    "--workspace-primary-share": `${workspaceSplit}fr`,
    "--workspace-terminal-share": `${1 - workspaceSplit}fr`,
  } as CSSProperties;
  const primaryFocusLabel = workspaceView === "waveform" ? "专注波形视图" : "专注姿态视图";

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <ActivityRail activePanel={sidebarPanel} onSelect={selectSidebarPanel} />
      <Sidebar
        activePanel={sidebarPanel}
        theme={theme}
        onClose={() => setSidebarOpen(false)}
        onThemeChange={setTheme}
      />

      <main className="workspace">
        <header className="workspace-header">
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-label="显示或隐藏侧栏"
            title="显示或隐藏侧栏"
            onClick={() => setSidebarOpen((open) => !open)}
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
            aria-orientation="horizontal"
          >
            <button
              id="workspace-waveform-tab"
              type="button"
              role="tab"
              aria-controls="workspace-waveform-panel"
              aria-selected={workspaceView === "waveform"}
              tabIndex={workspaceView === "waveform" ? 0 : -1}
              data-active={workspaceView === "waveform"}
              title="波形视图"
              ref={(element) => {
                workspaceTabRefs.current.waveform = element ?? undefined;
              }}
              onKeyDown={(event) => handleWorkspaceTabKeyDown(event, "waveform")}
              onClick={() => selectWorkspaceView("waveform")}
            >
              <ChartNoAxesCombined size={15} />
              <span>波形</span>
            </button>
            <button
              id="workspace-attitude-tab"
              type="button"
              role="tab"
              aria-controls="workspace-attitude-panel"
              aria-selected={workspaceView === "attitude"}
              tabIndex={workspaceView === "attitude" ? 0 : -1}
              data-active={workspaceView === "attitude"}
              title="姿态视图"
              ref={(element) => {
                workspaceTabRefs.current.attitude = element ?? undefined;
              }}
              onKeyDown={(event) => handleWorkspaceTabKeyDown(event, "attitude")}
              onFocus={() => void loadAttitudePanel()}
              onPointerEnter={() => void loadAttitudePanel()}
              onClick={() => selectWorkspaceView("attitude")}
            >
              <Orbit size={15} />
              <span>姿态</span>
            </button>
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
          <div className="workspace-header-meta">
            <span className="build-label">Vofa-Ultra</span>
            <span className="version-label">{APP_DISPLAY_VERSION}</span>
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
  const savedSplit = localStorage.getItem(WORKSPACE_SPLIT_STORAGE_KEY);
  if (savedSplit === null) {
    return DEFAULT_WORKSPACE_SPLIT;
  }
  const parsedSplit = Number.parseFloat(savedSplit);
  return Number.isFinite(parsedSplit)
    ? clampWorkspaceSplit(parsedSplit)
    : DEFAULT_WORKSPACE_SPLIT;
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
