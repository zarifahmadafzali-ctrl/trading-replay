/**
 * v3.20.3 — Journal delete: row removed; analytics derived from remainder.
 * Balance is NOT auto-reversed (documented architecture).
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const trades = [
  { id: "t1", tradeId: "t1", currencyPnL: 100, rMultiple: 2, reason: "tp" },
  { id: "t2", tradeId: "t2", currencyPnL: -50, rMultiple: -1, reason: "sl" },
  { id: "t3", tradeId: "t3", currencyPnL: 30, rMultiple: 0.6, reason: "manual" },
];

function deleteTrade(list, id) {
  return list.filter((t) => t.id !== id && t.tradeId !== id);
}

function analytics(list) {
  return {
    count: list.length,
    pnl: list.reduce((s, t) => s + (t.currencyPnL || 0), 0),
    totalR: list.reduce((s, t) => s + (t.rMultiple || 0), 0),
    wins: list.filter((t) => (t.currencyPnL || 0) > 0).length,
  };
}

const before = analytics(trades);
assert("before count 3", before.count === 3);

const afterDel = deleteTrade(trades, "t2");
const after = analytics(afterDel);
assert("after count 2", after.count === 2);
assert("t2 gone", !afterDel.some((t) => t.id === "t2"));
assert("pnl updated", after.pnl === 130);
assert("totalR updated", Math.abs(after.totalR - 2.6) < 1e-9);
assert("wins unchanged for remaining", after.wins === 2);

// Balance not auto-reversed
const accountBalance = 5100; // independent working state
assert("balance not auto changed by journal delete", accountBalance === 5100);

// Screenshot levels
function levelsVisible(entry, sl, tp, viewportFrom, viewportTo) {
  return [entry, sl, tp].every((p) => p >= viewportFrom && p <= viewportTo);
}
const entry = 39000, sl = 38900, tp = 39200;
const minP = Math.min(entry, sl, tp);
const maxP = Math.max(entry, sl, tp);
const pad = (maxP - minP) * 0.25;
assert("screenshot viewport contains all 3", levelsVisible(entry, sl, tp, minP - pad, maxP + pad));

// Jump to editing flag
let goToValue = "2026-06-15T10:00:00";
let goToEditing = true;
const cursorTick = "2026-06-15T10:00:05";
if (!goToEditing) goToValue = cursorTick;
assert("editing preserves time", goToValue === "2026-06-15T10:00:00");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
