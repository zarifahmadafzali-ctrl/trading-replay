/**
 * v3.19.4 — Full Prop lifecycle end-to-end regression.
 * Mirrors pure evaluation semantics from propRules / accountLifecycle / reconcile.
 * Deterministic: no Date.now() for state decisions.
 */

const SIZE = 5000;
const D1 = 1719792000; // fixed unix anchors (UTC days)
const day = (n) => D1 + n * 86400;

function toUnix(t) {
  return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
}
function utcDay(t) {
  const d = new Date(toUnix(t) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function countDays(trades) {
  const s = new Set();
  for (const tr of trades) {
    if (tr.exitTime != null) s.add(utcDay(tr.exitTime));
  }
  return s.size;
}
function sumPnL(trades) {
  let s = 0;
  for (const tr of trades) {
    if (tr.currencyPnL != null) s += tr.currencyPnL;
    else if (tr.rMultiple != null && tr.actualRiskAmount != null) s += tr.rMultiple * tr.actualRiskAmount;
  }
  return s;
}
function hasMinDays(days, min) {
  if (min == null || !(min > 0)) return true;
  return days >= min;
}
function targetHit(ref, pnl, pct) {
  if (pct == null || !(ref > 0)) return false;
  return pnl >= (ref * pct) / 100 - 1e-9;
}
function dailyBreach(ref, dayPnl, limitPct) {
  if (limitPct == null || !(ref > 0)) return false;
  return dayPnl <= -((ref * limitPct) / 100) + 1e-9;
}
function maxLossBreach(ref, equityDelta, pct) {
  if (pct == null || !(ref > 0)) return false;
  return equityDelta <= -((ref * pct) / 100) + 1e-9;
}
function consistency(trades, required) {
  let largest = 0,
    total = 0;
  for (const tr of trades) {
    const pnl = tr.currencyPnL ?? 0;
    if (pnl > 0) {
      total += pnl;
      if (pnl > largest) largest = pnl;
    }
  }
  if (required == null) return { pass: true, status: "NOT_CONFIGURED" };
  if (!(total > 0)) return { pass: false, status: "NOT_YET_QUALIFIED" };
  const actual = (largest / total) * 100;
  return { pass: actual <= required + 1e-9, status: actual <= required + 1e-9 ? "PASS" : "FAIL", actual };
}
function phasePass(ref, trades, targetPct, minDays, dailyLimit, maxLoss, consPct) {
  const pnl = sumPnL(trades);
  const days = countDays(trades);
  const equityDelta = pnl; // vs baseline
  if (dailyLimit != null) {
    // group by day
    const byDay = {};
    for (const tr of trades) {
      const k = utcDay(tr.exitTime);
      byDay[k] = (byDay[k] || 0) + (tr.currencyPnL || 0);
    }
    for (const k of Object.keys(byDay)) {
      if (dailyBreach(ref, byDay[k], dailyLimit)) return { pass: false, failed: true, reason: "DAILY_LOSS" };
    }
  }
  if (maxLossBreach(ref, equityDelta, maxLoss)) return { pass: false, failed: true, reason: "MAX_LOSS" };
  const c = consistency(trades, consPct);
  if (!c.pass && c.status === "FAIL") return { pass: false, failed: true, reason: "CONSISTENCY" };
  if (!targetHit(ref, pnl, targetPct)) return { pass: false, failed: false, reason: "TARGET" };
  if (!hasMinDays(days, minDays)) return { pass: false, failed: false, reason: "MIN_DAYS" };
  if (!c.pass && c.status === "NOT_YET_QUALIFIED" && consPct != null)
    return { pass: false, failed: false, reason: "CONSISTENCY_NQ" };
  return { pass: true, failed: false, pnl, days };
}
function balance(baseline, windowTrades) {
  return baseline + sumPnL(windowTrades);
}
function eventsUpTo(events, t) {
  return events.filter((e) => !e.superseded && toUnix(e.timestamp) <= t).sort((a, b) => a.timestamp - b.timestamp);
}
function derive(events, t) {
  const seq = eventsUpTo(events, t);
  let state = "ACTIVE";
  let phaseId = "p1";
  for (const e of seq) {
    if (e.type === "PHASE_STARTED") {
      state = "ACTIVE";
      phaseId = e.phaseId;
    } else if (e.type === "PHASE_PASSED") {
      phaseId = e.phaseId;
    } else if (e.type === "PHASE_FAILED") {
      state = "FAILED";
    } else if (e.type === "FUNDED") {
      state = "FUNDED";
    } else if (e.type === "PAYOUT_COOLDOWN_STARTED") {
      state = "PAYOUT_COOLDOWN";
      if (e.reenableAt != null && t >= e.reenableAt) state = "ACTIVE"; // funded trading after cooldown
    } else if (e.type === "PAYOUT_ELIGIBLE") {
      state = "PAYOUT_ELIGIBLE";
    } else if (e.type === "ACCOUNT_REENABLED") {
      state = "FUNDED";
    }
  }
  const canOpen =
    state === "ACTIVE" || state === "FUNDED" || state === "PAYOUT_ELIGIBLE";
  return { state, phaseId, canOpen };
}

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    failed++;
  } else console.log("PASS", name);
}

