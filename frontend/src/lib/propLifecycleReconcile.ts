/**
 * v3.19.3 — Prop lifecycle + balance consistency.
 *
 * Authoritative model:
 * - Journal trades = historical trading record (immutable)
 * - Current Prop RuleSets = evaluation of challenge/funded progression
 * - Lifecycle events = derived history (may be superseded; never override Journal + rules)
 * - AccountProfile.balance = simulated working equity for the *current* lifecycle state
 *   = phase/funded baseline (accountSize) + realized PnL of trades in that window only
 *
 * Phase 1 profit does NOT become Phase 2 or FUNDED starting equity.
 * Same accountId across Phase 1 → Phase 2 → FUNDED.
 */

import type { AccountProfile } from "./riskModel";
import {
  evaluatePropRules,
  ensurePropProgram,
  toUnixSec,
  filterTradesForPhaseWindow,
  sumCurrencyPnL,
  type PropTradeLike,
} from "./propRules";
import {
  deriveLifecycleFromEvents,
  makeLifecycleEvent,
  type LifecycleEvent,
  type LifecycleState,
} from "./accountLifecycle";

/** Bump when challenge evaluation / balance semantics change. */
export const PROP_LIFECYCLE_RULES_VERSION = 3;

export type PhaseEvalSummary = {
  phaseId: string;
  phaseName: string;
  phaseType: string;
  tradingDays: number;
  requiredTradingDays: number | null;
  minimumTradingDaysPassed: boolean;
  profitPct: number;
  targetPct: number | null;
  realizedPnL: number;
  referenceBalance: number;
  eligibleForPass: boolean;
  failed: boolean;
  reasons: string[];
  tradeCount: number;
};

export type BalanceCalcResult = {
  /** Fully determined expected working balance, or null if insufficient trade PnL data. */
  expectedBalance: number | null;
  baseline: number;
  windowPnL: number | null;
  includedTradeCount: number;
  excludedTradeCount: number;
  excludedReasons: string[];
  state: LifecycleState;
  activePhaseId?: string;
  calculable: boolean;
  note: string;
};

export type ReconciliationReport = {
  accountId: string;
  storedState: LifecycleState;
  storedActivePhaseId?: string;
  reconciledState: LifecycleState;
  reconciledActivePhaseId?: string;
  shouldBeFunded: boolean;
  phaseResults: PhaseEvalSummary[];
  differences: string[];
  nextLifecycleEvents: LifecycleEvent[];
  supersededCount: number;
  needsReconciliation: boolean;
  balanceNote: string;
  rulesVersion: number;
  /** v3.19.3 */
  storedBalance: number;
  expectedBalance: number | null;
  balanceDifference: number | null;
  balanceCalculable: boolean;
  balanceCalc: BalanceCalcResult;
};

function challengePhases(account: AccountProfile) {
  const prog = ensurePropProgram(account);
  const phases = prog?.phases || [];
  const challenge = phases.filter((p) => p.type !== "funded");
  return challenge.length ? challenge : phases;
}

function phaseAccountSize(account: AccountProfile, phaseId?: string): number {
  const prog = ensurePropProgram(account);
  const phases = prog?.phases || [];
  const ph = phaseId ? phases.find((p) => p.id === phaseId) : null;
  const size = ph?.rules?.accountSize;
  if (size != null && Number.isFinite(size) && size > 0) return size;
  if (account.initialBalance != null && account.initialBalance > 0) return account.initialBalance;
  if (account.balance != null && Number.isFinite(account.balance) && account.balance > 0) {
    return account.balance;
  }
  return 0;
}

function tradeHasUsablePnL(tr: PropTradeLike): boolean {
  if (tr.currencyPnL != null && Number.isFinite(tr.currencyPnL)) return true;
  if (
    tr.rMultiple != null &&
    Number.isFinite(tr.rMultiple) &&
    tr.actualRiskAmount != null &&
    Number.isFinite(tr.actualRiskAmount)
  ) {
    return true;
  }
  return false;
}

/**
 * Expected working equity for the *reconciled* lifecycle state at replayTime.
 * PHASE 1/2: baseline = that phase accountSize + PnL of trades in that phase window only.
 * FUNDED: baseline = final challenge/funded accountSize + PnL of post-FUNDED trades only.
 * Does not invent PnL; returns calculable=false if any included trade lacks currency data.
 */
