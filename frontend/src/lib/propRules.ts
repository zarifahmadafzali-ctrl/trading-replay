/**
 * v3.17.6 — Prop Firm RuleSet + Phase engine (pure evaluation only).
 * No automatic phase transitions, failures, or payouts.
 */

import type { AccountProfile } from "./riskModel";

export type PropRuleSet = {
  accountSize: number;
  profitTargetPct?: number;
  dailyLossLimitPct?: number;
  maxOverallLossPct?: number;
  minimumTradingDays?: number;
  consistencyPct?: number;
  leverage?: number;
  newsTradingAllowed?: boolean;
  weekendHoldingAllowed?: boolean;
  /** v3.17.8 — configurable payout schedule (extends legacy interval fields). */
  payout?: import("./payoutSchedule").PayoutSchedule;
};

export type PropPhaseConfig = {
  id: string;
  name: string;
  type: "challenge" | "funded" | "custom";
  rules: PropRuleSet;
};

export type PropProgramConfig = {
  id: string;
  firmName: string;
  programName: string;
  phases: PropPhaseConfig[];
};

export type PropRuleSnapshot = {
  accountType: "prop";
  propFirmName?: string;
  propProgramName?: string;
  propProgramId?: string;
  phaseId?: string;
  phaseName?: string;
  rules: PropRuleSet;
};

export type PropTradeLike = {
  accountId?: string;
  /** Phase id frozen at fill when available. */
  phaseId?: string;
  entryTime: number;
  exitTime?: number;
  /** Currency PnL if known; otherwise optional */
  currencyPnL?: number;
  rMultiple?: number | null;
  actualRiskAmount?: number | null;
  riskAmount?: number | null;
  pnlPoints?: number;
  finalLot?: number | null;
  reason?: string;
};

export type PropRuleEvaluation = {
  profitTargetReached: boolean;
  dailyLossBreached: boolean;
  maxOverallLossBreached: boolean;
  minimumTradingDaysReached: boolean;
  profitTargetProgressPct: number;
  currentProfitPct: number;
  tradingDays: number;
  eligibleForPhasePass: boolean;
  failed: boolean;
  reasons: string[];
  targetProfitCurrency: number | null;
  currentProfitCurrency: number;
  maxDailyLossCurrency: number | null;
  maxOverallLossCurrency: number | null;
  largestWinningTrade: number;
  totalWinningProfit: number;
  actualConsistencyPct: number | null;
  requiredConsistencyPct: number | null;
  consistencyStatus: "PASS" | "FAIL" | "NOT_YET_QUALIFIED" | "NOT_CONFIGURED";
  consistencyPassed: boolean;
  /** Realized PnL for the UTC day of currentTime (same-day aggregate). */
  todayRealizedPnL: number;
  /** |today loss| as % of reference when todayRealizedPnL is negative; else 0. */
  todayLossPct: number;
  dailyLossLimitPct: number | null;
};

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Default empty rules — no fabricated 8/5/10. Unset fields stay undefined. */

/** Deep-clone a PropRuleSet (nested payout included). */
export function clonePropRules(rules: PropRuleSet): PropRuleSet {
  const next: PropRuleSet = { ...rules };
  if (rules.payout) {
    next.payout = { ...rules.payout };
  }
  return next;
}

/** Deep-clone a phase (independent rules object). */
export function clonePropPhase(phase: PropPhaseConfig): PropPhaseConfig {
  return {
    ...phase,
    rules: clonePropRules(phase.rules || emptyPropRules(0)),
  };
}

/** Deep-clone full program so phases never share nested rule references. */
export function clonePropProgram(prog: PropProgramConfig): PropProgramConfig {
  return {
    ...prog,
    phases: (prog.phases || []).map((ph) => clonePropPhase(ph)),
  };
}

/**
 * Normalize program on load/edit: deep-clone every phase rules object.
 * Ensures legacy sessions cannot share mutable nested references.
 */