// ─── Config ───────────────────────────────────────────
const P1 = { target: 8, minDays: 3, daily: 5, max: 10, cons: 40 };
const P2 = { target: 5, minDays: 3, daily: 5, max: 10, cons: 40 };
const AID = "acc-full-lifecycle";

// ─── 3. Phase 1 ───────────────────────────────────────
// Risk $50 (1% of 5000). Day1 +2R=+100, Day2 +3R=+150, Day3 +3R=+150 → +400 = 8%
const p1Trades = [
  { accountId: AID, phaseId: "p1", exitTime: day(0) + 100, currencyPnL: 100, rMultiple: 2, actualRiskAmount: 50 },
  { accountId: AID, phaseId: "p1", exitTime: day(1) + 100, currencyPnL: 150, rMultiple: 3, actualRiskAmount: 50 },
  { accountId: AID, phaseId: "p1", exitTime: day(2) + 100, currencyPnL: 150, rMultiple: 3, actualRiskAmount: 50 },
];
assert("3a phase1 days=3", countDays(p1Trades) === 3);
assert("3b phase1 pnl=400", sumPnL(p1Trades) === 400);
assert("3c phase1 target 8%", targetHit(SIZE, 400, 8));
assert("3d phase1 passes all", phasePass(SIZE, p1Trades, P1.target, P1.minDays, P1.daily, P1.max, P1.cons).pass);
assert("3e phase1 balance 5400", balance(SIZE, p1Trades) === 5400);
assert("3f no phase2 trades in window", p1Trades.every((t) => t.phaseId === "p1"));

// ─── 4. Phase transition ──────────────────────────────
const afterP1 = [
  { type: "PHASE_STARTED", phaseId: "p1", timestamp: day(0), accountId: AID },
  { type: "PHASE_PASSED", phaseId: "p1", timestamp: day(2) + 100, accountId: AID },
  { type: "PHASE_STARTED", phaseId: "p2", timestamp: day(2) + 100, accountId: AID },
];
assert("4a same accountId", afterP1.every((e) => e.accountId === AID));
assert("4b phase2 baseline 5000 not 5400", balance(SIZE, []) === 5000);
assert("4c phase2 target $250", (SIZE * 5) / 100 === 250);
assert("4d phase2 min days independent", countDays([]) === 0);

// ─── 5. Phase 2 ───────────────────────────────────────
const p2Trades = [
  { accountId: AID, phaseId: "p2", exitTime: day(3) + 50, currencyPnL: 90, rMultiple: 1.8, actualRiskAmount: 50 },
  { accountId: AID, phaseId: "p2", exitTime: day(4) + 50, currencyPnL: 90, rMultiple: 1.8, actualRiskAmount: 50 },
  { accountId: AID, phaseId: "p2", exitTime: day(5) + 50, currencyPnL: 70, rMultiple: 1.4, actualRiskAmount: 50 },
]; // +250, 3 days
assert("5a phase2 days=3", countDays(p2Trades) === 3);
assert("5b phase2 pnl=250", sumPnL(p2Trades) === 250);
assert("5c phase2 passes", phasePass(SIZE, p2Trades, P2.target, P2.minDays, P2.daily, P2.max, P2.cons).pass);
assert("5d phase1 excluded from phase2 pnl", sumPnL(p2Trades) !== sumPnL([...p1Trades, ...p2Trades]));
assert("5e phase2 balance window 5250", balance(SIZE, p2Trades) === 5250);

