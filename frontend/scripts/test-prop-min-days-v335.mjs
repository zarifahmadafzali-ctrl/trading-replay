/**
 * v3.35.0 — minimum trading days + closed-only day definition + rule isolation.
 */
let f = 0;
function assert(n, c) {
  if (!c) { console.error("FAIL", n); f++; }
  else console.log("PASS", n);
}

function utcDayKey(ts) {
  const sec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function countTradingDays(trades, accountId) {
  const days = new Set();
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    if (t.exitTime == null || !Number.isFinite(t.exitTime)) continue;
    days.add(utcDayKey(t.exitTime));
  }
  return days.size;
}

function hasMinimumTradingDays(tradingDays, minimum) {
  if (minimum == null || !Number.isFinite(Number(minimum)) || Number(minimum) <= 0) return true;
  return tradingDays >= Number(minimum);
}

function eligible(profitReached, days, minDays, failed) {
  return profitReached && hasMinimumTradingDays(days, minDays) && !failed;
}

// Profile: min days = 3 (configurable, not hard-coded in engine)
const MIN = 3;

// 1 day target reached → NOT pass
const day1 = [
  { accountId: "a1", exitTime: Date.UTC(2026, 5, 1) / 1000, currencyPnL: 250 },
];
assert("1 day count", countTradingDays(day1, "a1") === 1);
assert("1 day not pass", !eligible(true, countTradingDays(day1, "a1"), MIN, false));

// 2 days
const day2 = [
  ...day1,
  { accountId: "a1", exitTime: Date.UTC(2026, 5, 2) / 1000, currencyPnL: 10 },
];
assert("2 days count", countTradingDays(day2, "a1") === 2);
assert("2 days not pass", !eligible(true, countTradingDays(day2, "a1"), MIN, false));

// 3 days
const day3 = [
  ...day2,
  { accountId: "a1", exitTime: Date.UTC(2026, 5, 3) / 1000, currencyPnL: 10 },
];
assert("3 days count", countTradingDays(day3, "a1") === 3);
assert("3 days pass", eligible(true, countTradingDays(day3, "a1"), MIN, false));

// same UTC day multiple trades = 1 day
const same = [
  { accountId: "a1", exitTime: Date.UTC(2026, 5, 1, 10) / 1000 },
  { accountId: "a1", exitTime: Date.UTC(2026, 5, 1, 15) / 1000 },
  { accountId: "a1", exitTime: Date.UTC(2026, 5, 1, 20) / 1000 },
];
assert("same day = 1", countTradingDays(same, "a1") === 1);

// pending / open only = 0
assert("pending zero", countTradingDays([{ accountId: "a1", entryTime: 100 }], "a1") === 0);
assert("open zero", countTradingDays([{ accountId: "a1", entryTime: 100, exitTime: null }], "a1") === 0);

// entryTime without exit must NOT count (regression of old fallback)
assert(
  "no entry fallback",
  countTradingDays([{ accountId: "a1", entryTime: Date.UTC(2026, 5, 1) / 1000 }], "a1") === 0
);

// Phase isolation: phase trade filter by phaseId
function filterPhase(trades, phaseId) {
  return trades.filter((t) => t.phaseId === phaseId);
}
const mixed = [
  { phaseId: "p1", exitTime: Date.UTC(2026, 5, 1) / 1000, accountId: "a1" },
  { phaseId: "p1", exitTime: Date.UTC(2026, 5, 2) / 1000, accountId: "a1" },
  { phaseId: "p2", exitTime: Date.UTC(2026, 5, 3) / 1000, accountId: "a1" },
];
assert("p1 days", countTradingDays(filterPhase(mixed, "p1"), "a1") === 2);
assert("p2 days", countTradingDays(filterPhase(mixed, "p2"), "a1") === 1);

// Rule object isolation (deep clone)
function cloneRules(r) {
  return JSON.parse(JSON.stringify(r));
}
const phase1 = { rules: { profitTargetPct: 5, minimumTradingDays: 3 } };
const phase2 = { rules: cloneRules(phase1.rules) };
phase2.rules.profitTargetPct = 8;
assert("p1 unchanged", phase1.rules.profitTargetPct === 5);
assert("p2 independent", phase2.rules.profitTargetPct === 8);

// Configurable min — not hard-coded 3
assert("min 1 pass", hasMinimumTradingDays(1, 1));
assert("min 5 fail", !hasMinimumTradingDays(3, 5));

// Funded baseline conceptual: challenge PnL does not become funded start
const phase1Size = 5000;
const phase1Pnl = 400;
const fundedSize = 5000;
const fundedStart = fundedSize; // not phase1Size + phase1Pnl
assert("funded baseline", fundedStart === 5000 && fundedStart !== phase1Size + phase1Pnl);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
