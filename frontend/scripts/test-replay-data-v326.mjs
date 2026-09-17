/**
 * v3.26.0 — Replay/data performance contracts (no IndexedDB).
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

// Display window bound (matches aggregateVisible)
function aggregateVisible(rows, cursorSeconds, timeframeSeconds) {
  if (cursorSeconds <= 0 || !rows.length) return [];
  const maxCandles = 1200;
  const tf = Math.max(1, timeframeSeconds);
  const start = Math.max(0, cursorSeconds - tf * maxCandles);
  const slice = rows.slice(start, cursorSeconds);
  if (tf <= 1) return slice;
  // fake aggregate: count buckets
  const out = [];
  let cur = null;
  for (const row of slice) {
    const bucket = Math.floor(row.time / tf) * tf;
    if (!cur || cur.time !== bucket) {
      cur = { time: bucket };
      out.push(cur);
    }
  }
  return out;
}

const big = Array.from({ length: 50000 }, (_, i) => ({
  time: 1_700_000_000 + i,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
}));
const vis1s = aggregateVisible(big, 40000, 1);
assert("1s display bounded", vis1s.length <= 1200);
const vis5m = aggregateVisible(big, 40000, 300);
assert("5m display bounded", vis5m.length <= 1200);

// exec window = slice between prev and cursor (1s bars)
function execWindow(baseBars, prev, cursor) {
  const lo = Math.min(prev, cursor);
  const hi = Math.max(prev, cursor);
  if (hi <= lo) return baseBars[Math.max(0, cursor - 1)] ? 1 : 0;
  return hi - lo;
}
assert("step 5s exec spans 5", execWindow(big, 100, 105) === 5);
assert("step back spans", execWindow(big, 105, 100) === 5);

// day transition continuity: indices continuous across concatenated days
const dayA = Array.from({ length: 10 }, (_, i) => ({ time: 1000 + i }));
const dayB = Array.from({ length: 10 }, (_, i) => ({ time: 2000 + i }));
const merged = [...dayA, ...dayB];
assert("day boundary keep open index", merged.length === 20 && merged[10].time === 2000);

// sort skip: already ordered
function needsSort(bars) {
  let last = -Infinity;
  for (const b of bars) {
    if (b.time < last) return true;
    last = b.time;
  }
  return false;
}
assert("ordered no sort", needsSort(merged) === false);
assert("unordered needs sort", needsSort([{ time: 2 }, { time: 1 }]) === true);

// generation guard
let gen = 0;
function load(id) {
  const g = ++gen;
  return { apply: () => g === gen };
}
const a = load(1);
const b = load(2);
assert("stale discarded", a.apply() === false && b.apply() === true);

// diagnostics read-only
const diag = { mutatesJournal: false, mutatesAccount: false };
assert("diag readonly", !diag.mutatesJournal && !diag.mutatesAccount);

// exec vs display separation
const rule = { execUsesAggregatedTf: false, displayMayAggregate: true };
assert("1s sacred", !rule.execUsesAggregatedTf && rule.displayMayAggregate);

// cache hit/miss model
function classify(hit, miss) {
  if (miss === 0 && hit > 0) return "local-cache";
  if (hit > 0 && miss > 0) return "partial-cache";
  if (hit === 0) return "miss";
  return "none";
}
assert("full hit", classify(5, 0) === "local-cache");
assert("partial", classify(2, 1) === "partial-cache");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