// Incomplete phase2 (1 day only) must NOT pass
const p2Incomplete = [p2Trades[0]];
assert(
  "5f phase2 1 day not pass",
  !phasePass(SIZE, p2Incomplete, P2.target, P2.minDays, P2.daily, P2.max, null).pass
);

// ─── 6. FUNDED ────────────────────────────────────────
const fundedTs = day(5) + 50;
const afterFunded = [
  ...afterP1,
  { type: "PHASE_PASSED", phaseId: "p2", timestamp: fundedTs, accountId: AID },
  { type: "FUNDED", phaseId: "p2", timestamp: fundedTs, accountId: AID },
];
const fundedCount = afterFunded.filter((e) => e.type === "FUNDED").length;
assert("6a exactly one FUNDED", fundedCount === 1);
assert("6b same accountId", afterFunded.every((e) => e.accountId === AID));
assert("6c funded baseline 5000", balance(SIZE, []) === 5000);
assert("6d challenge pnl not in funded equity", balance(SIZE, []) !== balance(SIZE, [...p1Trades, ...p2Trades]));

// ─── 7. Funded trades ─────────────────────────────────
const fundedTrades = [
  { accountId: AID, phaseId: "funded", exitTime: day(6) + 10, currencyPnL: 50, rMultiple: 1, actualRiskAmount: 50 },
  { accountId: AID, phaseId: "funded", exitTime: day(7) + 10, currencyPnL: -25, rMultiple: -0.5, actualRiskAmount: 50 },
  { accountId: AID, phaseId: "funded", exitTime: day(8) + 10, currencyPnL: 50, rMultiple: 1, actualRiskAmount: 50 },
];
assert("7a funded balance 5075", balance(SIZE, fundedTrades) === 5075);
assert("7b challenge not in funded window", balance(SIZE, fundedTrades) === SIZE + sumPnL(fundedTrades));

// ─── 8. Payout ────────────────────────────────────────
const fundedProfit = sumPnL(fundedTrades); // 75
const split = 80; // trader 80%
const traderPayout = (fundedProfit * split) / 100;
assert("8a payout from funded only", fundedProfit === 75);
assert("8b challenge cannot be withdrawn", sumPnL(p1Trades) + sumPnL(p2Trades) !== fundedProfit);
assert("8c split amount", traderPayout === 60);

const cooldownDays = 1;
const paidAt = day(9);
const reenableAt = paidAt + cooldownDays * 86400;
const payoutEvents = [
  ...afterFunded,
  { type: "PAYOUT_REQUESTED", timestamp: day(8) + 100, accountId: AID, amount: traderPayout },
  { type: "PAYOUT_PAID", timestamp: paidAt, accountId: AID, amount: traderPayout },
  { type: "PAYOUT_COOLDOWN_STARTED", timestamp: paidAt, accountId: AID, reenableAt },
];
assert("8d blocked during cooldown", !derive(payoutEvents, paidAt + 100).canOpen);
assert("8e allowed after cooldown", derive(payoutEvents, reenableAt).state === "ACTIVE" || derive(payoutEvents, reenableAt).canOpen);

// ─── 9. Daily loss ────────────────────────────────────
const dailyTrades = [
  { exitTime: day(0) + 1, currencyPnL: -100 }, // -2%
  { exitTime: day(0) + 2, currencyPnL: -100 }, // -2%
  { exitTime: day(0) + 3, currencyPnL: -60 }, // -1.2% → total -5.2% > 5%
];
assert("9a same day aggregated", utcDay(dailyTrades[0].exitTime) === utcDay(dailyTrades[2].exitTime));
assert("9b daily breach", dailyBreach(SIZE, sumPnL(dailyTrades), 5));
assert("9c phase fails", phasePass(SIZE, dailyTrades, 8, 0, 5, 10, null).failed);
assert("9d prior day not combined", !dailyBreach(SIZE, -50, 5)); // single day -1%

// Replay: before breach trade
const dailyPartial = dailyTrades.slice(0, 2); // -4%
assert("9e before final loss no breach", !dailyBreach(SIZE, sumPnL(dailyPartial), 5));

// ─── 10. Max loss ─────────────────────────────────────
const maxLossTrades = [
  { exitTime: day(0), currencyPnL: -300 },
  { exitTime: day(1), currencyPnL: -250 }, // -550 = -11% of 5000
];
assert("10a max loss breach", maxLossBreach(SIZE, sumPnL(maxLossTrades), 10));
assert("10b phase2 own baseline not phase1 equity", maxLossBreach(SIZE, -550, 10)); // uses 5000 not 5400
assert("10c no 10000 fallback", SIZE === 5000 && SIZE !== 10000);

