/**
 * v3.17.7 — Prop account lifecycle (deterministic, replay-time based).
 * State is derived from events + trades up to current replay timestamp.
 * No Date.now() for trading-state decisions.
 */

import type { AccountProfile } from "./riskModel";
import {
  evaluatePropRules,
  getActivePropPhase,
  ensurePropProgram,
  toUnixSec,
  type PropTradeLike,
} from "./propRules";

export type LifecycleState =
  | "ACTIVE"
  | "FAILED"
  | "FUNDED"
  | "PAYOUT_ELIGIBLE"
  | "PAYOUT_COOLDOWN"
  | "DISABLED";

export type LifecycleEventType =
  | "ACCOUNT_CREATED"
  | "PHASE_STARTED"
  | "PHASE_PASSED"
  | "PHASE_FAILED"
  | "FUNDED"
  | "PAYOUT_ELIGIBLE"
  | "PAYOUT_REQUESTED"
  | "PAYOUT_PAID"
  | "PAYOUT_COOLDOWN_STARTED"
  | "ACCOUNT_REENABLED"
  | "ACCOUNT_DISABLED";

export type LifecycleEvent = {
  id: string;
  accountId: string;
  type: LifecycleEventType;
  /** Unix seconds (replay/sim time) */
  timestamp: number;
  phaseId?: string;
  phaseName?: string;
  amount?: number;
  /** Cooldown ends at this unix time (for PAYOUT_COOLDOWN_STARTED) */
  reenableAt?: number;
  note?: string;
};

export type DerivedLifecycle = {
  state: LifecycleState;
  activePhaseId?: string;
  canOpenTrades: boolean;
  lastEvent?: LifecycleEvent;
  reasons: string[];
  reenableAt?: number;
};

