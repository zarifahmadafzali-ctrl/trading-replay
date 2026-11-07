/**
 * Phase B — Tick → 1-second OHLC (MID), matching TR Market Data processor/ohlc.py.
 *
 * - mid from record or (bid+ask)/2
 * - volume = bid_vol + ask_vol (+ volume if present on source objects before normalize)
 * - no fabricated empty seconds
 * - bucket = floor(time) for 1s (int(ts // 1) * 1)
 */

import type { Bar } from "./types";
import type { TickRecord } from "./tickTypes";

/**
 * Aggregate ticks to 1-second bars using MID price.
 * Input should already be normalized (stable order). Sorting is still applied defensively.
 */
export function ticksToOneSecondBars(ticks: TickRecord[]): Bar[] {
  if (!ticks.length) return [];

  const ordered = [...ticks].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });

  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();

  for (const t of ordered) {
    const bucket = Math.floor(t.time);
    const mid = Number.isFinite(t.mid)
      ? t.mid
      : t.bid > 0 && t.ask > 0
        ? (t.bid + t.ask) / 2
        : t.bid || t.ask;
    const vol = (t.bid_vol || 0) + (t.ask_vol || 0);
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { open: mid, high: mid, low: mid, close: mid, volume: vol });
    } else {
      existing.high = Math.max(existing.high, mid);
      existing.low = Math.min(existing.low, mid);
      existing.close = mid;
      existing.volume += vol;
    }
  }

  const bars: Bar[] = [];
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const k of keys) {
    const b = buckets.get(k)!;
    bars.push({
      time: k,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    });
  }
  return bars;
}

/** Compare two bar series for cross-validation (loose float tolerance). */
export function barsApproximatelyEqual(
  a: Bar[],
  b: Bar[],
  eps = 1e-6
): { ok: boolean; mismatches: number; extraA: number; extraB: number } {
  const mapB = new Map(b.map((x) => [x.time, x]));
  let mismatches = 0;
  let matched = 0;
  for (const x of a) {
    const y = mapB.get(x.time);
    if (!y) continue;
    matched += 1;
    mapB.delete(x.time);
    if (
      Math.abs(x.open - y.open) > eps ||
      Math.abs(x.high - y.high) > eps ||
      Math.abs(x.low - y.low) > eps ||
      Math.abs(x.close - y.close) > eps
    ) {
      mismatches += 1;
    }
  }
  return {
    ok: mismatches === 0 && a.length === b.length && mapB.size === 0,
    mismatches,
    extraA: a.length - matched,
    extraB: mapB.size,
  };
}