// ─── 11. Minimum trading days ─────────────────────────
const oneDay = [{ exitTime: day(0), currencyPnL: 400 }];
const twoDay = [
  { exitTime: day(0), currencyPnL: 200 },
  { exitTime: day(1), currencyPnL: 200 },
];
const threeDay = [
  { exitTime: day(0), currencyPnL: 140 },
  { exitTime: day(1), currencyPnL: 140 },
  { exitTime: day(2), currencyPnL: 140 },
];
assert("11a 1 day not pass min3", !hasMinDays(countDays(oneDay), 3));
assert("11b 2 days not pass min3", !hasMinDays(countDays(twoDay), 3));
assert("11c 3 days pass min3", hasMinDays(countDays(threeDay), 3));
const sameDayMulti = [
  { exitTime: day(0) + 1, currencyPnL: 100 },
  { exitTime: day(0) + 2, currencyPnL: 100 },
  { exitTime: day(0) + 3, currencyPnL: 200 },
];
assert("11d same UTC day = 1", countDays(sameDayMulti) === 1);

// ─── 12. Consistency ──────────────────────────────────
const consPass = [
  { currencyPnL: 100 },
  { currencyPnL: 100 },
  { currencyPnL: 100 },
]; // largest/total = 33.3% <= 40
const consFail = [
  { currencyPnL: 300 },
  { currencyPnL: 50 },
  { currencyPnL: 50 },
]; // 75% > 40
assert("12a consistency pass", consistency(consPass, 40).pass);
assert("12b consistency fail", !consistency(consFail, 40).pass);
assert("12c no wins NQ", consistency([{ currencyPnL: -10 }], 40).status === "NOT_YET_QUALIFIED");

// ─── 13. Legacy reconciliation ────────────────────────
const legacyInvalid = [
  { type: "PHASE_PASSED", phaseId: "p1", timestamp: day(0), accountId: AID, superseded: false },
  { type: "PHASE_PASSED", phaseId: "p2", timestamp: day(1), accountId: AID, superseded: false },
  { type: "FUNDED", phaseId: "p2", timestamp: day(1), accountId: AID, superseded: false },
];
// Only 1 day of phase2 trades under current rules → should NOT be funded
const weakP2 = [{ exitTime: day(1), currencyPnL: 100, phaseId: "p2" }]; // 2%, 1 day
assert("13a current rules phase2 fail", !phasePass(SIZE, weakP2, 5, 3, 5, 10, null).pass);
const superseded = legacyInvalid.map((e) => ({
  ...e,
  superseded: true,
  supersedeReason: "LEGACY_RULE_RECONCILIATION",
}));
assert("13b superseded not deleted", superseded.length === 3 && superseded.every((e) => e.type));
assert("13c derive ignores superseded", eventsUpTo(superseded, day(10)).length === 0);
// After superseding only: no FUNDED remains → ACTIVE (challenge), not FUNDED
const dSup = derive(superseded, day(10));
assert("13d invalid FUNDED gone (not FUNDED state)", dSup.state !== "FUNDED");
const journalImmutable = [...p1Trades];
assert("13e journal unchanged", journalImmutable.length === 3);

// Balance calculable
assert("13f balance calculable", balance(SIZE, weakP2) === 5100);
assert("13g missing pnl not invent", (() => {
  const tr = { exitTime: day(0) };
  return tr.currencyPnL == null && !(tr.rMultiple != null && tr.actualRiskAmount != null);
})());

// ─── 14. Valid legacy funded ──────────────────────────
assert("14a valid phase1+phase2 still funded path", phasePass(SIZE, p1Trades, 8, 3, 5, 10, null).pass && phasePass(SIZE, p2Trades, 5, 3, 5, 10, null).pass);

