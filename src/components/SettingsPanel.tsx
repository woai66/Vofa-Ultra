import { Monitor, Moon, RotateCcw, Settings, Sun } from "lucide-react";
import type { ThemePreference } from "../App";
import { APP_BUILD_ID, APP_DISPLAY_VERSION } from "../core/appMetadata";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { ChartWindowSeconds } from "../types/workspace";

export type TextSizePreference = "standard" | "comfortable";

interface SettingsPanelProps {
  themePreference: ThemePreference;
  onThemePreferenceChange(preference: ThemePreference): void;
  textSize: TextSizePreference;
  onTextSizeChange(preference: TextSizePreference): void;
}

export function SettingsPanel({
  themePreference,
  onThemePreferenceChange,
  textSize,
  onTextSizeChange,
}: SettingsPanelProps) {
  const chartWindowSeconds = useWorkbenchStore((state) => state.chartWindowSeconds);
  const setChartWindowSeconds = useWorkbenchStore((state) => state.setChartWindowSeconds);
  const terminalAutoScroll = useWorkbenchStore((state) => state.terminalAutoScroll);
  const setTerminalAutoScroll = useWorkbenchStore((state) => state.setTerminalAutoScroll);
  const resetStats = useWorkbenchStore((state) => state.resetStats);
  const isTransitioning = useWorkbenchStore(
    (state) => state.workspaceTransitionStatus !== "idle",
  );

  return (
    <div className="sidebar-panel settings-sidebar-panel">
      <div className="sidebar-heading">
        <div>
          <h1>工作台设置</h1>
        </div>
        <Settings size={20} />
      </div>
      <section className="sidebar-section">
        <span className="field-label" id="appearance-label">外观</span>
        <div
          className="segmented-control icon-segments"
          role="group"
          aria-labelledby="appearance-label"
        >
          <button
            type="button"
            aria-pressed={themePreference === "system"}
            data-active={themePreference === "system"}
            onClick={() => onThemePreferenceChange("system")}
          >
            <Monitor size={15} /> 系统
          </button>
          <button
            type="button"
            aria-pressed={themePreference === "dark"}
            data-active={themePreference === "dark"}
            onClick={() => onThemePreferenceChange("dark")}
          >
            <Moon size={15} /> 深色
          </button>
          <button
            type="button"
            aria-pressed={themePreference === "light"}
            data-active={themePreference === "light"}
            onClick={() => onThemePreferenceChange("light")}
          >
            <Sun size={15} /> 浅色
          </button>
        </div>
      </section>
      <section className="sidebar-section">
        <span className="field-label" id="text-size-label">界面字号</span>
        <div className="segmented-control" role="group" aria-labelledby="text-size-label">
          <button
            type="button"
            aria-pressed={textSize === "standard"}
            data-active={textSize === "standard"}
            onClick={() => onTextSizeChange("standard")}
          >
            标准
          </button>
          <button
            type="button"
            aria-pressed={textSize === "comfortable"}
            data-active={textSize === "comfortable"}
            onClick={() => onTextSizeChange("comfortable")}
          >
            舒适
          </button>
        </div>
      </section>
      <section className="sidebar-section">
        <label className="field-label" htmlFor="chart-window-setting">
          波形时间窗
        </label>
        <select
          id="chart-window-setting"
          name="chart-window-setting"
          value={chartWindowSeconds}
          disabled={isTransitioning}
          onChange={(event) =>
            setChartWindowSeconds(Number(event.target.value) as ChartWindowSeconds)
          }
        >
          <option value={5}>5 秒</option>
          <option value={15}>15 秒</option>
          <option value={30}>30 秒</option>
          <option value={60}>60 秒</option>
        </select>
        <label className="toggle-row standalone" htmlFor="terminal-auto-scroll">
          <span>终端自动滚动</span>
          <input
            id="terminal-auto-scroll"
            name="terminal-auto-scroll"
            type="checkbox"
            checked={terminalAutoScroll}
            disabled={isTransitioning}
            onChange={(event) => setTerminalAutoScroll(event.target.checked)}
          />
        </label>
      </section>
      <button className="secondary-button" type="button" onClick={resetStats}>
        <RotateCcw size={16} />
        重置传输统计
      </button>
      <section className="sidebar-section about-section" aria-labelledby="about-product-name">
        <span className="field-label">关于</span>
        <div className="about-product-line">
          <strong id="about-product-name">Vofa-Ultra</strong>
          <code>{APP_DISPLAY_VERSION}</code>
        </div>
        <p>面向嵌入式开发者的 Windows 串口与实时波形工作台。</p>
        <dl className="about-meta">
          <div>
            <dt>支持平台</dt>
            <dd>Windows 10/11 x64</dd>
          </div>
          <div>
            <dt>许可证</dt>
            <dd>MIT</dd>
          </div>
          <div>
            <dt>构建</dt>
            <dd>
              <code>{APP_BUILD_ID}</code>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
