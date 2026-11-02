import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = process.env.POSITION_TEST_LIB;
const M = require(`${L}/positionModel.js`);
const E = require(`${L}/positionEngine.js`);
const R = require(`${L}/positionRender.js`);

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; } else { fail++; console.log("FAIL:", name, extra); }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const bar = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c });
const pos = (over = {}) => ({
  id: "p1", kind: "position", side: "long", orderType: "market", status: "open",
  entry: { time: 100, price: 100 }, stop: { time: 100, price: 95 }, takeProfit: { time: 100, price: 110 }, ...over,
});

// ---------- ENGINE: legacy behaviour ----------
{
  let r = E.runPositionBars([pos()], [bar(101, 100, 101, 94, 96)]);
  ok("long SL exit at stop", r.closed.length === 1 && r.closed[0].reason === "sl" && r.closed[0].exitPrice === 95 && r.shapes.length === 0);
  r = E.runPositionBars([pos()], [bar(101, 100, 111, 99, 105)]);
  ok("long TP exit at target", r.closed[0].reason === "tp" && r.closed[0].exitPrice === 110 && near(r.closed[0].pnlPoints, 10));
  r = E.runPositionBars([pos()], [bar(101, 100, 111, 94, 100)]);
  ok("SL wins when SL and TP in same bar", r.closed[0].reason === "sl");
  r = E.runPositionBars([pos({ side: "short", stop: { time: 100, price: 105 }, takeProfit: { time: 100, price: 90 } })], [bar(101, 100, 106, 99, 100)]);
  ok("short SL", r.closed[0].reason === "sl" && r.closed[0].exitPrice === 105 && near(r.closed[0].pnlPoints, -5));
  r = E.runPositionBars([pos()], [bar(100, 100, 120, 80, 100)]);
  ok("same second as entry uses close only (no instant exit)", r.closed.length === 0 && r.shapes.length === 1);
  r = E.runPositionBars([pos({ status: "draft" })], [bar(101, 100, 120, 80, 100)]);
  ok("draft is never touched", r.closed.length === 0 && r.shapes[0].status === "draft");
  r = E.runPositionBars([pos({ orderType: "buy_limit", status: "pending", entry: { time: 90, price: 98 } })], [bar(101, 100, 101, 97, 99)]);
  ok("buy_limit fills at its price, status open", r.shapes[0].status === "open" && r.shapes[0].entry.price === 98 && r.shapes[0].entry.time === 101);
  ok("fill bar is not SL/TP-checked", r.closed.length === 0);
  r = E.runPositionBars([pos({ orderType: "buy_stop", status: "pending", entry: { time: 90, price: 102 } })], [bar(101, 100, 103, 99, 102)]);
  ok("buy_stop fills when high touches", r.shapes[0].status === "open");
  // stop-limit two stage
  const sl = pos({ orderType: "buy_stop_limit", status: "pending", entry: { time: 90, price: 101 }, stopPrice: 103, limitPrice: 101, stopTriggered: false });
  r = E.runPositionBars([sl], [bar(101, 100, 102, 99.5, 100)]);
  ok("stop-limit untouched below stop", r.shapes[0].status === "pending" && !r.shapes[0].stopTriggered);
  r = E.runPositionBars([sl], [bar(101, 100, 104, 102, 103)]);
  ok("stop-limit armed, limit not hit", r.shapes[0].status === "pending" && r.shapes[0].stopTriggered === true && r.events.some((e) => e.type === "stop_armed"));
  r = E.runPositionBars([sl], [bar(101, 100, 104, 100, 103)]);
  ok("stop-limit armed and limit hit same bar fills", r.shapes[0].status === "open" && r.shapes[0].entry.price === 101);
}

