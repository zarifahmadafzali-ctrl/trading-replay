/**
 * v3.19.2 — Legacy Prop lifecycle reconciliation.
 * Current Prop rules are authoritative for challenge evaluation.
 * Old PHASE_PASSED / FUNDED events are evidence only; they may be superseded.
 * Journal trades remain immutable. accountId never changes.
 */

import type { AccountProfile } from "./riskModel";
import {
  evaluatePropRules,
  ensurePropProgram,
  toUnixSec,
  filterTradesForPhaseWindow,
  type PropTradeLike,
} from "./propRules";
import {
  deriveLifecycleFromEvents,
  makeLifecycleEvent,
  eventsUpTo,
  type LifecycleEvent,
  type LifecycleState,
} from "./accountLifecycle";

/** Bump when challenge evaluation semantics change (min days, phase isolation, etc.). */
export const PROP_LIFECYCLE_RULES_VERSION = 2;

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
  /** Events to keep (old, marked superseded where needed) + new authoritative challenge events. */
  nextLifecycleEvents: LifecycleEvent[];
  supersededCount: number;
  needsReconciliation: boolean;
  balanceNote: string;
  rulesVersion: number;
};

function challengePhases(account: AccountProfile) {
  const prog = ensurePropProgram(account);
  const phases = prog?.phases || [];
  // Challenge phases in order; exclude pure funded-type phases from challenge ladder
  const challenge = phases.filter((p) => p.type !== "funded");
  return challenge.length ? challenge : phases;
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

  if ((account.accountType || "personal") !== "prop") {
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
      balanceNote: "Personal account — no Prop reconciliation.",
      rulesVersion: PROP_LIFECYCLE_RULES_VERSION,
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

    // Synthetic PHASE_STARTED at first trade after previous phase end, or 0
    const startTs = cursorTs;
    rebuilt.push(
      makeLifecycleEvent({
        accountId,
        type: "PHASE_STARTED",
        timestamp: startTs || (trades[0]?.exitTime ?? trades[0]?.entryTime ?? 0) || 0,
        phaseId: phase.id,
        phaseName: phase.name,
        note: "Reconciled under current Prop rules",
      })
    );

    // Build temporary event list so filterTradesForPhaseWindow can window correctly
    const windowEvents: LifecycleEvent[] = [...rebuilt];
    // Evaluate as if this phase is active and not yet passed
    const phaseTrades = filterTradesForPhaseWindow(
      trades,
      accountId,
      phase.id,
      windowEvents,
      t,
      "phase"
    );

    // For first phase with no prior PHASE_PASSED, include trades without phaseId in full window
    // filterTradesForPhaseWindow already uses start from PHASE_STARTED

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

    const summary: PhaseEvalSummary = {
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
    };
    phaseResults.push(summary);

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
      // Pass timestamp = last trade exit in phase window, or t
      let passTs = t;
      for (const tr of phaseTrades) {
        if (tr.exitTime != null && toUnixSec(tr.exitTime) > 0) {
          const et = toUnixSec(tr.exitTime);
          if (et <= t && (passTs === t || et > passTs || passTs === t)) {
            // use max exit in window
          }
        }
      }
      const exits = phaseTrades
        .map((tr) => (tr.exitTime != null ? toUnixSec(tr.exitTime) : 0))
        .filter((x) => x > 0 && x <= t);
      passTs = exits.length ? Math.max(...exits) : t;

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

  // Supersede legacy challenge / funded transition events; keep for audit
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
    } else {
      // Keep payout / other events as-is
      if (
        e.type === "PAYOUT_ELIGIBLE" ||
        e.type === "PAYOUT_REQUESTED" ||
        e.type === "PAYOUT_PAID" ||
        e.type === "PAYOUT_COOLDOWN_STARTED" ||
        e.type === "ACCOUNT_REENABLED" ||
        e.type === "ACCOUNT_DISABLED" ||
        e.type === "ACCOUNT_CREATED"
      ) {
        preserved.push(e);
      } else if (!CHALLENGE_TYPES.has(e.type)) {
        preserved.push(e);
      }
    }
  }

  const nextLifecycleEvents = [...preserved, ...rebuilt];

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

  const needsReconciliation =
    differences.length > 0 ||
    (account.propLifecycleRulesVersion != null &&
      account.propLifecycleRulesVersion < PROP_LIFECYCLE_RULES_VERSION &&
      (account.lifecycleEvents || []).some((e) => CHALLENGE_TYPES.has(e.type) && !e.superseded));

  // Also need recon if version missing and any challenge events exist while rules would differ
  const needs =
    needsReconciliation ||
    (stored.state === "FUNDED" && !shouldBeFunded) ||
    (stored.state !== reconciledState);

  let balanceNote =
    "AccountProfile.balance is not auto-rewritten. Journal PnL stays immutable. " +
    "If FUNDED is valid under reconciliation, working balance should be treated as accountSize baseline + post-funded PnL only after explicit migration.";
  if (stored.state === "FUNDED" && !shouldBeFunded) {
    balanceNote +=
      " Legacy FUNDED is invalid — balance is left unchanged (unsafe to auto-reset).";
  }
  if (shouldBeFunded) {
    const size =
      phases[phases.length - 1]?.rules?.accountSize ||
      account.initialBalance ||
      account.balance ||
      0;
    balanceNote += ` Valid FUNDED baseline under rules: ${size}.`;
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
  };
}

/** Apply a confirmed reconciliation report to an account (immutable). Does not change accountId. */
export function applyPropLifecycleReconciliation(
  account: AccountProfile,
  report: ReconciliationReport
): AccountProfile {
  if ((account.accountType || "personal") !== "prop") return account;
  return {
    ...account,
    lifecycleEvents: report.nextLifecycleEvents,
    activePropPhaseId: report.reconciledActivePhaseId || account.activePropPhaseId,
    propLifecycleRulesVersion: PROP_LIFECYCLE_RULES_VERSION,
    // Balance NOT auto-mutated — caller may optionally adjust if product policy allows
  };
}

/** Preview helpers for UI */
export function formatReconciliationSummary(report: ReconciliationReport): string {
  const lines = [
    `Stored: ${report.storedState}`,
    `Reconciled: ${report.reconciledState}`,
    ...report.differences,
  ];
  for (const p of report.phaseResults) {
    lines.push(
      `${p.phaseName}: days ${p.tradingDays}/${p.requiredTradingDays ?? "—"} · profit ${p.profitPct.toFixed(2)}% / ${p.targetPct ?? "—"}% · ${p.eligibleForPass ? "PASS" : p.failed ? "FAILED" : "NOT PASSED"}`
    );
  }
  return lines.join("\n");
}
