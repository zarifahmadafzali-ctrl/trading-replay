import type { DrawTool } from "../components/Chart";

export type ToolGroup = "cursor" | "trend" | "shapes" | "fib" | "measure" | "position";

export type ToolMeta = {
  id: DrawTool;
  label: string;
  group: ToolGroup;
};

/** Single source of truth for implemented drawing tools only. */
export const IMPLEMENTED_TOOLS: ToolMeta[] = [
  { id: "crosshair", label: "Select / Crosshair", group: "cursor" },
  { id: "trendline", label: "Trend Line", group: "trend" },
  { id: "ray", label: "Ray", group: "trend" },
  { id: "extended", label: "Extended Line", group: "trend" },
  { id: "hline", label: "Horizontal Line", group: "trend" },
  { id: "vline", label: "Vertical Line", group: "trend" },
  { id: "rectangle", label: "Rectangle", group: "shapes" },
  { id: "fib", label: "Fib Retracement", group: "fib" },
  { id: "measure", label: "Measure", group: "measure" },
  { id: "long", label: "Long Position", group: "position" },
  { id: "short", label: "Short Position", group: "position" },
];

export const GROUP_LABELS: Record<ToolGroup, string> = {
  cursor: "Cursors",
  trend: "Trend / Lines",
  shapes: "Shapes",
  fib: "Fibonacci",
  measure: "Measurement",
  position: "Position",
};

const FAV_KEY = "tr-draw-favorites-v1";

export function loadFavorites(): DrawTool[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return ["trendline", "hline", "rectangle"];
    const arr = JSON.parse(raw) as string[];
    const allowed = new Set(IMPLEMENTED_TOOLS.map((t) => t.id));
    return arr.filter((x) => allowed.has(x as DrawTool)) as DrawTool[];
  } catch {
    return ["trendline", "hline", "rectangle"];
  }
}

export function saveFavorites(ids: DrawTool[]) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(ids));
  } catch {
    /* */
  }
}