// ---------- ENGINE: differential test vs the OLD inline Chart.tsx loop ----------
function pendingTouchedOld(t, e, hi, lo) {
  if (t === "buy_limit") return lo <= e; if (t === "sell_limit") return hi >= e;
  if (t === "buy_stop") return hi >= e; if (t === "sell_stop") return lo <= e; return false;
}
function legacyRun(shapes, seq) {
  let working = shapes.slice(); const closed = [];
  for (const bar of seq) {
    const nw = [];
    for (const s of working) {
      if (s.kind !== "position") { nw.push(s); continue; }
      if (s.status === "pending") {
        const hi = bar.high, lo = bar.low;
        const isSL = s.orderType === "buy_stop_limit" || s.orderType === "sell_stop_limit";
        if (isSL) {
          const stopPx = s.stopPrice, limitPx = s.limitPrice;
          if (stopPx == null || limitPx == null) { nw.push(s); continue; }
          let triggered = !!s.stopTriggered;
          if (!triggered) { if (s.orderType === "buy_stop_limit" && hi >= stopPx) triggered = true; if (s.orderType === "sell_stop_limit" && lo <= stopPx) triggered = true; }
          if (triggered) {
            const hit = s.orderType === "buy_stop_limit" ? lo <= limitPx : hi >= limitPx;
            if (hit) { nw.push({ ...s, status: "open", stopTriggered: true, entry: { time: bar.time, price: limitPx } }); continue; }
          }
          if (triggered !== !!s.stopTriggered) nw.push({ ...s, stopTriggered: triggered }); else nw.push(s);
          continue;
        }
        if (pendingTouchedOld(s.orderType, s.entry.price, hi, lo)) nw.push({ ...s, status: "open", entry: { time: bar.time, price: s.entry.price } }); else nw.push(s);
        continue;
      }
      if (s.status !== "open") { nw.push(s); continue; }
      const same = bar.time <= s.entry.time; const hi = same ? bar.close : bar.high; const lo = same ? bar.close : bar.low;
      const long = s.side === "long"; let reason = null; let exitPrice = bar.close;
      if (long) { if (lo <= s.stop.price) { reason = "sl"; exitPrice = s.stop.price; } else if (hi >= s.takeProfit.price) { reason = "tp"; exitPrice = s.takeProfit.price; } }
      else { if (hi >= s.stop.price) { reason = "sl"; exitPrice = s.stop.price; } else if (lo <= s.takeProfit.price) { reason = "tp"; exitPrice = s.takeProfit.price; } }
      if (!reason) { nw.push(s); continue; }
      closed.push({ id: s.id, reason, exitPrice, exitTime: bar.time, pnlPoints: long ? exitPrice - s.entry.price : s.entry.price - exitPrice });
    }
    working = nw;
  }
  return { working, closed };
}
{
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const types = ["market", "buy_limit", "sell_limit", "buy_stop", "sell_stop", "buy_stop_limit", "sell_stop_limit"];
  let mismatches = 0; const N = 3000;
  for (let n = 0; n < N; n++) {
    const shapes = [];
    for (let k = 0; k < 3; k++) {
      const side = rnd() < 0.5 ? "long" : "short"; const ot = types[Math.floor(rnd() * types.length)];
      const px = 100 + (rnd() - 0.5) * 6; const status = ot === "market" ? "open" : (rnd() < 0.85 ? "pending" : "draft");
      const sp = side === "long" ? px - 1 - rnd() * 3 : px + 1 + rnd() * 3; const tp = side === "long" ? px + 1 + rnd() * 3 : px - 1 - rnd() * 3;
      shapes.push({ id: "s" + k, kind: "position", side, orderType: ot, status, entry: { time: 100, price: px }, stop: { time: 100, price: sp }, takeProfit: { time: 100, price: tp },
        ...(ot.endsWith("stop_limit") ? { stopPrice: px + (side === "long" ? 1 : -1) * rnd() * 3, limitPrice: px, stopTriggered: rnd() < 0.2 } : {}) });
    }
    shapes.push({ id: "d1", kind: "trendline" });
    const seq = []; let c = 100;
    for (let i = 0; i < 12; i++) { const o = c; const hi = o + rnd() * 3; const lo = o - rnd() * 3; c = lo + rnd() * (hi - lo); seq.push(bar(100 + i, o, hi, lo, c)); }
    const a = legacyRun(shapes, seq); const b = E.runPositionBars(shapes, seq);
    const norm = (x) => JSON.stringify(x.map((s) => ({ id: s.id, kind: s.kind, status: s.status, e: s.entry, t: s.stopTriggered ?? null })));
    const cn = (x) => JSON.stringify(x.map((q) => [q.id, q.reason, q.exitPrice, q.exitTime, q.pnlPoints]));
    if (norm(a.working) !== norm(b.shapes) || cn(a.closed) !== cn(b.closed)) mismatches++;
  }
  ok(`differential: new engine == old Chart.tsx loop on ${N} random cases`, mismatches === 0, `mismatches=${mismatches}`);
}

