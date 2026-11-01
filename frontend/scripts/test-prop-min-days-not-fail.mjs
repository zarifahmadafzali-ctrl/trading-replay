/**
 * v3.45.11 — Minimum trading days is a PASS GATE only; never alone fails the account.
 * Challenge time limit is calendar days from first entry (optional).
 */
import assert from "node:assert/strict";

// Minimal mirrors of the pure helpers (keep in sync with propRules.ts semantics)
function hasMinimumTradingDays(tradingDays, minimum) {
  if (minimum == null || !Number.isFinite(Number(minimum)) || Number(minimum) <= 0) return true;
  return tradingDays >= Number(minimum);
}
function hasExceededMaximumTradingDays(tradingDays, maximum) {
  if (maximum == null || !Number.isFinite(Number(maximum)) || Number(maximum) <= 0) return false;
  return tradingDays > Number(maximum);
}
function isChallengeTimeLimitBreached(firstEntryUnix, currentTimeUnix, limitDays) {
  if (limitDays == null || !Number.isFinite(Number(limitDays)) || Number(limitDays) <= 0) return false;
  if (firstEntryUnix == null || !Number.isFinite(firstEntryUnix)) return false;
  const elapsedSec = currentTimeUnix - firstEntryUnix;
  if (elapsedSec < 0) return false;
  return elapsedSec > Number(limitDays) * 86400;
}

function evaluate({ tradingDays, minDays, maxDays, timeLimitDays, firstEntry, now, profitReached, dailyBreach, overallBreach }) {
  const minReached = hasMinimumTradingDays(tradingDays, minDays);
  const maxBreach = hasExceededMaximumTradingDays(tradingDays, maxDays);
  const timeBreach = isChallengeTimeLimitBreached(firstEntry, now, timeLimitDays);
  // SAFETY: min days never in failed
  const failed = !!(dailyBreach || overallBreach || maxBreach || timeBreach);
  const eligible = !!(profitReached && minReached && !failed);
  return { minReached, failed, eligible };
}

let f = 0;
function check(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    f++;
  } else console.log("PASS", name);
}

// A: 1 of 3 min days, no other breach → NOT failed, NOT eligible
{
  const r = evaluate({ tradingDays: 1, minDays: 3, profitReached: false });
  check("A still trading when min days incomplete", r.failed === false && r.eligible === false && r.minReached === false);
}
// B: 3 of 3 min days, no profit → NOT failed, NOT eligible
{
  const r = evaluate({ tradingDays: 3, minDays: 3, profitReached: false });
  check("B min met alone does not pass or fail", r.failed === false && r.eligible === false && r.minReached === true);
}
// C: 3 of 3 + profit → eligible
{
  const r = evaluate({ tradingDays: 3, minDays: 3, profitReached: true });
  check("C min+target → eligible", r.failed === false && r.eligible === true);
}
// D: profit but only 2/3 days → not eligible, not failed
{
  const r = evaluate({ tradingDays: 2, minDays: 3, profitReached: true });
  check("D target without min days → not pass, not fail", r.failed === false && r.eligible === false);
}
// E: daily breach fails even with min incomplete
{
  const r = evaluate({ tradingDays: 1, minDays: 3, dailyBreach: true });
  check("E daily breach fails", r.failed === true);
}
// F: calendar time limit 60d exceeded → fail
{
  const first = 1_000_000;
  const now = first + 61 * 86400;
  const r = evaluate({ tradingDays: 10, minDays: 3, profitReached: true, timeLimitDays: 60, firstEntry: first, now });
  check("F time limit breach fails", r.failed === true && r.eligible === false);
}
// G: within 60d + min + target → pass
{
  const first = 1_000_000;
  const now = first + 20 * 86400;
  const r = evaluate({ tradingDays: 5, minDays: 3, profitReached: true, timeLimitDays: 60, firstEntry: first, now });
  check("G within time limit + min + target → eligible", r.failed === false && r.eligible === true);
}
// H: no time limit configured → never time-fail
{
  const r = evaluate({ tradingDays: 100, minDays: 3, profitReached: true, timeLimitDays: null, firstEntry: 1, now: 1 + 999 * 86400 });
  check("H no time limit never time-fails", r.failed === false && r.eligible === true);
}

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
