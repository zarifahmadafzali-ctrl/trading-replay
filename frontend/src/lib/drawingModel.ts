/**
 * Drawing model + pure geometry for chart drawings (no DOM, no React, no lightweight-charts).
 * Coordinates are LOGICAL (unix seconds + price). Screen pixels only appear in helpers that
 * receive a `project(pt)` callback supplied by Chart.tsx (its toXY).
 *
 * Backward compatible: every new field is optional; old persisted shapes load unchanged.
 */

export type LineStyle = "solid" | "dashed" | "dotted";
export type Pt = { time: number; price: number };
export type Px = { x: number; y: number };
export type Bounds = { w: number; h: number };

export type FibLevel = { value: number; color: string; enabled: boolean };

export const DEFAULT_FIB_LEVELS: FibLevel[] = [
  { value: 0, color: "#787B86", enabled: true },
  { value: 0.236, color: "#F23645", enabled: true },
  { value: 0.382, color: "#FF9800", enabled: true },
  { value: 0.5, color: "#4CAF50", enabled: true },
  { value: 0.618, color: "#089981", enabled: true },
  { value: 0.786, color: "#00BCD4", enabled: true },
  { value: 1, color: "#787B86", enabled: true },
  { value: 1.618, color: "#2962FF", enabled: false },
  { value: 2.618, color: "#F23645", enabled: false },
  { value: 3.618, color: "#9C27B0", enabled: false },
  { value: 4.236, color: "#E91E63", enabled: false },
];

export type TextAlign =
  | "center"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type DrawingBase = {
  id: string;
  visible?: boolean;
  locked?: boolean;
  color?: string;
  /** 0..1 stroke/line color opacity (default 1) */
  strokeOpacity?: number;
  lineWidth?: number;
  lineStyle?: LineStyle;
  fillColor?: string;
  /** 0..1 */
  fillOpacity?: number;
  text?: string;
  textColor?: string;
  fontSize?: number;
  /** Label placement relative to the shape bounds (rectangle/box tools etc.) */
  textAlign?: TextAlign;
};

export type TrendlineShape = DrawingBase & {
  kind: "trendline" | "ray" | "extended";
  a: Pt;
  b: Pt;
  extendLeft?: boolean;
  extendRight?: boolean;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  showStats?: boolean;
  showAngle?: boolean;
  showMidpoint?: boolean;
};
export type RectangleShape = DrawingBase & {
  kind: "rectangle";
  a: Pt;
  b: Pt;
  extendRight?: boolean;
  showStats?: boolean;
};
export type MeasureShape = DrawingBase & { kind: "measure"; a: Pt; b: Pt };
export type FibShape = DrawingBase & {
  kind: "fib";
  a: Pt;
  b: Pt;
  levels?: FibLevel[];
  reverse?: boolean;
  showPrices?: boolean;
  showPercents?: boolean;
  extendLeft?: boolean;
  extendRight?: boolean;
  /** diagonal a->b helper line (default true) */
  trendLine?: boolean;
};
export type ChannelShape = DrawingBase & {
  kind: "channel";
  a: Pt;
  b: Pt;
  /** a point ON the parallel line; offset is derived from it */
  c: Pt;
  extendLeft?: boolean;
  extendRight?: boolean;
  showMiddle?: boolean;
};
export type TextShape = DrawingBase & { kind: "text"; a: Pt; text: string };
export type HLineShape = DrawingBase & { kind: "hline"; price: number };
export type VLineShape = DrawingBase & { kind: "vline"; time: number };

export type DrawingShape =
  | TrendlineShape
  | RectangleShape
  | MeasureShape
  | FibShape
  | ChannelShape
  | TextShape
  | HLineShape
  | VLineShape;
export type DrawingKind = DrawingShape["kind"];

export type HitPart =
  | "a" | "b" | "c" | "body"
  | "tl" | "tr" | "bl" | "br" | "top" | "bottom" | "left" | "right";

