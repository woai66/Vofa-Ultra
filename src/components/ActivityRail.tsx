import {
  Cable,
  CircleDot,
  Folders,
  ListTree,
  Puzzle,
  Settings,
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
  { id: "connection" as const, label: "连接", icon: Cable, group: "core" as const },
  { id: "channels" as const, label: "通道", icon: ListTree, group: "core" as const },
  { id: "capture" as const, label: "记录", icon: CircleDot, group: "core" as const },
  { id: "workspaces" as const, label: "工作区", icon: Folders, group: "core" as const },
  {
    id: "processing" as const,
    label: "处理",
    icon: Workflow,
    group: "advanced" as const,
    groupStart: true,
  },
  { id: "extensions" as const, label: "扩展", icon: Puzzle, group: "advanced" as const },
  { id: "automation" as const, label: "自动化", icon: Zap, group: "advanced" as const },
  { id: "settings" as const, label: "设置", icon: Settings, group: "settings" as const },
];

export function ActivityRail({ activePanel, onSelect }: ActivityRailProps) {
  return (
    <nav className="activity-rail" aria-label="工作台导航">
      <div className="brand-mark" role="img" aria-label="Vofa-Ultra" title="Vofa-Ultra">
        <img src="/favicon.svg" alt="" />
      </div>
      <div className="rail-actions">
        {RAIL_ITEMS.map(({ id, label, icon: Icon, group, ...item }) => (
          <button
            key={id}
            className="rail-button"
            data-active={activePanel === id}
            data-group={group}
            data-group-start={"groupStart" in item ? item.groupStart : undefined}
            type="button"
            aria-label={label}
            aria-pressed={activePanel === id}
            title={label}
            onClick={() => onSelect(id)}
          >
            <Icon size={20} strokeWidth={1.75} />
          </button>
        ))}
      </div>
    </nav>
  );
}
