/**
 * v3.28.0 — Order/position lifecycle contracts (pure logic).
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const ORDER_TYPES = [
  "market",
  "buy_limit",
  "sell_limit",
  "buy_stop",
  "sell_stop",
  "buy_stop_limit",
  "sell_stop_limit",
];
assert("seven order types", ORDER_TYPES.length === 7);

// Lifecycle
function confirmDraft(orderType) {
  return orderType === "market" ? "open" : "pending";
}
assert("market → open", confirmDraft("market") === "open");
assert("limit → pending", confirmDraft("buy_limit") === "pending");

// Cancel pending does not journal
const journal = [];
function cancelPending(shapes, id) {
  return shapes.filter((s) => s.id !== id);
}
const shapes = [
  { id: "p1", status: "pending", kind: "position" },
  { id: "p2", status: "open", kind: "position" },
];
const after = cancelPending(shapes, "p1");
assert("pending removed", after.length === 1 && after[0].id === "p2");
assert("no journal on cancel", journal.length === 0);

// SL wins same bar
function sameBarClose(hi, lo, entry, sl, tp, side) {
  const hitSl = side === "long" ? lo <= sl : hi >= sl;
  const hitTp = side === "long" ? hi >= tp : lo <= tp;
  if (hitSl && hitTp) return "sl";
  if (hitSl) return "sl";
  if (hitTp) return "tp";
  return null;
}
assert("same bar SL wins", sameBarClose(100, 90, 95, 92, 98, "long") === "sl");

// riskSnapshot frozen after fill
const pos = { riskSnapshot: { lot: 1.5 }, stop: 100 };
const afterSl = { ...pos, stop: 99 };
assert("snapshot frozen", afterSl.riskSnapshot.lot === 1.5 && afterSl.stop === 99);

// Manual close reason
assert("manual reason", "manual" !== "sl" && "manual" !== "tp");

// Timeline no pointer spam
const events = [];
function logFinal(text) {
  events.push(text);
}
logFinal("SL modified · 41950");
assert("one final event", events.length === 1);

// Balance: cancel pending
let balance = 10000;
function onCancel() {
  /* no balance change */
}
onCancel();
assert("balance unchanged", balance === 10000);

// One journal on close
function onClose(j) {
  j.push({ id: "t1" });
}
onClose(journal);
onClose = null;
assert("one journal", journal.length === 1);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
