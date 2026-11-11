/**
 * C8 — Advanced trade analytics: risk gap, what-if scenarios, MFE/MAE, exit durations.
 * All hypothetical outputs are labeled separately from actual journal results.
 */

import type { JournalTrade } from "./journal";
import { resolveCurrencyPnL, rMultiple as rMultFn } from "./journal";
import type { Bar } from "./types";
import type { TickRecord } from "./tickTypes";

export type RiskComparison = {
  balanceBefore: number | null;
  targetRiskPercent: number | null;
  targetRiskAmount: number | null;
  actualRiskAmount: number | null;
  actualRiskPercent: number | null;
  riskAmountDiff: number | null;
  riskPercentDiff: number | null;
  entryPrice: number;
  stopPrice: number;
  stopDistance: number | null;
  finalLot: number | null;
  leverage: number | null;
  marginUsed: number | null;
  currencyPnL: number | null;
  rMultiple: number | null;
};

export function compareActualVsTargetRisk(t: JournalTrade): RiskComparison {
  const balance =
    t.balanceBefore != null && Number.isFinite(t.balanceBefore) ? t.balanceBefore : null;
  const targetPct =
    t.targetRiskPercent != null && Number.isFinite(t.targetRiskPercent)
      ? t.targetRiskPercent
      : t.riskPercent != null && Number.isFinite(t.riskPercent)
        ? t.riskPercent
        : null;
  const actualAmt =
    t.actualRiskAmount != null && Number.isFinite(t.actualRiskAmount)
      ? t.actualRiskAmount
      : t.riskAmount != null && Number.isFinite(t.riskAmount)
        ? t.riskAmount
        : null;
  const actualPct =
    t.actualRiskPercent != null && Number.isFinite(t.actualRiskPercent)
      ? t.actualRiskPercent
      : balance != null && actualAmt != null && balance > 0
        ? (actualAmt / balance) * 100
        : null;
  const targetAmt =
    balance != null && targetPct != null && balance > 0
      ? (balance * targetPct) / 100
      : null;
  const stopDist =
    Number.isFinite(t.entryPrice) && Number.isFinite(t.stopPrice)
      ? Math.abs(t.entryPrice - t.stopPrice)
      : null;

  return {
    balanceBefore: balance,
    targetRiskPercent: targetPct,
    targetRiskAmount: targetAmt,
    actualRiskAmount: actualAmt,
    actualRiskPercent: actualPct,
    riskAmountDiff:
      targetAmt != null && actualAmt != null ? actualAmt - targetAmt : null,
    riskPercentDiff:
      targetPct != null && actualPct != null ? actualPct - targetPct : null,
    entryPrice: t.entryPrice,
    stopPrice: t.stopPrice,
    stopDistance: stopDist,
    finalLot: t.finalLot ?? null,
    leverage: t.leverage ?? null,
    marginUsed: t.marginUsed ?? null,
    currencyPnL: resolveCurrencyPnL(t),
    rMultiple: t.rMultiple,
  };
}

export type WhatIfScenarioId =
  | "actual"
  | "scale_risk"
  | "fixed_risk_pct"
  | "fixed_profit_pct"
  | "wider_sl_rr"
  | "tighter_sl_rr";

export type WhatIfResult = {
  id: WhatIfScenarioId;
  label: string;
  hypothetical: true;
  available: boolean;
  unavailableReason?: string;
  riskAmount: number | null;
  riskPercent: number | null;
  targetProfit: number | null;
  rewardRisk: number | null;
  pnl: number | null;
  pnlDiffVsActual: number | null;
  notes?: string;
};

/**
 * Scale actual P&L by risk ratio (same R path). Does not invent fills.
 */