/* ───────────── style resolution ───────────── */

export const KIND_DEFAULTS: Record<DrawingKind, { color: string; lineWidth: number; lineStyle: LineStyle; fillOpacity: number }> = {
  trendline: { color: "#2962FF", lineWidth: 2, lineStyle: "solid", fillOpacity: 0 },
  ray: { color: "#2962FF", lineWidth: 2, lineStyle: "solid", fillOpacity: 0 },
  extended: { color: "#2962FF", lineWidth: 2, lineStyle: "solid", fillOpacity: 0 },
  rectangle: { color: "#2962FF", lineWidth: 1, lineStyle: "solid", fillOpacity: 0.2 },
  measure: { color: "#2962FF", lineWidth: 1, lineStyle: "dashed", fillOpacity: 0.2 },
  fib: { color: "#787B86", lineWidth: 1, lineStyle: "solid", fillOpacity: 0.1 },
  channel: { color: "#2962FF", lineWidth: 2, lineStyle: "solid", fillOpacity: 0.1 },
  text: { color: "#D1D4DC", lineWidth: 1, lineStyle: "solid", fillOpacity: 0.85 },
  hline: { color: "#34d399", lineWidth: 1.5, lineStyle: "dotted", fillOpacity: 0 },
  vline: { color: "#a78bfa", lineWidth: 1.5, lineStyle: "dotted", fillOpacity: 0 },
};

export type ResolvedStyle = {
  color: string;
  lineWidth: number;
  lineStyle: LineStyle;
  fillColor: string;
  fillOpacity: number;
  strokeOpacity: number;
};

export function resolveStyle(s: DrawingBase & { kind: DrawingKind }): ResolvedStyle {
  const d = KIND_DEFAULTS[s.kind];
  const color = s.color || d.color;
  const lw = Number(s.lineWidth);
  const fo = Number(s.fillOpacity);
  const so = Number(s.strokeOpacity);
  return {
    color,
    lineWidth: Number.isFinite(lw) && lw > 0 ? Math.min(lw, 8) : d.lineWidth,
    lineStyle: s.lineStyle || d.lineStyle,
    fillColor: s.fillColor || color,
    fillOpacity: s.fillOpacity != null && Number.isFinite(fo) ? Math.min(1, Math.max(0, fo)) : d.fillOpacity,
    strokeOpacity: s.strokeOpacity != null && Number.isFinite(so) ? Math.min(1, Math.max(0, so)) : 1,
  };
}

/** #rgb / #rrggbb + alpha -> rgba(). Other color formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function dashFor(style: LineStyle | undefined, width = 1): number[] {
  if (style === "dashed") return [6 + width, 4 + width];
  if (style === "dotted") return [1.5, 3 + width];
  return [];
}

/** Load-time migration: ray/extended become a trendline with extend flags (renders identically). */
export function normalizeShape<T extends { kind: string }>(raw: T): T {
  const s = raw as unknown as Record<string, unknown>;
  if (s.kind === "ray") {
    return { ...s, kind: "trendline", extendLeft: s.extendLeft ?? false, extendRight: s.extendRight ?? true } as unknown as T;
  }
  if (s.kind === "extended") {
    return { ...s, kind: "trendline", extendLeft: s.extendLeft ?? true, extendRight: s.extendRight ?? true } as unknown as T;
  }
  return raw;
}

/* ───────────── pure geometry ───────────── */

export function distPointToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/**
 * Clip the line p0->p1 to the canvas rect [0,w]x[0,h] (Liang-Barsky).
 * extL / extR extend the line beyond p0 / p1 to infinity before clipping (no magic "5000px").
 */
