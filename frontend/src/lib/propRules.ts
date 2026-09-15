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
  payout?: {
    enabled?: boolean;
    minimumTradingDays?: number;
    minimumPayoutPct?: number;
    payoutIntervalDays?: number;
  };
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
};

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Default empty rules — no fabricated 8/5/10. Unset fields stay undefined. */
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
        rules: { accountSize: size },
      },
    ],
  };
}

export function ensurePropProgram(account: AccountProfile): PropProgramConfig | null {
  if ((account.accountType || "personal") !== "prop") return null;
  if (account.propProgram && account.propProgram.phases?.length) {
    return account.propProgram;
  }
  const size = account.initialBalance || account.balance || 0;
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

  const failed = dailyLossBreached || maxOverallLossBreached;
  const eligibleForPhasePass =
    profitTargetReached && minimumTradingDaysReached && !failed;

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
  };
}
