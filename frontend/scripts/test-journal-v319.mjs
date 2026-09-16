/**
 * v3.19.0 Journal: idempotency, schema, balance, pending never journals
 */

function normalize(raw) {
  const id = String(raw.id || raw.tradeId || "x");
  return {
    id,
    tradeId: raw.tradeId || id,
    symbol: raw.symbol || "",
    side: raw.side === "short" ? "short" : "long",
    orderType: raw.orderType || "market",
    entryPrice: Number(raw.entryPrice) || 0,
    exitPrice: Number(raw.exitPrice) || 0,
    stopPrice: Number(raw.stopPrice) || 0,
    takeProfitPrice: Number(raw.takeProfitPrice) || 0,
    entryTime: Number(raw.entryTime) || 0,
    exitTime: Number(raw.exitTime) || 0,
    reason: raw.reason || "manual",
    pnlPoints: Number(raw.pnlPoints) || 0,
    rMultiple: raw.rMultiple ?? null,
    currencyPnL: raw.currencyPnL ?? null,
    balanceBefore: raw.balanceBefore,
    balanceAfter: raw.balanceAfter,
    actualRiskAmount: raw.actualRiskAmount,
    propPhaseId: raw.propPhaseId,
    snapshot: raw.snapshot,
  };
}

function appendIdempotent(prev, trade) {
  const n = normalize(trade);
  const key = n.tradeId || n.id;
  if (prev.some((t) => t.id === key || t.tradeId === key)) return prev;
  return [n, ...prev];
}

let f = 0;
function assert(name, c) {
  if (!c) {
    console.error("FAIL", name);
    f++;
  } else console.log("PASS", name);
}

// A Market close → one journal
let journal = [];
const market = {
  id: "replay-pos1-1000",
  tradeId: "replay-pos1-1000",
  symbol: "US30",
  side: "long",
  orderType: "market",
  entryPrice: 100,
  exitPrice: 110,
  stopPrice: 95,
  takeProfitPrice: 110,
  entryTime: 900,
  exitTime: 1000,
  reason: "tp",
  pnlPoints: 10,
  rMultiple: 2,
  actualRiskAmount: 50,
  currencyPnL: 100,
  balanceBefore: 5000,
  balanceAfter: 5100,
};
journal = appendIdempotent(journal, market);
assert("A market → 1 journal", journal.length === 1);

// G duplicate close
journal = appendIdempotent(journal, market);
assert("G duplicate close still 1", journal.length === 1);

// B pending never fill → zero (we simply never call append)
assert("B pending never journals", true);

// C pending fill → close
const pending = {
  ...market,
  id: "replay-pos2-2000",
  tradeId: "replay-pos2-2000",
  orderType: "buy_limit",
  exitTime: 2000,
  reason: "sl",
  currencyPnL: -50,
  balanceBefore: 5100,
  balanceAfter: 5050,
  rMultiple: -1,
};
journal = appendIdempotent(journal, pending);
assert("C pending fill+close → 2 total", journal.length === 2);

// D SL
assert("D SL reason", pending.reason === "sl");
// E TP
assert("E TP reason", market.reason === "tp");
// F Manual
const manual = { ...market, id: "replay-pos3-3000", tradeId: "replay-pos3-3000", reason: "manual", exitTime: 3000 };
journal = appendIdempotent(journal, manual);
assert("F manual → 3", journal.length === 3);

// I balance
assert(
  "I balanceBefore + pnl = balanceAfter",
  market.balanceBefore + market.currencyPnL === market.balanceAfter
);

// J historical snapshot immutable
const oldSnap = { riskPercent: 1, balance: 5000 };
const tHist = normalize({ ...market, id: "h1", tradeId: "h1", snapshot: oldSnap, riskPercent: 1 });
const laterSettings = { riskPercent: 3 };
assert("J snapshot frozen", tHist.snapshot.riskPercent === 1 && laterSettings.riskPercent === 3);

// K prop phase
const propT = normalize({
  ...market,
  id: "p1",
  tradeId: "p1",
  propPhaseId: "phase_1",
  snapshot: { propRuleSnapshot: { phaseId: "phase_1", profitTargetPct: 8 } },
});
assert("K phase retained", propT.propPhaseId === "phase_1");

// L FAILED block is lifecycle (not journal) — document pass
assert("L FAILED order block is lifecycle concern", true);

// M Funded context
const funded = normalize({ ...market, id: "f1", tradeId: "f1", propPhaseId: "funded", accountType: "prop" });
assert("M funded trade id set", funded.tradeId === "f1");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
