import {
  AudioWaveform,
  Cable,
  Database,
  Folders,
  Puzzle,
  Settings,
  SlidersHorizontal,
  Workflow,
  Zap,
} from "lucide-react";

export type SidebarPanel =
  | "connection"
  | "channels"
  | "processing"
  | "extensions"
  | "automation"
  | "capture"
  | "workspaces"
  | "settings";

interface ActivityRailProps {
  activePanel: SidebarPanel;
  onSelect(panel: SidebarPanel): void;
}

const RAIL_ITEMS = [
  { id: "connection" as const, label: "连接", icon: Cable },
  { id: "channels" as const, label: "通道", icon: SlidersHorizontal },
  { id: "processing" as const, label: "处理", icon: Workflow },
  { id: "extensions" as const, label: "扩展", icon: Puzzle },
  { id: "automation" as const, label: "自动化", icon: Zap },
  { id: "capture" as const, label: "记录", icon: Database },
  { id: "workspaces" as const, label: "工作区", icon: Folders },
  { id: "settings" as const, label: "设置", icon: Settings },
];

export function ActivityRail({ activePanel, onSelect }: ActivityRailProps) {
  return (
    <nav className="activity-rail" aria-label="工作台导航">
      <div className="brand-mark" role="img" aria-label="Vofa-Ultra" title="Vofa-Ultra">
        <AudioWaveform size={22} strokeWidth={2.2} />
      </div>
      <div className="rail-actions">
        {RAIL_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className="rail-button"
            data-active={activePanel === id}
            type="button"
            aria-label={label}
            aria-pressed={activePanel === id}
            title={label}
            onClick={() => onSelect(id)}
          >
            <Icon size={20} />
          </button>
        ))}
      </div>
      <span className="rail-wordmark" aria-hidden="true">
        ULTRA
      </span>
    </nav>
  );
}
