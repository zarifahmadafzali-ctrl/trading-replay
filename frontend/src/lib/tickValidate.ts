/**
 * Phase B — Tick validation and normalization.
 * Preserves fractional timestamps and equal-timestamp multiplicity.
 */

import type { TickNormalizeResult, TickRecord, TickValidationIssue } from "./tickTypes";

function bump(
  issues: Partial<Record<TickValidationIssue, number>>,
  k: TickValidationIssue
): void {
  issues[k] = (issues[k] || 0) + 1;
}

function finiteOrNaN(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Exact duplicate key for skip-on-reimport (not merely same timestamp). */
export function tickIdentityKey(t: {
  time: number;
  bid: number;
  ask: number;
  bid_vol?: number;
  ask_vol?: number;
  mid?: number;
}): string {
  return `${t.time}|${t.bid}|${t.ask}|${t.bid_vol ?? 0}|${t.ask_vol ?? 0}|${t.mid ?? ""}`;
}

/**
 * Validate and normalize raw tick-like objects.
 * - Does not floor timestamps.
 * - Assigns sequential `seq` in source order for stable sort.
 * - Skips exact duplicates within the batch (same identity key).
 * - Keeps different records that only share `time`.
 */
export function normalizeTicks(
  input: Array<Record<string, unknown> | null | undefined>
): TickNormalizeResult {
  const issues: Partial<Record<TickValidationIssue, number>> = {};
  const out: TickRecord[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let exactDuplicatesSkipped = 0;
  let lastTime = -Infinity;
  let outOfOrderSource = false;

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      rejected += 1;
      bump(issues, "missing_time");
      continue;
    }
    const time = finiteOrNaN(raw.time);
    if (!Number.isFinite(time)) {
      rejected += 1;
      bump(issues, "missing_time");
      continue;
    }
    if (time < 0) {
      rejected += 1;
      bump(issues, "invalid_time");
      continue;
    }
    // Accept accidental ms only when clearly ms-scale; convert without flooring fractional seconds of true second-scale values.
    let t = time;
    if (t > 1e12) {
      t = t / 1000;
    }

    const bid = finiteOrNaN(raw.bid);
    const ask = finiteOrNaN(raw.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      rejected += 1;
      if (!Number.isFinite(bid) && !Number.isFinite(ask)) bump(issues, "missing_bid_ask");
      else bump(issues, "non_numeric");
      continue;
    }
    if (bid > ask) {
      rejected += 1;
      bump(issues, "bid_gt_ask");
      continue;
    }

    let bid_vol = finiteOrNaN(raw.bid_vol ?? raw.bidVol ?? 0);
    let ask_vol = finiteOrNaN(raw.ask_vol ?? raw.askVol ?? 0);
    if (!Number.isFinite(bid_vol)) bid_vol = 0;
    if (!Number.isFinite(ask_vol)) ask_vol = 0;
    if (bid_vol < 0 || ask_vol < 0) {
      rejected += 1;
      bump(issues, "negative_volume");
      continue;
    }

    let mid = finiteOrNaN(raw.mid);
    if (!Number.isFinite(mid)) {
      mid = (bid + ask) / 2;
    }

    const rec: TickRecord = {
      time: t,
      bid,
      ask,
      bid_vol,
      ask_vol,
      mid,
    };
    const key = tickIdentityKey(rec);
    if (seen.has(key)) {
      exactDuplicatesSkipped += 1;
      bump(issues, "duplicate_full_record");
      continue;
    }
    seen.add(key);

    if (t < lastTime) outOfOrderSource = true;
    lastTime = t;

    rec.seq = out.length;
    out.push(rec);
  }

  // Stable order: time asc, then seq asc (source order for ties)
  out.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
  // Reassign seq after sort for compact storage
  out.forEach((r, i) => {
    r.seq = i;
  });

  return { ticks: out, rejected, issues, exactDuplicatesSkipped, outOfOrderSource };
}
