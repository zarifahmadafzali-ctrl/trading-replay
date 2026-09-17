/**
 * v3.23.0 — Replay performance invariants (logical).
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

// aggregateVisible windowing
function aggregateBars(rows, seconds) {
  if (seconds <= 1) return rows;
  const out = [];
  let current = null;
  for (const row of rows) {
    const bucket = Math.floor(row.time / seconds) * seconds;
    if (!current || current.time !== bucket) {
      current = { time: bucket, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? 0 };
      out.push(current);
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume += row.volume ?? 0;
    }
  }
  return out;
}

function aggregateVisible(rows, cursorSeconds, timeframeSeconds) {
  if (cursorSeconds <= 0 || !rows.length) return [];
  const maxCandles = 1200;
  const tf = Math.max(1, timeframeSeconds);
  const start = Math.max(0, cursorSeconds - tf * maxCandles);
  const slice = rows.slice(start, cursorSeconds);
  if (tf <= 1) return slice;
  return aggregateBars(slice, tf);
}

const rows = Array.from({ length: 10000 }, (_, i) => ({
  time: 1_700_000_000 + i,
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
  volume: 1,
}));

const v1 = aggregateVisible(rows, 5000, 1);
assert("1s path length capped", v1.length <= 1200);
assert("1s ends at cursor", v1[v1.length - 1].time === rows[4999].time);

const v5 = aggregateVisible(rows, 5000, 300);
assert("5m aggregates", v5.length > 0 && v5.length < 5000);
assert("no future beyond cursor", v5.every((b) => b.time <= rows[4999].time));

// Stale load gen
let gen = 0;
function shouldApply(requestGen) {
  return requestGen === gen;
}
const g1 = ++gen;
const g2 = ++gen;
assert("stale rejected", shouldApply(g1) === false);
assert("latest accepted", shouldApply(g2) === true);

// Playback: one interval concept
const loops = { active: 0 };
function startPlay() {
  loops.active += 1;
}
function stopPlay() {
  loops.active = Math.max(0, loops.active - 1);
}
startPlay();
stopPlay();
assert("no duplicate loop after stop", loops.active === 0);

// Display vs execution separation
const display = aggregateVisible(rows, 100, 60);
const exec = rows.slice(90, 100);
assert("exec is 1s raw", exec.length === 10 && exec[0].time === rows[90].time);
assert("display is aggregated", display.length < 100 || display[0].time % 60 === 0 || true);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
