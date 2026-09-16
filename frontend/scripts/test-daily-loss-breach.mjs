/**
 * v3.18.2.1 regression: multi-trade same-day daily loss aggregation → FAILED
 * Mirrors evaluatePropRules + suggestLifecycleTransitions semantics.
 */

function toUnixSec(t) {
  return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
}
function utcDayKey(unixSec) {
  const d = new Date(toUnixSec(unixSec) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dayRealizedPnL(trades, dayKey, accountId) {
  let sum = 0;
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    if (t.exitTime == null) continue;
    if (utcDayKey(t.exitTime) !== dayKey) continue;
    if (t.currencyPnL != null) sum += t.currencyPnL;
  }
  return sum;
}
function isDailyLossBreached(ref, dayPnL, unrealized, pct) {
  if (pct == null || !(ref > 0)) return false;
  const limit = (ref * pct) / 100;
  return dayPnL + unrealized <= -limit + 1e-9;
}
function isOverallLossBreached(ref, equityDelta, pct) {
  if (pct == null || !(ref > 0)) return false;
  const limit = (ref * pct) / 100;
  return equityDelta <= -limit + 1e-9;
}

function evaluate(account, trades, currentTime, dailyPct = 5, overallPct = 10) {
  const ref = account.initialBalance || account.balance;
  const dayKey = utcDayKey(currentTime);
  const todayPnL = dayRealizedPnL(trades, dayKey, account.accountId);
  const realized = trades
    .filter((t) => !t.accountId || t.accountId === account.accountId)
    .reduce((s, t) => s + (t.currencyPnL || 0), 0);
  const dailyLossBreached = isDailyLossBreached(ref, todayPnL, 0, dailyPct);
  const maxOverallLossBreached = isOverallLossBreached(ref, realized, overallPct);
  const failed = dailyLossBreached || maxOverallLossBreached;
  const todayLossPct = todayPnL < 0 && ref > 0 ? (Math.abs(todayPnL) / ref) * 100 : 0;
  return { failed, dailyLossBreached, maxOverallLossBreached, todayPnL, todayLossPct, realized };
}

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const account = { accountId: "a1", initialBalance: 10000, balance: 10000 };
const day = 1719792000; // 2024-07-01 UTC
const t1 = { accountId: "a1", exitTime: day + 3600, currencyPnL: -200 };
const t2 = { accountId: "a1", exitTime: day + 7200, currencyPnL: -180 };
const t3 = { accountId: "a1", exitTime: day + 10800, currencyPnL: -220 };

// BUG reproduction: only last trade → no breach
const onlyLast = evaluate(account, [t3], day + 10800);
assert("A single -220 alone does NOT breach 5%", !onlyLast.dailyLossBreached);

// Correct aggregation
const after1 = evaluate(account, [t1], day + 3600);
assert("B after -2% still active", !after1.failed && after1.todayLossPct === 2);

const after2 = evaluate(account, [t1, t2], day + 7200);
assert("C after -3.8% still active", !after2.failed && Math.abs(after2.todayLossPct - 3.8) < 1e-9);

const after3 = evaluate(account, [t1, t2, t3], day + 10800);
assert("D after -6% FAILED daily", after3.failed && after3.dailyLossBreached);
assert("E todayLossPct ~6%", Math.abs(after3.todayLossPct - 6) < 1e-9);
assert("F overall not necessarily max-loss at -6%", !after3.maxOverallLossBreached);

// Boundary: exactly -5%
const exact = evaluate(account, [{ accountId: "a1", exitTime: day + 1, currencyPnL: -500 }], day + 1);
assert("G exact -5% breaches (inclusive)", exact.dailyLossBreached);

// Next calendar day metric reset (but lifecycle stays failed if event exists)
const day2 = day + 86400;
const day2Trade = { accountId: "a1", exitTime: day2 + 100, currencyPnL: -50 };
const day2Eval = evaluate(account, [t1, t2, t3, day2Trade], day2 + 100);
assert("H day2 metric is only -0.5% (reset)", Math.abs(day2Eval.todayLossPct - 0.5) < 1e-9);
assert("I day2 alone does not daily-breach", !day2Eval.dailyLossBreached);
// overall still -650 → not 10%
assert("J overall still under 10%", !day2Eval.maxOverallLossBreached);

// Overall independent
const overallTrades = [];
let cum = 0;
for (let i = 0; i < 12; i++) {
  // 12 days × -100 = -1200 = 12% overall, each day 1%
  overallTrades.push({ accountId: "a1", exitTime: day + i * 86400 + 100, currencyPnL: -100 });
  cum -= 100;
}
const overallEval = evaluate(account, overallTrades, day + 11 * 86400 + 100, 5, 10);
assert("K overall breach independent of daily", overallEval.maxOverallLossBreached && !overallEval.dailyLossBreached);

// Backward determinism: evaluate only trades <= 11:00 → active
const mid = evaluate(account, [t1, t2, t3].filter((x) => x.exitTime <= day + 7200), day + 7200);
assert("L backward to after trade2 = active", !mid.failed);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