export function clipLineToRect(p0: Px, p1: Px, rect: Bounds, extL: boolean, extR: boolean): [Px, Px] | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  let t0 = extL ? -Infinity : 0;
  let t1 = extR ? Infinity : 1;
  const edges: [number, number][] = [
    [-dx, p0.x - 0],
    [dx, rect.w - p0.x],
    [-dy, p0.y - 0],
    [dy, rect.h - p0.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
    return dx === 0 && dy === 0 ? [p0, p1] : null;
  }
  if (t0 > t1) return null;
  return [
    { x: p0.x + t0 * dx, y: p0.y + t0 * dy },
    { x: p0.x + t1 * dx, y: p0.y + t1 * dy },
  ];
}

export function rectExtents(a: Pt, b: Pt) {
  return {
    t0: Math.min(a.time, b.time),
    t1: Math.max(a.time, b.time),
    pHigh: Math.max(a.price, b.price),
    pLow: Math.min(a.price, b.price),
  };
}

export function priceOnLineAt(a: Pt, b: Pt, time: number): number {
  if (b.time === a.time) return a.price;
  return a.price + ((b.price - a.price) * (time - a.time)) / (b.time - a.time);
}

export function channelOffset(s: Pick<ChannelShape, "a" | "b" | "c">): number {
  return s.c.price - priceOnLineAt(s.a, s.b, s.c.time);
}

export function channelParallel(s: Pick<ChannelShape, "a" | "b" | "c">): [Pt, Pt] {
  const off = channelOffset(s);
  return [
    { time: s.a.time, price: s.a.price + off },
    { time: s.b.time, price: s.b.price + off },
  ];
}

export function measureStats(a: Pt, b: Pt, opts: { barSec?: number } = {}) {
  const dPrice = b.price - a.price;
  const pct = a.price !== 0 ? (dPrice / Math.abs(a.price)) * 100 : 0;
  const durationSec = b.time - a.time;
  const bars = opts.barSec && opts.barSec > 0 ? Math.round(durationSec / opts.barSec) : null;
  return { dPrice, pct, durationSec, bars, up: dPrice >= 0 };
}

/** Same convention as the existing app: level 0 at b, level 1 at a (TradingView). */
export function fibPrice(a: Pt, b: Pt, level: number, reverse = false): number {
  return reverse ? a.price + (b.price - a.price) * level : b.price + (a.price - b.price) * level;
}

export function enabledFibLevels(s: Pick<FibShape, "levels">): FibLevel[] {
  return (s.levels && s.levels.length ? s.levels : DEFAULT_FIB_LEVELS)
    .filter((l) => l.enabled && Number.isFinite(l.value))
    .sort((x, y) => x.value - y.value);
}

export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.slice(0, 2).join(" ");
}

/** Shift-constrain (px): snap direction A->P to the nearest 45 degrees. */
export function constrainAnglePx(A: Px, P: Px): Px {
  const dx = P.x - A.x;
  const dy = P.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return P;
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: A.x + Math.cos(ang) * len, y: A.y + Math.sin(ang) * len };
}

/** Shift-constrain (px) for boxes: make a square, keeping the sign of each axis. */
export function constrainSquarePx(A: Px, P: Px): Px {
  const dx = P.x - A.x;
  const dy = P.y - A.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: A.x + Math.sign(dx || 1) * m, y: A.y + Math.sign(dy || 1) * m };
}

/* ───────────── move / drag (pure, logical coordinates) ───────────── */

export function moveShape<S extends DrawingShape>(s: S, dTime: number, dPrice: number): S {
  const mv = (p: Pt): Pt => ({ time: p.time + dTime, price: p.price + dPrice });
  const o = { ...s } as Record<string, unknown>;
  if ("a" in s) o.a = mv((s as { a: Pt }).a);
  if ("b" in s) o.b = mv((s as { b: Pt }).b);
  if ("c" in s) o.c = mv((s as { c: Pt }).c);
  if (s.kind === "hline") o.price = s.price + dPrice;
  if (s.kind === "vline") o.time = s.time + dTime;
  return o as unknown as S;
}

export type DragOrigin = { point: Pt; shape: DrawingShape };

