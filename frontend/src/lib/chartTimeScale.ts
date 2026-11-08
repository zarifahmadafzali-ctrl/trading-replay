/**
 * C1.3 / C1.4 — pure helpers for chart time-scale future space.
 * Does not create OHLC or touch market data stores.
 */

/** Minimum future whitespace slots after the last real candle. */
export const CHART_FUTURE_MIN_BARS = 64;

/** Hard cap so long sessions do not allocate unbounded whitespace. */
export const CHART_FUTURE_MAX_BARS = 320;

/** @deprecated use CHART_FUTURE_MIN_BARS / futureWhitespaceCount — kept for imports */
export const CHART_FUTURE_LOGICAL_BARS = CHART_FUTURE_MIN_BARS;

/**
 * Choose how many future whitespace points are needed so time labels can
 * reach the right edge of the chart for the current viewport width.
 */
export function futureWhitespaceCount(
  visibleLogicalWidth: number | null | undefined,
  minimum: number = CHART_FUTURE_MIN_BARS,
  maximum: number = CHART_FUTURE_MAX_BARS
): number {
  const min = Math.max(1, Math.floor(minimum));
  const max = Math.max(min, Math.floor(maximum));
  const w =
    visibleLogicalWidth != null && Number.isFinite(visibleLogicalWidth)
      ? Math.max(0, visibleLogicalWidth)
      : min;
  // At least half the viewport, and never below minimum — fills to the right edge
  // when the last real bar is kept in the left/center portion of the view.
  const target = Math.ceil(Math.max(min, w * 0.6, w - 8));
  return Math.max(min, Math.min(max, target));
}

/**
 * Compute a visible logical range that keeps the last real bar in view
 * and leaves `futureBars` of empty logical space to the right (to the chart edge).
 */
export function followVisibleLogicalRange(
  dataLength: number,
  visibleLogicalWidth: number,
  futureBars: number = CHART_FUTURE_MIN_BARS
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

export function shouldAutoFollowScroll(followMode: boolean, dataLength: number): boolean {
  return !!followMode && dataLength > 0;
}

/**
 * Future time-scale points only (Lightweight Charts WhitespaceData).
 * Unix seconds strictly after lastRealTime, spaced by the display timeframe.
 * Never includes OHLC or volume fields.
 */
export function buildFutureWhitespaceTimes(
  lastRealTime: number,
  stepSeconds: number,
  count: number = CHART_FUTURE_MIN_BARS
): number[] {
  if (!Number.isFinite(lastRealTime)) return [];
  const step = Math.max(1, Math.floor(Number(stepSeconds)) || 1);
  const n = Math.max(0, Math.min(CHART_FUTURE_MAX_BARS, Math.floor(count)));
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(lastRealTime + i * step);
  }
  return out;
}

export function isWhitespaceOnlyPoint(p: { time?: unknown; open?: unknown; value?: unknown }): boolean {
  if (p == null || typeof p !== "object") return false;
  if (typeof (p as { time?: unknown }).time !== "number") return false;
  return (p as { open?: unknown }).open === undefined && (p as { value?: unknown }).value === undefined;
}
