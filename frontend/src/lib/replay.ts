import type { Bar } from "./types";

export function aggregateBars(rows: Bar[], seconds: number): Bar[] {
  if (seconds <= 1) return rows;
  const out: Bar[] = [];
  let current: Bar | null = null;
  for (const row of rows) {
    const bucket = Math.floor(row.time / seconds) * seconds;
    if (!current || current.time !== bucket) {
      current = { time: bucket, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? 0 };
      out.push(current);
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume += row.volume ?? 0;
    }
  }
  return out;
}

export function aggregateVisible(rows: Bar[], cursorSeconds: number, timeframeSeconds: number): Bar[] {
  // Keep the chart light even when the replay dataset spans months. The
  // replay cursor still advances through every stored second; only the
  // rendered history is windowed.
  const maxCandles = 1200;
  const start = Math.max(0, cursorSeconds - Math.max(1, timeframeSeconds) * maxCandles);
  return aggregateBars(rows.slice(start, cursorSeconds), timeframeSeconds);
}
