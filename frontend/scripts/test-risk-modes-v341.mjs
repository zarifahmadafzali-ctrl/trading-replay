/**
 * v3.41.0 — Risk modes, trading-day definition, payout balance (pure logic).
 * Mirrors frontend/src/lib/riskModel.ts + propRules.ts + accountLifecycle.ts
 */
function roundDownToStep(lot, step, minLot) {
  if (!Number.isFinite(lot) || lot <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  const steps = Math.floor(lot / step + 1e-12);
  const rounded = steps * step;
  const precision = Math.max(0, (step.toString().split(".")[1] || "").length);
  const v = Number(rounded.toFixed(precision));
  return v < minLot - 1e-12 ? 0 : v;
}

function calculateRisk({
  balance,
  leverage,
  riskMode = "percent_equity",
  riskPercent = 1,
  fixedRiskAmount = 0,
  fixedLot = 0,
  entry,
  stop,
  pointValue = 1,
  contractSize = 1,
  minLot = 0.01,
  maxLot = 100,
  lotStep = 0.01,
  instMax = 100,
  usedMargin = 0,
  openPnL = 0,
}) {
  const equity = balance + openPnL;
  const freeMargin = Math.max(0, equity - usedMargin);
  const slDistance = Math.abs(entry - stop);
  let riskAmount = 0;
  if (riskMode === "fixed_money") riskAmount = Math.max(0, fixedRiskAmount);
  else if (riskMode === "fixed_lot") riskAmount = 0;
  else riskAmount = equity * (Math.max(0, riskPercent) / 100);

  let riskBasedLot = null;
  if (riskMode === "fixed_lot") {
    riskBasedLot = fixedLot > 0 ? roundDownToStep(fixedLot, lotStep, minLot) : null;
  } else if (riskAmount > 0 && slDistance > 0 && pointValue > 0) {
    riskBasedLot = roundDownToStep(riskAmount / (slDistance * pointValue), lotStep, minLot);
  }
  const perLot = (entry * contractSize) / Math.max(1, leverage);
  const marginMaxLot = perLot > 0 ? roundDownToStep(freeMargin / perLot, lotStep, minLot) : 0;
  const candidates = [riskBasedLot, marginMaxLot, maxLot, instMax].filter((x) => x != null && x > 0);
  let finalLot = null;
  if (candidates.length) {
    finalLot = roundDownToStep(Math.min(...candidates), lotStep, minLot);
    if (!(finalLot > 0)) finalLot = null;
  }
  const actualRiskAmount = finalLot != null ? slDistance * pointValue * finalLot : null;
  if (riskMode === "fixed_lot" && riskAmount <= 0 && actualRiskAmount != null) riskAmount = actualRiskAmount;
  const marginConstrained =
    finalLot != null && riskBasedLot != null && finalLot + 1e-12 < riskBasedLot;
  return { riskAmount, riskBasedLot, marginMaxLot, finalLot, actualRiskAmount, marginConstrained, equity, freeMargin };
}

function utcDayKey(t) {
  const sec = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function auditTradingDays(trades, accountId, definition = "fill_and_close") {
  const byDay = new Map();
  for (const t of trades) {
    if (accountId && t.accountId && t.accountId !== accountId) continue;
    const hasEntry = t.entryTime != null;
    const hasExit = t.exitTime != null;
    let dayKey = null;
    if (definition === "any_fill") {
      if (!hasEntry) continue;
      dayKey = utcDayKey(t.entryTime);
    } else if (definition === "any_close") {
      if (!hasExit) continue;
      dayKey = utcDayKey(t.exitTime);
    } else {
      if (!hasEntry || !hasExit) continue;
      dayKey = utcDayKey(t.exitTime);
    }
    const acc = byDay.get(dayKey) || { filled: 0, closed: 0, pnl: 0 };
    if (hasEntry) acc.filled++;
    if (hasExit) {
      acc.closed++;
      if (t.currencyPnL != null) acc.pnl += t.currencyPnL;
    }
    byDay.set(dayKey, acc);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({
      date,
      filledTrades: v.filled,
      closedTrades: v.closed,
      netPnL: v.pnl,
      rule: definition,
    }));
}

function countTradingDays(trades, accountId, definition) {
  return auditTradingDays(trades, accountId, definition).length;
}

function applyPayoutBalance(account, amount, behavior = "no_reset", baseline) {
  if (!(amount > 0)) return account;
  const deducted = account.balance - amount;
  if (behavior === "reset_equity_to_baseline") {
    const base = baseline > 0 ? baseline : account.initialBalance || deducted;
    return { ...account, balance: base };
  }
  return { ...account, balance: deducted };
}

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    failed++;
  } else console.log("PASS", name);
}

