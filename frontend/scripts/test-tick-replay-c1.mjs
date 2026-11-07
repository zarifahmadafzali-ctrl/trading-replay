/**
 * Phase C1 / C1.1 pure unit tests (JS mirrors of tickReplay helpers).
 * Keep logic aligned with src/lib/tickReplay.ts — no DOM / IndexedDB.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/tickReplay.ts"), "utf8");
const aliasSrc = readFileSync(join(__dirname, "../src/lib/symbolAliases.ts"), "utf8");

function sortTicksStable(ticks) {
  return ticks
    .map((t, i) => ({ ...t, seq: t.seq != null ? t.seq : i }))
    .sort((a, b) => (a.time - b.time) || (a.seq - b.seq));
}
function nextUtcDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}
function prevUtcDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.toISOString().slice(0, 10);
}
function unixToUtcDay(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
function findTickIndexAtOrBefore(ticks, t) {
  if (!ticks.length) return -1;
  let lo = 0, hi = ticks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].time <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
function mapTimeToTickIndex(ticks, t) {
  if (!ticks.length) return 0;
  const i = findTickIndexAtOrBefore(ticks, t);
  return i < 0 ? 0 : i;
}
function mapTickTimeToBars1sCursor(bars, tickTime) {
  if (!bars.length) return 1;
  const target = Math.floor(tickTime);
  let lo = 0, hi = bars.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return Math.min(bars.length, Math.max(1, ans + 1));
}
function findBars1sCursorForUnixTime(bars, targetUnixSec) {
  if (!bars.length) return 1;
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < targetUnixSec) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(bars.length, Math.max(1, lo + 1));
}
function shouldApplyTickNav(activeGeneration, requestGeneration) {
  return requestGeneration === activeGeneration && requestGeneration > 0;
}
function enumerateUtcDaysInclusive(startDay, endDay) {
  if (!startDay || !endDay) return [];
  const a = startDay <= endDay ? startDay : endDay;
  const b = startDay <= endDay ? endDay : startDay;
  const out = [];
  let cur = a;
  for (let i = 0; i < 1200; i++) {
    out.push(cur);
    if (cur === b) break;
    cur = nextUtcDay(cur);
  }
  return out;
}
function hasEligibleTickDayInRange(completeDays, startDay, endDay) {
  if (!completeDays.length || !startDay || !endDay) return false;
  const set = new Set(completeDays);
  for (const d of enumerateUtcDaysInclusive(startDay, endDay)) {
    if (set.has(d)) return true;
  }
  return false;
}
function canonicalSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (s === "USA30IDXUSD" || s === "US30") return "US30";
  return s;
}
function symbolLookupCandidates(sym) {
  const c = canonicalSymbol(sym);
  const out = [c];
  if (c === "US30") out.push("USA30IDXUSD");
  return [...new Set(out)];
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name); }
}

const ticks = sortTicksStable([
  { time: 1000.5, mid: 1, seq: 0 },
  { time: 1000.5, mid: 2, seq: 1 },
  { time: 1001.0, mid: 3, seq: 2 },
  { time: 1001.25, mid: 4, seq: 3 },
]);
check("equal-ts order", ticks[0].mid === 1 && ticks[1].mid === 2);
check("next within day", ticks[2].time === 1001.0);
check("mapTime mid-second uses last <=", mapTimeToTickIndex(ticks, 1000.5) === 1);
check("mapTime before all", mapTimeToTickIndex(ticks, 900) === 0);
check("mapTime after all", mapTimeToTickIndex(ticks, 9999) === 3);
check("fractional preserved", ticks[3].time === 1001.25);

const bars = [{ time: 1000 }, { time: 1001 }, { time: 1002 }];
check("bars cursor from tick", mapTickTimeToBars1sCursor(bars, 1001.25) === 2);
check("day next/prev", nextUtcDay("2026-11-04") === "2026-11-05" && prevUtcDay("2026-11-04") === "2026-11-03");
check("unix day", unixToUtcDay(1730688000).startsWith("2024-11"));
check("alias US30", canonicalSymbol("USA30IDXUSD") === "US30");
check("candidates include alias", symbolLookupCandidates("US30").includes("USA30IDXUSD"));
check("range enumerates 3 days", enumerateUtcDaysInclusive("2026-11-03", "2026-11-05").join(",") === "2026-11-03,2026-11-04,2026-11-05");
check("eligible mid day", hasEligibleTickDayInRange(["2026-11-04"], "2026-11-01", "2026-11-10") === true);
check("not eligible outside", hasEligibleTickDayInRange(["2026-10-01"], "2026-11-01", "2026-11-10") === false);
check("empty complete list", hasEligibleTickDayInRange([], "2026-11-01", "2026-11-10") === false);

const dayBars = [{ time: 1700000000 }, { time: 1700003600 }, { time: 1700064000 }];
check("findBars cursor at second bar", findBars1sCursorForUnixTime(dayBars, 1700003600) === 2);

const jumpTicks = sortTicksStable([
  { time: 1700003599.1, mid: 10, seq: 0 },
  { time: 1700003600.0, mid: 11, seq: 1 },
  { time: 1700003600.5, mid: 12, seq: 2 },
  { time: 1700003601.0, mid: 13, seq: 3 },
]);
const jumpIdx = mapTimeToTickIndex(jumpTicks, 1700003600);
check("Jump To maps near 07:00 target", jumpIdx === 1 && jumpTicks[jumpIdx].mid === 11);
check("Jump To → Next advances from target", jumpTicks[jumpIdx + 1].mid === 12);
check("Jump To → Previous from target", jumpTicks[jumpIdx - 1].mid === 10);
check("rapid Next stays after jump region", jumpTicks[jumpIdx + 2].mid === 13);

const day2 = sortTicksStable([
  { time: 1700064000.0, mid: 20, seq: 0 },
  { time: 1700064001.0, mid: 21, seq: 1 },
]);
check("cross-day map to first tick", mapTimeToTickIndex(day2, 1700064000) === 0);

let active = 0;
const g1 = ++active;
const g2 = ++active;
check("older nav rejected", shouldApplyTickNav(active, g1) === false);
check("latest nav accepted", shouldApplyTickNav(active, g2) === true);
check("zero gen rejected", shouldApplyTickNav(5, 0) === false);
check("seconds jump cursor only", findBars1sCursorForUnixTime(bars, 1001) === 2);
check("source exports C1.1 helpers", src.includes("export function findBars1sCursorForUnixTime") && src.includes("export function shouldApplyTickNav"));
check("ReplayView wires navigate", readFileSync(join(__dirname, "../src/views/ReplayView.tsx"), "utf8").includes("navigateReplayToUnixTime"));
check("alias module still present", aliasSrc.includes("canonicalSymbol"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