export function calculatePropLifecycleBalance(opts: {
  account: AccountProfile;
  journalTrades: PropTradeLike[];
  lifecycleEvents: LifecycleEvent[];
  lifecycleState: LifecycleState;
  activePhaseId?: string;
  replayTime: number;
}): BalanceCalcResult {
  const { account, journalTrades, lifecycleEvents, lifecycleState, activePhaseId, replayTime } =
    opts;
  const t = toUnixSec(replayTime);
  const accountId = account.accountId;

  const all = (journalTrades || []).filter(
    (tr) =>
      (!tr.accountId || tr.accountId === accountId) &&
      (tr.exitTime == null || toUnixSec(tr.exitTime) <= t)
  );

  const excludedReasons: string[] = [];
  let excludedTradeCount = 0;

  if (lifecycleState === "FAILED" || lifecycleState === "DISABLED") {
    // Working equity still = last active phase baseline + that window's PnL (frozen at fail)
    const phaseId = activePhaseId || challengePhases(account)[0]?.id;
    const baseline = phaseAccountSize(account, phaseId);
    const window = filterTradesForPhaseWindow(
      all,
      accountId,
      phaseId,
      lifecycleEvents,
      t,
      "phase"
    );
    return balanceFromWindow(window, baseline, lifecycleState, phaseId, excludedReasons);
  }

  if (
    lifecycleState === "FUNDED" ||
    lifecycleState === "PAYOUT_ELIGIBLE" ||
    lifecycleState === "PAYOUT_COOLDOWN"
  ) {
    const phases = challengePhases(account);
    const last = phases[phases.length - 1];
    const baseline = phaseAccountSize(account, last?.id) || phaseAccountSize(account);
    const window = filterTradesForPhaseWindow(all, accountId, last?.id, lifecycleEvents, t, "funded");
    // Trades before FUNDED are intentionally excluded from funded equity
    const tradeKey = (tr: PropTradeLike) =>
      `${tr.entryTime}|${tr.exitTime ?? ""}|${tr.currencyPnL ?? ""}|${tr.phaseId ?? ""}`;
    const fundedIds = new Set(window.map(tradeKey));
    for (const tr of all) {
      if (!fundedIds.has(tradeKey(tr))) {
        excludedTradeCount++;
      }
    }
    if (excludedTradeCount > 0) {
      excludedReasons.push(
        `${excludedTradeCount} challenge-period trade(s) excluded from FUNDED balance`
      );
    }
    return balanceFromWindow(window, baseline, lifecycleState, last?.id, excludedReasons);
  }

  // ACTIVE / trading challenge phase
  const phaseId = activePhaseId || challengePhases(account)[0]?.id;
  const baseline = phaseAccountSize(account, phaseId);
  const window = filterTradesForPhaseWindow(all, accountId, phaseId, lifecycleEvents, t, "phase");
  const tradeKey = (tr: PropTradeLike) =>
    `${tr.entryTime}|${tr.exitTime ?? ""}|${tr.currencyPnL ?? ""}|${tr.phaseId ?? ""}`;
  const winIds = new Set(window.map(tradeKey));
  for (const tr of all) {
    if (!winIds.has(tradeKey(tr))) {
      excludedTradeCount++;
    }
  }
  if (excludedTradeCount > 0) {
    excludedReasons.push(
      `${excludedTradeCount} trade(s) outside active phase window (prior phase PnL excluded)`
    );
  }
  return balanceFromWindow(window, baseline, lifecycleState, phaseId, excludedReasons);
}

function balanceFromWindow(
  window: PropTradeLike[],
  baseline: number,
  state: LifecycleState,
  activePhaseId: string | undefined,
  excludedReasons: string[]
): BalanceCalcResult {
  const missing = window.filter((tr) => !tradeHasUsablePnL(tr));
  if (missing.length > 0) {
    return {
      expectedBalance: null,
      baseline,
      windowPnL: null,
      includedTradeCount: window.length,
      excludedTradeCount: missing.length,
      excludedReasons: [
        ...excludedReasons,
        `${missing.length} trade(s) lack currencyPnL / (rMultiple×actualRiskAmount) — cannot compute balance`,
      ],
      state,
      activePhaseId,
      calculable: false,
      note: "Insufficient trade PnL data — balance not auto-updated.",
    };
  }
  const pnl = sumCurrencyPnL(window);
  const expected = baseline + pnl;
  return {
    expectedBalance: expected,
    baseline,
    windowPnL: pnl,
    includedTradeCount: window.length,
    excludedTradeCount: 0,
    excludedReasons,
    state,
    activePhaseId,
    calculable: true,
    note: `baseline ${baseline} + window PnL ${pnl.toFixed(2)} = ${expected.toFixed(2)}`,
  };
}

