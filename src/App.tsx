import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
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

export default function App() {
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("connection");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const activeWorkspace = useWorkbenchStore(selectActiveWorkspace);
  const workspaceDirty = useWorkbenchStore(selectIsWorkspaceDirty);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const savedTheme = localStorage.getItem("vofa-ultra-theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      return savedTheme;
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useWorkbenchRuntime();

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

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <ActivityRail activePanel={sidebarPanel} onSelect={selectSidebarPanel} />
      <Sidebar activePanel={sidebarPanel} theme={theme} onThemeChange={setTheme} />

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
            <strong>实时工作台</strong>
            <span>
              {activeWorkspace?.name ?? "工作区不可用"}
              {workspaceDirty ? " · 未保存" : ""}
            </span>
          </div>
          <div className="workspace-header-meta">
            <span className="build-label">Vofa-Ultra</span>
            <span className="version-label">v0.1.0</span>
          </div>
        </header>

        <div className="workspace-content">
          <WaveformPanel theme={theme} />
          <TerminalPanel />
        </div>
      </main>

      <StatusBar />
    </div>
  );
}