export function normalizePropProgram(prog: PropProgramConfig | null | undefined, fallbackSize = 0): PropProgramConfig {
  if (!prog || !prog.phases?.length) {
    return defaultPropProgram(fallbackSize > 0 ? fallbackSize : 5000);
  }
  return clonePropProgram({
    ...prog,
    id: prog.id || uid("prog"),
    firmName: prog.firmName || "",
    programName: prog.programName || "",
    phases: prog.phases.map((ph, i) => ({
      id: ph.id || uid("phase"),
      name: ph.name || `Phase ${i + 1}`,
      type: ph.type || (i === 0 ? "challenge" : ph.type) || "challenge",
      rules: clonePropRules({
        accountSize:
          ph.rules?.accountSize != null && Number.isFinite(ph.rules.accountSize) && ph.rules.accountSize > 0
            ? ph.rules.accountSize
            : fallbackSize > 0
              ? fallbackSize
              : 5000,
        profitTargetPct: ph.rules?.profitTargetPct,
        dailyLossLimitPct: ph.rules?.dailyLossLimitPct,
        maxOverallLossPct: ph.rules?.maxOverallLossPct,
        minimumTradingDays: ph.rules?.minimumTradingDays,
        consistencyPct: ph.rules?.consistencyPct,
        leverage: ph.rules?.leverage,
        payout: ph.rules?.payout ? { ...ph.rules.payout } : undefined,
      }),
    })),
  });
}

/** Create a new independent challenge/funded phase (never shares rules refs). */
export function createIndependentPhase(
  index: number,
  accountSize: number,
  type?: "challenge" | "funded" | "custom"
): PropPhaseConfig {
  const n = Math.max(1, index);
  const phaseType = type || (n > 2 ? "funded" : "challenge");
  return {
    id: uid("phase"),
    name: phaseType === "funded" ? "Funded" : `Phase ${n}`,
    type: phaseType,
    rules: emptyPropRules(accountSize > 0 ? accountSize : 5000),
  };
}

export function emptyPropRules(accountSize = 0): PropRuleSet {
  return { accountSize: Math.max(0, accountSize) };
}

export function defaultPropProgram(accountSize = 5000): PropProgramConfig {
  const size = accountSize > 0 ? accountSize : 5000;
  return {
    id: uid("prog"),
    firmName: "",
    programName: "",
    phases: [
      {
        id: uid("phase"),
        name: "Phase 1",
        type: "challenge",
        rules: emptyPropRules(size),
      },
    ],
  };
}

export function ensurePropProgram(account: AccountProfile): PropProgramConfig | null {
  if ((account.accountType || "personal") !== "prop") return null;
  const size = account.initialBalance || account.balance || 0;
  if (account.propProgram && account.propProgram.phases?.length) {
    // Always return a deep-cloned normalized copy so callers never mutate shared refs
    const cloned = normalizePropProgram(account.propProgram, size);
    if (account.propFirmName && !cloned.firmName) cloned.firmName = account.propFirmName;
    if (account.propProgramName && !cloned.programName) cloned.programName = account.propProgramName;
    return cloned;
  }
  const prog = defaultPropProgram(size);
  if (account.propFirmName) prog.firmName = account.propFirmName;
  if (account.propProgramName) prog.programName = account.propProgramName;
  return prog;
}

export function getActivePropPhase(account: AccountProfile): PropPhaseConfig | null {
  const prog = ensurePropProgram(account);
  if (!prog?.phases?.length) return null;
  const id = account.activePropPhaseId;
  if (id) {
    const found = prog.phases.find((p) => p.id === id);
    if (found) return found;
  }
  return prog.phases[0];
}

export function getActivePropRules(account: AccountProfile): PropRuleSet | null {
  const phase = getActivePropPhase(account);
  return phase?.rules ?? null;
}

