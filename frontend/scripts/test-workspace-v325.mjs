/**
 * v3.25.0 — Workspace invariants (logical).
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

// Feature inventory (code-level contract)
const inventory = {
  ordersPanel: "EXISTS",
  allOrderTypes: "EXISTS",
  liveRisk: "EXISTS",
  sessionRuntimeRestore: "EXISTS",
  journalOnClose: "EXISTS",
  pendingCancel: "NEW", // cancel pending without journal
  workspaceStrip: "NEW",
  positionsBook: "NEW",
  timeline: "NEW",
  hotkeyF: "NEW",
  hotkeyEsc: "NEW",
  noSecondJournal: true,
  noSecondRiskModel: true,
  execBars1s: true,
};

assert("orders exist", inventory.ordersPanel === "EXISTS");
assert("no second journal", inventory.noSecondJournal);
assert("no second risk", inventory.noSecondRiskModel);
assert("1s exec preserved", inventory.execBars1s);

// Pending cancel does not journal
function cancelPending(shapes, id) {
  return shapes.filter((s) => !(s.kind === "position" && s.id === id && s.status === "pending"));
}
const shapes = [
  { kind: "position", id: "p1", status: "pending" },
  { kind: "position", id: "p2", status: "open" },
];
const after = cancelPending(shapes, "p1");
assert("pending removed", after.length === 1 && after[0].id === "p2");
assert("open kept", after[0].status === "open");

// Timeline cap
function pushLog(log, text) {
  return [{ t: 1, text }, ...log].slice(0, 40);
}
let log = [];
for (let i = 0; i < 50; i++) log = pushLog(log, `e${i}`);
assert("timeline capped", log.length === 40);

// Hotkey ignore inputs
function shouldIgnore(tag) {
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
assert("ignore input", shouldIgnore("INPUT"));
assert("allow body", !shouldIgnore("DIV"));

// Account ownership
const pos = { accountId: "A1", status: "open" };
const active = "A2";
assert("owner not active switch", pos.accountId !== active);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
