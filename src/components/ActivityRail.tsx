import { AudioWaveform, Cable, Folders, Settings, SlidersHorizontal } from "lucide-react";

export type SidebarPanel = "connection" | "channels" | "workspaces" | "settings";

interface ActivityRailProps {
  activePanel: SidebarPanel;
  onSelect(panel: SidebarPanel): void;
}

const RAIL_ITEMS = [
  { id: "connection" as const, label: "连接", icon: Cable },
  { id: "channels" as const, label: "通道", icon: SlidersHorizontal },
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