/**
 * New shape after dragging `part` to logical point `pt`.
 * Computed from the shape AT DRAG START (origin.shape), so a box can be dragged
 * past its opposite edge and flips cleanly without jitter.
 */
export function applyDrag(current: DrawingShape, part: HitPart, pt: Pt, origin: DragOrigin): DrawingShape {
  const start = origin.shape;
  if (part === "body") {
    return moveShape(start, pt.time - origin.point.time, pt.price - origin.point.price);
  }
  if (part === "a" || part === "b" || part === "c") {
    if (!(part in start)) return current;
    return { ...current, [part]: { time: pt.time, price: pt.price } } as DrawingShape;
  }
  if (start.kind === "rectangle") {
    const { t0, t1, pHigh, pLow } = rectExtents(start.a, start.b);
    let nt0 = t0, nt1 = t1, nHigh = pHigh, nLow = pLow;
    switch (part) {
      case "tl": nt0 = pt.time; nHigh = pt.price; break;
      case "tr": nt1 = pt.time; nHigh = pt.price; break;
      case "bl": nt0 = pt.time; nLow = pt.price; break;
      case "br": nt1 = pt.time; nLow = pt.price; break;
      case "top": nHigh = pt.price; break;
      case "bottom": nLow = pt.price; break;
      case "left": nt0 = pt.time; break;
      case "right": nt1 = pt.time; break;
    }
    return {
      ...start,
      a: { time: Math.min(nt0, nt1), price: Math.max(nHigh, nLow) },
      b: { time: Math.max(nt0, nt1), price: Math.min(nHigh, nLow) },
    };
  }
  return current;
}

/* ───────────── hit-test ───────────── */

export type HitOpts = { handleTol: number; lineTol: number; bounds: Bounds; selected: boolean; fontSizeFallback?: number };
type Project = (p: Pt) => Px | null;

const near = (p: Px, x: number, y: number, tol: number) => Math.hypot(p.x - x, p.y - y) <= tol;

function insideRect(x: number, y: number, A: Px, B: Px, tol = 0) {
  return x >= Math.min(A.x, B.x) - tol && x <= Math.max(A.x, B.x) + tol &&
         y >= Math.min(A.y, B.y) - tol && y <= Math.max(A.y, B.y) + tol;
}

function nearLine(x: number, y: number, A: Px, B: Px, o: HitOpts, extL: boolean, extR: boolean): boolean {
  const seg = clipLineToRect(A, B, o.bounds, extL, extR);
  return !!seg && distPointToSegment(x, y, seg[0].x, seg[0].y, seg[1].x, seg[1].y) <= o.lineTol;
}