function uid(): string {
  return `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeLifecycleEvent(
  partial: Omit<LifecycleEvent, "id"> & { id?: string }
): LifecycleEvent {
  return {
    id: partial.id || uid(),
    accountId: partial.accountId,
    type: partial.type,
    timestamp: toUnixSec(partial.timestamp),
    phaseId: partial.phaseId,
    phaseName: partial.phaseName,
    amount: partial.amount,
    reenableAt: partial.reenableAt != null ? toUnixSec(partial.reenableAt) : undefined,
    note: partial.note,
  };
}

/** Events at or before replayTime, sorted ascending. */
export function eventsUpTo(events: LifecycleEvent[] | undefined, replayTime: number): LifecycleEvent[] {
  const t = toUnixSec(replayTime);
  return (events || [])
    .filter((e) => toUnixSec(e.timestamp) <= t)
    .sort((a, b) => toUnixSec(a.timestamp) - toUnixSec(b.timestamp) || a.id.localeCompare(b.id));
}

/**
 * Derive lifecycle state from the event log only (timeline reconstruction).
 * Trade-based auto transitions are applied separately via suggestLifecycleTransitions.
 */
export function deriveLifecycleFromEvents(
  account: AccountProfile,
  events: LifecycleEvent[] | undefined,
  replayTime: number
): DerivedLifecycle {
  const reasons: string[] = [];
  if ((account.accountType || "personal") !== "prop") {
    return { state: "ACTIVE", canOpenTrades: true, reasons: ["Personal account"] };
  }

  const seq = eventsUpTo(events, replayTime);
  let state: LifecycleState = "ACTIVE";
  let activePhaseId = account.activePropPhaseId;
  let reenableAt: number | undefined;
  let last: LifecycleEvent | undefined;

  for (const e of seq) {
    last = e;
    switch (e.type) {
      case "ACCOUNT_CREATED":
      case "PHASE_STARTED":
      case "ACCOUNT_REENABLED":
        state = "ACTIVE";
        if (e.phaseId) activePhaseId = e.phaseId;
        reenableAt = undefined;
        break;
      case "PHASE_PASSED":
        if (e.phaseId) activePhaseId = e.phaseId;
        break;
      case "PHASE_FAILED":
        state = "FAILED";
        reasons.push(e.note || "Phase failed");
        break;
      case "FUNDED":
        state = "FUNDED";
        if (e.phaseId) activePhaseId = e.phaseId;
        break;
      case "PAYOUT_ELIGIBLE":
        state = "PAYOUT_ELIGIBLE";
        break;
      case "PAYOUT_REQUESTED":
        break;
      case "PAYOUT_PAID":
      case "PAYOUT_COOLDOWN_STARTED":
        state = "PAYOUT_COOLDOWN";
        reenableAt = e.reenableAt;
        reasons.push("Payout cooldown");
        break;
      case "ACCOUNT_DISABLED":
        state = "DISABLED";
        reasons.push("Account disabled");
        break;
      default:
        break;
    }
  }

  // Cooldown auto-lift when replay time reaches reenableAt
  if (state === "PAYOUT_COOLDOWN" && reenableAt != null && toUnixSec(replayTime) >= reenableAt) {
    state = "ACTIVE";
    reasons.push("Cooldown ended (replay time)");
  }

  const canOpenTrades =
    state === "ACTIVE" || state === "FUNDED" || state === "PAYOUT_ELIGIBLE";

  if (!canOpenTrades) {
    reasons.push(`Cannot open trades in state ${state}`);
  }

  return {
    state,
    activePhaseId,
    canOpenTrades,
    lastEvent: last,
    reasons,
    reenableAt,
  };
}

export function canOpenNewTrades(
  account: AccountProfile,
  events: LifecycleEvent[] | undefined,
  replayTime: number
): boolean {
  return deriveLifecycleFromEvents(account, events, replayTime).canOpenTrades;
}

/**
 * Suggest new lifecycle events after a trade close, based on evaluatePropRules.
 * Does not mutate — caller appends and persists.
 * Uses only trades with exitTime <= replayTime.
 */
export function suggestLifecycleTransitions(opts: {
  account: AccountProfile;
  events: LifecycleEvent[] | undefined;
  trades: PropTradeLike[];
  replayTime: number;
  unrealizedPnL?: number;
}): LifecycleEvent[] {
  const { account, events, trades, replayTime } = opts;
  if ((account.accountType || "personal") !== "prop") return [];

  const t = toUnixSec(replayTime);
  const derived = deriveLifecycleFromEvents(account, events, t);
  if (derived.state === "FAILED" || derived.state === "DISABLED") return [];

  const accountTrades = trades.filter(
    (tr) =>
      (!tr.accountId || tr.accountId === account.accountId) &&
      (tr.exitTime == null || toUnixSec(tr.exitTime) <= t)
  );

  const evaluation = evaluatePropRules({
    account,
    trades: accountTrades,
    currentTime: t,
    unrealizedPnL: opts.unrealizedPnL ?? 0,
  });

  const out: LifecycleEvent[] = [];
  const phase = getActivePropPhase(account);

  // Failure (FAILED/DISABLED already returned above)
  if (evaluation.failed) {
    out.push(
      makeLifecycleEvent({
        accountId: account.accountId,
        type: "PHASE_FAILED",
        timestamp: t,
        phaseId: phase?.id,
        phaseName: phase?.name,
        note: evaluation.reasons.join("; ") || "Rule breach",
      })
    );
    return out;
  }

  // Phase pass → next phase or funded
  if (evaluation.eligibleForPhasePass && phase) {
    const prog = ensurePropProgram(account);
    const phases = prog?.phases || [];
    const idx = phases.findIndex((p) => p.id === phase.id);
    const next = idx >= 0 && idx < phases.length - 1 ? phases[idx + 1] : null;

    const alreadyPassed = eventsUpTo(events, t).some(
      (e) => e.type === "PHASE_PASSED" && e.phaseId === phase.id
    );
    if (!alreadyPassed) {
      out.push(
        makeLifecycleEvent({
          accountId: account.accountId,
          type: "PHASE_PASSED",
          timestamp: t,
          phaseId: phase.id,
          phaseName: phase.name,
          note: "Phase requirements met",
        })
      );
      if (next) {
        out.push(
          makeLifecycleEvent({
            accountId: account.accountId,
            type: "PHASE_STARTED",
            timestamp: t,
            phaseId: next.id,
            phaseName: next.name,
          })
        );
      } else if (phase.type === "challenge" || phase.type === "custom") {
        out.push(
          makeLifecycleEvent({
            accountId: account.accountId,
            type: "FUNDED",
            timestamp: t,
            phaseId: phase.id,
            phaseName: phase.name,
            note: "Final challenge phase passed",
          })
        );
      }
    }
  }

  // Payout eligibility (funded + payout rules)
  const rules = phase?.rules;
  if (
    (derived.state === "FUNDED" || derived.state === "ACTIVE") &&
    rules?.payout?.enabled &&
    !evaluation.failed
  ) {
    const minDays = rules.payout.minimumTradingDays ?? rules.minimumTradingDays;
    const daysOk =
      minDays == null || evaluation.tradingDays >= minDays;
    // Simple: eligible when min days met and not already in payout states
    const alreadyEligible = eventsUpTo(events, t).some((e) => e.type === "PAYOUT_ELIGIBLE");
    if (daysOk && !alreadyEligible && derived.state === "FUNDED") {
      out.push(
        makeLifecycleEvent({
          accountId: account.accountId,
          type: "PAYOUT_ELIGIBLE",
          timestamp: t,
          phaseId: phase?.id,
          phaseName: phase?.name,
        })
      );
    }
  }

  return out;
}

/** Simulate a payout + cooldown from replay time. */
export function buildPayoutEvents(opts: {
  accountId: string;
  amount: number;
  replayTime: number;
  cooldownDays?: number;
  phaseId?: string;
  phaseName?: string;
}): LifecycleEvent[] {
  const t = toUnixSec(opts.replayTime);
  const days = opts.cooldownDays != null && opts.cooldownDays > 0 ? opts.cooldownDays : 0;
  const reenableAt = t + days * 86400;
  return [
    makeLifecycleEvent({
      accountId: opts.accountId,
      type: "PAYOUT_PAID",
      timestamp: t,
      amount: opts.amount,
      phaseId: opts.phaseId,
      phaseName: opts.phaseName,
    }),
    makeLifecycleEvent({
      accountId: opts.accountId,
      type: "PAYOUT_COOLDOWN_STARTED",
      timestamp: t,
      reenableAt,
      phaseId: opts.phaseId,
      phaseName: opts.phaseName,
      note: days > 0 ? `Cooldown ${days} day(s)` : "No cooldown",
    }),
  ];
}

/** Append events to account profile (immutable). */
export function appendLifecycleEvents(
  account: AccountProfile,
  newEvents: LifecycleEvent[]
): AccountProfile {
  if (!newEvents.length) return account;
  const prev = account.lifecycleEvents || [];
  return {
    ...account,
    lifecycleEvents: [...prev, ...newEvents],
  };
}

/** After PHASE_STARTED / FUNDED, sync activePropPhaseId when event carries phaseId. */
export function applyPhaseFromLifecycle(
  account: AccountProfile,
  events: LifecycleEvent[],
  replayTime: number
): AccountProfile {
  const derived = deriveLifecycleFromEvents(account, events, replayTime);
  if (derived.activePhaseId && derived.activePhaseId !== account.activePropPhaseId) {
    return { ...account, activePropPhaseId: derived.activePhaseId };
  }
  return account;
}
