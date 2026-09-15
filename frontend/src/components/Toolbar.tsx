/**
 * Legacy icon-based drawing toolbar (TradingView-style).
 * v3.17.2: rendered as floating/movable overlay; icons driven by shared Favorites.
 */
import { useRef } from "react";
import type { DrawTool } from "./Chart";

type ToolDef = { id: DrawTool; label: string; icon: JSX.Element };

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ICONS: Record<string, JSX.Element> = {
  cursor: (
    <svg {...iconProps}>
      <path d="M5 3l14 7-6 2-2 6-6-15z" />
    </svg>
  ),
  trendline: (
    <svg {...iconProps}>
      <circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="19" cy="5" r="1.8" fill="currentColor" stroke="none" />
      <line x1="5" y1="19" x2="19" y2="5" />
    </svg>
  ),
  ray: (
    <svg {...iconProps}>
      <circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none" />
      <line x1="5" y1="19" x2="22" y2="2" />
    </svg>
  ),
  extended: (
    <svg {...iconProps}>
      <line x1="2" y1="22" x2="22" y2="2" />
      <circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  hline: (
    <svg {...iconProps}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="3" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="21" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  vline: (
    <svg {...iconProps}>
      <line x1="12" y1="3" x2="12" y2="21" />
      <circle cx="12" cy="3" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="21" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  rectangle: (
    <svg {...iconProps}>
      <rect x="4" y="6" width="16" height="12" rx="1" />
    </svg>
  ),
  fib: (
    <svg {...iconProps}>
      <line x1="3" y1="5" x2="21" y2="5" />
      <line x1="3" y1="9.5" x2="21" y2="9.5" opacity="0.5" />
      <line x1="3" y1="14" x2="21" y2="14" opacity="0.8" />
      <line x1="3" y1="19" x2="21" y2="19" />
    </svg>
  ),
  measure: (
    <svg {...iconProps}>
      <rect x="3" y="9" width="18" height="6" rx="1" />
      <line x1="7" y1="9" x2="7" y2="12" />
      <line x1="11" y1="9" x2="11" y2="12" />
      <line x1="15" y1="9" x2="15" y2="12" />
      <line x1="19" y1="9" x2="19" y2="12" />
    </svg>
  ),
  long: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16V8M8 12l4-4 4 4" />
    </svg>
  ),
  short: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12l4 4 4-4" />
    </svg>
  ),
  trash: (
    <svg {...iconProps}>
      <path d="M4 7h16M9 7V5h6v2M8 7l1 12h6l1-12" />
    </svg>
  ),
  grip: (
    <svg {...iconProps} width={14} height={14}>
      <circle cx="8" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="18" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
};

/** Canonical tool defs with icons — same set as drawing engine supports. */
export const TOOLBAR_TOOLS: ToolDef[] = [
  { id: "crosshair", label: "Crosshair / Select", icon: ICONS.cursor },
  { id: "trendline", label: "Trend Line", icon: ICONS.trendline },
  { id: "ray", label: "Ray", icon: ICONS.ray },
  { id: "extended", label: "Extended Line", icon: ICONS.extended },
  { id: "hline", label: "Horizontal Line", icon: ICONS.hline },
  { id: "vline", label: "Vertical Line", icon: ICONS.vline },
  { id: "rectangle", label: "Rectangle", icon: ICONS.rectangle },
  { id: "fib", label: "Fibonacci Retracement", icon: ICONS.fib },
  { id: "measure", label: "Measure (Price + Time)", icon: ICONS.measure },
  { id: "long", label: "Long Position", icon: ICONS.long },
  { id: "short", label: "Short Position", icon: ICONS.short },
];

const DEFAULT_FAVORITES: DrawTool[] = ["crosshair", "trendline", "hline", "long", "short"];

function resolveTools(favorites: DrawTool[] | undefined): ToolDef[] {
  const ids = favorites && favorites.length ? favorites : DEFAULT_FAVORITES;
  const out: ToolDef[] = [];
  for (const id of ids) {
    const def = TOOLBAR_TOOLS.find((t) => t.id === id);
    if (def) out.push(def);
  }
  return out.length ? out : TOOLBAR_TOOLS.filter((t) => DEFAULT_FAVORITES.includes(t.id));
}

export function Toolbar({
  activeTool,
  onToolChange,
  onDeleteSelected,
  hasSelection,
  favorites,
  position,
  onPositionChange,
}: {
  activeTool: DrawTool;
  onToolChange: (tool: DrawTool) => void;
  onDeleteSelected?: () => void;
  hasSelection?: boolean;
  /** Shared Favorites from ReplayView — same source as Drawing Tools menu. */
  favorites?: DrawTool[];
  position?: { x: number; y: number };
  onPositionChange?: (pos: { x: number; y: number }) => void;
}) {
  const tools = resolveTools(favorites);
  const pos = position || { x: 8, y: 8 };
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  return (
    <div
      className="tv-toolbar tv-toolbar-float"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("button.tv-tool")) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        el.classList.add("dragging");
      }}
      onPointerMove={(e) => {
        if (!dragRef.current || !onPositionChange) return;
        const x = Math.max(0, e.clientX - dragRef.current.dx);
        const y = Math.max(0, e.clientY - dragRef.current.dy);
        onPositionChange({ x, y });
      }}
      onPointerUp={(e) => {
        dragRef.current = null;
        (e.currentTarget as HTMLElement).classList.remove("dragging");
      }}
      onPointerCancel={(e) => {
        dragRef.current = null;
        (e.currentTarget as HTMLElement).classList.remove("dragging");
      }}
    >
      <span className="tv-toolbar-grip" title="Drag toolbar" aria-hidden>
        {ICONS.grip}
      </span>
      {tools.map((t) => (
        <ToolButton
          key={t.id}
          tool={t}
          active={activeTool === t.id}
          onClick={() => onToolChange(t.id)}
        />
      ))}
      <div className="tv-sep" />
      <button
        type="button"
        title="Delete selected shape"
        className="tv-tool tv-tool-danger"
        onClick={onDeleteSelected}
        disabled={!hasSelection}
      >
        {ICONS.trash}
      </button>
    </div>
  );
}

function ToolButton({ tool, active, onClick }: { tool: ToolDef; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={tool.label}
      className={`tv-tool${active ? " active" : ""}`}
      onClick={onClick}
    >
      {tool.icon}
    </button>
  );
}