/**
 * Pure deterministic rebuild of challenge lifecycle from Journal + current rules.
 * Does NOT trust legacy PHASE_PASSED / FUNDED as proof of pass.
 */
export function reconcilePropLifecycle(
  account: AccountProfile,
  journalTrades: PropTradeLike[],
  replayTime: number
): ReconciliationReport {
  const t = toUnixSec(replayTime);
  const accountId = account.accountId;
  const stored = deriveLifecycleFromEvents(account, account.lifecycleEvents, t);
  const storedBalance = Number.isFinite(account.balance)
    ? account.balance
    : account.initialBalance || 0;

  if ((account.accountType || "personal") !== "prop") {
    const emptyBal: BalanceCalcResult = {
      expectedBalance: storedBalance,
      baseline: storedBalance,
      windowPnL: 0,
      includedTradeCount: 0,
      excludedTradeCount: 0,
      excludedReasons: [],
      state: "ACTIVE",
      calculable: true,
      note: "Personal account — no Prop reconciliation.",
    };
    return {
      accountId,
      storedState: stored.state,
      storedActivePhaseId: stored.activePhaseId,
      reconciledState: "ACTIVE",
      shouldBeFunded: false,
      phaseResults: [],
      differences: [],
      nextLifecycleEvents: account.lifecycleEvents || [],
      supersededCount: 0,
      needsReconciliation: false,
      balanceNote: emptyBal.note,
      rulesVersion: PROP_LIFECYCLE_RULES_VERSION,
      storedBalance,
      expectedBalance: storedBalance,
      balanceDifference: 0,
      balanceCalculable: true,
      balanceCalc: emptyBal,
    };
  }

  const trades = (journalTrades || []).filter(
    (tr) =>
      (!tr.accountId || tr.accountId === accountId) &&
      (tr.exitTime == null || toUnixSec(tr.exitTime) <= t)
  );

  const phases = challengePhases(account);
  const phaseResults: PhaseEvalSummary[] = [];
  const rebuilt: LifecycleEvent[] = [];

  let cursorTs = 0;
  let allChallengePassed = phases.length > 0;
  let failed = false;
  let activePhaseId = phases[0]?.id;
  let reconciledState: LifecycleState = "ACTIVE";

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    activePhaseId = phase.id;

    const startTs =
      cursorTs ||
      (trades[0]?.exitTime != null
        ? toUnixSec(trades[0].exitTime)
        : trades[0]?.entryTime != null
          ? toUnixSec(trades[0].entryTime)
          : 0);

    rebuilt.push(
      makeLifecycleEvent({
        accountId,
        type: "PHASE_STARTED",
        timestamp: startTs,
        phaseId: phase.id,
        phaseName: phase.name,
        note: "Reconciled under current Prop rules",
      })
    );

    const windowEvents: LifecycleEvent[] = [...rebuilt];
    const phaseTrades = filterTradesForPhaseWindow(
      trades,
      accountId,
      phase.id,
      windowEvents,
      t,
      "phase"
    );

    const accountForEval: AccountProfile = {
      ...account,
      activePropPhaseId: phase.id,
    };

    const evaluation = evaluatePropRules({
      account: accountForEval,
      trades: phaseTrades,
      currentTime: t,
      unrealizedPnL: 0,
    });

    phaseResults.push({
      phaseId: phase.id,
      phaseName: phase.name,
      phaseType: phase.type || "challenge",
      tradingDays: evaluation.tradingDays,
      requiredTradingDays: evaluation.requiredTradingDays,
      minimumTradingDaysPassed: evaluation.minimumTradingDaysPassed,
      profitPct: evaluation.currentProfitPct,
      targetPct: phase.rules?.profitTargetPct ?? null,
      realizedPnL: evaluation.currentProfitCurrency,
      referenceBalance:
        phase.rules?.accountSize && phase.rules.accountSize > 0
          ? phase.rules.accountSize
          : account.initialBalance || account.balance || 0,
      eligibleForPass: evaluation.eligibleForPhasePass,
      failed: evaluation.failed,
      reasons: evaluation.reasons || [],
      tradeCount: phaseTrades.length,
    });

    if (evaluation.failed) {
      failed = true;
      allChallengePassed = false;
      reconciledState = "FAILED";
      rebuilt.push(
        makeLifecycleEvent({
          accountId,
          type: "PHASE_FAILED",
          timestamp: t,
          phaseId: phase.id,
          phaseName: phase.name,
          note: evaluation.reasons.join("; ") || "Rule breach (reconciled)",
        })
      );
      break;
    }

    if (evaluation.eligibleForPhasePass) {
      const exits = phaseTrades
        .map((tr) => (tr.exitTime != null ? toUnixSec(tr.exitTime) : 0))
        .filter((x) => x > 0 && x <= t);
      const passTs = exits.length ? Math.max(...exits) : t;

      rebuilt.push(
        makeLifecycleEvent({
          accountId,
          type: "PHASE_PASSED",
          timestamp: passTs,
          phaseId: phase.id,
          phaseName: phase.name,
          note: "Phase requirements met (reconciled)",
        })
      );
      cursorTs = passTs;
    } else {
      allChallengePassed = false;
      reconciledState = "ACTIVE";
      break;
    }
  }

  let shouldBeFunded = false;
  if (!failed && allChallengePassed && phases.length > 0) {
    shouldBeFunded = true;
    reconciledState = "FUNDED";
    const lastPass = rebuilt.filter((e) => e.type === "PHASE_PASSED").pop();
    const fundedTs = lastPass?.timestamp ?? t;
    rebuilt.push(
      makeLifecycleEvent({
        accountId,
        type: "FUNDED",
        timestamp: fundedTs,
        phaseId: phases[phases.length - 1]?.id,
        phaseName: phases[phases.length - 1]?.name,
        note: "Final challenge phase passed (reconciled)",
      })
    );
    activePhaseId = phases[phases.length - 1]?.id;
  }

  const CHALLENGE_TYPES = new Set([
    "PHASE_STARTED",
    "PHASE_PASSED",
    "PHASE_FAILED",
    "FUNDED",
  ]);
  let supersededCount = 0;
  const preserved: LifecycleEvent[] = [];
  for (const e of account.lifecycleEvents || []) {
    if (CHALLENGE_TYPES.has(e.type) && !e.superseded) {
      preserved.push({
        ...e,
        superseded: true,
        supersedeReason: "LEGACY_RULE_RECONCILIATION",
      });
      supersededCount++;
    } else if (e.superseded) {
      preserved.push(e);
    } else if (
      e.type === "PAYOUT_ELIGIBLE" ||
      e.type === "PAYOUT_REQUESTED" ||
      e.type === "PAYOUT_PAID" ||
      e.type === "PAYOUT_COOLDOWN_STARTED" ||
      e.type === "ACCOUNT_REENABLED" ||
      e.type === "ACCOUNT_DISABLED" ||
      e.type === "ACCOUNT_CREATED" ||
      !CHALLENGE_TYPES.has(e.type)
    ) {
      preserved.push(e);
    }
  }

  const nextLifecycleEvents = [...preserved, ...rebuilt];

  const balanceCalc = calculatePropLifecycleBalance({
    account,
    journalTrades: trades,
    lifecycleEvents: nextLifecycleEvents,
    lifecycleState: reconciledState,
    activePhaseId,
    replayTime: t,
  });

  const differences: string[] = [];
  if (stored.state !== reconciledState) {
    differences.push(`Lifecycle state: stored ${stored.state} → reconciled ${reconciledState}`);
  }
  if (stored.activePhaseId && activePhaseId && stored.activePhaseId !== activePhaseId) {
    differences.push(`Active phase: stored ${stored.activePhaseId} → reconciled ${activePhaseId}`);
  }
  for (const pr of phaseResults) {
    if (pr.requiredTradingDays != null && !pr.minimumTradingDaysPassed) {
      differences.push(
        `${pr.phaseName}: trading days ${pr.tradingDays}/${pr.requiredTradingDays} (not met)`
      );
    }
    if (pr.targetPct != null && !pr.eligibleForPass && !pr.failed) {
      differences.push(
        `${pr.phaseName}: profit ${pr.profitPct.toFixed(2)}% / target ${pr.targetPct}% — NOT PASSED`
      );
    }
  }
  if (stored.state === "FUNDED" && !shouldBeFunded) {
    differences.push("Stored FUNDED is invalid under current rules (will be superseded).");
  }
  if (stored.state !== "FUNDED" && shouldBeFunded) {
    differences.push("Current rules grant FUNDED (was not stored as FUNDED).");
  }

  const expectedBalance = balanceCalc.expectedBalance;
  const balanceDifference =
    expectedBalance != null && Number.isFinite(storedBalance)
      ? expectedBalance - storedBalance
      : null;
  if (balanceDifference != null && Math.abs(balanceDifference) > 0.005) {
    differences.push(
      `Balance: stored ${storedBalance.toFixed(2)} → expected ${expectedBalance!.toFixed(2)} (Δ ${balanceDifference >= 0 ? "+" : ""}${balanceDifference.toFixed(2)})`
    );
  }
  if (!balanceCalc.calculable) {
    differences.push(`Balance not calculable: ${balanceCalc.note}`);
  }

  const needs =
    differences.length > 0 ||
    stored.state !== reconciledState ||
    (stored.state === "FUNDED" && !shouldBeFunded) ||
    (balanceDifference != null && Math.abs(balanceDifference) > 0.005);

  let balanceNote = balanceCalc.note;
  if (!balanceCalc.calculable) {
    balanceNote += " Existing AccountProfile.balance will be preserved on apply.";
  } else if (balanceDifference != null && Math.abs(balanceDifference) > 0.005) {
    balanceNote += " Apply will set AccountProfile.balance to expected value.";
  }

  return {
    accountId,
    storedState: stored.state,
    storedActivePhaseId: stored.activePhaseId,
    reconciledState,
    reconciledActivePhaseId: activePhaseId,
    shouldBeFunded,
    phaseResults,
    differences,
    nextLifecycleEvents,
    supersededCount,
    needsReconciliation: needs,
    balanceNote,
    rulesVersion: PROP_LIFECYCLE_RULES_VERSION,
    storedBalance,
    expectedBalance,
    balanceDifference,
    balanceCalculable: balanceCalc.calculable,
    balanceCalc,
  };
}

