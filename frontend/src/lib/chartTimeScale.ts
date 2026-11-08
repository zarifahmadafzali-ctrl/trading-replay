/**
 * C1.3 / C1.4-A — pure helpers for chart time-scale future space.
 * Does not create OHLC or touch market data stores.
 */

/** Logical / whitespace bars of empty future space after the last real candle. */
export const CHART_FUTURE_LOGICAL_BARS = 28;

/**
 * Compute a visible logical range that keeps the last real bar in view
 * and leaves `futureBars` of empty logical space to the right.
 *
 * `dataLength` is the number of real candles (not counting whitespace).
 * `visibleLogicalWidth` is the current viewport width in logical indices.
 */
export function followVisibleLogicalRange(
  dataLength: number,
  visibleLogicalWidth: number,
  futureBars: number = CHART_FUTURE_LOGICAL_BARS
): { from: number; to: number } | null {
  if (!(dataLength > 0) || !Number.isFinite(dataLength)) return null;
  const last = dataLength - 1;
  const future = Math.max(0, futureBars);
  const width = Math.max(10, Number.isFinite(visibleLogicalWidth) ? visibleLogicalWidth : 80);
  const to = last + future;
  const from = to - width;
  return { from, to };
}

/** True when every series timestamp is at or before the last real bar time. */
export function candleSeriesHasOnlyRealTimes(
  seriesTimes: number[],
  lastRealTime: number
): boolean {
  if (!seriesTimes.length) return true;
  return seriesTimes.every((t) => Number.isFinite(t) && t <= lastRealTime);
}

/**
 * Decide whether an automatic follow scroll should run.
 * Manual pan is protected by requiring followMode === true.
 */
export function shouldAutoFollowScroll(followMode: boolean, dataLength: number): boolean {
  return !!followMode && dataLength > 0;
}

/**
 * C1.4-A — future time-scale points only (Lightweight Charts WhitespaceData).
 * Returns unix seconds strictly after lastRealTime, spaced by the display timeframe.
 * Never includes OHLC or volume fields.
 */
export function buildFutureWhitespaceTimes(
  lastRealTime: number,
  stepSeconds: number,
  count: number = CHART_FUTURE_LOGICAL_BARS
): number[] {
  if (!Number.isFinite(lastRealTime)) return [];
  const step = Math.max(1, Math.floor(Number(stepSeconds)) || 1);
  const n = Math.max(0, Math.min(200, Math.floor(count)));
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(lastRealTime + i * step);
  }
  return out;
}

/** Guard: a payload point is whitespace-only (time, no open). */
export function isWhitespaceOnlyPoint(p: { time?: unknown; open?: unknown; value?: unknown }): boolean {
  if (p == null || typeof p !== "object") return false;
  if (typeof (p as { time?: unknown }).time !== "number") return false;
  return (p as { open?: unknown }).open === undefined && (p as { value?: unknown }).value === undefined;
}
