/**
 * C8/C8.1 — Advanced trade analytics: risk gap, what-if, MFE/MAE, exit durations.
 * Hypothetical results are never treated as real journal outcomes.
 */

import type { JournalTrade } from "./journal";
import { resolveCurrencyPnL } from "./journal";
import type { Bar } from "./types";
import type { TickRecord } from "./tickTypes";
import { tradingDayKey } from "./propRules";

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
  freeMarginBefore: number | null;
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
    balance != null && targetPct != null && balance > 0 ? (balance * targetPct) / 100 : null;
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
    riskAmountDiff: targetAmt != null && actualAmt != null ? actualAmt - targetAmt : null,
    riskPercentDiff: targetPct != null && actualPct != null ? actualPct - targetPct : null,
    entryPrice: t.entryPrice,
    stopPrice: t.stopPrice,
    stopDistance: stopDist,
    finalLot: t.finalLot ?? null,
    leverage: t.leverage ?? null,
    marginUsed: t.marginUsed ?? null,
    freeMarginBefore: t.freeMarginBefore ?? null,
    currencyPnL: resolveCurrencyPnL(t),
    rMultiple: t.rMultiple,
  };
}

export type WhatIfValidation = "theoretical" | "margin_validated" | "unavailable";

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
  /** theoretical = scaled math only; margin_validated = margin fields support size; unavailable = cannot compute */
  validation: WhatIfValidation;
  unavailableReason?: string;
  riskAmount: number | null;
  riskPercent: number | null;
  targetProfit: number | null;
  rewardRisk: number | null;
  pnl: number | null;
  pnlDiffVsActual: number | null;
  impliedLot: number | null;
  notes?: string;
};

/**
 * If lot and margin scale linearly with risk, check free+used margin covers scaled requirement.
 * Without margin/lot history → theoretical only (never claim executable).
 */
function classifyMarginForScaledRisk(
  t: JournalTrade,
  scale: number
): { validation: WhatIfValidation; impliedLot: number | null; notes: string } {
  const lot = t.finalLot;
  const marginUsed = t.marginUsed;
  const free = t.freeMarginBefore;
  const impliedLot =
    lot != null && Number.isFinite(lot) && scale > 0 ? lot * scale : null;

  if (marginUsed == null || !Number.isFinite(marginUsed) || marginUsed < 0) {
    return {
      validation: "theoretical",
      impliedLot,
      notes:
        "Theoretical only: historical marginUsed missing — larger size is not verified as executable.",
    };
  }
  if (free == null || !Number.isFinite(free)) {
    return {
      validation: "theoretical",
      impliedLot,
      notes:
        "Theoretical only: freeMarginBefore missing — cannot validate margin headroom.",
    };
  }
  const required = marginUsed * scale;
  const available = free + marginUsed; // release current, re-allocate (simplified)
  if (required > available + 1e-6) {
    return {
      validation: "theoretical",
      impliedLot,
      notes: `Theoretical only: scaled margin ~${required.toFixed(2)} exceeds available ~${available.toFixed(2)}.`,
    };
  }
  return {
    validation: "margin_validated",
    impliedLot,
    notes:
      "Margin check passed under linear margin scaling assumption (same instrument/leverage). Still hypothetical — not a real trade.",
  };
}