export function whatIfScaleRisk(
  t: JournalTrade,
  newRiskAmount: number
): WhatIfResult {
  const actual = compareActualVsTargetRisk(t);
  const actualPnl = actual.currencyPnL;
  if (actual.actualRiskAmount == null || actual.actualRiskAmount <= 0) {
    return {
      id: "scale_risk",
      label: `Scale risk to ${newRiskAmount}`,
      hypothetical: true,
      available: false,
      unavailableReason: "Actual risk amount unavailable",
      riskAmount: null,
      riskPercent: null,
      targetProfit: null,
      rewardRisk: t.rMultiple,
      pnl: null,
      pnlDiffVsActual: null,
    };
  }
  if (actualPnl == null) {
    return {
      id: "scale_risk",
      label: `Scale risk to ${newRiskAmount}`,
      hypothetical: true,
      available: false,
      unavailableReason: "Actual currency P&L unavailable",
      riskAmount: newRiskAmount,
      riskPercent:
        actual.balanceBefore != null && actual.balanceBefore > 0
          ? (newRiskAmount / actual.balanceBefore) * 100
          : null,
      targetProfit: null,
      rewardRisk: t.rMultiple,
      pnl: null,
      pnlDiffVsActual: null,
    };
  }
  const scale = newRiskAmount / actual.actualRiskAmount;
  const pnl = actualPnl * scale;
  return {
    id: "scale_risk",
    label: `Hypothetical risk $${newRiskAmount.toFixed(0)} (scaled)`,
    hypothetical: true,
    available: true,
    riskAmount: newRiskAmount,
    riskPercent:
      actual.balanceBefore != null && actual.balanceBefore > 0
        ? (newRiskAmount / actual.balanceBefore) * 100
        : null,
    targetProfit: null,
    rewardRisk: t.rMultiple,
    pnl,
    pnlDiffVsActual: pnl - actualPnl,
    notes:
      "Assumes same R multiple and fill prices; does not verify margin for larger size.",
  };
}

export function whatIfFixedRiskPercent(t: JournalTrade, pct: number): WhatIfResult {
  const bal = t.balanceBefore;
  if (bal == null || !(bal > 0)) {
    return {
      id: "fixed_risk_pct",
      label: `Risk ${pct}% of balance`,
      hypothetical: true,
      available: false,
      unavailableReason: "Balance at entry unavailable",
      riskAmount: null,
      riskPercent: pct,
      targetProfit: null,
      rewardRisk: t.rMultiple,
      pnl: null,
      pnlDiffVsActual: null,
    };
  }
  return whatIfScaleRisk(t, (bal * pct) / 100);
}

export function whatIfFixedProfitPercent(t: JournalTrade, pct: number): WhatIfResult {
  const bal = t.balanceBefore;
  const actualPnl = resolveCurrencyPnL(t);
  if (bal == null || !(bal > 0)) {
    return {
      id: "fixed_profit_pct",
      label: `Target profit ${pct}%`,
      hypothetical: true,
      available: false,
      unavailableReason: "Balance at entry unavailable",
      riskAmount: null,
      riskPercent: null,
      targetProfit: null,
      rewardRisk: null,
      pnl: null,
      pnlDiffVsActual: null,
    };
  }
  const target = (bal * pct) / 100;
  // Only meaningful for wins as a target level; still report as hypothetical target
  return {
    id: "fixed_profit_pct",
    label: `Hypothetical target profit ${pct}% of balance`,
    hypothetical: true,
    available: true,
    riskAmount: t.actualRiskAmount ?? t.riskAmount ?? null,
    riskPercent: t.actualRiskPercent ?? t.riskPercent ?? null,
    targetProfit: target,
    rewardRisk:
      t.actualRiskAmount != null && t.actualRiskAmount > 0
        ? target / t.actualRiskAmount
        : null,
    pnl: null,
    pnlDiffVsActual: actualPnl != null ? target - actualPnl : null,
    notes:
      "Target profit level only — not an actual trade outcome. Does not claim this target was hit.",
  };
}

export type ExcursionResult = {
  available: boolean;
  unavailableReason?: string;
  dataSource: "tick" | "bars_1s" | "none";
  mfePrice: number | null;
  maePrice: number | null;
  mfePoints: number | null;
  maePoints: number | null;
  mfeR: number | null;
  maeR: number | null;
  postExitMfePrice: number | null;
  postExitMfePoints: number | null;
  postExitMfeR: number | null;
  observationEnd: number | null;
  note?: string;
};

