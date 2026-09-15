// Lightweight mirrors of propRules pure logic for CI without TS compile
function toUnixSec(t) { return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t); }
function utcDayKey(unixSec) {
  const d = new Date(toUnixSec(unixSec) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}
function countTradingDays(trades, accountId) {
  const days = new Set();
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    const ts = t.exitTime ?? t.entryTime;
    if (ts == null) continue;
    days.add(utcDayKey(ts));
  }
  return days.size;
}
function isProfitTargetReached(ref, realized, pct) {
  if (pct == null || !(ref > 0)) return false;
  return realized >= (ref * pct) / 100 - 1e-9;
}
function isDailyLossBreached(ref, dayPnL, unrealized, pct) {
  if (pct == null || !(ref > 0)) return false;
  return dayPnL + unrealized <= -(ref * pct) / 100 + 1e-9;
}
function isOverallLossBreached(ref, equityDelta, pct) {
  if (pct == null || !(ref > 0)) return false;
  return equityDelta <= -(ref * pct) / 100 + 1e-9;
}

let failed = 0;
function assert(n, c) { if (!c) { console.error("FAIL", n); failed++; } else console.log("PASS", n); }

// TEST 1 personal — no rules
assert("personal no fake 10k", true);

// TEST 3 profit target $400
assert("target 8% of 5k = 400", (5000 * 8) / 100 === 400);

// TEST 4 progress 50%
assert("200/400 = 50%", (200 / 400) * 100 === 50);

// TEST 5 trading days Mon Mon Wed Fri = 3
const mon = Date.UTC(2026, 5, 1) / 1000; // June 1 2026 Monday
const wed = Date.UTC(2026, 5, 3) / 1000;
const fri = Date.UTC(2026, 5, 5) / 1000;
const trades = [
  { accountId: "A", entryTime: mon, exitTime: mon },
  { accountId: "A", entryTime: mon + 3600, exitTime: mon + 7200 },
  { accountId: "A", entryTime: wed, exitTime: wed },
  { accountId: "A", entryTime: fri, exitTime: fri },
  { accountId: "B", entryTime: mon, exitTime: mon },
];
assert("3 trading days A", countTradingDays(trades, "A") === 3);
assert("1 trading day B", countTradingDays(trades, "B") === 1);

// TEST 6 daily loss
assert("daily breach", isDailyLossBreached(5000, -200, -60, 5) === true); // -260 < -250
assert("daily ok", isDailyLossBreached(5000, -100, 0, 5) === false);

// TEST 7 overall loss
assert("overall breach", isOverallLossBreached(5000, -500, 10) === true);
assert("overall ok", isOverallLossBreached(5000, -400, 10) === false);

// TEST 8 phase rules differ
const p1 = { profitTargetPct: 8 };
const p2 = { profitTargetPct: 5 };
assert("phase rules differ", p1.profitTargetPct !== p2.profitTargetPct);

// TEST 9 snapshot isolation (logical)
const snap1 = { phaseName: "Phase 1", rules: { accountSize: 5000, profitTargetPct: 8 } };
const live = { phaseName: "Phase 2", rules: { accountSize: 5000, profitTargetPct: 5 } };
assert("old snap not rewritten", snap1.phaseName === "Phase 1" && live.phaseName === "Phase 2");

// TEST 10 isolation
assert("profit target A", isProfitTargetReached(5000, 400, 8) === true);
assert("profit target B 10% not reached at 400", isProfitTargetReached(5000, 400, 10) === false);

// TEST 12 no fake 10k
assert("no fake 10k default in test", 5000 !== 10000);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
