import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const M = require(`${process.env.EQUITY_TEST_LIB}/equityCurveModel.js`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL:", name, extra); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const P = (time, balance, pnl = 0, tradeId = "") => ({ time, balance, pnl, tradeId });
const DAY = 86400;
const utcDay = (t) => String(Math.floor(t / DAY));

// ---------- basics ----------
{
  const n = M.normalizePoints([P(30, 1100), P(10, 1000), P(NaN, 5), P(20, 1050)]);
  ok("normalize sorts and drops NaN", n.length === 3 && n[0].time === 10 && n[2].time === 30);
  const pts = [P(100, 1000), P(200, 1100, 100, "a"), P(300, 1050, -50, "b")];
  ok("stepValueAt before first = starting balance", M.stepValueAt(pts, 50, 999) === 999);
  ok("stepValueAt at exact time includes that close", M.stepValueAt(pts, 200, 1000) === 1100);
  ok("stepValueAt between closes is flat", M.stepValueAt(pts, 250, 1000) === 1100);
  ok("stepValueBefore excludes the close at t", M.stepValueBefore(pts, 200, 1000) === 1000);
  ok("stepValueBefore before everything = starting balance", M.stepValueBefore(pts, 100, 777) === 777);
  ok("nearestPointIndex picks the closest", M.nearestPointIndex(pts, 140) === 0 && M.nearestPointIndex(pts, 160) === 1 && M.nearestPointIndex(pts, 9999) === 2 && M.nearestPointIndex(pts, 1) === 0);
  ok("nearestPointIndex empty", M.nearestPointIndex([], 5) === -1);
  const pk = M.runningPeak(pts, 1000);
  ok("running peak", JSON.stringify(pk) === JSON.stringify([1000, 1100, 1100]));
  ok("peakAt", M.peakAt(pts, pk, 250, 1000) === 1100 && M.peakAt(pts, pk, 50, 1000) === 1000);
}

// ---------- windows ----------
{
  const pts = [P(0, 1000), P(10 * DAY, 1100), P(40 * DAY, 1200)];
  const full = M.fullWindow(pts);
  ok("fullWindow", full.t0 === 0 && full.t1 === 40 * DAY);
  ok("fullWindow single point has a span", M.fullWindow([P(5, 1)]).t1 > 5);
  const w = M.rangeWindow(pts, "week");
  ok("range week = last 7 days", w.t1 === 40 * DAY && near(w.t1 - w.t0, 7 * DAY));
  ok("range month = last 30 days", near(M.rangeWindow(pts, "month").t1 - M.rangeWindow(pts, "month").t0, 30 * DAY));
  ok("range day = last 1 day", near(M.rangeWindow(pts, "day").t1 - M.rangeWindow(pts, "day").t0, DAY));
  ok("range all = full", JSON.stringify(M.rangeWindow(pts, "all")) === JSON.stringify(full));
  const short = [P(0, 1), P(2 * DAY, 2)];
  ok("range month on a 2-day journal clamps to full", JSON.stringify(M.rangeWindow(short, "month")) === JSON.stringify(M.fullWindow(short)));
  // zoom keeps the anchor at the same screen fraction
  const win = { t0: 0, t1: 1000 };
  const z = M.zoomWindow(win, 2, 250, { t0: 0, t1: 1000 });
  ok("zoom in halves the span", near(z.t1 - z.t0, 500));
  ok("zoom keeps the anchor fraction", near((250 - z.t0) / (z.t1 - z.t0), 0.25));
  const z2 = M.zoomWindow({ t0: 100, t1: 600 }, 0.5, 350, { t0: 0, t1: 1000 });
  ok("zoom out doubles the span and stays inside bounds", near(z2.t1 - z2.t0, 1000) && z2.t0 >= 0 && z2.t1 <= 1000);
  ok("zoom has a minimum span", M.zoomWindow({ t0: 0, t1: 100 }, 1000, 50, { t0: 0, t1: 1000 }).t1 - M.zoomWindow({ t0: 0, t1: 100 }, 1000, 50, { t0: 0, t1: 1000 }).t0 >= 60);
  const pn = M.panWindow({ t0: 200, t1: 400 }, 900, { t0: 0, t1: 1000 });
  ok("pan clamps to the end", pn.t1 === 1000 && near(pn.t1 - pn.t0, 200));
  const pm = M.panWindow({ t0: 200, t1: 400 }, 300, { t0: 0, t1: 1000 });
  ok("pan inside bounds just shifts", pm.t0 === 500 && pm.t1 === 700);
  ok("pan clamps to the start", M.panWindow({ t0: 200, t1: 400 }, -999, { t0: 0, t1: 1000 }).t0 === 0);
  ok("isFullWindow", M.isFullWindow({ t0: 0, t1: 1000 }, { t0: 0, t1: 1000 }) && !M.isFullWindow({ t0: 10, t1: 1000 }, { t0: 0, t1: 1000 }));
  ok("zoom ignores bad factor", M.zoomWindow(win, NaN, 5, win) === win && M.zoomWindow(win, -1, 5, win) === win);
}

// ---------- decimate (display only, values stay exact) ----------
{
  const small = Array.from({ length: 50 }, (_, i) => P(i * 10, 1000 + i));
  ok("small series is returned whole (excluding the window start)", M.decimate(small, { t0: 0, t1: 490 }, 600).length === 49);
  const N = 20000;
  const big = Array.from({ length: N }, (_, i) => P(i, 1000 + Math.sin(i / 50) * 100 + (i === 12345 ? 777 : 0)));
  const win = { t0: 0, t1: N - 1 };
  const d = M.decimate(big, win, 200);
  ok("decimate bounds the vertex count", d.length <= 200 * 4 && d.length > 100, String(d.length));
  ok("decimate keeps time order", d.every((p, i) => i === 0 || p.time >= d[i - 1].time));
  ok("decimate keeps the global spike (max)", d.some((p) => p.time === 12345));
  ok("decimate keeps the last point", d[d.length - 1].time === N - 1);
  const sub = M.decimate(big, { t0: 5000, t1: 6000 }, 200);
  ok("decimate respects the window", sub.every((p) => p.time > 5000 && p.time <= 6000));
}

// ---------- step geometry ----------
{
  const pts = [P(0, 1000), P(10, 1100, 100, "a"), P(20, 1050, -50, "b")];
  const x = (t) => t, y = (v) => v;
  const d = M.stepPathD(pts, { t0: 0, t1: 30 }, 1000, x, y);
  ok("step path is flat then jumps at each close", d === "M0,1000 H10 V1100 H20 V1050 H30", d);
  const mid = M.stepPathD(pts, { t0: 15, t1: 30 }, 1000, x, y);
  ok("window start uses the balance in force at t0", mid === "M15,1100 H20 V1050 H30", mid);
  const area = M.stepAreaD(pts, { t0: 0, t1: 30 }, 1000, x, y, 2000);
  ok("area closes down to the bottom", area.endsWith("V2000 H0 Z"));
  const gap = M.peakGapAreaD(pts, M.runningPeak(pts, 1000), { t0: 0, t1: 30 }, 1000, x, y);
  ok("peak-gap area is a closed shape", gap.startsWith("M0,1000") && gap.endsWith("Z"));
}

// ---------- allowed drawdown levels ----------
{
  ok("account floor = start*(1-pct) (8% of 1000 = 920)", near(M.accountFloor(1000, 8), 920));
  ok("account floor needs start and pct", M.accountFloor(0, 8) === null && M.accountFloor(1000, null) === null && M.accountFloor(1000, 0) === null);

  const t0 = 10 * DAY + 3600; // 01:00 UTC of day 10
  const pts = [
    P(t0, 1000),
    P(10 * DAY + 10 * 3600, 1100, 100, "a"), // day 10, +100
    P(12 * DAY + 5 * 3600, 1050, -50, "b"), // day 12 (day 11 had no trades)
    P(13 * DAY, 1080, 30, "c"), // EXACTLY midnight: belongs to day 13
  ];
  const bounds = M.fullWindow(pts);
  const segs = M.dailyFloor(pts, 1000, 4, utcDay, bounds);
  const lv = (t) => M.floorAt(segs, t);
  ok("daily limit = 4% of the starting balance (40)", near(lv(t0 + 100), 960));
  ok("first day uses the starting balance (1000-40)", near(lv(10 * DAY + 20 * 3600), 960));
  ok("next day starts from the balance at its start (1100-40)", near(lv(11 * DAY + 1), 1060));
  ok("a day with no trades keeps the carried balance", near(lv(11 * DAY + 80000), 1060));
  ok("day 12 still starts from 1100 (the -50 closes inside it)", near(lv(12 * DAY + 100), 1060) && near(lv(12 * DAY + 20 * 3600), 1060));
  ok("day 13 starts from 1050 (a close AT midnight belongs to the new day)", near(lv(13 * DAY), 1010), String(lv(13 * DAY)));
  ok("segments are contiguous and cover the whole range",
    segs[0].t0 === bounds.t0 && segs[segs.length - 1].t1 >= bounds.t1 && segs.every((s, i) => i === 0 || s.t0 === segs[i - 1].t1));
  ok("boundaries land exactly on midnight", segs.slice(1).every((s) => s.t0 % DAY === 0));
  ok("no segments without a daily limit", M.dailyFloor(pts, 1000, null, utcDay, bounds).length === 0 && M.dailyFloor(pts, 0, 4, utcDay, bounds).length === 0);
  ok("floorAt empty", M.floorAt([], 5) === null);

  // non-UTC trading day (DST aware): New York calendar day
  const nyKey = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));
  const jan = Date.UTC(2026, 0, 15, 12) / 1000;
  const nyPts = [P(jan, 1000), P(jan + 2 * DAY, 1200, 200, "x")];
  const nySegs = M.dailyFloor(nyPts, 1000, 5, nyKey, M.fullWindow(nyPts));
  ok("NY day boundary = 05:00 UTC in January", nySegs.length >= 2 && nySegs[0].t1 === Date.UTC(2026, 0, 16, 5) / 1000, String(nySegs[0] && nySegs[0].t1));
  const jul = Date.UTC(2026, 6, 15, 12) / 1000;
  const nyJul = M.dailyFloor([P(jul, 1000), P(jul + DAY, 1000)], 1000, 5, nyKey, { t0: jul, t1: jul + DAY });
  ok("NY day boundary = 04:00 UTC in July (DST)", nyJul[0].t1 === Date.UTC(2026, 6, 16, 4) / 1000);
}

