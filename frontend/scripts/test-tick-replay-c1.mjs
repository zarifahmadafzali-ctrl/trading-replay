/**
 * Phase C1 — pure tick replay helpers (no IndexedDB).
 * Run: node frontend/scripts/test-tick-replay-c1.mjs
 */

function unixToUtcDay(unixSec) {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}
function nextUtcDay(day) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function prevUtcDay(day) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function sortTicksStable(ticks) {
  return [...ticks].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
}
function findTickIndexAtOrBefore(ticks, t) {
  if (!ticks.length || !Number.isFinite(t)) return -1;
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
function canonicalSymbol(symbol) {
  const map = {
    US30: "US30", USA30IDXUSD: "US30", US30IDXUSD: "US30",
    XAUUSD: "XAUUSD", GOLD: "XAUUSD",
  };
  const u = String(symbol || "").trim().toUpperCase();
  return map[u] || u;
}
function symbolLookupCandidates(symbol) {
  const c = canonicalSymbol(symbol);
  const out = [c];
  for (const [alias, canon] of Object.entries({
    US30: "US30", USA30IDXUSD: "US30", US30IDXUSD: "US30",
  })) {
    if (canon === c && alias !== c) out.push(alias);
  }
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
check("unix day", unixToUtcDay(1730688000) === "2024-11-04" || unixToUtcDay(1730688000).startsWith("2024-11"));
check("alias US30", canonicalSymbol("USA30IDXUSD") === "US30");
check("candidates include alias", symbolLookupCandidates("US30").includes("USA30IDXUSD"));

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
check("range enumerates 3 days", enumerateUtcDaysInclusive("2026-11-03", "2026-11-05").join(",") === "2026-11-03,2026-11-04,2026-11-05");
check("eligible mid day", hasEligibleTickDayInRange(["2026-11-04"], "2026-11-01", "2026-11-10") === true);
check("not eligible outside", hasEligibleTickDayInRange(["2026-10-01"], "2026-11-01", "2026-11-10") === false);
check("empty complete list", hasEligibleTickDayInRange([], "2026-11-01", "2026-11-10") === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
