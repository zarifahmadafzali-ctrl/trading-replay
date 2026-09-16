/**
 * v3.18.1 — Prop lifecycle + payout status UI (derived view only).
 * Source of truth: accountLifecycle + propRules + payoutSchedule.
 */
import React, { useMemo } from "react";
import type { AccountProfile } from "../lib/riskModel";
import {
  evaluatePropRules,
  getActivePropPhase,
  ensurePropProgram,
  sumCurrencyPnL,
  type PropTradeLike,
} from "../lib/propRules";
import {
  deriveLifecycleFromEvents,
  buildPayoutEvents,
  appendLifecycleEvents,
  eventsUpTo,
  type LifecycleEvent,
  type LifecycleState,
} from "../lib/accountLifecycle";
import {
  calculatePayoutEligibility,
  normalizePayoutSchedule,
} from "../lib/payoutSchedule";

export type PropAccountStatusProps = {
  account: AccountProfile;
  trades: PropTradeLike[];
  /** Replay/simulation unix seconds — NEVER Date.now() for state. */
  replayTime: number;
  /** Persist updated account (with new lifecycle events). */
  onAccountChange?: (next: AccountProfile) => void;
  compact?: boolean;
};

function uiStateLabel(state: LifecycleState): string {
  switch (state) {
    case "ACTIVE":
      return "TRADING";
    case "FAILED":
      return "FAILED";
    case "FUNDED":
      return "FUNDED";
    case "PAYOUT_ELIGIBLE":
      return "PAYOUT_ELIGIBLE";
    case "PAYOUT_COOLDOWN":
      return "COOLDOWN";
    case "DISABLED":
      return "DISABLED";
    default:
      return state;
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtDay(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toISOString().slice(0, 10);
}

export function PropAccountStatus({
  account,
  trades,
  replayTime,
  onAccountChange,
  compact,
}: PropAccountStatusProps) {
  const isProp = (account.accountType || "personal") === "prop";
  const prog = isProp ? ensurePropProgram(account) : null;
  const phase = isProp ? getActivePropPhase(account) : null;
  const rules = phase?.rules;
  const derived = useMemo(
    () => deriveLifecycleFromEvents(account, account.lifecycleEvents, replayTime),
    [account, replayTime]
  );
  const evaluation = useMemo(
    () =>
      evaluatePropRules({
        account,
        trades: trades.filter((t) => !t.accountId || t.accountId === account.accountId),
        currentTime: replayTime,
      }),
    [account, trades, replayTime]
  );

  const accountTrades = useMemo(
    () => trades.filter((t) => !t.accountId || t.accountId === account.accountId),
    [trades, account.accountId]
  );

  const payoutUi = useMemo(() => {
    if (!rules?.payout) return null;
    const sch = normalizePayoutSchedule(rules.payout);
    const seq = eventsUpTo(account.lifecycleEvents, replayTime);
    const fundedEv = [...seq].reverse().find((e) => e.type === "FUNDED");
    const lastPaid = [...seq].reverse().find((e) => e.type === "PAYOUT_PAID");
    const lastReq = [...seq].reverse().find((e) => e.type === "PAYOUT_REQUESTED");
    const firstTrade = accountTrades
      .filter((tr) => tr.exitTime != null)
      .sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0))[0];
    const availableProfit = sumCurrencyPnL(accountTrades, account.accountId);
    const elig = calculatePayoutEligibility({
      schedule: sch,
      accountSize: rules.accountSize || account.initialBalance || account.balance || 0,
      availableProfit,
      trades: accountTrades,
      accountId: account.accountId,
      replayTime,
      fundedAt: fundedEv?.timestamp,
      firstFundedTradeAt: firstTrade?.exitTime ?? firstTrade?.entryTime,
      lastPayoutAt: lastPaid?.timestamp,
      events: seq,
    });

    let payoutStatus = "NOT ELIGIBLE";
    if (derived.state === "PAYOUT_COOLDOWN") payoutStatus = "COOLDOWN";
    else if (lastReq && (!lastPaid || lastReq.timestamp > lastPaid.timestamp)) {
      const proc = sch.processingDays || 0;
      const paidAt = lastReq.timestamp + proc * 86400;
      payoutStatus = replayTime >= paidAt ? "PAID" : "PROCESSING";
    } else if (derived.state === "PAYOUT_ELIGIBLE" || elig.eligible) payoutStatus = "ELIGIBLE";
    else if (lastPaid) payoutStatus = "PAID";

    const history = seq
      .filter((e) =>
        e.type === "PAYOUT_REQUESTED" ||
        e.type === "PAYOUT_PAID" ||
        e.type === "PAYOUT_ELIGIBLE" ||
        e.type === "PAYOUT_COOLDOWN_STARTED"
      )
      .slice()
      .reverse()
      .slice(0, 12);

    return { elig, sch, payoutStatus, history, availableProfit };
  }, [account, rules, accountTrades, replayTime, derived.state]);

  const size = rules?.accountSize || account.initialBalance || account.balance || 0;
  const targetProfit =
    rules?.profitTargetPct != null ? (size * rules.profitTargetPct) / 100 : null;
  const maxDaily =
    rules?.dailyLossLimitPct != null ? (size * rules.dailyLossLimitPct) / 100 : null;
  const maxOverall =
    rules?.maxOverallLossPct != null ? (size * rules.maxOverallLossPct) / 100 : null;

  if (!isProp) return null;

  function requestPayout() {
    if (!onAccountChange || !payoutUi?.elig.eligible) return;
    const amount = payoutUi.elig.traderPayout;
    const events = buildPayoutEvents({
      accountId: account.accountId,
      amount,
      replayTime,
      cooldownDays: payoutUi.sch.cooldownDays,
      processingDays: payoutUi.sch.processingDays,
      phaseId: phase?.id,
      phaseName: phase?.name,
    });
    // Also stamp REQUEST path is inside buildPayoutEvents
    onAccountChange(appendLifecycleEvents(account, events));
  }

  const nextPhase = (() => {
    const phases = prog?.phases || [];
    const idx = phase ? phases.findIndex((p) => p.id === phase.id) : -1;
    return idx >= 0 && idx < phases.length - 1 ? phases[idx + 1] : null;
  })();

  return (
    <div className={`prop-status-box${compact ? " prop-status-compact" : ""}`}>
      <div className="prop-status-head">
        <strong>{account.name}</strong>
        <span className={`prop-state-pill state-${derived.state.toLowerCase()}`}>
          {uiStateLabel(derived.state)}
        </span>
      </div>
      <div className="prop-status-meta">
        <span>Prop</span>
        {prog?.firmName ? <span>· {prog.firmName}</span> : null}
        {prog?.programName ? <span>· {prog.programName}</span> : null}
        <span>· Size {fmtUsd(size)}</span>
        <span>· Bal {fmtUsd(account.balance)}</span>
      </div>

      {phase && (
        <div className="prop-phase-block">
          <div className="muted" style={{ fontSize: 11 }}>CURRENT PHASE · {phase.name}</div>
          <div className="prop-progress-grid">
            <div>
              <span className="risk-calc-k">Profit</span>
              <span className="risk-calc-v">
                {fmtUsd(evaluation.currentProfitCurrency)}
                {targetProfit != null ? ` / ${fmtUsd(targetProfit)}` : ""}
              </span>
            </div>
            <div>
              <span className="risk-calc-k">Trading Days</span>
              <span className="risk-calc-v">
                {evaluation.tradingDays}
                {rules?.minimumTradingDays != null ? ` / ${rules.minimumTradingDays}` : ""}
              </span>
            </div>
            {maxDaily != null && (
              <div>
                <span className="risk-calc-k">Daily Loss Cap</span>
                <span className="risk-calc-v">{fmtUsd(maxDaily)}</span>
              </div>
            )}
            {maxOverall != null && (
              <div>
                <span className="risk-calc-k">Max Loss Cap</span>
                <span className="risk-calc-v">{fmtUsd(maxOverall)}</span>
              </div>
            )}
            {rules?.consistencyPct != null && (
              <div>
                <span className="risk-calc-k">Consistency</span>
                <span className="risk-calc-v">{rules.consistencyPct}%</span>
              </div>
            )}
            {rules?.leverage != null && (
              <div>
                <span className="risk-calc-k">Phase Lev</span>
                <span className="risk-calc-v">1:{rules.leverage}</span>
              </div>
            )}
          </div>
          {evaluation.eligibleForPhasePass && (
            <p className="prop-event ok">
              ✓ {phase.name} Passed
              {nextPhase ? ` · Next: ${nextPhase.name}` : " · Challenge complete"}
            </p>
          )}
          {derived.state === "FUNDED" && <p className="prop-event ok">✓ Challenge Passed · FUNDED</p>}
          {derived.state === "FAILED" && (
            <p className="prop-event fail">
              ✕ Account Failed
              {evaluation.reasons?.length ? ` · ${evaluation.reasons[0]}` : derived.reasons[0] ? ` · ${derived.reasons[0]}` : ""}
            </p>
          )}
        </div>
      )}

      {derived.state === "FUNDED" ||
      derived.state === "PAYOUT_ELIGIBLE" ||
      derived.state === "PAYOUT_COOLDOWN" ||
      payoutUi ? (
        <div className="prop-payout-block">
          <div className="muted" style={{ fontSize: 11 }}>PAYOUT</div>
          <div className="prop-status-meta">
            Status: <strong>{payoutUi?.payoutStatus || "NOT ELIGIBLE"}</strong>
          </div>
          {payoutUi && (
            <>
              <div className="prop-progress-grid">
                <div>
                  <span className="risk-calc-k">Eligible profit</span>
                  <span className="risk-calc-v">{fmtUsd(payoutUi.availableProfit)}</span>
                </div>
                <div>
                  <span className="risk-calc-k">Minimum</span>
                  <span className="risk-calc-v">{fmtUsd(payoutUi.elig.minimumRequired)}</span>
                </div>
                <div>
                  <span className="risk-calc-k">Trader share</span>
                  <span className="risk-calc-v">
                    {payoutUi.sch.profitSplitPct != null ? `${payoutUi.sch.profitSplitPct}%` : "100%"}
                  </span>
                </div>
                <div>
                  <span className="risk-calc-k">Est. payout</span>
                  <span className="risk-calc-v pos">{fmtUsd(payoutUi.elig.traderPayout)}</span>
                </div>
              </div>
              {payoutUi.elig.eligible && onAccountChange && (
                <button type="button" className="on prop-payout-btn" onClick={requestPayout}>
                  REQUEST PAYOUT
                </button>
              )}
              {payoutUi.history.length > 0 && (
                <div className="prop-payout-history">
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>History</div>
                  <ul>
                    {payoutUi.history.map((e: LifecycleEvent) => (
                      <li key={e.id}>
                        {fmtDay(e.timestamp)} · {e.type.replace("PAYOUT_", "")}
                        {e.amount != null ? ` · ${fmtUsd(e.amount)}` : ""}
                        {e.reenableAt != null ? ` · until ${fmtDay(e.reenableAt)}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