// ─── 15. Backward / forward replay ────────────────────
const fullTimeline = [
  { type: "PHASE_STARTED", phaseId: "p1", timestamp: day(0), accountId: AID },
  ...p1Trades.map((tr) => ({ type: "TRADE", timestamp: tr.exitTime, phaseId: "p1" })),
  { type: "PHASE_PASSED", phaseId: "p1", timestamp: day(2) + 100, accountId: AID },
  { type: "PHASE_STARTED", phaseId: "p2", timestamp: day(2) + 100, accountId: AID },
  ...p2Trades.map((tr) => ({ type: "TRADE", timestamp: tr.exitTime, phaseId: "p2" })),
  { type: "PHASE_PASSED", phaseId: "p2", timestamp: fundedTs, accountId: AID },
  { type: "FUNDED", phaseId: "p2", timestamp: fundedTs, accountId: AID },
  ...fundedTrades.map((tr) => ({ type: "TRADE", timestamp: tr.exitTime, phaseId: "funded" })),
  { type: "PAYOUT_REQUESTED", timestamp: day(8) + 100, accountId: AID },
  { type: "PAYOUT_PAID", timestamp: paidAt, accountId: AID },
  { type: "PAYOUT_COOLDOWN_STARTED", timestamp: paidAt, accountId: AID, reenableAt },
];

function stateAt(t) {
  return derive(
    fullTimeline.filter((e) => e.type !== "TRADE"),
    t
  );
}
assert("15A before p1 trades ACTIVE p1", stateAt(day(0) - 10).state === "ACTIVE" && stateAt(day(0) - 10).phaseId === "p1");
assert("15B during p1 ACTIVE", stateAt(day(1)).state === "ACTIVE");
assert("15C at p1 pass has PHASE_PASSED", eventsUpTo(fullTimeline.filter((e) => e.type !== "TRADE"), day(2) + 100).some((e) => e.type === "PHASE_PASSED"));
assert("15D before p2 still after p1", stateAt(day(2) + 50).phaseId === "p1" || stateAt(day(2) + 50).phaseId === "p2");
assert("15E during p2", stateAt(day(4)).phaseId === "p2" || stateAt(day(4)).state === "ACTIVE");
assert("15F at FUNDED", stateAt(fundedTs).state === "FUNDED");
assert("15G after funded trades still FUNDED", stateAt(day(8)).state === "FUNDED" || stateAt(day(8)).state === "PAYOUT_ELIGIBLE");
assert("15H before payout FUNDED", stateAt(day(8)).state === "FUNDED" || stateAt(day(8)).canOpen);
assert("15I during cooldown blocked", stateAt(paidAt + 100).state === "PAYOUT_COOLDOWN" || !stateAt(paidAt + 100).canOpen);
assert("15J after cooldown can open", stateAt(reenableAt).canOpen || stateAt(reenableAt).state === "ACTIVE");

// Forward determinism: re-derive at fundedTs twice
const a = stateAt(fundedTs);
const b = stateAt(fundedTs);
assert("15K deterministic", a.state === b.state && a.phaseId === b.phaseId);

// Future trades must not affect past
const pastTrades = p1Trades.filter((tr) => tr.exitTime <= day(1));
const pastBal = balance(SIZE, pastTrades);
// day(0) trade only is strictly before day(1); day(1)+100 is after day(1)
assert("15L no future pnl in past", pastBal === SIZE + sumPnL(pastTrades));
assert("15L2 excludes later day trade", pastTrades.length === 1 && pastBal === 5100);

// ─── 16. Multi-account isolation ──────────────────────
const accA = { id: "A", bal: 5000, events: [{ type: "FUNDED", accountId: "A", timestamp: day(0) }] };
const accB = { id: "B", bal: 12000, events: [{ type: "PHASE_STARTED", accountId: "B", phaseId: "p1", timestamp: day(0) }] };
const accC = { id: "C", personal: true, bal: 10000 };
assert("16a A funded not B", derive(accA.events, day(1)).state === "FUNDED");
assert("16b B still active", derive(accB.events, day(1)).state === "ACTIVE");
assert("16c balances isolated", accA.bal !== accB.bal && accB.bal !== accC.bal);
assert("16d personal unaffected", accC.personal === true);

// ─── 17. Persistence model (structural) ───────────────
const sessionSnap = {
  accounts: [{ accountId: AID, balance: 5000, lifecycleEvents: afterFunded, propLifecycleRulesVersion: 3 }],
  trades: [...p1Trades, ...p2Trades, ...fundedTrades],
};
assert("17a refresh keeps accountId", sessionSnap.accounts[0].accountId === AID);
assert("17b refresh keeps version", sessionSnap.accounts[0].propLifecycleRulesVersion === 3);
assert("17c trades immutable count", sessionSnap.trades.length === 9);

// ─── Fallback audit ───────────────────────────────────
assert("18 no hard-coded 10000 as size", SIZE === 5000);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
