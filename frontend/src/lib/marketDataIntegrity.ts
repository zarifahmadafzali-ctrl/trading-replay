/**
 * v3.30.0 — Market-data OHLC integrity helpers.
 * Does not invent bars. Does not mark incomplete days COMPLETE.
 * Dedup semantics: last write for the same timestamp wins.
 */

import type { Bar } from "./types";

export type BarValidationIssue =
  | "missing_time"
  | "invalid_time"
  | "non_finite_ohlc"
  | "high_low_inconsistent"
  | "volume_invalid";

export type NormalizeBarsResult = {
  bars: Bar[];
  rejected: number;
  issues: Partial<Record<BarValidationIssue, number>>;
  duplicatesCollapsed: number;
};

function toUnixSeconds(t: number): number | null {
  if (!Number.isFinite(t)) return null;
  // Accept ms accidentally stored as time
  if (t > 1e12) return Math.floor(t / 1000);
  if (t < 0) return null;
  return Math.floor(t);
}

/** Validate a single bar; returns normalized bar or null. */
export function validateBar(raw: Partial<Bar> | null | undefined): Bar | null {
  if (!raw) return null;
  const time = toUnixSeconds(Number(raw.time));
  if (time == null) return null;
  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  const hi = Math.max(open, close, high, low);
  const lo = Math.min(open, close, high, low);
  // Repair mild high/low inversion by clamping to OHLC envelope rather than inventing prices
  const volumeRaw = raw.volume;
  let volume = 0;
  if (volumeRaw != null) {
    const v = Number(volumeRaw);
    if (!Number.isFinite(v) || v < 0) return null;
    volume = v;
  }
  return {
    time,
    open,
    high: hi,
    low: lo,
    close,
    volume,
  };
}

/**
 * Normalize a bar list: validate, dedupe by timestamp (last wins), sort ascending.
 */
export function normalizeBars(input: Array<Partial<Bar> | null | undefined>): NormalizeBarsResult {
  const issues: Partial<Record<BarValidationIssue, number>> = {};
  const bump = (k: BarValidationIssue) => {
    issues[k] = (issues[k] || 0) + 1;
  };
  const byT = new Map<number, Bar>();
  let rejected = 0;
  let duplicatesCollapsed = 0;

  for (const raw of input) {
    if (!raw) {
      rejected += 1;
      bump("missing_time");
      continue;
    }
    if (raw.time == null || !Number.isFinite(Number(raw.time))) {
      rejected += 1;
      bump("missing_time");
      continue;
    }
    const t = toUnixSeconds(Number(raw.time));
    if (t == null) {
      rejected += 1;
      bump("invalid_time");
      continue;
    }
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    const close = Number(raw.close);
    if (![open, high, low, close].every(Number.isFinite)) {
      rejected += 1;
      bump("non_finite_ohlc");
      continue;
    }
    if (high < Math.max(open, close) - 1e-12 || low > Math.min(open, close) + 1e-12) {
      // still accept after clamp, but count inconsistency
      bump("high_low_inconsistent");
    }
    const bar = validateBar(raw);
    if (!bar) {
      rejected += 1;
      continue;
    }
    if (byT.has(bar.time)) duplicatesCollapsed += 1;
    byT.set(bar.time, bar);
  }

  const bars = Array.from(byT.values()).sort((a, b) => a.time - b.time);
  return { bars, rejected, issues, duplicatesCollapsed };
}

/** True if array is non-decreasing by time (already ordered). */
export function isTimeSorted(bars: Bar[]): boolean {
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time < bars[i - 1].time) return false;
  }
  return true;
}
