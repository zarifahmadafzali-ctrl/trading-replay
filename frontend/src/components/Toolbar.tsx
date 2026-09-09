import type { DrawTool } from "./Chart";

type ToolDef = {
  id: DrawTool;
  label: string;
  icon: JSX.Element;
};

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
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v13a1 1 0 01-1 1H8a1 1 0 01-1-1V7h10z" />
    </svg>
  ),
};

const TOOLS: ToolDef[] = [
  { id: "crosshair", label: "Cursor / Select", icon: ICONS.cursor },
  { id: "trendline", label: "Trend Line", icon: ICONS.trendline },
  { id: "hline", label: "Horizontal Line", icon: ICONS.hline },
  { id: "vline", label: "Vertical Line", icon: ICONS.vline },
  { id: "rectangle", label: "Rectangle", icon: ICONS.rectangle },
  { id: "fib", label: "Fibonacci Retracement", icon: ICONS.fib },
  { id: "measure", label: "Measure", icon: ICONS.measure },
];

const POSITION_TOOLS: ToolDef[] = [
  { id: "long", label: "Long", icon: ICONS.long },
  { id: "short", label: "Short", icon: ICONS.short },
];

export function Toolbar({
  activeTool,
  onToolChange,
  onDeleteSelected,
  hasSelection,
}: {
  activeTool: DrawTool;
  onToolChange: (tool: DrawTool) => void;
  onDeleteSelected?: () => void;
  hasSelection?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 6,
        background: "#0b0f14",
        border: "1px solid #202a35",
        borderRadius: 8,
        width: 44,
      }}
    >
      {TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} active={activeTool === t.id} onClick={() => onToolChange(t.id)} />
      ))}

      <div style={{ height: 1, background: "#202a35", margin: "4px 2px" }} />

      {POSITION_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} active={activeTool === t.id} onClick={() => onToolChange(t.id)} />
      ))}

      <div style={{ height: 1, background: "#202a35", margin: "4px 2px" }} />

      <button
        title="Delete selected shape"
        onClick={onDeleteSelected}
        disabled={!hasSelection}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          borderRadius: 6,
          color: hasSelection ? "#ef5350" : "#3a4552",
          cursor: hasSelection ? "pointer" : "not-allowed",
        }}
      >
        {ICONS.trash}
      </button>
    </div>
  );
}

function ToolButton({
  tool,
  active,
  onClick,
}: {
  tool: ToolDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={tool.label}
      onClick={onClick}
      style={{
        width: 32,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "#263442" : "transparent",
        border: "none",
        borderRadius: 6,
        color: active ? "#fbbf24" : "#cdd7e3",
        cursor: "pointer",
      }}
    >
      {tool.icon}
    </button>
  );
}
