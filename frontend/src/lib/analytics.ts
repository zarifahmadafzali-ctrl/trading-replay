import { currencyPnLFromTradeFields } from "./riskModel";
/**
 * v3.17.0 — Professional analytics from closed Journal trades only.
 * Pure functions; no market-data dependency. Prop-firm hooks left for v3.18.
 */
import type { JournalTrade, CloseReason } from "./journal";

export type AnalyticsFilters = {
  sessionId?: string | "all" | null;
  accountId?: string | "all" | null;
  symbol?: string | "all" | null;
  /** inclusive unix seconds or ms — normalized internally */
  fromTime?: number | null;
  toTime?: number | null;
  /** v3.24.0 — same dimensions as Journal list filters */
  side?: "long" | "short" | "all" | null;
  orderType?: string | "all" | null;
  reason?: string | "all" | null;
  /** win | loss | breakeven based on tradeOutcome */
  result?: "win" | "loss" | "breakeven" | "all" | null;
};

export type EquityPoint = {
  time: number;
  equity: number;
  balance: number;
  tradeId: string;
  pnl: number;
  r: number | null;
};

export type AnalyticsSummary = {
  startingBalance: number;
  endingBalance: number;
  netPnl: number;
  returnPercent: number | null;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  averageR: number | null;
  totalR: number | null;
  medianR: number | null;
  maxR: number | null;
  minR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyR: number | null;
  expectancyCurrency: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number | null;
  recoveryFactor: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  currentWinStreak: number;
  currentLossStreak: number;
  avgDurationSec: number | null;
  medianDurationSec: number | null;
  minDurationSec: number | null;
  maxDurationSec: number | null;
  /** v3.24.0 currency averages (null when no samples) */
  avgWinCurrency: number | null;
  avgLossCurrency: number | null;
};

export type BreakdownRow = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  netPnl: number;
  totalR: number | null;
  averageR: number | null;
};

export type TimeBucket = {
  key: string;
  trades: number;
  netPnl: number;
  winRate: number | null;
  totalR: number | null;
  averageR: number | null;
};

export type SessionCompareRow = {
  sessionId: string;
  sessionName: string;
  account: string;
  symbol: string;
  trades: number;
  winRate: number | null;
  netPnl: number;
  totalR: number | null;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  expectancyR: number | null;
};

function toSec(t: number): number {
  // Journal uses unix seconds for entry/exit (chart time)
  return t > 1e12 ? Math.floor(t / 1000) : t;
}

/** Closed trades only (Journal is already closed-only). */
export function filterTrades(
  trades: JournalTrade[],
  filters: AnalyticsFilters
): JournalTrade[] {
  return trades.filter((t) => {
    if (!t.exitTime || t.entryTime == null) return false;
    if (filters.sessionId && filters.sessionId !== "all") {
      if ((t.sessionId || "") !== filters.sessionId) return false;
    }
    if (filters.accountId && filters.accountId !== "all") {
      if ((t.accountId || "") !== filters.accountId) return false;
    }
    if (filters.symbol && filters.symbol !== "all") {
      if ((t.symbol || "").toUpperCase() !== filters.symbol.toUpperCase()) return false;
    }
    const xt = toSec(t.exitTime);
    if (filters.fromTime != null && xt < toSec(filters.fromTime)) return false;
    if (filters.toTime != null && xt > toSec(filters.toTime)) return false;
    if (filters.side && filters.side !== "all") {
      if (t.side !== filters.side) return false;
    }
    if (filters.orderType && filters.orderType !== "all") {
      if ((t.orderType || "") !== filters.orderType) return false;
    }
    if (filters.reason && filters.reason !== "all") {
      if ((t.reason || "") !== filters.reason) return false;
    }
    if (filters.result && filters.result !== "all") {
      if (tradeOutcome(t) !== filters.result) return false;
    }
    return true;
  });
}

