/**
 * Floating drawing toolbar — favorites icons, drag-to-reposition, H/V layout,
 * and finger/mouse slide along the tool strip without accidental selection.
 */
import { useEffect, useRef, useState } from "react";
import type { DrawTool } from "./Chart";

type ToolDef = { id: DrawTool; label: string; icon: JSX.Element };
type ToolbarOrientation = "vertical" | "horizontal";

const ORIENT_KEY = "tr-float-toolbar-orient";
const SLIDE_THRESHOLD_PX = 10;

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
  channel: (
    <svg {...iconProps}>
      <line x1="4" y1="18" x2="18" y2="6" />
      <line x1="6" y1="22" x2="20" y2="10" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="20" cy="10" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  text: (
    <svg {...iconProps}>
      <path d="M5 6h14M12 6v14M8 20h8" />
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
  orientH: (
    <svg {...iconProps}>
      <rect x="3" y="9" width="18" height="6" rx="1" />
    </svg>
  ),
  orientV: (
    <svg {...iconProps}>
      <rect x="9" y="3" width="6" height="18" rx="1" />
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
  { id: "channel", label: "Parallel Channel", icon: ICONS.channel },
  { id: "text", label: "Text / Note", icon: ICONS.text },
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

function loadOrient(): ToolbarOrientation {
  try {
    const v = localStorage.getItem(ORIENT_KEY);
    if (v === "horizontal" || v === "vertical") return v;
  } catch {
    /* */
  }
  return "vertical";
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
  favorites?: DrawTool[];
  position?: { x: number; y: number };
  onPositionChange?: (pos: { x: number; y: number }) => void;
}) {
  const tools = resolveTools(favorites);
  const pos = position || { x: 8, y: 8 };
  const [orient, setOrient] = useState<ToolbarOrientation>(() => loadOrient());
  const shellDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const slideRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
    toolId: DrawTool | null;
    action: "tool" | "delete" | null;
  } | null>(null);
  const lastStripGestureRef = useRef<{ moved: boolean }>({ moved: false });

  useEffect(() => {
    try {
      localStorage.setItem(ORIENT_KEY, orient);
    } catch {
      /* */
    }
  }, [orient]);

  const toggleOrient = () => {
    setOrient((o) => (o === "vertical" ? "horizontal" : "vertical"));
  };

  const onStripPointerDown = (
    e: React.PointerEvent,
    toolId: DrawTool | null,
    action: "tool" | "delete" | null = "tool"
  ) => {
    const strip = stripRef.current;
    if (!strip) return;
    // Only primary button / touch
    if (e.button != null && e.button !== 0) return;
    slideRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: strip.scrollLeft,
      scrollTop: strip.scrollTop,
      moved: false,
      toolId,
      action: toolId ? "tool" : action,
    };
    try {
      strip.setPointerCapture(e.pointerId);
    } catch {
      /* */
    }
  };

  const onStripPointerMove = (e: React.PointerEvent) => {
    const s = slideRef.current;
    const strip = stripRef.current;
    if (!s || !strip || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.moved && Math.hypot(dx, dy) >= SLIDE_THRESHOLD_PX) {
      s.moved = true;
    }
    if (s.moved) {
      if (orient === "horizontal") {
        strip.scrollLeft = s.scrollLeft - dx;
      } else {
        strip.scrollTop = s.scrollTop - dy;
      }
      e.preventDefault();
    }
  };

  const onStripPointerUp = (e: React.PointerEvent) => {
    const s = slideRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const wasSlide = s.moved;
    const toolId = s.toolId;
    slideRef.current = null;
    try {
      stripRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
    lastStripGestureRef.current = { moved: wasSlide };
    // Tap without meaningful movement → select tool or delete
    if (!wasSlide) {
      if (toolId) onToolChange(toolId);
      else if (s.action === "delete") onDeleteSelected?.();
    }
  };

  return (
    <div
      className={`tv-toolbar tv-toolbar-float tv-toolbar-${orient}`}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".tv-toolbar-strip") || t.closest("button.tv-tool")) return;
        if (t.closest("button.tv-orient")) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        shellDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        el.classList.add("dragging");
      }}
      onPointerMove={(e) => {
        if (!shellDragRef.current || !onPositionChange) return;
        const x = Math.max(0, e.clientX - shellDragRef.current.dx);
        const y = Math.max(0, e.clientY - shellDragRef.current.dy);
        onPositionChange({ x, y });
      }}
      onPointerUp={(e) => {
        shellDragRef.current = null;
        (e.currentTarget as HTMLElement).classList.remove("dragging");
      }}
      onPointerCancel={(e) => {
        shellDragRef.current = null;
        (e.currentTarget as HTMLElement).classList.remove("dragging");
      }}
    >
      <span className="tv-toolbar-grip" title="Drag toolbar" aria-hidden>
        {ICONS.grip}
      </span>
      <button
        type="button"
        className="tv-tool tv-orient"
        title={orient === "vertical" ? "Switch to horizontal" : "Switch to vertical"}
        onClick={toggleOrient}
      >
        {orient === "vertical" ? ICONS.orientH : ICONS.orientV}
      </button>
      <div
        className="tv-toolbar-strip"
        ref={stripRef}
        onPointerMove={onStripPointerMove}
        onPointerUp={onStripPointerUp}
        onPointerCancel={onStripPointerUp}
      >
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.label}
            className={`tv-tool${activeTool === t.id ? " active" : ""}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onStripPointerDown(e, t.id);
            }}
            // Click handled via pointer-up after slide detection (avoid double-fire)
            onClick={(e) => e.preventDefault()}
          >
            {t.icon}
          </button>
        ))}
        <div className="tv-sep" aria-hidden />
        <button
          type="button"
          title="Delete selected shape"
          className="tv-tool tv-tool-danger"
          disabled={!hasSelection}
          onPointerDown={(e) => {
            e.stopPropagation();
            onStripPointerDown(e, null, "delete");
          }}
          onClick={(e) => e.preventDefault()}
        >
          {ICONS.trash}
        </button>
      </div>
    </div>
  );
}