// ---------- ENGINE: opt-ins ----------
{
  let r = E.runPositionBars([pos()], [bar(101, 90, 91, 89, 90)], {}, { gapFill: true });
  ok("gapFill: long SL gapped through exits at open", r.closed[0].exitPrice === 90 && near(r.closed[0].pnlPoints, -10));
  r = E.runPositionBars([pos()], [bar(101, 90, 91, 89, 90)]);
  ok("legacy: same gap exits at stop level", r.closed[0].exitPrice === 95);
  r = E.runPositionBars([pos({ orderType: "buy_stop", status: "pending", entry: { time: 90, price: 102 } })], [bar(101, 105, 106, 104, 105)], {}, { gapFill: true });
  ok("gapFill: buy_stop gapped up fills at open (slippage)", r.shapes[0].entry.price === 105);
  r = E.runPositionBars([pos({ orderType: "buy_limit", status: "pending", entry: { time: 90, price: 98 } })], [bar(101, 96, 99, 95, 97)], {}, { gapFill: true });
  ok("gapFill: buy_limit gapped below fills at open (improvement)", r.shapes[0].entry.price === 96);
  r = E.runPositionBars([pos({ orderType: "buy_limit", status: "pending", entry: { time: 90, price: 98 } })], [bar(101, 100, 101, 97, 99)], { canFill: () => false });
  ok("canFill=false cancels the pending order", r.shapes.length === 0 && r.events[0].type === "cancelled");
  r = E.runPositionBars([pos({ orderType: "buy_limit", status: "pending", entry: { time: 90, price: 98 }, rightTime: 120 })], [bar(500, 100, 101, 97, 99)]);
  ok("fill extends rightTime so the box stays visible", r.shapes[0].rightTime > 500);
  r = E.runPositionBars([pos()], [bar(101, 100, 101, 94, 96)], { onClose: () => ({ screenshot: "SHOT" }) });
  ok("onClose hook merges screenshot", r.closed[0].screenshot === "SHOT");
  const mc = E.manualClose(pos(), { price: 103, time: 150 });
  ok("manual close pnl", mc && near(mc.pnlPoints, 3) && mc.reason === "manual");
  ok("manual close refused for pending", E.manualClose(pos({ status: "pending" }), { price: 103, time: 150 }) === null);
}

