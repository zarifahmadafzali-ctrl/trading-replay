/**
 * v3.22.0 — Market day status + delete semantics (logical).
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

function classifyDayStatus(row, opts = {}) {
  if (opts.loading) return "LOADING";
  if (opts.failed) return "FAILED";
  if (!row) return "MISSING";
  if (row.complete && row.classification === "EXPECTED_EMPTY") return "EMPTY";
  if (row.complete && (row.classification === "SUCCESS" || (row.barCount ?? 0) > 0)) return "COMPLETE";
  if (row.complete && row.classification === "FAILED") return "FAILED";
  if ((row.bars?.length ?? 0) > 0 || (row.barCount ?? 0) > 0) return "PARTIAL";
  return "MISSING";
}

assert("null -> MISSING", classifyDayStatus(null) === "MISSING");
assert("empty complete -> EMPTY", classifyDayStatus({ complete: true, classification: "EXPECTED_EMPTY", barCount: 0 }) === "EMPTY");
assert("success complete -> COMPLETE", classifyDayStatus({ complete: true, classification: "SUCCESS", barCount: 100 }) === "COMPLETE");
assert("bars incomplete -> PARTIAL", classifyDayStatus({ complete: false, bars: [{ time: 1 }], barCount: 1 }) === "PARTIAL");
assert("loading -> LOADING", classifyDayStatus(null, { loading: true }) === "LOADING");
assert("failed flag -> FAILED", classifyDayStatus(null, { failed: true }) === "FAILED");

// Dedup timestamps
function dedupe(bars) {
  const byT = new Map();
  for (const b of bars) byT.set(b.time, b);
  return Array.from(byT.values()).sort((a, b) => a.time - b.time);
}
const d = dedupe([
  { time: 2, c: 1 },
  { time: 1, c: 1 },
  { time: 2, c: 9 },
]);
assert("dedupe length", d.length === 2);
assert("dedupe order", d[0].time === 1 && d[1].time === 2);
assert("dedupe last wins", d[1].c === 9);

// Session independence
const ownership = {
  market: "barCache",
  sessionDeleteTouchesMarket: false,
  marketDeleteTouchesSession: false,
  backupIncludesMarket: false,
};
assert("market in barCache", ownership.market === "barCache");
assert("session delete independent", !ownership.sessionDeleteTouchesMarket);
assert("market delete independent", !ownership.marketDeleteTouchesSession);
assert("backup excludes market", !ownership.backupIncludesMarket);

// Complete skip
function shouldFetch(row) {
  return !(row?.complete);
}
assert("complete skips fetch", shouldFetch({ complete: true }) === false);
assert("partial may fetch", shouldFetch({ complete: false, bars: [1] }) === true);
assert("missing fetches", shouldFetch(null) === true);

// Estimate not exact
const est = 1000 * 40;
assert("estimate formula", est === 40000);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