export function whatIfScaleRisk(t: JournalTrade, newRiskAmount: number): WhatIfResult {
  const actual = compareActualVsTargetRisk(t);
  const actualPnl = actual.currencyPnL;
  const base = {
    id: "scale_risk" as const,
    label: `Scale risk to ${newRiskAmount}`,
    hypothetical: true as const,
    riskAmount: newRiskAmount,
    riskPercent:
      actual.balanceBefore != null && actual.balanceBefore > 0
        ? (newRiskAmount / actual.balanceBefore) * 100
        : null,
    targetProfit: null as number | null,
    rewardRisk: t.rMultiple,
    impliedLot: null as number | null,
  };

  if (!(newRiskAmount > 0) || !Number.isFinite(newRiskAmount)) {
    return {
      ...base,
      available: false,
      validation: "unavailable",
      unavailableReason: "Invalid risk amount",
      pnl: null,
      pnlDiffVsActual: null,
    };
  }
  if (actual.actualRiskAmount == null || actual.actualRiskAmount <= 0) {
    return {
      ...base,
      available: false,
      validation: "unavailable",
      unavailableReason: "Actual risk amount unavailable",
      pnl: null,
      pnlDiffVsActual: null,
    };
  }
  if (actualPnl == null) {
    return {
      ...base,
      available: false,
      validation: "unavailable",
      unavailableReason: "Actual currency P&L unavailable",
      pnl: null,
      pnlDiffVsActual: null,
    };
  }

  const scale = newRiskAmount / actual.actualRiskAmount;
  const pnl = actualPnl * scale;
  const margin = classifyMarginForScaledRisk(t, scale);

  return {
    ...base,
    available: true,
    validation: margin.validation,
    pnl,
    pnlDiffVsActual: pnl - actualPnl,
    impliedLot: margin.impliedLot,
    notes: margin.notes,
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
      validation: "unavailable",
      unavailableReason: "Balance at entry unavailable",
      riskAmount: null,
      riskPercent: pct,
      targetProfit: null,
      rewardRisk: t.rMultiple,
      pnl: null,
      pnlDiffVsActual: null,
      impliedLot: null,
    };
  }
  const scaled = whatIfScaleRisk(t, (bal * pct) / 100);
  return { ...scaled, id: "fixed_risk_pct", label: `Risk ${pct}% of balance` };
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
      validation: "unavailable",
      unavailableReason: "Balance at entry unavailable",
      riskAmount: null,
      riskPercent: null,
      targetProfit: null,
      rewardRisk: null,
      pnl: null,
      pnlDiffVsActual: null,
      impliedLot: null,
    };
  }
  const target = (bal * pct) / 100;
  return {
    id: "fixed_profit_pct",
    label: `Hypothetical target profit ${pct}% of balance`,
    hypothetical: true,
    available: true,
    validation: "theoretical",
    riskAmount: t.actualRiskAmount ?? t.riskAmount ?? null,
    riskPercent: t.actualRiskPercent ?? t.riskPercent ?? null,
    targetProfit: target,
    rewardRisk:
      t.actualRiskAmount != null && t.actualRiskAmount > 0
        ? target / t.actualRiskAmount
        : null,
    pnl: null,
    pnlDiffVsActual: actualPnl != null ? target - actualPnl : null,
    impliedLot: null,
    notes:
      "Target profit level only — not an actual outcome and not margin-validated.",
  };
}

export type ExcursionResult = {
  available: boolean;
  unavailableReason?: string;
  dataSource: "tick" | "bars_1s" | "none";
  /** long mark-to-market uses Bid; short uses Ask (exit-side quotes). */
  priceBasis: "bid_mtm_long_ask_mtm_short" | "ohlc_estimate" | "none";
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
  observationBoundary: "america_new_york_calendar_day" | "utc_calendar_day" | "unknown";
  note?: string;
};

function riskPoints(t: JournalTrade): number | null {
  const d = Math.abs(t.entryPrice - t.stopPrice);
  return d > 1e-12 ? d : null;
}

/**
 * Last unix second still on the same calendar day as `unixSec` in `timeZone`
 * (DST-aware via tradingDayKey / Intl).
 */
