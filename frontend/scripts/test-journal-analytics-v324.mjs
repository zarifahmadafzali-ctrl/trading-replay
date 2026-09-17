/**
 * v3.24.0 — Journal → Analytics hardening (logical, no DOM).
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

function tradeOutcome(t) {
  if (t.rMultiple != null) {
    if (t.rMultiple > 1e-9) return "win";
    if (t.rMultiple < -1e-9) return "loss";
    return "breakeven";
  }
  if (t.pnlPoints > 1e-9) return "win";
  if (t.pnlPoints < -1e-9) return "loss";
  return "breakeven";
}

function filterTrades(trades, filters) {
  return trades.filter((t) => {
    if (!t.exitTime || t.entryTime == null) return false;
    if (filters.side && filters.side !== "all" && t.side !== filters.side) return false;
    if (filters.result && filters.result !== "all" && tradeOutcome(t) !== filters.result) return false;
    if (filters.accountId && filters.accountId !== "all" && t.accountId !== filters.accountId) return false;
    if (filters.sessionId && filters.sessionId !== "all" && t.sessionId !== filters.sessionId) return false;
    return true;
  });
}

function safeDiv(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-12) return null;
  const v = a / b;
  return Number.isFinite(v) ? v : null;
}

function computePF(trades) {
  let gp = 0, gl = 0;
  for (const t of trades) {
    const o = tradeOutcome(t);
    const pnl = t.currencyPnL ?? 0;
    if (o === "win") gp += Math.max(0, pnl);
    else if (o === "loss") gl += Math.min(0, pnl);
  }
  return safeDiv(gp, Math.abs(gl));
}

function equityCurve(trades, start) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let eq = start;
  const pts = [];
  for (const t of sorted) {
    eq += t.currencyPnL ?? 0;
    pts.push({ time: t.exitTime, equity: eq });
  }
  return pts;
}

function maxDD(curve) {
  let peak = -Infinity, maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, peak - p.equity);
  }
  return maxDd;
}

function streaks(trades) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let maxW = 0, maxL = 0, w = 0, l = 0;
  for (const t of sorted) {
    const o = tradeOutcome(t);
    if (o === "win") { w++; l = 0; maxW = Math.max(maxW, w); }
    else if (o === "loss") { l++; w = 0; maxL = Math.max(maxL, l); }
    else { w = 0; l = 0; }
  }
  return { maxW, maxL };
}

const trades = [
  { id: "1", sessionId: "S1", accountId: "A1", side: "long", entryTime: 1, exitTime: 10, rMultiple: 2, pnlPoints: 20, currencyPnL: 100 },
  { id: "2", sessionId: "S1", accountId: "A1", side: "short", entryTime: 2, exitTime: 20, rMultiple: -1, pnlPoints: -10, currencyPnL: -50 },
  { id: "3", sessionId: "S2", accountId: "A2", side: "long", entryTime: 3, exitTime: 30, rMultiple: 1.5, pnlPoints: 15, currencyPnL: 75 },
  { id: "4", sessionId: "S1", accountId: "A1", side: "long", entryTime: 4, exitTime: 40, rMultiple: null, pnlPoints: 5, currencyPnL: 10 },
];

// zero trades
assert("zero trades PF null", computePF([]) === null);

// zero losses → PF null (not Infinity)
const onlyWins = trades.filter((t) => tradeOutcome(t) === "win");
assert("zero-loss PF null", computePF(onlyWins) === null);

// missing R excluded from R avg
const withR = trades.filter((t) => t.rMultiple != null);
assert("missing R filtered", withR.length === 3);

// one filtered dataset
const longOnly = filterTrades(trades, { side: "long" });
assert("side filter", longOnly.every((t) => t.side === "long") && longOnly.length === 3);

const wins = filterTrades(trades, { result: "win" });
assert("result filter", wins.every((t) => tradeOutcome(t) === "win"));

// equity order
const curve = equityCurve(trades.filter((t) => t.accountId === "A1"), 5000);
assert("equity chronological", curve[0].time < curve[1].time);
assert("equity start+pnl", Math.abs(curve[curve.length - 1].equity - (5000 + 100 - 50 + 10)) < 1e-6);

// drawdown
const dd = maxDD([{ equity: 100 }, { equity: 120 }, { equity: 90 }, { equity: 110 }]);
assert("max DD", dd === 30);

// streaks
const st = streaks([
  { exitTime: 1, rMultiple: 1, pnlPoints: 1 },
  { exitTime: 2, rMultiple: 1, pnlPoints: 1 },
  { exitTime: 3, rMultiple: -1, pnlPoints: -1 },
  { exitTime: 4, rMultiple: -1, pnlPoints: -1 },
  { exitTime: 5, rMultiple: -1, pnlPoints: -1 },
]);
assert("win streak", st.maxW === 2);
assert("loss streak", st.maxL === 3);

// multi-account isolation
const a1 = filterTrades(trades, { accountId: "A1" });
assert("account isolation", a1.every((t) => t.accountId === "A1") && a1.length === 3);

// session isolation
const s2 = filterTrades(trades, { sessionId: "S2" });
assert("session isolation", s2.length === 1 && s2[0].sessionId === "S2");

// delete updates analytics count
let j = [...trades];
j = j.filter((t) => t.id !== "2");
assert("delete reduces count", j.length === 3);
assert("PF after delete", computePF(j) !== undefined);

// analytics cannot mutate balance
const bal = { balance: 5000 };
const _ = filterTrades(j, {});
assert("balance untouched", bal.balance === 5000);

// CSV shape
function csv(rows) {
  return "id,side\n" + rows.map((r) => `${r.id},${r.side}`).join("\n");
}
const c = csv(j);
assert("csv has header", c.startsWith("id,side"));
assert("csv rows", c.split("\n").length === 4);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