/** Chronological by exit time, then entry, then id. */
export function sortClosedChronological(trades: JournalTrade[]): JournalTrade[] {
  return [...trades].sort((a, b) => {
    const ae = toSec(a.exitTime);
    const be = toSec(b.exitTime);
    if (ae !== be) return ae - be;
    const ai = toSec(a.entryTime);
    const bi = toSec(b.entryTime);
    if (ai !== bi) return ai - bi;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export function tradeOutcome(t: JournalTrade): "win" | "loss" | "breakeven" {
  if (t.rMultiple != null) {
    if (t.rMultiple > 1e-9) return "win";
    if (t.rMultiple < -1e-9) return "loss";
    return "breakeven";
  }
  if (t.pnlPoints > 1e-9) return "win";
  if (t.pnlPoints < -1e-9) return "loss";
  return "breakeven";
}

/** Monetary P&L from frozen trade fields — never from live account settings. */
export function tradePnLCurrency(t: JournalTrade): number {
  const snap = t.snapshot as Record<string, unknown> | undefined;
  const pv =
    typeof snap?.pointValue === "number"
      ? snap.pointValue
      : typeof t.snapshot === "object" && t.snapshot && "pointValue" in (t.snapshot as object)
        ? Number((t.snapshot as any).pointValue)
        : null;
  return currencyPnLFromTradeFields({
    rMultiple: t.rMultiple,
    actualRiskAmount: t.actualRiskAmount,
    riskAmount: t.riskAmount,
    pnlPoints: t.pnlPoints,
    finalLot: t.finalLot,
    riskBasedLot: t.riskBasedLot,
    pointValue: pv,
  });
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function safeDiv(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-12) return null;
  const v = a / b;
  return Number.isFinite(v) ? v : null;
}

export function buildEquityCurve(
  trades: JournalTrade[],
  startingBalance: number
): EquityPoint[] {
  const sorted = sortClosedChronological(trades);
  let equity = startingBalance;
  const points: EquityPoint[] = [
    {
      time: sorted[0] ? toSec(sorted[0].entryTime) : 0,
      equity: startingBalance,
      balance: startingBalance,
      tradeId: "",
      pnl: 0,
      r: null,
    },
  ];
  for (const t of sorted) {
    const pnl = tradePnLCurrency(t);
    equity += pnl;
    points.push({
      time: toSec(t.exitTime),
      equity,
      balance: equity,
      tradeId: t.id,
      pnl,
      r: t.rMultiple,
    });
  }
  return points;
}

export function maxDrawdownFromCurve(points: EquityPoint[]): {
  maxDrawdown: number;
  maxDrawdownPercent: number | null;
  peak: number;
} {
  let peak = points[0]?.equity ?? 0;
  let maxDd = 0;
  let maxDdPct: number | null = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    const dd = p.equity - peak; // <= 0
    if (dd < maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? dd / peak : null;
    }
  }
  return {
    maxDrawdown: maxDd,
    maxDrawdownPercent: maxDdPct,
    peak,
  };
}

export function computeStreaks(trades: JournalTrade[]): {
  maxWinStreak: number;
  maxLossStreak: number;
  currentWinStreak: number;
  currentLossStreak: number;
} {
  const sorted = sortClosedChronological(trades);
  let maxW = 0,
    maxL = 0,
    curW = 0,
    curL = 0;
  for (const t of sorted) {
    const o = tradeOutcome(t);
    if (o === "win") {
      curW += 1;
      curL = 0;
      maxW = Math.max(maxW, curW);
    } else if (o === "loss") {
      curL += 1;
      curW = 0;
      maxL = Math.max(maxL, curL);
    } else {
      curW = 0;
      curL = 0;
    }
  }
  return {
    maxWinStreak: maxW,
    maxLossStreak: maxL,
    currentWinStreak: curW,
    currentLossStreak: curL,
  };
}

export function computeSummary(
  trades: JournalTrade[],
  startingBalance: number
): AnalyticsSummary {
  const sorted = sortClosedChronological(trades);
  let wins = 0,
    losses = 0,
    be = 0;
  let grossProfit = 0,
    grossLoss = 0;
  const rs: number[] = [];
  const winRs: number[] = [];
  const lossRs: number[] = [];
  const durs: number[] = [];

  for (const t of sorted) {
    const o = tradeOutcome(t);
    const pnl = tradePnLCurrency(t);
    if (o === "win") {
      wins += 1;
      grossProfit += Math.max(0, pnl);
    } else if (o === "loss") {
      losses += 1;
      grossLoss += Math.min(0, pnl);
    } else {
      be += 1;
    }
    if (t.rMultiple != null && Number.isFinite(t.rMultiple)) {
      rs.push(t.rMultiple);
      if (o === "win") winRs.push(t.rMultiple);
      if (o === "loss") lossRs.push(t.rMultiple);
    }
    const dur =
      t.durationSeconds != null
        ? t.durationSeconds
        : Math.max(0, toSec(t.exitTime) - toSec(t.entryTime));
    if (Number.isFinite(dur)) durs.push(dur);
  }

  const total = sorted.length;
  const totalR = rs.length ? rs.reduce((a, b) => a + b, 0) : null;
  const averageR = rs.length ? totalR! / rs.length : null;
  const avgWinR = winRs.length ? winRs.reduce((a, b) => a + b, 0) / winRs.length : null;
  const avgLossR = lossRs.length ? lossRs.reduce((a, b) => a + b, 0) / lossRs.length : null;
  const winRate = total > 0 ? wins / total : null;
  const lossRate = total > 0 ? losses / total : null;
  // R expectancy only when at least one trade has finite R (do not invent 0R).
  const expectancyR =
    rs.length > 0 && winRate != null && lossRate != null
      ? (winRate * (avgWinR ?? 0)) + (lossRate * (avgLossR ?? 0))
      : null;

  const winPnls: number[] = [];
  const lossPnls: number[] = [];
  for (const t of sorted) {
    const o = tradeOutcome(t);
    const pnl = tradePnLCurrency(t);
    if (o === "win") winPnls.push(pnl);
    else if (o === "loss") lossPnls.push(pnl);
  }
  const avgWinCurrency = winPnls.length
    ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length
    : null;
  const avgLossCurrency = lossPnls.length
    ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length
    : null;

  const curve = buildEquityCurve(sorted, startingBalance);
  const ending = curve.length ? curve[curve.length - 1].equity : startingBalance;
  const netPnl = ending - startingBalance;
  const { maxDrawdown, maxDrawdownPercent } = maxDrawdownFromCurve(curve);
  const streaks = computeStreaks(sorted);

  const pf = safeDiv(grossProfit, Math.abs(grossLoss));
  const recovery = safeDiv(netPnl, Math.abs(maxDrawdown));

  return {
    startingBalance,
    endingBalance: ending,
    netPnl,
    returnPercent: startingBalance !== 0 ? netPnl / startingBalance : null,
    grossProfit,
    grossLoss,
    profitFactor: pf,
    totalTrades: total,
    wins,
    losses,
    breakeven: be,
    winRate,
    averageR,
    totalR,
    medianR: median(rs),
    maxR: rs.length ? Math.max(...rs) : null,
    minR: rs.length ? Math.min(...rs) : null,
    avgWinR,
    avgLossR,
    expectancyR,
    expectancyCurrency:
      expectancyR != null && sorted[0]?.actualRiskAmount != null
        ? expectancyR * (sorted[0].actualRiskAmount || 0)
        : expectancyR != null && sorted[0]?.riskAmount != null
          ? expectancyR * (sorted[0].riskAmount || 0)
          : netPnl !== 0 && total > 0
            ? netPnl / total
            : null,
    maxDrawdown,
    maxDrawdownPercent,
    recoveryFactor: recovery,
    maxWinStreak: streaks.maxWinStreak,
    maxLossStreak: streaks.maxLossStreak,
    currentWinStreak: streaks.currentWinStreak,
    currentLossStreak: streaks.currentLossStreak,
    avgDurationSec: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
    medianDurationSec: median(durs),
    minDurationSec: durs.length ? Math.min(...durs) : null,
    maxDurationSec: durs.length ? Math.max(...durs) : null,
    avgWinCurrency,
    avgLossCurrency,
  };
}

export function rDistribution(trades: JournalTrade[], bucketSize = 0.5): { bucket: string; count: number }[] {
  const map = new Map<string, number>();
  for (const t of trades) {
    if (t.rMultiple == null || !Number.isFinite(t.rMultiple)) continue;
    const b = Math.floor(t.rMultiple / bucketSize) * bucketSize;
    const key = `${b.toFixed(1)}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => parseFloat(a.bucket) - parseFloat(b.bucket));
}

function groupBy(
  trades: JournalTrade[],
  keyFn: (t: JournalTrade) => string
): BreakdownRow[] {
  const groups = new Map<string, JournalTrade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const rows: BreakdownRow[] = [];
  for (const [key, list] of groups) {
    const s = computeSummary(list, 0);
    rows.push({
      key,
      trades: s.totalTrades,
      wins: s.wins,
      losses: s.losses,
      breakeven: s.breakeven,
      winRate: s.winRate,
      netPnl: s.netPnl,
      totalR: s.totalR,
      averageR: s.averageR,
    });
  }
  return rows.sort((a, b) => b.trades - a.trades);
}

export function breakdownByDirection(trades: JournalTrade[]) {
  return groupBy(trades, (t) => t.side);
}
export function breakdownByOrderType(trades: JournalTrade[]) {
  return groupBy(trades, (t) => t.orderType || "unknown");
}
export function breakdownByExitReason(trades: JournalTrade[]) {
  return groupBy(trades, (t) => t.reason || "unknown");
}
export function breakdownBySymbol(trades: JournalTrade[]) {
  return groupBy(trades, (t) => t.symbol || "—");
}
export function breakdownByAccount(trades: JournalTrade[]) {
  return groupBy(trades, (t) => t.accountId || "—");
}

export function timeAnalysis(
  trades: JournalTrade[],
  mode: "dow" | "hour" | "day" | "week" | "month"
): TimeBucket[] {
  const groups = new Map<string, JournalTrade[]>();
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const t of trades) {
    const d = new Date(toSec(t.exitTime) * 1000);
    let key = "";
    if (mode === "dow") key = dowNames[d.getUTCDay()];
    else if (mode === "hour") key = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
    else if (mode === "day") key = d.toISOString().slice(0, 10);
    else if (mode === "month") key = d.toISOString().slice(0, 7);
    else {
      // ISO week
      const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dayNum = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      key = `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const rows: TimeBucket[] = [];
  for (const [key, list] of groups) {
    const s = computeSummary(list, 0);
    rows.push({
      key,
      trades: s.totalTrades,
      netPnl: s.netPnl,
      winRate: s.winRate,
      totalR: s.totalR,
      averageR: s.averageR,
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** Format duration for UI */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(2)}d`;
}

export function formatPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

/** Prop firm foundation — structure only for v3.18 */
export type PropFirmAnalyticsInput = {
  accountSize: number;
  profitTargetPercent: number;
  dailyDdPercent: number;
  overallDdPercent: number;
  minTradingDays: number;
  maxTradingDays?: number | null;
  consistencyRulePercent?: number | null;
  profitCapPercent?: number | null;
  trailingDrawdownPercent?: number | null;
  staticDrawdownPercent?: number | null;
};

export function propFirmReadyMetrics(
  summary: AnalyticsSummary,
  _cfg?: PropFirmAnalyticsInput
): {
  netPnl: number;
  maxDrawdown: number;
  maxDrawdownPercent: number | null;
  tradingDaysEstimate: number;
  readyForRules: true;
} {
  return {
    netPnl: summary.netPnl,
    maxDrawdown: summary.maxDrawdown,
    maxDrawdownPercent: summary.maxDrawdownPercent,
    tradingDaysEstimate: summary.totalTrades, // placeholder until day grouping in v3.18
    readyForRules: true,
  };
}
