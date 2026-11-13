/**
 * Equity curve model (pure: no React, no DOM). Replaces the old UnifiedEquityPanel math.
 *
 * Data rule (unchanged from analytics.ts): the curve is the CLOSED-trade balance. Between two closes the
 * balance is flat and it jumps at each close, so the chart draws a STEP line. Nothing is interpolated:
 * every value the chart shows exists in the journal.
 */

export type CurvePoint = {
  time: number; // unix seconds (point 0 = first entry at the starting balance; others = exit times)
  balance: number;
  pnl: number;
  tradeId: string;
  r?: number | null;
};

export type Win = { t0: number; t1: number };
export type FloorSeg = { t0: number; t1: number; level: number };
export type RangePreset = "all" | "month" | "week" | "day";

const MIN_SPAN = 60; // never zoom below one minute

/** Sorted by time (stable); times forced non-decreasing so step paths never go backwards. */
export function normalizePoints(points: CurvePoint[]): CurvePoint[] {
  const out = points
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.balance))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.time - b.p.time || a.i - b.i)
    .map((x) => x.p);
  return out;
}

/** Index of the last point with time <= t (or -1). */
function lastIndexAtOrBefore(points: CurvePoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Balance after all closes with time <= t. */
export function stepValueAt(points: CurvePoint[], t: number, startingBalance: number): number {
  const i = lastIndexAtOrBefore(points, t);
  return i < 0 ? startingBalance : points[i]!.balance;
}

/** Balance before any close with time >= t (value at the very start of an instant). */
export function stepValueBefore(points: CurvePoint[], t: number, startingBalance: number): number {
  const i = lastIndexAtOrBefore(points, t - 1e-6);
  return i < 0 ? startingBalance : points[i]!.balance;
}

/** Index of the point whose time is closest to t. */
export function nearestPointIndex(points: CurvePoint[], t: number): number {
  if (!points.length) return -1;
  const i = lastIndexAtOrBefore(points, t);
  if (i < 0) return 0;
  if (i >= points.length - 1) return points.length - 1;
  return t - points[i]!.time <= points[i + 1]!.time - t ? i : i + 1;
}

/** Running peak of balance, parallel to points. */
export function runningPeak(points: CurvePoint[], startingBalance: number): number[] {
  let peak = startingBalance;
  return points.map((p) => {
    if (p.balance > peak) peak = p.balance;
    return peak;
  });
}

export function peakAt(points: CurvePoint[], peaks: number[], t: number, startingBalance: number): number {
  const i = lastIndexAtOrBefore(points, t);
  return i < 0 ? startingBalance : peaks[i]!;
}

// ------------------------------------------------------------------ windows (zoom / pan / presets)

export function fullWindow(points: CurvePoint[]): Win {
  if (!points.length) return { t0: 0, t1: 1 };
  const t0 = points[0]!.time;
  const t1 = points[points.length - 1]!.time;
  return t1 > t0 ? { t0, t1 } : { t0, t1: t0 + MIN_SPAN };
}

export function clampWindow(w: Win, bounds: Win): Win {
  const full = bounds.t1 - bounds.t0;
  let span = Math.max(MIN_SPAN, w.t1 - w.t0);
  if (span >= full) return { ...bounds };
  let t0 = w.t0;
  if (t0 < bounds.t0) t0 = bounds.t0;
  if (t0 + span > bounds.t1) t0 = bounds.t1 - span;
  span = Math.min(span, full);
  return { t0, t1: t0 + span };
}

/** factor > 1 zooms in, < 1 zooms out; the anchor time keeps its screen position. */
export function zoomWindow(w: Win, factor: number, anchorT: number, bounds: Win): Win {
  if (!(factor > 0) || !Number.isFinite(factor)) return w;
  const span = w.t1 - w.t0;
  const newSpan = Math.max(MIN_SPAN, span / factor);
  const a = Math.min(Math.max(anchorT, w.t0), w.t1);
  const frac = span > 0 ? (a - w.t0) / span : 0.5;
  const t0 = a - frac * newSpan;
  return clampWindow({ t0, t1: t0 + newSpan }, bounds);
}

export function panWindow(w: Win, dt: number, bounds: Win): Win {
  return clampWindow({ t0: w.t0 + dt, t1: w.t1 + dt }, bounds);
}

const DAY = 86400;

/** View window relative to the LAST point (like the Month / Week / Day buttons of a prop dashboard). */
export function rangeWindow(points: CurvePoint[], preset: RangePreset): Win {
  const bounds = fullWindow(points);
  if (preset === "all") return bounds;
  const days = preset === "month" ? 30 : preset === "week" ? 7 : 1;
  return clampWindow({ t0: bounds.t1 - days * DAY, t1: bounds.t1 }, bounds);
}

export function isFullWindow(w: Win, bounds: Win): boolean {
  return w.t0 <= bounds.t0 + 1e-6 && w.t1 >= bounds.t1 - 1e-6;
}

// ------------------------------------------------------------------ display decimation (values stay exact)

/**
 * Keeps first/last/min/max of each pixel bucket inside the window so a huge journal draws a few thousand
 * vertices at most. Tooltips never use this output: they read the full series.
 */
export function decimate(points: CurvePoint[], win: Win, buckets: number): CurvePoint[] {
  const start = lastIndexAtOrBefore(points, win.t0) + 1; // first point strictly after t0
  const end = lastIndexAtOrBefore(points, win.t1); // inclusive
  if (end < start) return [];
  if (buckets < 1 || end - start + 1 <= buckets * 4) return points.slice(start, end + 1);
  const span = win.t1 - win.t0;
  const out: CurvePoint[] = [];
  let bi = -1;
  let first = -1;
  let last = -1;
  let mn = -1;
  let mx = -1;
  const flush = () => {
    if (first < 0) return;
    for (const i of [...new Set([first, mn, mx, last])].sort((x, y) => x - y)) out.push(points[i]!);
  };
  for (let i = start; i <= end; i++) {
    const p = points[i]!;
    const b = Math.min(buckets - 1, Math.floor(((p.time - win.t0) / span) * buckets));
    if (b !== bi) {
      flush();
      bi = b;
      first = last = mn = mx = i;
    } else {
      last = i;
      if (p.balance < points[mn]!.balance) mn = i;
      if (p.balance > points[mx]!.balance) mx = i;
    }
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ step geometry

export type XY = (t: number) => number;
export type YV = (v: number) => number;

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** SVG path of the closed-balance STEP line inside the window (flat, then a vertical jump at each close). */
export function stepPathD(points: CurvePoint[], win: Win, startingBalance: number, xOf: XY, yOf: YV, drawn?: CurvePoint[]): string {
  const vis = drawn ?? decimate(points, win, 600);
  let v = stepValueAt(points, win.t0, startingBalance);
  let d = `M${f1(xOf(win.t0))},${f1(yOf(v))}`;
  for (const p of vis) {
    d += ` H${f1(xOf(p.time))} V${f1(yOf(p.balance))}`;
    v = p.balance;
  }
  d += ` H${f1(xOf(win.t1))}`;
  return d;
}

/** Closed area under the step line, down to yBottom (for the gradient fill). */
export function stepAreaD(points: CurvePoint[], win: Win, startingBalance: number, xOf: XY, yOf: YV, yBottom: number, drawn?: CurvePoint[]): string {
  const line = stepPathD(points, win, startingBalance, xOf, yOf, drawn);
  return `${line} V${f1(yBottom)} H${f1(xOf(win.t0))} Z`;
}

/** Area between the running-peak step line and the balance step line (visual "drawdown from peak"). */
export function peakGapAreaD(points: CurvePoint[], peaks: number[], win: Win, startingBalance: number, xOf: XY, yOf: YV, drawn?: CurvePoint[]): string {
  const vis = drawn ?? decimate(points, win, 600);
  const idxOf = new Map<CurvePoint, number>();
  points.forEach((p, i) => idxOf.set(p, i));
  const peak0 = peakAt(points, peaks, win.t0, startingBalance);
  const bal0 = stepValueAt(points, win.t0, startingBalance);
  let top = `M${f1(xOf(win.t0))},${f1(yOf(peak0))}`;
  const bottom: [number, number][] = [[xOf(win.t0), yOf(bal0)]];
  let lastBal = bal0;
  for (const p of vis) {
    const pk = peaks[idxOf.get(p) ?? 0] ?? peak0;
    top += ` H${f1(xOf(p.time))} V${f1(yOf(pk))}`;
    bottom.push([xOf(p.time), yOf(lastBal)]);
    bottom.push([xOf(p.time), yOf(p.balance)]);
    lastBal = p.balance;
  }
  top += ` H${f1(xOf(win.t1))}`;
  bottom.push([xOf(win.t1), yOf(lastBal)]);
  return `${top} ${bottom.reverse().map(([x, y]) => `L${f1(x)},${f1(y)}`).join(" ")} Z`;
}

// ------------------------------------------------------------------ allowed drawdown levels

/** Static account floor: starting balance minus the allowed overall loss. */
export function accountFloor(startingBalance: number, maxPct: number | null | undefined): number | null {
  if (!(startingBalance > 0) || maxPct == null || !(maxPct > 0)) return null;
  return startingBalance * (1 - maxPct / 100);
}

/**
 * Daily floor as a STEP line: for each trading day, (balance at the start of that day) - (daily limit),
 * where the limit is startingBalance * pct (the same reference propRules uses: the account size).
 * dayKeyOf must be the SAME trading-day function the prop rules use (timezone / reset hour).
 */
export function dailyFloor(
  points: CurvePoint[],
  startingBalance: number,
  dailyPct: number | null | undefined,
  dayKeyOf: (unixSec: number) => string,
  bounds: Win
): FloorSeg[] {
  if (!(startingBalance > 0) || dailyPct == null || !(dailyPct > 0) || !points.length) return [];
  const limit = (startingBalance * dailyPct) / 100;
  const segs: FloorSeg[] = [];
  const STEP = 6 * 3600;
  let t = bounds.t0;
  let curKey = dayKeyOf(t);
  let segStart = t;
  let dayStartBal = stepValueBefore(points, t, startingBalance);
  let guard = 0;
  while (t < bounds.t1 && guard++ < 200000) {
    const next = Math.min(t + STEP, bounds.t1);
    if (dayKeyOf(next) !== curKey) {
      // boundary lies in (t, next]; binary search the first second with the new key
      let lo = t;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (dayKeyOf(mid) === curKey) lo = mid;
        else hi = mid;
      }
      const b = hi;
      segs.push({ t0: segStart, t1: b, level: dayStartBal - limit });
      segStart = b;
      curKey = dayKeyOf(b);
      dayStartBal = stepValueBefore(points, b, startingBalance);
      t = b;
    } else {
      t = next;
    }
  }
  segs.push({ t0: segStart, t1: Math.max(bounds.t1, segStart), level: dayStartBal - limit });
  return segs;
}

export function floorAt(segs: FloorSeg[], t: number): number | null {
  if (!segs.length) return null;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= segs[i]!.t0) return segs[i]!.level;
  }
  return segs[0]!.level;
}