export function pointInPoly(x: number, y: number, poly: Px[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Unselected shapes only report "body" (first tap selects, like TradingView);
 * handles are grabbable only when `selected`. hline/vline keep their existing hit-tests in Chart.
 * Locked shapes can be selected; the caller must not start a drag when `shape.locked`.
 */
export function hitTestShape(s: DrawingShape, project: Project, x: number, y: number, o: HitOpts): { part: HitPart } | null {
  if (s.kind === "hline" || s.kind === "vline") return null;

  if (s.kind === "trendline" || s.kind === "ray" || s.kind === "extended") {
    const n = normalizeShape(s) as TrendlineShape;
    const A = project(n.a), B = project(n.b);
    if (!A || !B) return null;
    if (o.selected && !s.locked) {
      if (near(A, x, y, o.handleTol)) return { part: "a" };
      if (near(B, x, y, o.handleTol)) return { part: "b" };
    }
    return nearLine(x, y, A, B, o, !!n.extendLeft, !!n.extendRight) ? { part: "body" } : null;
  }

  if (s.kind === "rectangle") {
    const A = project(s.a), B = project(s.b);
    if (!A || !B) return null;
    const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x), y0 = Math.min(A.y, B.y), y1 = Math.max(A.y, B.y);
    if (o.selected && !s.locked) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const hs: [HitPart, number, number][] = [
        ["tl", x0, y0], ["tr", x1, y0], ["bl", x0, y1], ["br", x1, y1],
        ["top", mx, y0], ["bottom", mx, y1], ["left", x0, my], ["right", x1, my],
      ];
      for (const [part, hx, hy] of hs) if (Math.hypot(hx - x, hy - y) <= o.handleTol) return { part };
    }
    return insideRect(x, y, A, B, o.lineTol) ? { part: "body" } : null;
  }

  if (s.kind === "measure") {
    const A = project(s.a), B = project(s.b);
    if (!A || !B) return null;
    if (o.selected && !s.locked) {
      if (near(A, x, y, o.handleTol)) return { part: "a" };
      if (near(B, x, y, o.handleTol)) return { part: "b" };
    }
    return insideRect(x, y, A, B, o.lineTol) ? { part: "body" } : null;
  }

  if (s.kind === "fib") {
    const A = project(s.a), B = project(s.b);
    if (!A || !B) return null;
    if (o.selected && !s.locked) {
      if (near(A, x, y, o.handleTol)) return { part: "a" };
      if (near(B, x, y, o.handleTol)) return { part: "b" };
    }
    const lv = enabledFibLevels(s);
    const ys: number[] = [];
    for (const l of lv) {
      const p = project({ time: s.a.time, price: fibPrice(s.a, s.b, l.value, !!s.reverse) });
      if (p) ys.push(p.y);
    }
    if (!ys.length) return null;
    const xl = s.extendLeft ? 0 : Math.min(A.x, B.x);
    const xr = s.extendRight ? o.bounds.w : Math.max(A.x, B.x);
    const inX = x >= xl - o.lineTol && x <= xr + o.lineTol;
    const inY = y >= Math.min(...ys) - o.lineTol && y <= Math.max(...ys) + o.lineTol;
    return inX && inY ? { part: "body" } : null;
  }

  if (s.kind === "channel") {
    const A = project(s.a), B = project(s.b), C = project(s.c);
    if (!A || !B || !C) return null;
    if (o.selected && !s.locked) {
      if (near(A, x, y, o.handleTol)) return { part: "a" };
      if (near(B, x, y, o.handleTol)) return { part: "b" };
      if (near(C, x, y, o.handleTol)) return { part: "c" };
    }
    const [a2, b2] = channelParallel(s);
    const A2 = project(a2), B2 = project(b2);
    if (!A2 || !B2) return null;
    const eL = !!s.extendLeft, eR = !!s.extendRight;
    if (nearLine(x, y, A, B, o, eL, eR) || nearLine(x, y, A2, B2, o, eL, eR)) return { part: "body" };
    return pointInPoly(x, y, [A, B, B2, A2]) ? { part: "body" } : null;
  }

  if (s.kind === "text") {
    const A = project(s.a);
    if (!A) return null;
    const fs = s.fontSize || o.fontSizeFallback || 13;
    const w = Math.max(24, (s.text || "").length * fs * 0.6) + 12;
    const h = fs + 10;
    return x >= A.x && x <= A.x + w && y >= A.y - h && y <= A.y ? { part: "body" } : null;
  }
  return null;
}

/** Bounding box in px of everything the shape draws (anchor for the floating settings bar). */
export function shapeBoundsPx(s: DrawingShape, project: Project, bounds: Bounds): { x0: number; y0: number; x1: number; y1: number } | null {
  const pts: Px[] = [];
  const add = (p: Pt) => { const q = project(p); if (q) pts.push(q); };
  if (s.kind === "hline") {
    const q = project({ time: 0, price: s.price });
    return q ? { x0: 0, x1: bounds.w, y0: q.y, y1: q.y } : null;
  }
  if (s.kind === "vline") {
    const q = project({ time: s.time, price: 0 });
    return q ? { x0: q.x, x1: q.x, y0: 0, y1: bounds.h } : null;
  }
  if ("a" in s) add(s.a);
  if ("b" in s) add(s.b);
  if (s.kind === "channel") { add(s.c); const [a2, b2] = channelParallel(s); add(a2); add(b2); }
  if (s.kind === "fib") {
    for (const l of enabledFibLevels(s)) add({ time: s.a.time, price: fibPrice(s.a, s.b, l.value, !!s.reverse) });
  }
  if (!pts.length) return null;
  return {
    x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
  };
}

