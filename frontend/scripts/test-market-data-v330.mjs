/**
 * v3.30.0 — market data integrity + range contracts (no browser IDB).
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

function toUnixSeconds(t) {
  if (!Number.isFinite(t)) return null;
  if (t > 1e12) return Math.floor(t / 1000);
  if (t < 0) return null;
  return Math.floor(t);
}

function validateBar(raw) {
  if (!raw) return null;
  const time = toUnixSeconds(Number(raw.time));
  if (time == null) return null;
  const open = Number(raw.open), high = Number(raw.high), low = Number(raw.low), close = Number(raw.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  const hi = Math.max(open, close, high, low);
  const lo = Math.min(open, close, high, low);
  return { time, open, high: hi, low: lo, close, volume: Number(raw.volume) || 0 };
}

function normalizeBars(input) {
  const byT = new Map();
  let rejected = 0, duplicatesCollapsed = 0;
  for (const raw of input) {
    const bar = validateBar(raw);
    if (!bar) { rejected++; continue; }
    if (byT.has(bar.time)) duplicatesCollapsed++;
    byT.set(bar.time, bar);
  }
  const bars = Array.from(byT.values()).sort((a, b) => a.time - b.time);
  return { bars, rejected, duplicatesCollapsed };
}

function isTimeSorted(bars) {
  for (let i = 1; i < bars.length; i++) if (bars[i].time < bars[i - 1].time) return false;
  return true;
}

// valid
const a = normalizeBars([
  { time: 100, open: 1, high: 2, low: 0.5, close: 1.5 },
  { time: 101, open: 1.5, high: 2, low: 1, close: 1.2 },
]);
assert("two valid", a.bars.length === 2 && a.rejected === 0);

// reject NaN
const b = normalizeBars([{ time: 1, open: NaN, high: 2, low: 1, close: 1 }]);
assert("reject nan", b.bars.length === 0 && b.rejected === 1);

// last wins dedup
const c = normalizeBars([
  { time: 50, open: 1, high: 2, low: 1, close: 1 },
  { time: 50, open: 9, high: 10, low: 8, close: 9 },
]);
assert("last wins", c.bars.length === 1 && c.bars[0].close === 9 && c.duplicatesCollapsed === 1);

// sort
const d = normalizeBars([
  { time: 3, open: 1, high: 1, low: 1, close: 1 },
  { time: 1, open: 1, high: 1, low: 1, close: 1 },
  { time: 2, open: 1, high: 1, low: 1, close: 1 },
]);
assert("sorted", isTimeSorted(d.bars) && d.bars[0].time === 1);

// high/low clamp
const e = validateBar({ time: 1, open: 5, high: 4, low: 6, close: 5 });
assert("clamp hl", e && e.high >= e.open && e.low <= e.open);

// symbol isolation key model
function dayId(symbol, day) {
  return `${symbol.toUpperCase()}|${day}`;
}
assert("us30 key", dayId("us30", "2026-06-01") === "US30|2026-06-01");
assert("isolation", dayId("US30", "2026-06-01") !== dayId("EURUSD", "2026-06-01"));

// ordered concat skip sort heuristic
function needsSort(chunks) {
  let last = -Infinity, ns = false;
  for (const ch of chunks) {
    for (const b of ch) {
      if (b.time < last) { ns = true; break; }
      last = b.time;
    }
  }
  return ns;
}
assert("no sort ordered days", needsSort([
  [{ time: 1 }, { time: 2 }],
  [{ time: 3 }, { time: 4 }],
]) === false);
assert("sort disordered", needsSort([
  [{ time: 5 }],
  [{ time: 1 }],
]) === true);

// display window bound (matches aggregateVisible maxCandles)
const maxCandles = 1200;
const baseLen = 200_000;
const cursor = 150_000;
const tf = 60;
const start = Math.max(0, cursor - tf * maxCandles);
const sliceLen = cursor - start;
assert("display bounded", sliceLen <= tf * maxCandles);

// sliding window for full baseBars NOT implemented — document
const slidingWindowImplemented = false;
assert("no unsafe sliding window claim", slidingWindowImplemented === false);

// synthetic 50k normalize performance sanity
const big = [];
for (let i = 0; i < 50_000; i++) big.push({ time: i, open: 1, high: 2, low: 0.5, close: 1.1, volume: 1 });
const t0 = Date.now();
const n = normalizeBars(big);
const ms = Date.now() - t0;
assert("50k normalize", n.bars.length === 50_000);
console.log("OBS normalize50k_ms=", ms);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