export function getPropPhase(account: AccountProfile, phaseId: string): PropPhaseConfig | null {
  const prog = ensurePropProgram(account);
  return prog?.phases?.find((p) => p.id === phaseId) ?? null;
}

/** Effective leverage: phase rules override account leverage when set. */
export function getEffectiveLeverage(account: AccountProfile): number {
  const rules = getActivePropRules(account);
  if (rules?.leverage != null && rules.leverage >= 1) return rules.leverage;
  return Math.max(1, account.leverage || 1);
}

export function buildPropRuleSnapshot(account: AccountProfile): PropRuleSnapshot | null {
  if ((account.accountType || "personal") !== "prop") return null;
  const prog = ensurePropProgram(account);
  const phase = getActivePropPhase(account);
  if (!phase) return null;
  return {
    accountType: "prop",
    propFirmName: prog?.firmName || account.propFirmName,
    propProgramName: prog?.programName || account.propProgramName,
    propProgramId: prog?.id || account.propProgramId,
    phaseId: phase.id,
    phaseName: phase.name,
    rules: { ...phase.rules },
  };
}

/** Unix seconds (normalize ms). */
export function toUnixSec(t: number): number {
  return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
}

/** UTC calendar day key YYYY-MM-DD from unix seconds. */
export function utcDayKey(unixSec: number): string {
  const d = new Date(toUnixSec(unixSec) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function countTradingDays(trades: PropTradeLike[], accountId?: string): number {
  const days = new Set<string>();
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    // Count filled/closed trades only (must have exit or explicit fill time = entry)
    const ts = t.exitTime ?? t.entryTime;
    if (ts == null || !Number.isFinite(ts)) continue;
    days.add(utcDayKey(ts));
  }
  return days.size;
}

export function sumCurrencyPnL(trades: PropTradeLike[], accountId?: string): number {
  let sum = 0;
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    if (t.currencyPnL != null && Number.isFinite(t.currencyPnL)) {
      sum += t.currencyPnL;
      continue;
    }
    if (
      t.rMultiple != null &&
      Number.isFinite(t.rMultiple) &&
      t.actualRiskAmount != null &&
      Number.isFinite(t.actualRiskAmount)
    ) {
      sum += t.rMultiple * t.actualRiskAmount;
    }
  }
  return sum;
}

/** Realized PnL for a specific UTC day (uses exit time). */
export function dayRealizedPnL(
  trades: PropTradeLike[],
  dayKey: string,
  accountId?: string
): number {
  let sum = 0;
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    if (t.exitTime == null) continue;
    if (utcDayKey(t.exitTime) !== dayKey) continue;
    if (t.currencyPnL != null && Number.isFinite(t.currencyPnL)) {
      sum += t.currencyPnL;
      continue;
    }
    if (
      t.rMultiple != null &&
      Number.isFinite(t.rMultiple) &&
      t.actualRiskAmount != null &&
      Number.isFinite(t.actualRiskAmount)
    ) {
      sum += t.rMultiple * t.actualRiskAmount;
    }
  }
  return sum;
}

export type PropProgressState = {
  account: AccountProfile;
  trades: PropTradeLike[];
  /** Replay simulation time (unix sec or ms) — NOT Date.now() */
  currentTime: number;
  /** Unrealized open PnL in currency for this account */
  unrealizedPnL?: number;
};

