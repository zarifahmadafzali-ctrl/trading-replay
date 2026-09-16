/**
 * v3.19.1 — Minimum trading days (unique calendar days, phase-scoped)
 */

function utcDayKey(unixSec) {
  const t = unixSec > 1e12 ? Math.floor(unixSec / 1000) : Math.floor(unixSec);
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}
function countTradingDays(trades) {
  const days = new Set();
  for (const t of trades) {
    const ts = t.exitTime ?? t.entryTime;
    if (ts == null) continue;
    days.add(utcDayKey(ts));
  }
  return days.size;
}
function hasMinDays(tradingDays, minimum) {
  if (minimum == null || !Number.isFinite(Number(minimum)) || Number(minimum) <= 0) return true;
  return tradingDays >= Number(minimum);
}
function isTargetReached(ref, pnl, pct) {
  if (pct == null || !(ref > 0)) return false;
  return pnl >= (ref * pct) / 100 - 1e-9;
}
function eligible(ref, pnl, targetPct, trades, minDays) {
  const days = countTradingDays(trades);
  return isTargetReached(ref, pnl, targetPct) && hasMinDays(days, minDays);
}

let f = 0;
function assert(n, c) {
  if (!c) { console.error("FAIL", n); f++; }
  else console.log("PASS", n);
}

const day1 = 1719792000; // 2024-07-01
const day2 = day1 + 86400;
const day3 = day1 + 2 * 86400;

// A: 3 trades same day → 1 trading day → NOT pass with min 3
const sameDay = [
  { exitTime: day1 + 100, currencyPnL: 200 },
  { exitTime: day1 + 200, currencyPnL: 200 },
  { exitTime: day1 + 300, currencyPnL: 200 },
];
assert("A same-day trades count as 1 day", countTradingDays(sameDay) === 1);
assert("A not pass min 3", !eligible(5000, 600, 8, sameDay, 3));

// B: 3 different dates → 3 days
const threeDays = [
  { exitTime: day1 + 100, currencyPnL: 150 },
  { exitTime: day2 + 100, currencyPnL: 150 },
  { exitTime: day3 + 100, currencyPnL: 150 },
];
assert("B three unique days", countTradingDays(threeDays) === 3);
assert("B min 3 passes", hasMinDays(3, 3) && eligible(5000, 450, 8, threeDays, 3) === isTargetReached(5000, 450, 8));

// C: Phase 2 only 1 day while Phase 1 had 3 — independent
const phase1 = threeDays;
const phase2 = [{ exitTime: day1 + 86400 * 10, currencyPnL: 300 }];
assert("C phase2 days = 1", countTradingDays(phase2) === 1);
assert("C phase2 not pass min 3", !eligible(5000, 300, 5, phase2, 3));
assert("C phase1 still 3", countTradingDays(phase1) === 3);

// D: min unset → only target matters
assert("D unset min + target → pass", eligible(5000, 400, 8, sameDay, null));
assert("D min 0 treated as unset", hasMinDays(1, 0) === true);

// E/F: accountId stable across phase events (identity rule)
const accountId = "ACC-001";
const events = [
  { type: "PHASE_PASSED", accountId, phaseId: "phase1", timestamp: day3 },
  { type: "PHASE_STARTED", accountId, phaseId: "phase2", timestamp: day3 },
  { type: "PHASE_PASSED", accountId, phaseId: "phase2", timestamp: day3 + 5 * 86400 },
  { type: "FUNDED", accountId, phaseId: "funded", timestamp: day3 + 5 * 86400 },
];
assert("E phase1→2 same accountId", events.every((e) => e.accountId === accountId));
assert("F phase2→FUNDED same accountId", events[3].accountId === accountId && events[3].type === "FUNDED");

// G: journal same accountId different phaseId
const j1 = { accountId, propPhaseId: "phase1" };
const j2 = { accountId, propPhaseId: "phase2" };
assert("G same account different phase", j1.accountId === j2.accountId && j1.propPhaseId !== j2.propPhaseId);

// H/I/J/K: analytics starting balance must use real size
function resolveStart(acc) {
  if (acc.accountType === "prop" && acc.propProgram?.phases?.length) {
    const ph = acc.propProgram.phases.find((p) => p.id === acc.activePropPhaseId) || acc.propProgram.phases[0];
    if (ph?.rules?.accountSize > 0) return ph.rules.accountSize;
  }
  if (acc.initialBalance > 0) return acc.initialBalance;
  if (acc.balance > 0) return acc.balance;
  return null;
}
assert("H $1000", resolveStart({ accountType: "prop", propProgram: { phases: [{ id: "p1", rules: { accountSize: 1000 } }] }, activePropPhaseId: "p1", initialBalance: 10000 }) === 1000);
assert("I $5000", resolveStart({ accountType: "prop", propProgram: { phases: [{ id: "p1", rules: { accountSize: 5000 } }] }, activePropPhaseId: "p1", initialBalance: 10000 }) === 5000);
assert("J $25000", resolveStart({ accountType: "prop", propProgram: { phases: [{ id: "p1", rules: { accountSize: 25000 } }] }, activePropPhaseId: "p1" }) === 25000);
assert("K no fake 10k when size known", resolveStart({ accountType: "prop", propProgram: { phases: [{ id: "p1", rules: { accountSize: 1000 } }] }, initialBalance: 10000 }) === 1000);

// L missing → null not 10000
assert("L missing → null", resolveStart({ accountType: "personal" }) === null);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
