/**
 * C1.3 — pure helpers for chart time-scale future whitespace.
 * Does not create OHLC or touch market data stores.
 */

/** Logical bars of empty space to the right of the last real candle (TradingView-like). */
export const CHART_FUTURE_LOGICAL_BARS = 28;

/**
 * Compute a visible logical range that keeps the last real bar in view
 * and leaves `futureBars` of empty logical space to the right.
 *
 * `dataLength` is the number of real candles in the series (not including future space).
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