// ---------- axes ----------
{
  const t = M.niceTicks(0, 1037, 5);
  ok("niceTicks are increasing nice multiples inside the range", t.length >= 3 && t.every((v, i) => i === 0 || v > t[i - 1]) && t.every((v) => v >= 0 && v <= 1037) && t[1] - t[0] === 200, JSON.stringify(t));
  const t2 = M.niceTicks(900, 1100, 4);
  ok("niceTicks 900..1100", t2[0] >= 900 && t2[t2.length - 1] <= 1100 && t2.length >= 3, JSON.stringify(t2));
  ok("niceTicks equal min/max still returns ticks", M.niceTicks(5, 5, 4).length >= 1);
  ok("niceTicks bad input", M.niceTicks(NaN, 5).length === 0);
  const tt = M.timeTicks({ t0: 0, t1: 30 * DAY }, 5);
  ok("timeTicks inside window and increasing", tt.length >= 3 && tt.every((v, i) => v >= 0 && v <= 30 * DAY && (i === 0 || v > tt[i - 1])));
  ok("timeFormatFor by span", M.timeFormatFor({ t0: 0, t1: DAY }) === "time" && M.timeFormatFor({ t0: 0, t1: 30 * DAY }) === "day" && M.timeFormatFor({ t0: 0, t1: 400 * DAY }) === "month");
  ok("formatTick UTC day", M.formatTick(Date.UTC(2026, 4, 2) / 1000, "day", "UTC").length > 2);
  ok("formatStamp has date and time", /2026/.test(M.formatStamp(Date.UTC(2026, 9, 1, 23, 20, 1) / 1000, "UTC")) && /23/.test(M.formatStamp(Date.UTC(2026, 9, 1, 23, 20, 1) / 1000, "UTC")));
  const yd = M.yDomain([1000, 1100]);
  ok("yDomain pads both sides", yd.min < 1000 && yd.max > 1100);
  ok("yDomain flat series still has a span", M.yDomain([1000, 1000]).max > M.yDomain([1000, 1000]).min);
  ok("yDomain empty", M.yDomain([]).max > M.yDomain([]).min);
}

console.log(`equity model tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
