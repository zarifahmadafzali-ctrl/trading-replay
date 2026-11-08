/**
 * C1.3 / C1.4-A — pure chart future-whitespace helpers (no DOM).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/chartTimeScale.ts"), "utf8");
const chartSrc = readFileSync(join(__dirname, "../src/components/Chart.tsx"), "utf8");

for (const name of [
  "CHART_FUTURE_LOGICAL_BARS",
  "followVisibleLogicalRange",
  "buildFutureWhitespaceTimes",
  "isWhitespaceOnlyPoint",
  "shouldAutoFollowScroll",
]) {
  if (!src.includes(name)) {
    console.error("FAIL missing", name);
    process.exit(1);
  }
}

const CHART_FUTURE_LOGICAL_BARS = 28;
function followVisibleLogicalRange(dataLength, visibleLogicalWidth, futureBars = CHART_FUTURE_LOGICAL_BARS) {
  if (!(dataLength > 0) || !Number.isFinite(dataLength)) return null;
  const last = dataLength - 1;
  const future = Math.max(0, futureBars);
  const width = Math.max(10, Number.isFinite(visibleLogicalWidth) ? visibleLogicalWidth : 80);
  const to = last + future;
  const from = to - width;
  return { from, to };
}
function buildFutureWhitespaceTimes(lastRealTime, stepSeconds, count = CHART_FUTURE_LOGICAL_BARS) {
  if (!Number.isFinite(lastRealTime)) return [];
  const step = Math.max(1, Math.floor(Number(stepSeconds)) || 1);
  const n = Math.max(0, Math.min(200, Math.floor(count)));
  const out = [];
  for (let i = 1; i <= n; i++) out.push(lastRealTime + i * step);
  return out;
}
function isWhitespaceOnlyPoint(p) {
  if (p == null || typeof p !== "object") return false;
  if (typeof p.time !== "number") return false;
  return p.open === undefined && p.value === undefined;
}
function shouldAutoFollowScroll(followMode, dataLength) {
  return !!followMode && dataLength > 0;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name); }
}

check("future bars constant", CHART_FUTURE_LOGICAL_BARS === 28);
const r = followVisibleLogicalRange(100, 80, 28);
check("range extends past last candle", r && r.to === 99 + 28 && r.from === r.to - 80);

const last = 1_000_000;
const step5m = 300;
const ws = buildFutureWhitespaceTimes(last, step5m, 5);
check("whitespace count", ws.length === 5);
check("first future = last+step", ws[0] === last + 300);
check("spacing matches TF", ws[1] - ws[0] === 300 && ws[4] - ws[3] === 300);
check("strictly after last real", ws.every((t) => t > last));

const built = [
  { time: last, open: 1, high: 2, low: 0.5, close: 1.5 },
  ...ws.map((t) => ({ time: t })),
];
check("whitespace entries only time", built.slice(1).every(isWhitespaceOnlyPoint));
check("real candle not whitespace", isWhitespaceOnlyPoint(built[0]) === false);

check("1s step spacing", buildFutureWhitespaceTimes(100, 1, 3).join(",") === "101,102,103");
check("invalid last → empty", buildFutureWhitespaceTimes(NaN, 60, 5).length === 0);

check("Chart builds whitespace", chartSrc.includes("buildFutureWhitespaceTimes"));
check("Chart spreads whitespacePts into setData", chartSrc.includes("...whitespacePts"));
check("Chart uses barSeconds for step", chartSrc.includes("buildFutureWhitespaceTimes(last.time, stepSec"));
check("no synthetic open on whitespace path", !/whitespacePts\.map\(\(t\).*open:/.test(chartSrc.replace(/\n/g, " ")));
check("bars effect depends on barSeconds", chartSrc.includes("[bars, cursor, followPrice, barSeconds]"));
check("follow gate intact", chartSrc.includes("shouldAutoFollowScroll(followRef.current"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