export function calculatePropProgress(state: PropProgressState): {
  rules: PropRuleSet | null;
  phase: PropPhaseConfig | null;
  referenceBalance: number;
  realizedPnL: number;
  currentProfitPct: number;
  profitTargetProgressPct: number;
  targetProfitCurrency: number | null;
  tradingDays: number;
  todayKey: string;
  todayRealizedPnL: number;
} {
  const phase = getActivePropPhase(state.account);
  const rules = phase?.rules ?? null;
  const referenceBalance =
    rules?.accountSize && rules.accountSize > 0
      ? rules.accountSize
      : state.account.initialBalance || state.account.balance || 0;
  const realizedPnL = sumCurrencyPnL(state.trades, state.account.accountId);
  const currentProfitPct =
    referenceBalance > 0 ? (realizedPnL / referenceBalance) * 100 : 0;
  const targetPct = rules?.profitTargetPct;
  const targetProfitCurrency =
    targetPct != null && referenceBalance > 0 ? (referenceBalance * targetPct) / 100 : null;
  const profitTargetProgressPct =
    targetProfitCurrency != null && targetProfitCurrency > 0
      ? Math.max(0, (realizedPnL / targetProfitCurrency) * 100)
      : 0;
  const todayKey = utcDayKey(state.currentTime);
  const todayRealizedPnL = dayRealizedPnL(state.trades, todayKey, state.account.accountId);
  const tradingDays = countTradingDays(state.trades, state.account.accountId);
  return {
    rules,
    phase,
    referenceBalance,
    realizedPnL,
    currentProfitPct,
    profitTargetProgressPct,
    targetProfitCurrency,
    tradingDays,
    todayKey,
    todayRealizedPnL,
  };
}

export function isProfitTargetReached(
  referenceBalance: number,
  realizedPnL: number,
  profitTargetPct?: number
): boolean {
  if (profitTargetPct == null || !(referenceBalance > 0)) return false;
  const target = (referenceBalance * profitTargetPct) / 100;
  return realizedPnL >= target - 1e-9;
}

export function isDailyLossBreached(
  referenceBalance: number,
  dayPnL: number,
  unrealizedPnL: number,
  dailyLossLimitPct?: number
): boolean {
  if (dailyLossLimitPct == null || !(referenceBalance > 0)) return false;
  const limit = (referenceBalance * dailyLossLimitPct) / 100;
  // Breach when day's combined realized+unrealized loss exceeds limit
  const dayTotal = dayPnL + unrealizedPnL;
  return dayTotal <= -limit + 1e-9;
}

export function isOverallLossBreached(
  referenceBalance: number,
  equityDelta: number,
  maxOverallLossPct?: number
): boolean {
  if (maxOverallLossPct == null || !(referenceBalance > 0)) return false;
  const limit = (referenceBalance * maxOverallLossPct) / 100;
  // equityDelta = current equity - reference (negative when down)
  return equityDelta <= -limit + 1e-9;
}

export function hasMinimumTradingDays(tradingDays: number, minimum?: number): boolean {
  if (minimum == null) return true;
  return tradingDays >= minimum;
}

/**
 * Consistency: largestWinningTrade / totalWinningProfit × 100.
 * PASS when actual <= required consistencyPct.
 */
export function calculateConsistencyMetric(
  trades: PropTradeLike[],
  accountId: string | undefined,
  requiredConsistencyPct?: number
): {
  largestWinningTrade: number;
  totalWinningProfit: number;
  actualConsistencyPct: number | null;
  requiredConsistencyPct: number | null;
  consistencyStatus: "PASS" | "FAIL" | "NOT_YET_QUALIFIED" | "NOT_CONFIGURED";
  consistencyPassed: boolean;
} {
  let largest = 0;
  let totalWin = 0;
  for (const tr of trades) {
    if (accountId && tr.accountId && tr.accountId !== accountId) continue;
    let pnl = 0;
    if (tr.currencyPnL != null && Number.isFinite(tr.currencyPnL)) pnl = tr.currencyPnL;
    else if (
      tr.rMultiple != null &&
      Number.isFinite(tr.rMultiple) &&
      tr.actualRiskAmount != null &&
      Number.isFinite(tr.actualRiskAmount)
    ) {
      pnl = tr.rMultiple * tr.actualRiskAmount;
    }
    if (pnl > 0) {
      totalWin += pnl;
      if (pnl > largest) largest = pnl;
    }
  }
  const required =
    requiredConsistencyPct != null && Number.isFinite(requiredConsistencyPct)
      ? requiredConsistencyPct
      : null;
  if (required == null) {
    return {
      largestWinningTrade: largest,
      totalWinningProfit: totalWin,
      actualConsistencyPct: totalWin > 0 ? (largest / totalWin) * 100 : null,
      requiredConsistencyPct: null,
      consistencyStatus: "NOT_CONFIGURED",
      consistencyPassed: true,
    };
  }
  if (!(totalWin > 0)) {
    return {
      largestWinningTrade: largest,
      totalWinningProfit: totalWin,
      actualConsistencyPct: null,
      requiredConsistencyPct: required,
      consistencyStatus: "NOT_YET_QUALIFIED",
      consistencyPassed: false,
    };
  }
  const actual = (largest / totalWin) * 100;
  const pass = actual <= required + 1e-9;
  return {
    largestWinningTrade: largest,
    totalWinningProfit: totalWin,
    actualConsistencyPct: actual,
    requiredConsistencyPct: required,
    consistencyStatus: pass ? "PASS" : "FAIL",
    consistencyPassed: pass,
  };
}


