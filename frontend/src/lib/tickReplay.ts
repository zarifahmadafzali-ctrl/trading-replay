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


/** 1-based exclusive-style bar cursor matching ReplayView Jump binary search. */
export function findBars1sCursorForUnixTime(
  bars: Array<{ time: number }>,
  targetUnixSec: number
): number {
  if (!bars.length) return 1;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < targetUnixSec) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(bars.length, Math.max(1, lo + 1));
}

/** Async tick navigation: only the latest generation may apply window/index updates. */
export function shouldApplyTickNav(activeGeneration: number, requestGeneration: number): boolean {
  return requestGeneration === activeGeneration && requestGeneration > 0;
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

// ---------------------------------------------------------------------------
// C1.2 — Real-time playback delay helpers (pure, no timers)
// ---------------------------------------------------------------------------

/** Soft upper bound so multi-day gaps do not freeze the browser UI for hours. */
export const PLAY_DELAY_MAX_MS = 300_000; // 5 minutes wall-clock

/**
 * Convert a market-time delta (seconds, may be fractional) into wall-clock delay.
 * speed 1 = real time; 2 = twice as fast; 0.5 = half speed.
 * Same-timestamp ticks (delta <= 0) yield 0 so they advance on the next macrotask.
 */
export function wallClockDelayMs(
  marketTimeDeltaSeconds: number,
  playbackSpeed: number
): number {
  const speed = playbackSpeed > 0 && Number.isFinite(playbackSpeed) ? playbackSpeed : 1;
  if (!Number.isFinite(marketTimeDeltaSeconds) || marketTimeDeltaSeconds <= 0) {
    return 0;
  }
  const ms = (marketTimeDeltaSeconds * 1000) / speed;
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(PLAY_DELAY_MAX_MS, ms);
}

/**
 * Seconds-mode: market delta between the bar at the current exclusive cursor
 * and the bar after advancing `stepBars` indices (1s bar array).
 * `cursor` is the exclusive end index used by ReplayView (1..length).
 */
export function secondsModeNextDeltaSec(
  bars: Array<{ time: number }>,
  cursor: number,
  stepBars: number
): { deltaSec: number; nextCursor: number; atEnd: boolean } {
  const len = bars.length;
  const step = Math.max(1, Math.floor(stepBars) || 1);
  if (len <= 0 || cursor >= len) {
    return { deltaSec: 0, nextCursor: cursor, atEnd: true };
  }
  const nextCursor = Math.min(len, cursor + step);
  const t0 = bars[Math.max(0, cursor - 1)]?.time;
  const t1 = bars[Math.max(0, nextCursor - 1)]?.time;
  let deltaSec = step;
  if (t0 != null && t1 != null && Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
    deltaSec = t1 - t0;
  }
  // If timestamps are equal or inverted, fall back to nominal step size so play continues.
  if (!(deltaSec > 0)) deltaSec = step;
  return {
    deltaSec,
    nextCursor,
    atEnd: nextCursor >= len && cursor >= len,
  };
}

/**
 * Tick-mode: market delta from tick at `index` to the next tick in the same window.
 * Same timestamps → deltaSec 0 (advance immediately, preserve seq order).
 * atEnd true when there is no next tick in this window (caller may day-roll).
 */
export function tickModeNextDeltaSec(
  ticks: Array<{ time: number }>,
  index: number
): { deltaSec: number; nextIndex: number; atEnd: boolean; sameTimestamp: boolean } {
  if (!ticks.length || index < 0 || index >= ticks.length - 1) {
    return { deltaSec: 0, nextIndex: index, atEnd: true, sameTimestamp: false };
  }
  const nextIndex = index + 1;
  const t0 = ticks[index].time;
  const t1 = ticks[nextIndex].time;
  const deltaSec = Number.isFinite(t0) && Number.isFinite(t1) ? t1 - t0 : 0;
  return {
    deltaSec: deltaSec > 0 ? deltaSec : 0,
    nextIndex,
    atEnd: false,
    sameTimestamp: !(deltaSec > 0),
  };
}