// Mode C: % equity — equity 10100, 1% → $101
{
  const r = calculateRisk({
    balance: 10100,
    leverage: 20,
    riskMode: "percent_equity",
    riskPercent: 1,
    entry: 42000,
    stop: 41900,
    pointValue: 1,
  });
  assert("% equity riskAmount=101", Math.abs(r.riskAmount - 101) < 0.01);
  assert("% equity finalLot>0", r.finalLot != null && r.finalLot > 0);
}

// Mode B: fixed money $100
{
  const r = calculateRisk({
    balance: 10100,
    leverage: 20,
    riskMode: "fixed_money",
    fixedRiskAmount: 100,
    entry: 42000,
    stop: 41900,
    pointValue: 1,
  });
  assert("fixed money riskAmount=100", Math.abs(r.riskAmount - 100) < 0.01);
  assert("fixed money finalLot≈1.0", r.finalLot != null && Math.abs(r.finalLot - 1) < 0.02);
}

// Mode A: fixed lot 0.10
{
  const r = calculateRisk({
    balance: 10100,
    leverage: 20,
    riskMode: "fixed_lot",
    fixedLot: 0.1,
    entry: 42000,
    stop: 41900,
    pointValue: 1,
  });
  assert("fixed lot=0.10", r.finalLot != null && Math.abs(r.finalLot - 0.1) < 1e-9);
}

// Margin clamps large risk lot
{
  const r = calculateRisk({
    balance: 10100,
    leverage: 20,
    riskMode: "percent_equity",
    riskPercent: 50,
    entry: 42000,
    stop: 41900,
    pointValue: 1,
  });
  assert("marginMaxLot>0", r.marginMaxLot > 0);
  assert("finalLot<=riskBasedLot", r.finalLot != null && r.riskBasedLot != null && r.finalLot <= r.riskBasedLot + 1e-9);
  assert("marginConstrained", r.marginConstrained === true);
}

// riskLot 1.50 vs marginLot smaller → final = margin
{
  // Craft: risk wants ~1.5 lot, margin allows less
  // equity 3000, lev 20, entry 42000 → perLot=2100 → marginMax≈1.42
  // risk 5%, equity 3000 → riskAmt 150 → lot 1.5 at SL 100
  const r = calculateRisk({
    balance: 3000,
    leverage: 20,
    riskMode: "percent_equity",
    riskPercent: 5,
    entry: 42000,
    stop: 41900,
    pointValue: 1,
  });
  assert("example final <= margin", r.finalLot != null && r.finalLot <= r.marginMaxLot + 1e-9);
  assert("example final < pure risk when constrained", r.riskBasedLot != null && r.finalLot <= r.riskBasedLot + 1e-9);
}

// Trading days
{
  const day1 = Date.UTC(2026, 8, 29) / 1000; // Sep 29
  const day2 = Date.UTC(2026, 8, 30) / 1000;
  const trades = [
    { accountId: "a1", entryTime: day1 + 3600, exitTime: day1 + 7200, currencyPnL: 40 },
    { accountId: "a1", entryTime: day1 + 8000, exitTime: day1 + 9000, currencyPnL: 44 },
    { accountId: "a1", entryTime: day2 + 1000, exitTime: day2 + 2000, currencyPnL: -10 },
    { accountId: "a1", entryTime: day2 + 5000 }, // open only
  ];
  assert("fill_and_close=2", countTradingDays(trades, "a1", "fill_and_close") === 2);
  assert("any_fill>=2", countTradingDays(trades, "a1", "any_fill") >= 2);
  assert("no trades=0", countTradingDays([], "a1", "fill_and_close") === 0);
  assert("open-only fill_and_close=0", countTradingDays([{ accountId: "a1", entryTime: day1 }], "a1", "fill_and_close") === 0);
  assert("open-only any_fill=1", countTradingDays([{ accountId: "a1", entryTime: day1 }], "a1", "any_fill") === 1);
  const audit = auditTradingDays(trades, "a1", "fill_and_close");
  assert("audit len=2", audit.length === 2);
  assert("audit has netPnL", audit[0].netPnL === 84);
  assert("audit rule stamped", audit[0].rule === "fill_and_close");
  // same day multi-trade = 1 day
  assert("same day multi = 1", countTradingDays(trades.slice(0, 2), "a1", "fill_and_close") === 1);
}

// Payout balance
{
  const a = { balance: 10800, initialBalance: 10000 };
  assert("no_reset → 10400", Math.abs(applyPayoutBalance(a, 400, "no_reset").balance - 10400) < 0.01);
  assert("reset baseline → 10000", Math.abs(applyPayoutBalance(a, 400, "reset_equity_to_baseline", 10000).balance - 10000) < 0.01);
  assert("history not deleted", applyPayoutBalance(a, 400, "no_reset").initialBalance === 10000);
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll v3.41.0 risk-mode / trading-day / payout tests PASS");
process.exit(0);