/**
 * Phase-scoped trades for evaluation.
 * Prefer explicit phaseId on trade; else use lifecycle event windows.
 * Funded evaluation: only trades at/after FUNDED event.
 */
export function filterTradesForPhaseWindow(
  trades: PropTradeLike[],
  accountId: string | undefined,
  phaseId: string | undefined,
  events: { type: string; phaseId?: string; timestamp: number }[] | undefined,
  replayTime: number,
  mode: "phase" | "funded" = "phase"
): PropTradeLike[] {
  const t = toUnixSec(replayTime);
  const seq = (events || [])
    .filter((e) => toUnixSec(e.timestamp) <= t)
    .sort((a, b) => toUnixSec(a.timestamp) - toUnixSec(b.timestamp));

  let windowStart = 0;
  let windowEnd = t;

  if (mode === "funded") {
    const fundedEv = [...seq].reverse().find((e) => e.type === "FUNDED");
    if (!fundedEv) return [];
    windowStart = toUnixSec(fundedEv.timestamp);
    windowEnd = t;
  } else if (phaseId) {
    const started = [...seq].reverse().find((e) => e.type === "PHASE_STARTED" && e.phaseId === phaseId);
    const passed = seq.find((e) => e.type === "PHASE_PASSED" && e.phaseId === phaseId);
    // First phase may have no PHASE_STARTED — use 0
    windowStart = started ? toUnixSec(started.timestamp) : 0;
    windowEnd = passed ? toUnixSec(passed.timestamp) : t;
  }

  return trades.filter((tr) => {
    if (accountId && tr.accountId && tr.accountId !== accountId) return false;
    const exit = tr.exitTime != null ? toUnixSec(tr.exitTime) : null;
    if (exit == null || !Number.isFinite(exit)) return false;
    if (exit > windowEnd || exit < windowStart) return false;
    // If trade carries phaseId, enforce match for phase mode
    if (mode === "phase" && phaseId && tr.phaseId && tr.phaseId !== phaseId) return false;
    if (mode === "funded" && tr.phaseId && tr.phaseId !== "funded") {
      // still allow trades without phaseId if inside funded window
    }
    return true;
  });
}

