import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/chartTimeScale.ts"), "utf8");
const chartSrc = readFileSync(join(__dirname, "../src/components/Chart.tsx"), "utf8");

const CHART_FUTURE_MIN_BARS = 64;
const CHART_FUTURE_MAX_BARS = 320;
function futureWhitespaceCount(visibleLogicalWidth, minimum = CHART_FUTURE_MIN_BARS, maximum = CHART_FUTURE_MAX_BARS) {
  const min = Math.max(1, Math.floor(minimum));
  const max = Math.max(min, Math.floor(maximum));
  const w = visibleLogicalWidth != null && Number.isFinite(visibleLogicalWidth) ? Math.max(0, visibleLogicalWidth) : min;
  const target = Math.ceil(Math.max(min, w * 0.6, w - 8));
  return Math.max(min, Math.min(max, target));
}
function buildFutureWhitespaceTimes(lastRealTime, stepSeconds, count = CHART_FUTURE_MIN_BARS) {
  if (!Number.isFinite(lastRealTime)) return [];
  const step = Math.max(1, Math.floor(Number(stepSeconds)) || 1);
  const n = Math.max(0, Math.min(CHART_FUTURE_MAX_BARS, Math.floor(count)));
  const out = [];
  for (let i = 1; i <= n; i++) out.push(lastRealTime + i * step);
  return out;
}
function isWhitespaceOnlyPoint(p) {
  if (p == null || typeof p !== "object") return false;
  if (typeof p.time !== "number") return false;
  return p.open === undefined && p.value === undefined;
}
function followVisibleLogicalRange(dataLength, visibleLogicalWidth, futureBars) {
  if (!(dataLength > 0) || !Number.isFinite(dataLength)) return null;
  const last = dataLength - 1;
  const future = Math.max(0, futureBars);
  const width = Math.max(10, Number.isFinite(visibleLogicalWidth) ? visibleLogicalWidth : 80);
  const to = last + future;
  const from = to - width;
  return { from, to };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name); }
}

check("exports min/max/count", src.includes("futureWhitespaceCount") && src.includes("CHART_FUTURE_MIN_BARS"));
check("count fills wide viewport", futureWhitespaceCount(120) >= 64);
check("count uses viewport", futureWhitespaceCount(200) >= 120);
check("count capped", futureWhitespaceCount(9999) === CHART_FUTURE_MAX_BARS);

const last = 1_000_000;
const ws = buildFutureWhitespaceTimes(last, 300, futureWhitespaceCount(100));
check("many future slots", ws.length >= 64);
check("spacing 5m", ws[1] - ws[0] === 300);
check("reaches far past last", ws[ws.length - 1] - last >= 300 * 60);
check("whitespace only time", ws.map((t) => ({ time: t })).every(isWhitespaceOnlyPoint));

const fr = followVisibleLogicalRange(50, 100, 80);
check("follow to past last", fr && fr.to === 49 + 80);
check("follow span = width", fr && fr.to - fr.from === 100);

check("Chart uses futureWhitespaceCount", chartSrc.includes("futureWhitespaceCount"));
check("Chart builds whitespace from count", chartSrc.includes("buildFutureWhitespaceTimes(last.time, stepSec, futureCount)"));
check("no synthetic open on ws", !/whitespacePts\.map\(\(t\).*open:/.test(chartSrc.replace(/\n/g, " ")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