// ---------- MODEL: validation ----------
{
  ok("valid long has no errors", M.validatePosition(pos(), 100).length === 0);
  ok("long with SL above entry is an error", M.validatePosition(pos({ stop: { time: 1, price: 101 } }), 100).some((i) => i.code === "sl_side"));
  ok("short with TP above entry is an error", M.validatePosition(pos({ side: "short", stop: { time: 1, price: 105 }, takeProfit: { time: 1, price: 101 } }), 100).some((i) => i.code === "tp_side"));
  ok("buy_limit above market is an error", M.validatePosition(pos({ orderType: "buy_limit", status: "draft", entry: { time: 1, price: 101 } }), 100).some((i) => i.code === "pending_side"));
  ok("open long: SL above market flagged", M.validatePosition(pos(), 94).some((i) => i.code === "sl_crossed"));
  const pc = M.prepareConfirm(pos({ status: "draft", entry: { time: 50, price: 90 }, stop: { time: 50, price: 85 }, takeProfit: { time: 50, price: 100 } }), { price: 100, time: 200 });
  ok("market confirm uses CURRENT price/time, not stale draft", pc.pos.entry.price === 100 && pc.pos.entry.time === 200);
  const pc2 = M.prepareConfirm(pos({ status: "draft", entry: { time: 50, price: 90 }, stop: { time: 50, price: 85 }, takeProfit: { time: 50, price: 100 } }), { price: 105, time: 200 });
  ok("market confirm blocked when the market already moved past the target", pc2.ok === false && pc2.issues.some((i) => i.code === "tp_side"));
  const pc3 = M.prepareConfirm(pos({ status: "draft", entry: { time: 50, price: 90 }, stop: { time: 50, price: 101 }, takeProfit: { time: 50, price: 120 } }), { price: 100, time: 200 });
  ok("market confirm blocked when the market already moved below the stop", pc3.ok === false && pc3.issues.some((i) => i.code === "sl_side"));
}

// ---------- MODEL: drag / geometry / texts ----------
{
  const o = { pt: { time: 100, price: 100 }, pos: pos({ status: "draft" }) };
  let d = M.applyPositionDrag(o.pos, "stop", { time: 100, price: 120 }, o, { tick: 0.01, barSec: 60 });
  ok("drag SL across entry is clamped below entry", d.stop.price < 100 && near(d.stop.price, 99.99, 1e-6));
  d = M.applyPositionDrag(o.pos, "takeProfit", { time: 100, price: 80 }, o, { tick: 0.01, barSec: 60 });
  ok("drag TP across entry is clamped above entry", near(d.takeProfit.price, 100.01, 1e-6));
  const pend = pos({ status: "pending", orderType: "buy_limit", rightTime: 700 });
  d = M.applyPositionDrag(pend, "body", { time: 160, price: 103 }, { pt: { time: 100, price: 100 }, pos: pend }, { tick: 0.01, barSec: 60 });
  ok("body drag moves whole position (price+time, keeps distances)", near(d.entry.price, 103) && near(d.stop.price, 98) && near(d.takeProfit.price, 113) && d.rightTime === 760);
  const open = pos({ rightTime: 700 });
  d = M.applyPositionDrag(open, "body", { time: 160, price: 103 }, { pt: { time: 100, price: 100 }, pos: open }, { tick: 0.01, barSec: 60 });
  ok("open position body is not movable", d === open || (d.entry.price === 100));
  d = M.applyPositionDrag(open, "stop", { time: 100, price: 99 }, { pt: { time: 100, price: 99 }, pos: open }, { tick: 0.01, barSec: 60, market: 98 });
  ok("open: SL cannot be dragged beyond the current market", d.stop.price <= 97.99 + 1e-9);
  d = M.applyPositionDrag(pos({ locked: true }), "stop", { time: 1, price: 90 }, { pt: { time: 1, price: 90 }, pos: pos() }, { tick: 0.01, barSec: 60 });
  ok("locked position cannot be dragged", d.stop.price === 95);
  d = M.applyPositionDrag(open, "right", { time: 50, price: 100 }, { pt: { time: 50, price: 100 }, pos: open }, { tick: 0.01, barSec: 60 });
  ok("right edge has a minimum width", d.rightTime >= 100 + 180);

  const box = M.positionBox(pos({ rightTime: 700 }), { xOf: (t) => t * 0.5, yOf: (p) => 1000 - p * 5, w: 800 });
  ok("box x0/x1 from times", box && near(box.x0, 50) && near(box.x1, 350));
  const legacy = M.positionBox(pos(), { xOf: () => null, yOf: (p) => 1000 - p * 5, w: 800 });
  ok("legacy shape (no rightTime) = full width", legacy.x0 === 0 && legacy.x1 === 800);
  ok("hit: TP line", M.hitTestPosition(pos(), box, 200, box.tpY + 2, { tol: 8 }) === "takeProfit");
  ok("hit: right handle wins over lines", M.hitTestPosition(pos(), box, box.x1, box.entryY, { tol: 8 }) === "right");
  ok("hit: outside = null", M.hitTestPosition(pos(), box, 700, 5, { tol: 8 }) === null);
  ok("hit: open entry line is not draggable (body)", M.hitTestPosition(pos(), box, 200, box.entryY, { tol: 8 }) === "body");
  ok("hit: draft entry line draggable", M.hitTestPosition(pos({ status: "draft" }), box, 200, box.entryY, { tol: 8 }) === "entry");

  const t = M.buildPositionTexts(pos(), { priceDecimals: 2, tick: 0.01, lot: 1.5, riskAmount: 75, rewardAmount: 150, openPnL: 12.5 });
  ok("texts: target", t.target === "Target: 110.00 (10.00%) 1000, Amount: 150.00", t.target);
  ok("texts: stop", t.stop === "Stop: 95.00 (-5.00%) 500, Amount: -75.00", t.stop);
  ok("texts: center has pnl, qty, rr", t.center === "Open P&L: +12.50, Qty: 1.5, Risk/Reward Ratio: 2.00", t.center);
  ok("level conversion ticks->price (long TP)", near(M.levelFromInput("long", "takeProfit", 100, 50, "ticks", 0.1), 105));
  ok("level conversion % (short SL goes up)", near(M.levelFromInput("short", "stop", 100, 2, "percent", 0.01), 102));
  ok("normalize drops bad rightTime", M.normalizePosition(pos({ rightTime: 50 })).rightTime === undefined);
  ok("normalize drops bad risk", M.normalizePosition(pos({ risk: { percent: -1 } })).risk === undefined);
  ok("old shape passes normalize unchanged", JSON.stringify(M.normalizePosition(pos())) === JSON.stringify(pos()));
}

