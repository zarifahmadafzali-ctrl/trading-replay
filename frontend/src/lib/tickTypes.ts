/**
 * Phase B — native Tick record types (compatible with TR Market Data).
 * No tick replay / execution in this phase.
 */

export type TickRecord = {
  /** Unix time in seconds; fractional precision preserved (not floored). */
  time: number;
  bid: number;
  ask: number;
  bid_vol: number;
  ask_vol: number;
  /** mid = (bid+ask)/2 when not supplied by source. */
  mid: number;
  /**
   * Internal stable order among equal timestamps (source order).
   * Not part of the on-wire TR Market Data schema.
   */
  seq?: number;
};

export type TickDayRow = {
  id: string;
  symbol: string;
  day: string;
  /** Sorted by (time, seq); equal timestamps kept as separate rows. */
  ticks: TickRecord[];
  tickCount: number;
  savedAt: number;
  /** true only after a successful full-day write. */
  complete: boolean;
  source?: string;
  priceBasis?: "mid";
};

export type TickValidationIssue =
  | "missing_time"
  | "invalid_time"
  | "missing_bid_ask"
  | "non_numeric"
  | "bid_gt_ask"
  | "negative_volume"
  | "duplicate_full_record";

export type TickNormalizeResult = {
  ticks: TickRecord[];
  rejected: number;
  issues: Partial<Record<TickValidationIssue, number>>;
  exactDuplicatesSkipped: number;
  outOfOrderSource: boolean;
};
