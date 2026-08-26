import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChartNoAxesCombined, LoaderCircle, Menu, Orbit } from "lucide-react";
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
export type ThemePreference = "system" | ThemeMode;

const WORKSPACE_VIEWS = ["waveform", "attitude"] as const;
type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];
const THEME_STORAGE_KEY = "vofa-ultra-theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: light)";

function readThemePreference(): ThemePreference {
  const saved_theme = localStorage.getItem(THEME_STORAGE_KEY);
  return saved_theme === "dark" || saved_theme === "light" || saved_theme === "system"
    ? saved_theme
    : "system";
}

function readSystemTheme(): ThemeMode {
  return window.matchMedia(SYSTEM_THEME_QUERY).matches ? "light" : "dark";
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
  const workspaceTabRefs = useRef<Partial<Record<WorkspaceView, HTMLButtonElement>>>({});
  const activeWorkspace = useWorkbenchStore(selectActiveWorkspace);
  const workspaceDirty = useWorkbenchStore(selectIsWorkspaceDirty);
  const replayStatus = useWorkbenchStore((state) => state.replayStatus);
  const replaySessionId = useWorkbenchStore((state) => state.replaySessionId);
  const replayPath = useWorkbenchStore((state) => state.replayPath);
  const [theme_preference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [system_theme, setSystemTheme] = useState<ThemeMode>(readSystemTheme);
  const theme = theme_preference === "system" ? system_theme : theme_preference;

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme_preference);
  }, [theme_preference]);

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

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <ActivityRail activePanel={sidebarPanel} onSelect={selectSidebarPanel} />
      <Sidebar
        activePanel={sidebarPanel}
        themePreference={theme_preference}
        onClose={() => setSidebarOpen(false)}
        onThemePreferenceChange={setThemePreference}
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
          <div className="workspace-header-meta">
            <span className="build-label">Vofa-Ultra</span>
            <span className="version-label">{APP_DISPLAY_VERSION}</span>
          </div>
        </header>

        <div className="workspace-content" data-waveform-measuring={waveformMeasuring}>
          <WorkspaceTabPanel view="waveform" activeView={workspaceView}>
            <WaveformPanel theme={theme} onMeasurementModeChange={setWaveformMeasuring} />
          </WorkspaceTabPanel>
          <WorkspaceTabPanel view="attitude" activeView={workspaceView}>
            <Suspense fallback={<AttitudePanelFallback />}>
              <AttitudePanel theme={theme} />
            </Suspense>
          </WorkspaceTabPanel>
          <TerminalPanel />
        </div>
      </main>

      <StatusBar />
    </div>
  );
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
