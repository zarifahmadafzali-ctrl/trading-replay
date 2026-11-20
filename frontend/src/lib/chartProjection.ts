/**
 * Chart <-> drawing projection math (pure: no React, no lightweight-charts).
 * Drawings store absolute unix time + price. These helpers map time <-> the chart's LOGICAL index
 * on the series that is CURRENTLY loaded into the chart, and invert screen x continuously.
 *
 * Rules that keep drawings glued to the candles:
 *  - the bars used here must be the SAME bars that were last given to the chart (see Chart.tsx projBarsRef),
 *  - the period used outside the loaded range is the display timeframe step (the spacing of the whitespace
 *    points the chart gets), never a value inferred from the first bars (gaps made that wrong),
 *  - screen x -> time is CONTINUOUS (no snapping to a bar open time).
 */

export type BarTime = { time: number };

/** Spacing (seconds) used for logical positions outside the loaded bars. Display timeframe step wins. */
export function projectionPeriod(stepSec: number | null | undefined, fallbackSec?: number | null): number {
  const a = Number(stepSec);
  if (Number.isFinite(a) && a >= 1) return Math.floor(a);
  const b = Number(fallbackSec);
  if (Number.isFinite(b) && b >= 1) return Math.floor(b);
  return 60;
}

/** Absolute market time -> continuous logical index (bar i sits at logical i). */
export function timeToLogical(bars: BarTime[], time: number, period: number): number | null {
  if (!bars.length || !Number.isFinite(time) || !(period > 0)) return null;
  const last = bars.length - 1;
  if (time <= bars[0]!.time) return (time - bars[0]!.time) / period;
  if (time >= bars[last]!.time) return last + (time - bars[last]!.time) / period;
  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time <= time) lo = mid;
    else hi = mid;
  }
  const t0 = bars[lo]!.time;
  const t1 = bars[hi]!.time;
  return lo + (time - t0) / Math.max(1, t1 - t0);
}

/** Exact inverse of timeToLogical. */
export function logicalToTime(bars: BarTime[], logical: number, period: number): number | null {
  if (!bars.length || !Number.isFinite(logical) || !(period > 0)) return null;
  const last = bars.length - 1;
  if (logical <= 0) return bars[0]!.time + logical * period;
  if (logical >= last) return bars[last]!.time + (logical - last) * period;
  const i0 = Math.floor(logical);
  const i1 = Math.min(last, i0 + 1);
  return bars[i0]!.time + (bars[i1]!.time - bars[i0]!.time) * (logical - i0);
}

/**
 * Screen x -> FRACTIONAL logical index.
 * coordinateToLogical may return an integer in some builds; calibrating with two logicalToCoordinate
 * samples (which are always continuous) makes the result exact either way.
 */
export function continuousLogicalAt(
  x: number,
  coordinateToLogical: (x: number) => number | null | undefined,
  logicalToCoordinate: (l: number) => number | null | undefined
): number | null {
  const l = coordinateToLogical(x);
  if (l == null || !Number.isFinite(l)) return null;
  const i0 = Math.round(l);
  const c0 = logicalToCoordinate(i0);
  const c1 = logicalToCoordinate(i0 + 1);
  if (c0 == null || c1 == null || !Number.isFinite(c0) || !Number.isFinite(c1)) return l;
  const px = c1 - c0;
  if (!(Math.abs(px) > 1e-6)) return l;
  return i0 + (x - c0) / px;
}

/** Median spacing of the first `sample` bars (robust to a gap); null when it cannot be inferred. */
export function medianSpacing(times: number[], sample = 32): number | null {
  const d: number[] = [];
  const n = Math.min(times.length, sample);
  for (let i = 1; i < n; i++) {
    const v = times[i]! - times[i - 1]!;
    if (v > 0 && Number.isFinite(v)) d.push(v);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)]!;
}

export type PaneInfo = {
  /** width of the visible LEFT price scale (0 / null when hidden) */
  leftScaleW?: number | null;
  /** width of the plot area (time scale width) */
  plotW?: number | null;
  /** pane height when the chart API reports it */
  paneH?: number | null;
  /** height of the time axis (used when paneH is unknown) */
  timeScaleH?: number | null;
};
export type Rect = { x: number; y: number; w: number; h: number };

/** Plot rectangle inside the overlay canvas (the canvas also covers the price and time axes). */
export function paneRect(canvasW: number, canvasH: number, info: PaneInfo = {}): Rect {
  const ok = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  const x = ok(info.leftScaleW) && info.leftScaleW < canvasW ? info.leftScaleW : 0;
  const w = ok(info.plotW) && x + info.plotW <= canvasW + 1 ? info.plotW : canvasW - x;
  const h = ok(info.paneH) && info.paneH <= canvasH + 1 ? info.paneH : ok(info.timeScaleH) && info.timeScaleH < canvasH ? canvasH - info.timeScaleH : canvasH;
  return { x, y: 0, w: Math.max(1, Math.min(w, canvasW - x)), h: Math.max(1, Math.min(h, canvasH)) };
}
