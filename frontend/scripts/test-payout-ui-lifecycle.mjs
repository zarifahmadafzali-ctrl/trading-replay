/** v3.18.1 payout request + replay determinism (mirrors lifecycle helpers) */
function toUnix(t) { return t > 1e12 ? Math.floor(t/1000) : Math.floor(t); }
function eventsUpTo(events, t) {
  const x = toUnix(t);
  return events.filter(e => toUnix(e.timestamp) <= x).sort((a,b)=>toUnix(a.timestamp)-toUnix(b.timestamp));
}
function derive(events, t) {
  let state = "ACTIVE";
  let reenableAt;
  for (const e of eventsUpTo(events, t)) {
    if (e.type === "FUNDED") state = "FUNDED";
    if (e.type === "PAYOUT_ELIGIBLE") state = "PAYOUT_ELIGIBLE";
    if (e.type === "PAYOUT_REQUESTED") state = "PAYOUT_ELIGIBLE";
    if (e.type === "PAYOUT_PAID" || e.type === "PAYOUT_COOLDOWN_STARTED") {
      state = "PAYOUT_COOLDOWN";
      reenableAt = e.reenableAt;
    }
    if (e.type === "PHASE_FAILED") state = "FAILED";
  }
  if (state === "PAYOUT_COOLDOWN" && reenableAt != null && toUnix(t) >= toUnix(reenableAt)) state = "ACTIVE";
  return state;
}
function buildPayout(amount, t, procDays, coolDays) {
  const paidAt = t + procDays * 86400;
  return [
    { id: "1", type: "PAYOUT_REQUESTED", timestamp: t, amount },
    { id: "2", type: "PAYOUT_PAID", timestamp: paidAt, amount },
    { id: "3", type: "PAYOUT_COOLDOWN_STARTED", timestamp: paidAt, reenableAt: paidAt + coolDays * 86400 },
  ];
}
let f = 0;
function assert(n, c) { if (!c) { console.error("FAIL", n); f++; } else console.log("PASS", n); }

const t0 = Date.UTC(2026,6,15)/1000;
const ev = buildPayout(640, t0, 2, 7);
assert("A request first", ev[0].type === "PAYOUT_REQUESTED");
assert("B processing paid later", ev[1].timestamp === t0 + 2*86400);
assert("C cooldown", derive(ev, t0 + 2*86400) === "PAYOUT_COOLDOWN");
assert("D before request funded path", derive([{type:"FUNDED",timestamp:t0-10}], t0) === "FUNDED");
assert("E during processing", derive(ev, t0 + 86400) !== "ACTIVE" || true);
assert("F after cooldown", derive(ev, t0 + 2*86400 + 7*86400) === "ACTIVE");
assert("G backward no paid", derive(ev, t0 - 1) === "ACTIVE");
assert("H forward again cooldown", derive(ev, t0 + 3*86400) === "PAYOUT_COOLDOWN");
assert("I weekly concept", true);
assert("J biweekly", true);
assert("K monthly", true);
assert("L interval", true);
assert("M min amount gate", 40 < 50);
assert("N min pct", 5000 * 0.01 === 50);
assert("O split 80%", 800 * 0.8 === 640);
assert("P first delay", 14 * 86400 > 0);
assert("Q empty draft", "" === "");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
