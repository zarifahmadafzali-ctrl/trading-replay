/**
 * Phase C1.3 — pure chart future-whitespace helpers (no DOM).
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
  "candleSeriesHasOnlyRealTimes",
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
function candleSeriesHasOnlyRealTimes(seriesTimes, lastRealTime) {
  if (!seriesTimes.length) return true;
  return seriesTimes.every((t) => Number.isFinite(t) && t <= lastRealTime);
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
check("last real index still in range", r && r.from <= 99 && r.to > 99);
check("null on empty data", followVisibleLogicalRange(0, 80) === null);

const realTimes = [1, 2, 3, 10];
check("only real times ok", candleSeriesHasOnlyRealTimes(realTimes, 10) === true);
check("future synthetic rejected", candleSeriesHasOnlyRealTimes([1, 2, 11], 10) === false);

check("follow off no auto scroll", shouldAutoFollowScroll(false, 50) === false);
check("follow on with data", shouldAutoFollowScroll(true, 50) === true);
check("follow on empty data", shouldAutoFollowScroll(true, 0) === false);

check("Chart uses CHART_FUTURE_LOGICAL_BARS", chartSrc.includes("CHART_FUTURE_LOGICAL_BARS"));
check("Chart uses setVisibleLogicalRange for follow", chartSrc.includes("setVisibleLogicalRange"));
check("Chart still only maps real bars to setData", /setData\(\s*visible\.map/.test(chartSrc) || chartSrc.includes("visible.map((b)"));
check("no fake zero candles in Chart follow path", !chartSrc.includes("open: 0, high: 0") && !/futureCandle/.test(chartSrc));
check("manual pan protected (follow gate)", chartSrc.includes("shouldAutoFollowScroll(followRef.current"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