export function endOfZoneCalendarDayUnix(
  unixSec: number,
  timeZone: string
): number {
  const key = tradingDayKey(unixSec, timeZone, 0);
  let lo = Math.floor(unixSec);
  let hi = lo + 48 * 3600;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (tradingDayKey(mid, timeZone, 0) === key) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * MFE/MAE entry→exit and post-exit to end of zone calendar day.
 *
 * Tick mark-to-market (exit-side):
 * - Long: Bid (sell side)
 * - Short: Ask (buy-to-cover side)
 *
 * Entry price on the journal is already the execution fill (Ask long / Bid short from C2/C3).
 * 1s OHLC is high/low estimate only — intrabar order unknown.
 */
export function computeExcursion(
  t: JournalTrade,
  barsDuring: Bar[],
  barsAfter: Bar[],
  ticksDuring?: TickRecord[] | null,
  ticksAfter?: TickRecord[] | null,
  opts?: { postExitTimeZone?: string }
): ExcursionResult {
  const risk = riskPoints(t);
  const long = t.side === "long";
  const entry = t.entryPrice;
  const tz = opts?.postExitTimeZone?.trim() || "America/New_York";
  const zoneEnd = endOfZoneCalendarDayUnix(t.exitTime, tz);
  const boundaryLabel =
    tz === "UTC" || tz === "Etc/UTC"
      ? ("utc_calendar_day" as const)
      : tz === "America/New_York"
        ? ("america_new_york_calendar_day" as const)
        : ("unknown" as const);

  let dataSource: ExcursionResult["dataSource"] = "none";
  let priceBasis: ExcursionResult["priceBasis"] = "none";
  let mfePrice: number | null = null;
  let maePrice: number | null = null;

  const useTicks = ticksDuring && ticksDuring.length > 0;
  if (useTicks) {
    dataSource = "tick";
    priceBasis = "bid_mtm_long_ask_mtm_short";
    for (const tk of ticksDuring!) {
      if (!Number.isFinite(tk.time) || !Number.isFinite(tk.bid) || !Number.isFinite(tk.ask)) continue;
      if (tk.bid > tk.ask) continue;
      if (tk.time < t.entryTime || tk.time > t.exitTime) continue;
      // Exit-side mark-to-market only (consistent with closing the position)
      const mtm = long ? tk.bid : tk.ask;
      if (long) {
        if (mfePrice == null || mtm > mfePrice) mfePrice = mtm;
        if (maePrice == null || mtm < maePrice) maePrice = mtm;
      } else {
        if (mfePrice == null || mtm < mfePrice) mfePrice = mtm;
        if (maePrice == null || mtm > maePrice) maePrice = mtm;
      }
    }
  } else if (barsDuring.length) {
    dataSource = "bars_1s";
    priceBasis = "ohlc_estimate";
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
      priceBasis: "none",
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
      observationBoundary: boundaryLabel,
    };
  }

  const mfePoints =
    mfePrice != null ? (long ? mfePrice - entry : entry - mfePrice) : null;
  const maePoints =
    maePrice != null ? (long ? entry - maePrice : maePrice - entry) : null;

  // Clamp post-exit samples to zone day end
  let postExitMfePrice: number | null = null;
  const afterTicks = ticksAfter && ticksAfter.length > 0;
  if (afterTicks) {
    for (const tk of ticksAfter!) {
      if (!Number.isFinite(tk.time) || tk.time <= t.exitTime || tk.time > zoneEnd) continue;
      if (!Number.isFinite(tk.bid) || !Number.isFinite(tk.ask) || tk.bid > tk.ask) continue;
      const mtm = long ? tk.bid : tk.ask;
      if (long) {
        if (postExitMfePrice == null || mtm > postExitMfePrice) postExitMfePrice = mtm;
      } else {
        if (postExitMfePrice == null || mtm < postExitMfePrice) postExitMfePrice = mtm;
      }
    }
  } else {
    for (const b of barsAfter) {
      if (b.time <= t.exitTime || b.time > zoneEnd) continue;
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

  return {
    available: true,
    dataSource,
    priceBasis,
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
    observationEnd: zoneEnd,
    observationBoundary: boundaryLabel,
    note:
      dataSource === "bars_1s"
        ? "Excursion estimated from 1s OHLC high/low (intrabar order unknown). Post-exit window ends at America/New_York calendar day (DST-aware), not exchange session close."
        : dataSource === "tick"
          ? "Tick MTM uses Bid for long / Ask for short. Post-exit ends at America/New_York calendar day (DST-aware). Not actual captured profit."
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
  excludedInvalidTimestamps: number;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function durationSec(t: JournalTrade): number | null {
  if (
    t.durationSeconds != null &&
    Number.isFinite(t.durationSeconds) &&
    t.durationSeconds >= 0
  ) {
    return t.durationSeconds;
  }
  if (!Number.isFinite(t.entryTime) || !Number.isFinite(t.exitTime)) return null;
  if (t.exitTime < t.entryTime) return null;
  return Math.max(0, t.exitTime - t.entryTime);
}

function isBreakeven(t: JournalTrade): boolean {
  const pnl = resolveCurrencyPnL(t);
  if (pnl != null && Math.abs(pnl) < 1e-8) return true;
  if (t.rMultiple != null && Math.abs(t.rMultiple) < 1e-8) return true;
  if (Number.isFinite(t.pnlPoints) && Math.abs(t.pnlPoints) < 1e-8) return true;
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
  let excluded = 0;
  for (const t of trades) {
    const d = durationSec(t);
    if (d == null) {
      excluded++;
      continue;
    }
    buckets.all!.push(d);
    if (isBreakeven(t)) {
      buckets.breakeven!.push(d);
      continue;
    }
    if (t.reason === "tp") buckets.tp!.push(d);
    else if (t.reason === "sl") buckets.sl!.push(d);
    else buckets.manual!.push(d);
  }
  const pack = (
    reason: DurationBucketStats["reason"],
    xs: number[]
  ): DurationBucketStats => ({
    reason,
    count: xs.length,
    minSec: xs.length ? Math.min(...xs) : null,
    maxSec: xs.length ? Math.max(...xs) : null,
    avgSec: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    medianSec: median(xs),
    excludedInvalidTimestamps: excluded,
  });
  return [
    pack("all", buckets.all!),
    pack("tp", buckets.tp!),
    pack("sl", buckets.sl!),
    pack("breakeven", buckets.breakeven!),
    pack("manual", buckets.manual!),
  ];
}


/** Absolute initial stop distance in price points (|entry − stop|). */
export function stopDistancePoints(t: JournalTrade): number | null {
  if (t.slDistance != null && Number.isFinite(t.slDistance) && t.slDistance > 0) {
    return Math.abs(t.slDistance);
  }
  if (
    t.entryPrice != null &&
    t.stopPrice != null &&
    Number.isFinite(t.entryPrice) &&
    Number.isFinite(t.stopPrice)
  ) {
    const d = Math.abs(t.entryPrice - t.stopPrice);
    return d > 0 ? d : null;
  }
  return null;
}

export type StopDistanceBucketStats = {
  reason: "all" | "tp" | "sl" | "manual" | "breakeven";
  count: number;
  minPts: number | null;
  maxPts: number | null;
  avgPts: number | null;
  medianPts: number | null;
  excludedMissing: number;
};

/**
 * Min/max/avg/median initial stop distance (price points) by exit type.
 * For index CFDs these are points; for FX they match pip-scale when stop is in price.
 */
export function stopDistanceStatsByExit(trades: JournalTrade[]): StopDistanceBucketStats[] {
  const buckets: Record<string, number[]> = {
    tp: [],
    sl: [],
    manual: [],
    breakeven: [],
    all: [],
  };
  let excluded = 0;
  for (const t of trades) {
    const d = stopDistancePoints(t);
    if (d == null) {
      excluded++;
      continue;
    }
    buckets.all!.push(d);
    if (isBreakeven(t)) {
      buckets.breakeven!.push(d);
      continue;
    }
    if (t.reason === "tp") buckets.tp!.push(d);
    else if (t.reason === "sl") buckets.sl!.push(d);
    else buckets.manual!.push(d);
  }
  const pack = (
    reason: StopDistanceBucketStats["reason"],
    xs: number[]
  ): StopDistanceBucketStats => ({
    reason,
    count: xs.length,
    minPts: xs.length ? Math.min(...xs) : null,
    maxPts: xs.length ? Math.max(...xs) : null,
    avgPts: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    medianPts: median(xs),
    excludedMissing: excluded,
  });
  return [
    pack("all", buckets.all!),
    pack("tp", buckets.tp!),
    pack("sl", buckets.sl!),
    pack("breakeven", buckets.breakeven!),
    pack("manual", buckets.manual!),
  ];
}

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
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
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


export type ProfitDurationBucket = {
  outcome: "win" | "loss" | "breakeven";
  count: number;
  minSec: number | null;
  maxSec: number | null;
  avgSec: number | null;
  medianSec: number | null;
  excludedInvalidTimestamps: number;
};

/** Duration stats by actual realized P&L sign (not exit reason, not What-If). */
export function durationStatsByProfitability(trades: JournalTrade[]): ProfitDurationBucket[] {
  const buckets: Record<"win" | "loss" | "breakeven", number[]> = {
    win: [],
    loss: [],
    breakeven: [],
  };
  let excluded = 0;
  for (const t of trades) {
    const d = durationSec(t);
    if (d == null) {
      excluded++;
      continue;
    }
    const pnl = resolveCurrencyPnL(t);
    if (pnl == null || !Number.isFinite(pnl)) {
      excluded++;
      continue;
    }
    if (pnl > 0) buckets.win.push(d);
    else if (pnl < 0) buckets.loss.push(d);
    else buckets.breakeven.push(d);
  }
  const pack = (outcome: ProfitDurationBucket["outcome"], xs: number[]): ProfitDurationBucket => ({
    outcome,
    count: xs.length,
    minSec: xs.length ? Math.min(...xs) : null,
    maxSec: xs.length ? Math.max(...xs) : null,
    avgSec: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    medianSec: median(xs),
    excludedInvalidTimestamps: excluded,
  });
  return [pack("win", buckets.win), pack("loss", buckets.loss), pack("breakeven", buckets.breakeven)];
}

export type DailyTwoTradeCategory =
  | "both_profit"
  | "first_profit_second_loss"
  | "first_loss_second_profit"
  | "both_loss"
  | "has_breakeven"
  | "unclassified";

export type DailyTwoTradeAnalysis = {
  exactlyTwoDays: number;
  moreThanTwoDays: number;
  /** Days with exactly one closed trade. */
  singleTradeDays: number;
  /** Single-trade day and that trade was a win (often: TP first → stop trading). */
  singleWinDays: number;
  /** Single-trade day and that trade was a loss. */
  singleLossDays: number;
  /** Exactly-two days where the first trade lost (typical path into a second trade). */
  firstLossTwoTradeDays: number;
  /** Exactly-two days where the first trade won (unusual if strategy skips 2nd after TP). */
  firstWinTwoTradeDays: number;
  categories: Record<DailyTwoTradeCategory, number>;
  pctSecondProfitable: number | null;
  pctBothLosing: number | null;
  pctBothProfitable: number | null;
  /** Among days with first loss + second trade: share where second was profitable. */
  pctSecondWinAfterFirstLoss: number | null;
  timezone: string;
};

function pnlOutcome(t: JournalTrade): "win" | "loss" | "breakeven" | "unknown" {
  const pnl = resolveCurrencyPnL(t);
  if (pnl == null || !Number.isFinite(pnl)) return "unknown";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "breakeven";
}

/**
 * Days with exactly two completed trades — first/second by entryTime.
 * Uses tradingDayKey(..., America/New_York, 0) by default.
 */
export function analyzeDailyTwoTradeBehavior(
  trades: JournalTrade[],
  timeZone = "America/New_York"
): DailyTwoTradeAnalysis {
  const byDay = new Map<string, JournalTrade[]>();
  for (const t of trades) {
    const key = tradingDayKey(t.entryTime, timeZone, 0);
    const arr = byDay.get(key) || [];
    arr.push(t);
    byDay.set(key, arr);
  }

  const categories: Record<DailyTwoTradeCategory, number> = {
    both_profit: 0,
    first_profit_second_loss: 0,
    first_loss_second_profit: 0,
    both_loss: 0,
    has_breakeven: 0,
    unclassified: 0,
  };
  let exactlyTwo = 0;
  let moreThanTwo = 0;
  let secondProfitable = 0;
  let singleTradeDays = 0;
  let singleWinDays = 0;
  let singleLossDays = 0;
  let firstLossTwoTradeDays = 0;
  let firstWinTwoTradeDays = 0;
  let secondWinAfterFirstLoss = 0;

  for (const [, list] of byDay) {
    if (list.length > 2) {
      moreThanTwo++;
      continue;
    }
    if (list.length === 1) {
      singleTradeDays++;
      const o = pnlOutcome(list[0]!);
      if (o === "win") singleWinDays++;
      else if (o === "loss") singleLossDays++;
      continue;
    }
    if (list.length !== 2) continue;
    exactlyTwo++;
    const ordered = list.slice().sort((a, b) => a.entryTime - b.entryTime);
    const a = pnlOutcome(ordered[0]!);
    const b = pnlOutcome(ordered[1]!);
    if (a === "win") firstWinTwoTradeDays++;
    if (a === "loss") {
      firstLossTwoTradeDays++;
      if (b === "win") secondWinAfterFirstLoss++;
    }
    if (a === "unknown" || b === "unknown") {
      categories.unclassified++;
      continue;
    }
    if (a === "breakeven" || b === "breakeven") {
      categories.has_breakeven++;
      continue;
    }
    if (a === "win" && b === "win") categories.both_profit++;
    else if (a === "win" && b === "loss") categories.first_profit_second_loss++;
    else if (a === "loss" && b === "win") categories.first_loss_second_profit++;
    else if (a === "loss" && b === "loss") categories.both_loss++;
    else categories.unclassified++;

    if (b === "win") secondProfitable++;
  }

  const den = exactlyTwo > 0 ? exactlyTwo : null;
  const denFirstLoss = firstLossTwoTradeDays > 0 ? firstLossTwoTradeDays : null;
  return {
    exactlyTwoDays: exactlyTwo,
    moreThanTwoDays: moreThanTwo,
    singleTradeDays,
    singleWinDays,
    singleLossDays,
    firstLossTwoTradeDays,
    firstWinTwoTradeDays,
    categories,
    pctSecondProfitable: den ? (secondProfitable / den) * 100 : null,
    pctBothLosing: den ? (categories.both_loss / den) * 100 : null,
    pctBothProfitable: den ? (categories.both_profit / den) * 100 : null,
    pctSecondWinAfterFirstLoss: denFirstLoss
      ? (secondWinAfterFirstLoss / denFirstLoss) * 100
      : null,
    timezone: timeZone,
  };
}
