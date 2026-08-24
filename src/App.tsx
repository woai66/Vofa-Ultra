import { lazy, Suspense, useEffect, useState } from "react";
import { ChartNoAxesCombined, LoaderCircle, Menu, Orbit } from "lucide-react";
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
type WorkspaceView = "waveform" | "attitude";

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
          <div className="workspace-view-tabs" role="tablist" aria-label="工作区视图">
            <button
              type="button"
              role="tab"
              aria-selected={workspaceView === "waveform"}
              data-active={workspaceView === "waveform"}
              title="波形视图"
              onClick={() => selectWorkspaceView("waveform")}
            >
              <ChartNoAxesCombined size={15} />
              <span>波形</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workspaceView === "attitude"}
              data-active={workspaceView === "attitude"}
              title="姿态视图"
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
            <span className="version-label">v0.1.0</span>
          </div>
        </header>

        <div className="workspace-content" data-waveform-measuring={waveformMeasuring}>
          {workspaceView === "waveform" ? (
            <WaveformPanel theme={theme} onMeasurementModeChange={setWaveformMeasuring} />
          ) : (
            <Suspense fallback={<AttitudePanelFallback />}>
              <AttitudePanel theme={theme} />
            </Suspense>
          )}
          <TerminalPanel />
        </div>
      </main>

      <StatusBar />
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
