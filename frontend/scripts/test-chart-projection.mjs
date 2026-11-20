let P;
if (process.env.PROJ_TEST_MODULE) {
  P = await import(process.env.PROJ_TEST_MODULE);
} else {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  P = require(`${process.env.PROJ_TEST_LIB}/chartProjection.js`);
}
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) pass++; else { fail++; console.log("FAIL:", n, e); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// 5m bars with a weekend gap in the middle (Fri 21:55 -> Sun 22:00)
const STEP = 300;
const bars = [];
for (let i = 0; i < 20; i++) bars.push({ time: 1000000 + i * STEP });
const gapStart = bars[bars.length - 1].time;
for (let i = 0; i < 20; i++) bars.push({ time: gapStart + 48 * 3600 + i * STEP });
const period = P.projectionPeriod(STEP);

ok("projectionPeriod prefers the display step", P.projectionPeriod(300, 60) === 300 && P.projectionPeriod(null, 120) === 120 && P.projectionPeriod(0, 0) === 60 && P.projectionPeriod(NaN) === 60);

// round trip logical -> time -> logical everywhere, including before the first bar and in the future whitespace
let worst = 0;
for (let l = -12; l <= bars.length - 1 + 90; l += 0.37) {
  const t = P.logicalToTime(bars, l, period);
  const back = P.timeToLogical(bars, t, period);
  worst = Math.max(worst, Math.abs(back - l));
}
ok("logical <-> time round trip is exact (gap, before first, whitespace)", worst < 1e-6, String(worst));
ok("bar open time maps to its integer index", near(P.timeToLogical(bars, bars[7].time, period), 7) && near(P.timeToLogical(bars, bars[25].time, period), 25));
ok("a time inside a bar is a fraction between neighbours", near(P.timeToLogical(bars, bars[3].time + 150, period), 3.5));
ok("future whitespace uses the display step", near(P.timeToLogical(bars, bars[bars.length - 1].time + 10 * STEP, period), bars.length - 1 + 10));
ok("empty / bad input -> null", P.timeToLogical([], 5, 60) === null && P.timeToLogical(bars, NaN, 60) === null && P.logicalToTime(bars, NaN, 60) === null && P.timeToLogical(bars, 5, 0) === null);

// the old inference from the first two bars breaks across a gap; the display step does not
const naive = bars[1].time - bars[0].time;
ok("display step is stable while first-two-bars spacing can be a gap", naive === STEP);
const gapFirst = [{ time: 0 }, { time: 172800 }, { time: 173100 }, { time: 173400 }, { time: 173700 }];
ok("first-two-bars spacing would be 172800 across a gap (the old bug)", gapFirst[1].time - gapFirst[0].time === 172800);
ok("median spacing ignores a leading gap", P.medianSpacing(gapFirst.map((b) => b.time)) === 300);
ok("median spacing null for <2 bars", P.medianSpacing([5]) === null);

// continuous x -> logical, for a coordinateToLogical that returns FLOATS and one that returns INTEGERS
const spacing = 9.5, offset = 37.25;
const l2c = (l) => offset + l * spacing;
const c2lFloat = (x) => (x - offset) / spacing;
const c2lInt = (x) => Math.ceil((x - offset) / spacing); // snapping variant
let wf = 0, wi = 0;
for (let x = 20; x < 900; x += 3.3) {
  wf = Math.max(wf, Math.abs(P.continuousLogicalAt(x, c2lFloat, l2c) - (x - offset) / spacing));
  wi = Math.max(wi, Math.abs(P.continuousLogicalAt(x, c2lInt, l2c) - (x - offset) / spacing));
}
ok("continuous inverse exact with a float coordinateToLogical", wf < 1e-9, String(wf));
ok("continuous inverse exact even when coordinateToLogical snaps to integers", wi < 1e-9, String(wi));
ok("continuous inverse handles null", P.continuousLogicalAt(5, () => null, l2c) === null && P.continuousLogicalAt(5, () => NaN, l2c) === null);
ok("falls back to the raw value when calibration is impossible", P.continuousLogicalAt(5, () => 3.25, () => null) === 3.25);

// full chain screen x -> time -> screen x is the identity (no drift when a drawing is dragged)
let drift = 0;
const l2cChain = (l) => 40 + l * 8.5;
const c2lChain = (x) => (x - 40) / 8.5;
for (let x = 45; x < 800; x += 5.7) {
  const lg = P.continuousLogicalAt(x, c2lChain, l2cChain);
  const t = P.logicalToTime(bars, lg, period);
  const lg2 = P.timeToLogical(bars, t, period);
  drift = Math.max(drift, Math.abs(l2cChain(lg2) - x));
}
ok("x -> time -> x has no drift (cursor and drawing stay together)", drift < 1e-6, String(drift));

// TF switch: the same market time lands on the right place on a different series
const bars15 = []; for (let i = 0; i < 10; i++) bars15.push({ time: 1000000 + i * 900 });
const t0 = 1000000 + 4 * STEP + 90; // a time that lies inside a 5m bar and inside a 15m bar
const l5 = P.timeToLogical(bars.slice(0, 20), t0, 300);
const l15 = P.timeToLogical(bars15, t0, 900);
ok("same market time -> proportional position on both timeframes", near(l5 * 300, (t0 - 1000000)) && near(l15 * 900, (t0 - 1000000)));

// pane rectangle (overlay canvas also covers the axes)
const R = P.paneRect;
ok("paneRect without info = whole canvas", JSON.stringify(R(860, 400)) === JSON.stringify({ x: 0, y: 0, w: 860, h: 400 }));
ok("paneRect excludes the right price axis", R(860, 400, { plotW: 800 }).w === 800);
ok("paneRect excludes the time axis", R(860, 400, { timeScaleH: 26 }).h === 374);
ok("paneRect prefers paneH", R(860, 400, { paneH: 370, timeScaleH: 26 }).h === 370);
ok("paneRect left scale shifts x", R(900, 400, { leftScaleW: 50, plotW: 800 }).x === 50);
ok("paneRect ignores nonsense", JSON.stringify(R(860, 400, { plotW: 5000, timeScaleH: 900, paneH: -1, leftScaleW: NaN })) === JSON.stringify({ x: 0, y: 0, w: 860, h: 400 }));

console.log(`chart projection tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