// ------------------------------------------------------------------ axes

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max - min < 1e-9) {
    const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.05 : 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const T_STEPS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 180 * DAY, 365 * DAY];

export function timeTicks(win: Win, target = 5): number[] {
  const span = win.t1 - win.t0;
  if (!(span > 0)) return [];
  const raw = span / Math.max(1, target);
  const step = T_STEPS.find((s) => s >= raw) ?? T_STEPS[T_STEPS.length - 1]!;
  const out: number[] = [];
  for (let t = Math.ceil(win.t0 / step) * step; t <= win.t1; t += step) out.push(t);
  return out;
}

export type TimeFmt = "time" | "day" | "month";

export function timeFormatFor(win: Win): TimeFmt {
  const span = win.t1 - win.t0;
  if (span <= 2 * DAY) return "time";
  if (span <= 120 * DAY) return "day";
  return "month";
}

export function formatTick(sec: number, fmt: TimeFmt, timeZone?: string): string {
  const d = new Date(sec * 1000);
  try {
    if (fmt === "time") return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
    if (fmt === "day") return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", timeZone });
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone });
  } catch {
    return String(sec);
  }
}

export function formatStamp(sec: number, timeZone?: string): string {
  try {
    return new Date(sec * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone,
    });
  } catch {
    return String(sec);
  }
}

/** Y domain over the visible values (+ any visible limit lines), with padding. */
export function yDomain(values: number[], pad = 0.08): { min: number; max: number } {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { min: 0, max: 1 };
  let min = Math.min(...v);
  let max = Math.max(...v);
  if (max - min < 1e-9) {
    const p = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.02 : 1;
    min -= p;
    max += p;
  }
  const span = max - min;
  return { min: min - span * pad, max: max + span * pad };
}
