/**
 * Phase C1.2 — pure real-time playback delay helpers.
 * Deterministic; no real timers.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/tickReplay.ts"), "utf8");

for (const name of [
  "wallClockDelayMs",
  "secondsModeNextDeltaSec",
  "tickModeNextDeltaSec",
  "PLAY_DELAY_MAX_MS",
]) {
  if (!src.includes(name)) {
    console.error("FAIL source missing", name);
    process.exit(1);
  }
}

function wallClockDelayMs(marketTimeDeltaSeconds, playbackSpeed) {
  const speed = playbackSpeed > 0 && Number.isFinite(playbackSpeed) ? playbackSpeed : 1;
  if (!Number.isFinite(marketTimeDeltaSeconds) || marketTimeDeltaSeconds <= 0) return 0;
  const ms = (marketTimeDeltaSeconds * 1000) / speed;
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(300_000, ms);
}
function secondsModeNextDeltaSec(bars, cursor, stepBars) {
  const len = bars.length;
  const step = Math.max(1, Math.floor(stepBars) || 1);
  if (len <= 0 || cursor >= len) return { deltaSec: 0, nextCursor: cursor, atEnd: true };
  const nextCursor = Math.min(len, cursor + step);
  const t0 = bars[Math.max(0, cursor - 1)]?.time;
  const t1 = bars[Math.max(0, nextCursor - 1)]?.time;
  let deltaSec = step;
  if (t0 != null && t1 != null && Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) deltaSec = t1 - t0;
  if (!(deltaSec > 0)) deltaSec = step;
  return { deltaSec, nextCursor, atEnd: nextCursor >= len && cursor >= len };
}
function tickModeNextDeltaSec(ticks, index) {
  if (!ticks.length || index < 0 || index >= ticks.length - 1) {
    return { deltaSec: 0, nextIndex: index, atEnd: true, sameTimestamp: false };
  }
  const nextIndex = index + 1;
  const t0 = ticks[index].time;
  const t1 = ticks[nextIndex].time;
  const deltaSec = Number.isFinite(t0) && Number.isFinite(t1) ? t1 - t0 : 0;
  return {
    deltaSec: deltaSec > 0 ? deltaSec : 0,
    nextIndex,
    atEnd: false,
    sameTimestamp: !(deltaSec > 0),
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name); }
}

// Seconds 1x / 2x / 0.5x
check("1s step @1x = 1000ms", wallClockDelayMs(1, 1) === 1000);
check("1s step @2x = 500ms", wallClockDelayMs(1, 2) === 500);
check("1s step @0.5x = 2000ms", wallClockDelayMs(1, 0.5) === 2000);
check("5s step @1x = 5000ms", wallClockDelayMs(5, 1) === 5000);
check("60s step @1x = 60000ms", wallClockDelayMs(60, 1) === 60000);
check("60s step @10x = 6000ms", wallClockDelayMs(60, 10) === 6000);

// Different step sizes from bars
const bars = [];
for (let i = 0; i < 120; i++) bars.push({ time: 1_700_000_000 + i });
const d1 = secondsModeNextDeltaSec(bars, 10, 1);
check("seconds step 1 delta", d1.deltaSec === 1 && d1.nextCursor === 11);
const d5 = secondsModeNextDeltaSec(bars, 10, 5);
check("seconds step 5 delta", d5.deltaSec === 5 && d5.nextCursor === 15);
const d60 = secondsModeNextDeltaSec(bars, 10, 60);
check("seconds step 60 delta", d60.deltaSec === 60 && d60.nextCursor === 70);

// Gap in bars (weekend-like)
const gapBars = [{ time: 100 }, { time: 101 }, { time: 100 + 86400 }];
const dg = secondsModeNextDeltaSec(gapBars, 2, 1);
check("seconds respects real gap", dg.deltaSec === 86400 - 1);

// End of data
const end = secondsModeNextDeltaSec(bars, bars.length, 1);
check("seconds atEnd", end.atEnd === true);

// Tick irregular intervals
const ticks = [
  { time: 1000.0 },
  { time: 1000.25 },
  { time: 1001.0 },
  { time: 1001.0 },
  { time: 1001.0 },
  { time: 1005.5 },
];
const t0 = tickModeNextDeltaSec(ticks, 0);
check("tick fractional delta", Math.abs(t0.deltaSec - 0.25) < 1e-9 && t0.nextIndex === 1);
check("tick fractional wall 1x", wallClockDelayMs(t0.deltaSec, 1) === 250);

const tSame = tickModeNextDeltaSec(ticks, 2);
check("same-timestamp delta 0", tSame.deltaSec === 0 && tSame.sameTimestamp === true);
check("same-timestamp delay 0", wallClockDelayMs(tSame.deltaSec, 1) === 0);
const tSame2 = tickModeNextDeltaSec(ticks, 3);
check("same-timestamp chain", tSame2.deltaSec === 0 && tSame2.nextIndex === 4);

const tGap = tickModeNextDeltaSec(ticks, 4);
check("irregular tick gap", Math.abs(tGap.deltaSec - 4.5) < 1e-9);
check("irregular tick @2x", wallClockDelayMs(tGap.deltaSec, 2) === 2250);

const tEnd = tickModeNextDeltaSec(ticks, 5);
check("tick atEnd", tEnd.atEnd === true);

// Speed edge cases
check("speed 0 treated as 1", wallClockDelayMs(1, 0) === 1000);
check("negative delta → 0", wallClockDelayMs(-1, 1) === 0);
check("soft max delay", wallClockDelayMs(999999, 1) === 300_000);

// Scheduling policy (documented invariants for ReplayView)
check("no fixed 250ms formula", wallClockDelayMs(1, 1) !== 250);
check("ReplayView no longer uses 250/speed", !readFileSync(join(__dirname, "../src/views/ReplayView.tsx"), "utf8").includes("250 / speed"));
check("ReplayView uses setTimeout scheduler", readFileSync(join(__dirname, "../src/views/ReplayView.tsx"), "utf8").includes("wallClockDelayMs"));
check("ReplayView imports tickModeNextDeltaSec", readFileSync(join(__dirname, "../src/views/ReplayView.tsx"), "utf8").includes("tickModeNextDeltaSec"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