// ---------- RENDER: recorder context ----------
{
  const calls = [];
  const ctx = new Proxy({}, {
    get(_, k) { if (k === "measureText") return (t) => ({ width: String(t).length * 6 }); return (...a) => { calls.push([k, ...a]); }; },
    set(_, k, v) { calls.push(["set:" + k, v]); return true; },
  });
  const style = M.resolveStyle({});
  const shortPos = pos({ side: "short", stop: { time: 100, price: 105 }, takeProfit: { time: 100, price: 90 } });
  const box = M.positionBox(shortPos, { xOf: () => null, yOf: (p) => 1000 - p * 5, w: 800 });
  const texts = M.buildPositionTexts(shortPos, { priceDecimals: 2, tick: 0.01 });
  let threw = false;
  try { R.drawPosition(ctx, shortPos, { box, w: 800, h: 1000, style, texts, selected: true, priceDecimals: 2 }); } catch (e) { threw = true; console.log(e); }
  ok("render does not throw", !threw && calls.length > 20);
  const fills = calls.filter((c) => c[0] === "set:fillStyle").map((c) => String(c[1]));
  ok("short: profit zone uses profitColor (green), not red", fills.some((f) => f.startsWith("rgba(8,153,129")));
  ok("short: stop zone uses stopColor (red)", fills.some((f) => f.startsWith("rgba(242,54,69")));
  calls.length = 0;
  R.drawPosition(ctx, shortPos, { box, w: 800, h: 1000, style, texts, selected: true, priceDecimals: 2, forScreenshot: true });
  ok("screenshot mode draws no selection handles", !calls.some((c) => c[0] === "arc"));
  calls.length = 0;
  R.drawPosition(ctx, shortPos, { box, w: 800, h: 1000, style, texts, selected: true, priceDecimals: 2 });
  ok("selected draws handles", calls.some((c) => c[0] === "arc"));
}

console.log(`position tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