/** Apply confirmed reconciliation. Updates lifecycle events; balance only if fully calculable. */
export function applyPropLifecycleReconciliation(
  account: AccountProfile,
  report: ReconciliationReport
): AccountProfile {
  if ((account.accountType || "personal") !== "prop") return account;
  const next: AccountProfile = {
    ...account,
    lifecycleEvents: report.nextLifecycleEvents,
    activePropPhaseId: report.reconciledActivePhaseId || account.activePropPhaseId,
    propLifecycleRulesVersion: PROP_LIFECYCLE_RULES_VERSION,
  };
  if (report.balanceCalculable && report.expectedBalance != null && Number.isFinite(report.expectedBalance)) {
    next.balance = report.expectedBalance;
    // On valid FUNDED, also align initialBalance to baseline for analytics starting point
    if (report.shouldBeFunded && report.balanceCalc.baseline > 0) {
      next.initialBalance = report.balanceCalc.baseline;
    }
  }
  return next;
}

export function formatReconciliationSummary(report: ReconciliationReport): string {
  const lines = [
    `Stored: ${report.storedState}`,
    `Reconciled: ${report.reconciledState}`,
    `Stored balance: ${report.storedBalance}`,
    `Expected balance: ${report.expectedBalance ?? "—"}`,
    ...report.differences,
  ];
  for (const p of report.phaseResults) {
    lines.push(
      `${p.phaseName}: days ${p.tradingDays}/${p.requiredTradingDays ?? "—"} · profit ${p.profitPct.toFixed(2)}% / ${p.targetPct ?? "—"}% · trades ${p.tradeCount} · ${p.eligibleForPass ? "PASS" : p.failed ? "FAILED" : "NOT PASSED"}`
    );
  }
  return lines.join("\n");
}