function riskPoints(t: JournalTrade): number | null {
  const d = Math.abs(t.entryPrice - t.stopPrice);
  return d > 1e-12 ? d : null;
}

/**
 * MFE/MAE from entry→exit and post-exit to end of UTC calendar day (fallback).
 * Long: favorable = high-side, adverse = low-side using bar high/low or tick mid extremes.
 */
export function computeExcursion(
  t: JournalTrade,
  barsDuring: Bar[],
  barsAfter: Bar[],
  ticksDuring?: TickRecord[] | null,
  ticksAfter?: TickRecord[] | null
): ExcursionResult {
  const risk = riskPoints(t);
  const long = t.side === "long";
  const entry = t.entryPrice;

  let dataSource: ExcursionResult["dataSource"] = "none";
  let mfePrice: number | null = null;
  let maePrice: number | null = null;

  const useTicks = ticksDuring && ticksDuring.length > 0;
  if (useTicks) {
    dataSource = "tick";
    for (const tk of ticksDuring!) {
      if (tk.time < t.entryTime || tk.time > t.exitTime) continue;
      // Favorable/adverse using side-appropriate quotes when possible
      const favPx = long ? tk.bid : tk.ask; // mark-to-market exit side
      const advPx = long ? tk.bid : tk.ask;
      if (long) {
        if (mfePrice == null || favPx > mfePrice) mfePrice = favPx;
        if (maePrice == null || advPx < maePrice) maePrice = advPx;
      } else {
        if (mfePrice == null || favPx < mfePrice) mfePrice = favPx;
        if (maePrice == null || advPx > maePrice) maePrice = advPx;
      }
    }
  } else if (barsDuring.length) {
    dataSource = "bars_1s";
    for (const b of barsDuring) {
      if (b.time < t.entryTime || b.time > t.exitTime) continue;
      if (long) {
        if (mfePrice == null || b.high > mfePrice) mfePrice = b.high;
        if (maePrice == null || b.low < maePrice) maePrice = b.low;
      } else {
        if (mfePrice == null || b.low < mfePrice) mfePrice = b.low;
        if (maePrice == null || b.high > maePrice) maePrice = b.high;
      }
    }
  }

  if (mfePrice == null && maePrice == null) {
    return {
      available: false,
      unavailableReason: "No 1s or tick data for trade window",
      dataSource: "none",
      mfePrice: null,
      maePrice: null,
      mfePoints: null,
      maePoints: null,
      mfeR: null,
      maeR: null,
      postExitMfePrice: null,
      postExitMfePoints: null,
      postExitMfeR: null,
      observationEnd: null,
    };
  }

  const mfePoints =
    mfePrice != null ? (long ? mfePrice - entry : entry - mfePrice) : null;
  const maePoints =
    maePrice != null ? (long ? entry - maePrice : maePrice - entry) : null;

  let postExitMfePrice: number | null = null;
  const afterTicks = ticksAfter && ticksAfter.length > 0;
  if (afterTicks) {
    for (const tk of ticksAfter!) {
      if (tk.time <= t.exitTime) continue;
      const px = long ? tk.bid : tk.ask;
      if (long) {
        if (postExitMfePrice == null || px > postExitMfePrice) postExitMfePrice = px;
      } else {
        if (postExitMfePrice == null || px < postExitMfePrice) postExitMfePrice = px;
      }
    }
  } else {
    for (const b of barsAfter) {
      if (b.time <= t.exitTime) continue;
      if (long) {
        if (postExitMfePrice == null || b.high > postExitMfePrice) postExitMfePrice = b.high;
      } else {
        if (postExitMfePrice == null || b.low < postExitMfePrice) postExitMfePrice = b.low;
      }
    }
  }

  const postExitMfePoints =
    postExitMfePrice != null
      ? long
        ? postExitMfePrice - entry
        : entry - postExitMfePrice
      : null;

  const observationEnd =
    barsAfter.length > 0
      ? barsAfter[barsAfter.length - 1]!.time
      : barsDuring.length
        ? barsDuring[barsDuring.length - 1]!.time
        : t.exitTime;

  return {
    available: true,
    dataSource,
    mfePrice,
    maePrice,
    mfePoints,
    maePoints,
    mfeR: mfePoints != null && risk ? mfePoints / risk : null,
    maeR: maePoints != null && risk ? maePoints / risk : null,
    postExitMfePrice,
    postExitMfePoints,
    postExitMfeR:
      postExitMfePoints != null && risk ? postExitMfePoints / risk : null,
    observationEnd,
    note:
      dataSource === "bars_1s"
        ? "Excursion estimated from 1s OHLC high/low (intrabar order unknown)."
        : dataSource === "tick"
          ? "Excursion from tick Bid/Ask mark-to-market."
          : undefined,
  };
}

