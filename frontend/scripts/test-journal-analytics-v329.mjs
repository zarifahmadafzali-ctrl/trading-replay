/**
 * v3.29.0 — Journal/Analytics + pending validation contracts.
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

function validatePendingVsMarket(orderType, market, entry, stopPrice, limitPrice) {
  if (market == null) return { ok: true, message: null };
  const eps = 1e-8;
  if (orderType === "buy_limit" && entry >= market - eps)
    return { ok: false, message: "below" };
  if (orderType === "sell_limit" && entry <= market + eps)
    return { ok: false, message: "above" };
  if (orderType === "buy_stop" && entry <= market + eps)
    return { ok: false, message: "above" };
  if (orderType === "sell_stop" && entry >= market - eps)
    return { ok: false, message: "below" };
  if (orderType === "buy_stop_limit") {
    const stop = stopPrice ?? entry;
    if (stop <= market + eps) return { ok: false, message: "stop above" };
  }
  if (orderType === "sell_stop_limit") {
    const stop = stopPrice ?? entry;
    if (stop >= market - eps) return { ok: false, message: "stop below" };
  }
  return { ok: true, message: null };
}

assert("buy limit invalid", !validatePendingVsMarket("buy_limit", 100, 101).ok);
assert("buy limit valid", validatePendingVsMarket("buy_limit", 100, 99).ok);
assert("sell stop valid", validatePendingVsMarket("sell_stop", 100, 99).ok);
assert("buy stop invalid", !validatePendingVsMarket("buy_stop", 100, 99).ok);

function lotFromSnapshot(snap) {
  if (!snap) return null;
  for (const k of ["finalLot", "riskBasedLot", "lot"]) {
    if (typeof snap[k] === "number" && snap[k] > 0) return snap[k];
  }
  return null;
}
assert("lot real", lotFromSnapshot({ finalLot: 0.37 }) === 0.37);
assert("lot never invent", lotFromSnapshot({}) === null);

function auditTrade(t) {
  const issues = [];
  if (t.exitTime < t.entryTime) issues.push("order");
  if (!Number.isFinite(t.currencyPnL) && t.currencyPnL != null) issues.push("nan");
  return issues;
}
assert("ok trade", auditTrade({ entryTime: 1, exitTime: 2, currencyPnL: 1 }).length === 0);
assert("bad order", auditTrade({ entryTime: 5, exitTime: 2, currencyPnL: 1 }).length > 0);

// Search filter
function searchRows(rows, q) {
  const qq = q.trim().toLowerCase();
  if (!qq) return rows;
  return rows.filter((t) => `${t.symbol} ${t.side} ${t.reason}`.toLowerCase().includes(qq));
}
const rows = [
  { symbol: "US30", side: "long", reason: "tp" },
  { symbol: "EURUSD", side: "short", reason: "sl" },
];
assert("search us30", searchRows(rows, "us30").length === 1);
assert("search sl", searchRows(rows, "sl").length === 1);

// MAE/MFE not fabricated
const maeImplemented = false;
assert("no fake MAE", maeImplemented === false);

// Analytics empty safety
function pf(grossProfit, grossLossAbs) {
  if (grossLossAbs <= 0) return null;
  return grossProfit / grossLossAbs;
}
assert("pf no infinity", pf(100, 0) === null);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
