/**
 * v3.26.0 — Read-only replay / market-data load diagnostics.
 * Does not mutate Session, Journal, Accounts, or Prop.
 */

export type LastRangeLoadDiag = {
  symbol: string;
  start: string;
  end: string;
  source: "local-cache" | "partial-cache" | "backend-merge" | "offline-cache" | "none";
  barCount: number;
  daysHit: number;
  daysMiss: number;
  daysEmpty: number;
  loadMs: number;
  sorted: boolean;
  at: number;
};

export type ReplayWindowDiag = {
  baseBars: number;
  displayCandles: number;
  execWindow: number;
  cursor: number;
  timeframeSeconds: number;
  replayStepSeconds: number;
};

let lastRange: LastRangeLoadDiag | null = null;
let lastWindow: ReplayWindowDiag | null = null;

export function recordRangeLoad(d: LastRangeLoadDiag): void {
  lastRange = d;
}

export function recordReplayWindow(d: ReplayWindowDiag): void {
  lastWindow = d;
}

export function getLastRangeLoad(): LastRangeLoadDiag | null {
  return lastRange;
}

export function getLastReplayWindow(): ReplayWindowDiag | null {
  return lastWindow;
}