export type DurationBucketStats = {
  reason: "tp" | "sl" | "manual" | "breakeven" | "all";
  count: number;
  minSec: number | null;
  maxSec: number | null;
  avgSec: number | null;
  medianSec: number | null;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function durationSec(t: JournalTrade): number | null {
  if (t.durationSeconds != null && Number.isFinite(t.durationSeconds)) return t.durationSeconds;
  const d = t.exitTime - t.entryTime;
  return Number.isFinite(d) ? Math.max(0, d) : null;
}

function isBreakeven(t: JournalTrade): boolean {
  const pnl = resolveCurrencyPnL(t);
  if (pnl != null && Math.abs(pnl) < 1e-8) return true;
  if (t.rMultiple != null && Math.abs(t.rMultiple) < 1e-8) return true;
  if (Math.abs(t.pnlPoints) < 1e-8) return true;
  return false;
}

export function durationStatsByExit(trades: JournalTrade[]): DurationBucketStats[] {
  const buckets: Record<string, number[]> = {
    tp: [],
    sl: [],
    manual: [],
    breakeven: [],
    all: [],
  };
  for (const t of trades) {
    const d = durationSec(t);
    if (d == null) continue;
    buckets.all!.push(d);
    if (isBreakeven(t)) {
      buckets.breakeven!.push(d);
      continue;
    }
    if (t.reason === "tp") buckets.tp!.push(d);
    else if (t.reason === "sl") buckets.sl!.push(d);
    else buckets.manual!.push(d);
  }
  const pack = (reason: DurationBucketStats["reason"], xs: number[]): DurationBucketStats => ({
    reason,
    count: xs.length,
    minSec: xs.length ? Math.min(...xs) : null,
    maxSec: xs.length ? Math.max(...xs) : null,
    avgSec: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    medianSec: median(xs),
  });
  return [
    pack("all", buckets.all!),
    pack("tp", buckets.tp!),
    pack("sl", buckets.sl!),
    pack("breakeven", buckets.breakeven!),
    pack("manual", buckets.manual!),
  ];
}

/** Aggregate risk gap across filtered trades (samples with both target and actual). */
export function aggregateRiskGap(trades: JournalTrade[]): {
  samples: number;
  avgTargetPct: number | null;
  avgActualPct: number | null;
  avgDiffPct: number | null;
  avgTargetAmt: number | null;
  avgActualAmt: number | null;
} {
  const targetPcts: number[] = [];
  const actualPcts: number[] = [];
  const targetAmts: number[] = [];
  const actualAmts: number[] = [];
  for (const t of trades) {
    const c = compareActualVsTargetRisk(t);
    if (c.targetRiskPercent != null) targetPcts.push(c.targetRiskPercent);
    if (c.actualRiskPercent != null) actualPcts.push(c.actualRiskPercent);
    if (c.targetRiskAmount != null) targetAmts.push(c.targetRiskAmount);
    if (c.actualRiskAmount != null) actualAmts.push(c.actualRiskAmount);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const samples = trades.filter((t) => {
    const c = compareActualVsTargetRisk(t);
    return c.targetRiskPercent != null && c.actualRiskPercent != null;
  }).length;
  const avgT = avg(targetPcts);
  const avgA = avg(actualPcts);
  return {
    samples,
    avgTargetPct: avgT,
    avgActualPct: avgA,
    avgDiffPct: avgT != null && avgA != null ? avgA - avgT : null,
    avgTargetAmt: avg(targetAmts),
    avgActualAmt: avg(actualAmts),
  };
}