/** Evaluation only — no mutations. */
export function evaluatePropRules(state: PropProgressState): PropRuleEvaluation {
  const progress = calculatePropProgress(state);
  const rules = progress.rules;
  const unrealized = state.unrealizedPnL ?? 0;
  const reasons: string[] = [];

  if (!rules) {
    return {
      profitTargetReached: false,
      dailyLossBreached: false,
      maxOverallLossBreached: false,
      minimumTradingDaysReached: false,
      profitTargetProgressPct: 0,
      currentProfitPct: 0,
      tradingDays: 0,
      eligibleForPhasePass: false,
      failed: false,
      reasons: ["No Prop rules configured"],
      targetProfitCurrency: null,
      currentProfitCurrency: 0,
      maxDailyLossCurrency: null,
      maxOverallLossCurrency: null,
      largestWinningTrade: 0,
      totalWinningProfit: 0,
      actualConsistencyPct: null,
      requiredConsistencyPct: null,
      consistencyStatus: "NOT_CONFIGURED",
      consistencyPassed: true,
      todayRealizedPnL: 0,
      todayLossPct: 0,
      dailyLossLimitPct: null,
    };
  }

  const ref = progress.referenceBalance;
  const realized = progress.realizedPnL;
  const equityDelta = realized + unrealized;

  const profitTargetReached = isProfitTargetReached(ref, realized, rules.profitTargetPct);
  const dailyLossBreached = isDailyLossBreached(
    ref,
    progress.todayRealizedPnL,
    unrealized,
    rules.dailyLossLimitPct
  );
  const maxOverallLossBreached = isOverallLossBreached(
    ref,
    equityDelta,
    rules.maxOverallLossPct
  );
  const minimumTradingDaysReached = hasMinimumTradingDays(
    progress.tradingDays,
    rules.minimumTradingDays
  );

  if (dailyLossBreached) reasons.push("Daily loss limit breached");
  if (maxOverallLossBreached) reasons.push("Max overall loss breached");
  if (profitTargetReached) reasons.push("Profit target reached");
  if (minimumTradingDaysReached && rules.minimumTradingDays != null) {
    reasons.push(`Minimum trading days met (${progress.tradingDays})`);
  }

  const consistency = calculateConsistencyMetric(
    state.trades,
    state.account.accountId,
    rules.consistencyPct
  );
  if (consistency.consistencyStatus === "FAIL") {
    reasons.push(
      `Consistency failed (${consistency.actualConsistencyPct?.toFixed(1)}% > ${consistency.requiredConsistencyPct}%)`
    );
  }
  if (consistency.consistencyStatus === "PASS") {
    reasons.push(
      `Consistency met (${consistency.actualConsistencyPct?.toFixed(1)}% ≤ ${consistency.requiredConsistencyPct}%)`
    );
  }

  const failed = dailyLossBreached || maxOverallLossBreached;
  const eligibleForPhasePass =
    profitTargetReached &&
    minimumTradingDaysReached &&
    !failed &&
    consistency.consistencyPassed;

  return {
    profitTargetReached,
    dailyLossBreached,
    maxOverallLossBreached,
    minimumTradingDaysReached,
    profitTargetProgressPct: progress.profitTargetProgressPct,
    currentProfitPct: progress.currentProfitPct,
    tradingDays: progress.tradingDays,
    eligibleForPhasePass,
    failed,
    reasons,
    targetProfitCurrency: progress.targetProfitCurrency,
    currentProfitCurrency: realized,
    maxDailyLossCurrency:
      rules.dailyLossLimitPct != null && ref > 0
        ? (ref * rules.dailyLossLimitPct) / 100
        : null,
    maxOverallLossCurrency:
      rules.maxOverallLossPct != null && ref > 0
        ? (ref * rules.maxOverallLossPct) / 100
        : null,
    largestWinningTrade: consistency.largestWinningTrade,
    totalWinningProfit: consistency.totalWinningProfit,
    actualConsistencyPct: consistency.actualConsistencyPct,
    requiredConsistencyPct: consistency.requiredConsistencyPct,
    consistencyStatus: consistency.consistencyStatus,
    consistencyPassed: consistency.consistencyPassed,
    todayRealizedPnL: progress.todayRealizedPnL,
    todayLossPct:
      progress.todayRealizedPnL < 0 && ref > 0
        ? (Math.abs(progress.todayRealizedPnL) / ref) * 100
        : 0,
    dailyLossLimitPct: rules.dailyLossLimitPct ?? null,
  };
}