/* ───────────── creation + per-tool defaults ───────────── */

const GEOMETRY_KEYS = new Set(["id", "kind", "a", "b", "c", "time", "price", "text"]); // text content excluded; appearance-only templates
const DEFAULTS_KEY = "tr-draw-defaults-v2";

export function loadToolDefaults(kind: DrawingKind): Partial<DrawingShape> {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
    return (all[kind] || {}) as Partial<DrawingShape>;
  } catch {
    return {};
  }
}

export function saveToolDefaults(kind: DrawingKind, shape: DrawingShape): void {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
    all[kind] = extractAppearance(shape);
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

/** Appearance-only fields (no geometry/size). Used for defaults + named templates. */
export function extractAppearance(shape: DrawingShape): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    if (GEOMETRY_KEYS.has(k) || v === undefined) continue;
    clean[k] = v;
  }
  return clean;
}

const TEMPLATES_KEY = "tr-draw-templates-v1";

export type DrawingTemplate = { id: string; name: string; kind: DrawingKind; style: Record<string, unknown> };

export function listTemplates(kind: DrawingKind): DrawingTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    const all = raw ? (JSON.parse(raw) as DrawingTemplate[]) : [];
    return all.filter((t) => t.kind === kind);
  } catch {
    return [];
  }
}

export function saveNamedTemplate(kind: DrawingKind, name: string, shape: DrawingShape): DrawingTemplate {
  const tpl: DrawingTemplate = {
    id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "Template",
    kind,
    style: extractAppearance(shape),
  };
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    const all = raw ? (JSON.parse(raw) as DrawingTemplate[]) : [];
    all.push(tpl);
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return tpl;
}

export function deleteNamedTemplate(id: string): void {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    const all = raw ? (JSON.parse(raw) as DrawingTemplate[]) : [];
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(all.filter((t) => t.id !== id)));
  } catch {
    /* ignore */
  }
}

export function applyAppearance(shape: DrawingShape, style: Record<string, unknown>): DrawingShape {
  const next = { ...shape } as Record<string, unknown>;
  for (const [k, v] of Object.entries(style)) {
    if (GEOMETRY_KEYS.has(k) || k === "id" || k === "kind") continue;
    next[k] = v;
  }
  return next as unknown as DrawingShape;
}

export function createShape(
  kind: DrawingKind,
  points: { a?: Pt; b?: Pt; c?: Pt },
  id: string,
  defaults: Partial<DrawingShape> = {}
): DrawingShape {
  const base = { ...defaults, id, kind } as Record<string, unknown>;
  if (points.a) base.a = points.a;
  if (points.b) base.b = points.b;
  if (points.c) base.c = points.c;
  return normalizeShape(base as unknown as DrawingShape);
}

export function cloneShape(s: DrawingShape, newId: string, dTime = 0, dPrice = 0): DrawingShape {
  return { ...moveShape(s, dTime, dPrice), id: newId, locked: false };
}

export function bringToFront(shapes: DrawingShape[], id: string): DrawingShape[] {
  const i = shapes.findIndex((s) => s.id === id);
  if (i < 0) return shapes;
  return [...shapes.slice(0, i), ...shapes.slice(i + 1), shapes[i]];
}
export function sendToBack(shapes: DrawingShape[], id: string): DrawingShape[] {
  const i = shapes.findIndex((s) => s.id === id);
  if (i < 0) return shapes;
  return [shapes[i], ...shapes.slice(0, i), ...shapes.slice(i + 1)];
}
