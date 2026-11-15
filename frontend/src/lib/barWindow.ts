/**
 * P10 — Dynamic bar window helpers (RAM-bounded historical loading).
 * IndexedDB day-shard schema is unchanged; this only manages in-memory merges.
 */
import type { Bar } from "./types";
import { cacheGetRange, eachDay } from "./barCache";
import { unixToUtcDay } from "./tickReplay";

/** Session spans at or below this use the legacy full-range load path. */
export const FULL_LOAD_MAX_DAYS = 14;
/** First paint for large sessions: trailing days of the requested range. */
export const INITIAL_WINDOW_DAYS = 7;
/** Extra calendar days before/after a visible/request range. */
export const PREFETCH_DAYS = 2;
/** Soft cap on calendar days retained in the in-memory window. */
export const MAX_RESIDENT_DAYS = 28;

export function sessionDaySpan(start: string, end: string): number {
  if (!start || !end || end < start) return 0;
  return eachDay(start, end).length;
}

export function shouldFullLoad(start: string, end: string): boolean {
  return sessionDaySpan(start, end) <= FULL_LOAD_MAX_DAYS;
}

export function clampDayToSession(day: string, sessionStart: string, sessionEnd: string): string {
  if (sessionStart && day < sessionStart) return sessionStart;
  if (sessionEnd && day > sessionEnd) return sessionEnd;
  return day;
}

export function shiftUtcDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Calendar day range covering [fromSec, toSec] expanded by prefetch days, clamped to session. */
export function dayRangeForTimes(
  fromSec: number,
  toSec: number,
  sessionStart: string,
  sessionEnd: string,
  prefetchDays = PREFETCH_DAYS
): { start: string; end: string } {
  const lo = Math.min(fromSec, toSec);
  const hi = Math.max(fromSec, toSec);
  let start = shiftUtcDay(unixToUtcDay(lo), -Math.max(0, prefetchDays));
  let end = shiftUtcDay(unixToUtcDay(hi), Math.max(0, prefetchDays));
  start = clampDayToSession(start, sessionStart, sessionEnd);
  end = clampDayToSession(end, sessionStart, sessionEnd);
  if (end < start) end = start;
  return { start, end };
}

/** Trailing N days of a session calendar (inclusive). */
export function trailingSessionDays(sessionStart: string, sessionEnd: string, n: number): { start: string; end: string } {
  const days = eachDay(sessionStart, sessionEnd);
  if (!days.length) return { start: sessionStart, end: sessionEnd };
  const slice = days.slice(-Math.max(1, n));
  return { start: slice[0]!, end: slice[slice.length - 1]! };
}

/**
 * Merge incoming bars into existing by unix time (dedupe).
 * `prepended` = how many bars in the result sit strictly before the previous first time
 * (used to keep the replay cursor on the same market timestamp).
 */
export function mergeBarsChronological(
  existing: Bar[],
  incoming: Bar[]
): { bars: Bar[]; prepended: number } {
  if (!incoming.length) return { bars: existing, prepended: 0 };
  if (!existing.length) return { bars: incoming.slice(), prepended: 0 };

  const prevFirst = existing[0]!.time;
  const map = new Map<number, Bar>();
  for (const b of existing) map.set(b.time, b);
  for (const b of incoming) {
    if (!map.has(b.time)) map.set(b.time, b);
  }
  const bars = Array.from(map.values()).sort((a, b) => a.time - b.time);
  let prepended = 0;
  for (const b of bars) {
    if (b.time < prevFirst) prepended++;
    else break;
  }
  return { bars, prepended };
}

/** True when every second in [fromSec, toSec] is covered by existing bars (inclusive endpoints). */
export function windowCoversRange(bars: Bar[], fromSec: number, toSec: number): boolean {
  if (!bars.length) return false;
  const lo = Math.min(fromSec, toSec);
  const hi = Math.max(fromSec, toSec);
  return bars[0]!.time <= lo && bars[bars.length - 1]!.time >= hi;
}

export function residentCalendarDays(bars: Bar[]): number {
  if (!bars.length) return 0;
  return sessionDaySpan(unixToUtcDay(bars[0]!.time), unixToUtcDay(bars[bars.length - 1]!.time));
}

/**
 * Evict days farthest from anchorTime until calendar span ≤ maxDays.
 * Returns cursor adjustment (prepended negative when head removed).
 */
export function trimBarsAroundTime(
  bars: Bar[],
  anchorTime: number,
  maxDays: number
): { bars: Bar[]; removedFromStart: number } {
  if (!bars.length || maxDays <= 0) return { bars, removedFromStart: 0 };
  if (residentCalendarDays(bars) <= maxDays) return { bars, removedFromStart: 0 };

  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const d = unixToUtcDay(b.time);
    const arr = byDay.get(d);
    if (arr) arr.push(b);
    else byDay.set(d, [b]);
  }
  const days = [...byDay.keys()].sort();
  const anchorDay = unixToUtcDay(anchorTime);
  const scored = days.map((d) => ({
    d,
    dist: Math.abs(Date.parse(`${d}T00:00:00.000Z`) - Date.parse(`${anchorDay}T00:00:00.000Z`)),
  }));
  scored.sort((a, b) => a.dist - b.dist || a.d.localeCompare(b.d));
  const keep = new Set(scored.slice(0, maxDays).map((x) => x.d));
  const next: Bar[] = [];
  for (const d of days) {
    if (keep.has(d)) next.push(...(byDay.get(d) || []));
  }
  next.sort((a, b) => a.time - b.time);
  let removedFromStart = 0;
  if (bars[0] && next[0] && next[0].time > bars[0].time) {
    for (const b of bars) {
      if (b.time < next[0].time) removedFromStart++;
      else break;
    }
  }
  return { bars: next, removedFromStart };
}

export async function loadBarsForDayRange(symbol: string, start: string, end: string) {
  return cacheGetRange(symbol, start, end);
}
