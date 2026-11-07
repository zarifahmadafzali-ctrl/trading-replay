/**
 * Phase C1 — pure Tick Replay helpers (no React, no execution changes).
 * Stable order is (time ASC, seq ASC) as produced by normalizeTicks.
 */

import type { TickRecord } from "./tickTypes";

export type ReplayResolution = "tick" | "seconds";

export function unixToUtcDay(unixSec: number): string {
  const t = Number(unixSec);
  if (!Number.isFinite(t)) return "1970-01-01";
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function nextUtcDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function prevUtcDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Ensure ticks are ordered by (time, seq). Idempotent if already normalized. */
export function sortTicksStable(ticks: TickRecord[]): TickRecord[] {
  return [...ticks].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
}

/**
 * Last index with tick.time <= t (binary search).
 * Among equal timestamps the highest index (last seq) wins.
 * Returns -1 if all ticks are after t.
 */
export function findTickIndexAtOrBefore(ticks: TickRecord[], t: number): number {
  if (!ticks.length || !Number.isFinite(t)) return -1;
  let lo = 0;
  let hi = ticks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** First index with tick.time >= t, or ticks.length if none. */
export function findTickIndexAtOrAfter(ticks: TickRecord[], t: number): number {
  if (!ticks.length || !Number.isFinite(t)) return 0;
  let lo = 0;
  let hi = ticks.length - 1;
  let ans = ticks.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].time >= t) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/**
 * Map a continuous replay time onto a tick index when entering Tick mode.
 * Prefer the last tick with time <= t (end of that timestamp group).
 * If all ticks are after t, use index 0.
 * If all ticks are before t, use last index.
 */
export function mapTimeToTickIndex(ticks: TickRecord[], t: number): number {
  if (!ticks.length) return 0;
  const i = findTickIndexAtOrBefore(ticks, t);
  if (i < 0) return 0;
  return i;
}

/** Map tick time to 1-based 1s bar cursor (last bar with time <= floor(t)). */
export function mapTickTimeToBars1sCursor(
  bars: Array<{ time: number }>,
  tickTime: number
): number {
  if (!bars.length) return 1;
  const target = Math.floor(tickTime);
  let lo = 0;
  let hi = bars.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.min(bars.length, Math.max(1, ans + 1));
}

export type TickDayEligibility = {
  eligible: boolean;
  symbolUsed: string | null;
  day: string | null;
  tickCount: number;
  reason?: string;
};

export function isCompleteTickDay(row: {
  complete?: boolean;
  tickCount?: number;
  ticks?: unknown[];
} | null): boolean {
  if (!row) return false;
  if (row.complete === false) return false;
  const n = row.tickCount ?? row.ticks?.length ?? 0;
  return n > 0;
}


/** Inclusive list of UTC calendar days from startDay to endDay (YYYY-MM-DD). */
export function enumerateUtcDaysInclusive(startDay: string, endDay: string): string[] {
  if (!startDay || !endDay) return [];
  const a = startDay <= endDay ? startDay : endDay;
  const b = startDay <= endDay ? endDay : startDay;
  const out: string[] = [];
  let cur = a;
  // safety cap ~ 3 years
  for (let i = 0; i < 1200; i++) {
    out.push(cur);
    if (cur === b) break;
    cur = nextUtcDay(cur);
  }
  return out;
}

/** True if any complete tick day intersects [startDay, endDay] inclusive. */
export function hasEligibleTickDayInRange(
  completeDays: string[],
  startDay: string,
  endDay: string
): boolean {
  if (!completeDays.length || !startDay || !endDay) return false;
  const set = new Set(completeDays);
  for (const d of enumerateUtcDaysInclusive(startDay, endDay)) {
    if (set.has(d)) return true;
  }
  return false;
}
