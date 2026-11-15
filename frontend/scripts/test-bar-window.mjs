/**
 * P10 pure helpers for dynamic bar window (no DOM).
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/barWindow.ts"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Mirror mergeBarsChronological
function mergeBarsChronological(existing, incoming) {
  if (!incoming.length) return { bars: existing, prepended: 0 };
  if (!existing.length) return { bars: incoming.slice(), prepended: 0 };
  const prevFirst = existing[0].time;
  const map = new Map();
  for (const b of existing) map.set(b.time, b);
  for (const b of incoming) if (!map.has(b.time)) map.set(b.time, b);
  const bars = Array.from(map.values()).sort((a, b) => a.time - b.time);
  let prepended = 0;
  for (const b of bars) {
    if (b.time < prevFirst) prepended++;
    else break;
  }
  return { bars, prepended };
}

function windowCoversRange(bars, fromSec, toSec) {
  if (!bars.length) return false;
  const lo = Math.min(fromSec, toSec);
  const hi = Math.max(fromSec, toSec);
  return bars[0].time <= lo && bars[bars.length - 1].time >= hi;
}

const a = [
  { time: 100, open: 1, high: 1, low: 1, close: 1 },
  { time: 101, open: 1, high: 1, low: 1, close: 1 },
];
const b = [
  { time: 98, open: 1, high: 1, low: 1, close: 1 },
  { time: 99, open: 1, high: 1, low: 1, close: 1 },
  { time: 100, open: 1, high: 1, low: 1, close: 1 },
];
const m = mergeBarsChronological(a, b);
assert(m.prepended === 2, "prepended should be 2");
assert(m.bars.length === 4, "merged length 4");
assert(windowCoversRange(m.bars, 98, 101), "covers full");
assert(!windowCoversRange(a, 98, 101), "old window incomplete");
assert(src.includes("FULL_LOAD_MAX_DAYS"), "source exports constants");
assert(src.includes("mergeBarsChronological"), "source has merge");
console.log("test-bar-window: PASS");
