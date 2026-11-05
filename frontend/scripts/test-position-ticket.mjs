import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = process.env.POSITION_TEST_LIB;
const M = require(`${L}/positionModel.js`);
const S = require(`${L}/positionSizing.js`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL:", name, extra); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const pos = (o = {}) => ({
  id: "d1", kind: "position", side: "long", orderType: "market", status: "draft",
  entry: { time: 100, price: 100 }, stop: { time: 100, price: 95 }, takeProfit: { time: 100, price: 110 }, ...o,
});
const TICK = 0.01;

// ---------- detectOrderType ----------
{
  const d = M.detectOrderType;
  ok("long at market", d("long", 100, 100, TICK) === "market");
  ok("long within 1 tick", d("long", 100.01, 100, TICK) === "market");
  ok("long below = buy limit", d("long", 99, 100, TICK) === "buy_limit");
  ok("long above = buy stop", d("long", 101, 100, TICK) === "buy_stop");
  ok("short above = sell limit", d("short", 101, 100, TICK) === "sell_limit");
  ok("short below = sell stop", d("short", 99, 100, TICK) === "sell_stop");
  ok("typeChoiceOf auto default", M.typeChoiceOf({ orderType: "buy_limit" }) === "auto");
  ok("typeChoiceOf manual limit", M.typeChoiceOf({ orderType: "sell_limit", orderTypeAuto: false }) === "limit");
  ok("typeChoiceOf manual stop-limit", M.typeChoiceOf({ orderType: "buy_stop_limit", orderTypeAuto: false }) === "stop_limit");
}

// ---------- syncDraft ----------
{
  const c = (m, extra = {}) => ({ market: m, tick: TICK, ...extra });
  let p = pos();
  let s = M.syncDraft(p, c(101.5));
  ok("market draft: entry follows the market", near(s.entry.price, 101.5) && s.orderType === "market");
  ok("market draft: SL/TP keep absolute prices", s.stop.price === 95 && s.takeProfit.price === 110);
  ok("market draft: same object when nothing changes", M.syncDraft(s, c(101.5)) === s);
  ok("non-draft untouched", M.syncDraft(pos({ status: "open" }), c(150)).entry.price === 100);
  ok("no market -> untouched", M.syncDraft(p, c(null)) === p);
  const sl = pos({ orderType: "buy_stop_limit", stopPrice: 103, limitPrice: 101, orderTypeAuto: false });
  ok("stop-limit never auto-changed", M.syncDraft(sl, c(100, { userMovedEntry: true })) === sl);
  // user drags entry below market -> becomes buy limit and STAYS there while the market ticks
  const dragged = pos({ entry: { time: 100, price: 98 } });
  const afterDrag = M.syncDraft(dragged, c(100, { userMovedEntry: true }));
  ok("auto market draft dragged below market -> buy_limit", afterDrag.orderType === "buy_limit" && afterDrag.entry.price === 98);
  ok("pending auto draft keeps its entry on market ticks", M.syncDraft(afterDrag, c(100.4)).entry.price === 98);
  // market falls below the limit price -> the same entry is now a stop (type re-detected)
  ok("auto re-detects when the market crosses the entry", M.syncDraft(afterDrag, c(97)).orderType === "buy_stop");
  // dragged back within one tick -> market again and following
  const back = M.syncDraft({ ...afterDrag, entry: { time: 100, price: 100.005 } }, c(100, { userMovedEntry: true }));
  ok("dragged back to the market -> market", back.orderType === "market" && near(back.entry.price, 100));
  // manual type is respected
  const manual = pos({ orderType: "buy_limit", orderTypeAuto: false, entry: { time: 100, price: 99 } });
  ok("manual limit is not re-detected", M.syncDraft(manual, c(90)) === manual);
  const manualMarket = pos({ orderType: "market", orderTypeAuto: false });
  ok("manual market still follows the market", near(M.syncDraft(manualMarket, c(103)).entry.price, 103));
  // short mirror
  const sh = M.syncDraft(pos({ side: "short", orderType: "market", entry: { time: 100, price: 102 } }), c(100, { userMovedEntry: true }));
  ok("short dragged above market -> sell_limit", sh.orderType === "sell_limit");
}

// ---------- R:R lock ----------
{
  const lock = (o = {}) => pos({ rrLock: { enabled: true, ratio: 2 }, ...o });
  let p = M.applyRRLock(lock({ stop: { time: 100, price: 96 } }), "stop", TICK);
  ok("long: SL 96 -> TP = entry + 2*risk = 108", near(p.takeProfit.price, 108));
  p = M.applyRRLock(lock({ side: "short", stop: { time: 100, price: 104 }, takeProfit: { time: 100, price: 90 } }), "stop", TICK);
  ok("short: SL 104 -> TP = 92", near(p.takeProfit.price, 92));
  p = M.applyRRLock(lock({ takeProfit: { time: 100, price: 115 } }), "takeProfit", TICK);
  ok("TP dragged while locked updates the ratio (3.0), TP unchanged", p.rrLock.ratio === 3 && p.takeProfit.price === 115);
  const off = pos({ rrLock: { enabled: false, ratio: 2 }, stop: { time: 100, price: 96 } });
  ok("disabled lock does nothing", M.applyRRLock(off, "stop", TICK) === off);
  p = M.enableRRLock(pos(), 2, TICK);
  ok("enable lock recomputes TP from current SL (risk 5 -> TP 110)", p.rrLock.enabled && near(p.takeProfit.price, 110));
  p = M.enableRRLock(pos({ stop: { time: 100, price: 98 } }), 3, TICK);
  ok("enable lock with ratio 3, risk 2 -> TP 106", near(p.takeProfit.price, 106));
  ok("snaps TP to the tick", near(M.applyRRLock(lock({ stop: { time: 100, price: 96.003 } }), "stop", 0.01).takeProfit.price, 107.99, 0.0051));
  // drag integration
  const o = { pt: { time: 100, price: 95 }, pos: lock() };
  const d = M.applyPositionDrag(lock(), "stop", { time: 100, price: 96 }, o, { tick: TICK, barSec: 60 });
  ok("drag SL with lock moves TP", near(d.stop.price, 96) && near(d.takeProfit.price, 108));
  const d2 = M.applyPositionDrag(lock(), "takeProfit", { time: 100, price: 112 }, { pt: { time: 100, price: 110 }, pos: lock() }, { tick: TICK, barSec: 60 });
  ok("drag TP with lock updates the ratio", d2.rrLock.ratio === 2.4 && near(d2.takeProfit.price, 112));
  const d3 = M.applyPositionDrag(pos(), "stop", { time: 100, price: 96 }, { pt: { time: 100, price: 95 }, pos: pos() }, { tick: TICK, barSec: 60 });
  ok("no lock: drag SL leaves TP", d3.takeProfit.price === 110);
}

// ---------- applyEdit ----------
{
  const c = { market: 100, tick: TICK };
  let p = M.applyEdit(pos({ rrLock: { enabled: true, ratio: 2 } }), { stop: { time: 100, price: 96 } }, c);
  ok("edit stop with lock -> TP follows", near(p.takeProfit.price, 108));
  p = M.applyEdit(pos({ rrLock: { enabled: true, ratio: 2 } }), { takeProfit: { time: 100, price: 120 } }, c);
  ok("edit TP with lock -> ratio 4", p.rrLock.ratio === 4);
  p = M.applyEdit(pos(), { rrLock: { enabled: true, ratio: 3 } }, c);
  ok("turning the lock on recomputes TP", near(p.takeProfit.price, 115));
  p = M.applyEdit(pos(), { entry: { time: 100, price: 98 } }, c);
  ok("edit entry on auto draft -> type detected", p.orderType === "buy_limit");
  p = M.applyEdit(pos({ status: "pending", orderType: "buy_limit" }), { stop: { time: 100, price: 94 } }, c);
  ok("non-draft edit is a plain merge", p.stop.price === 94 && p.orderType === "buy_limit");
}

// ---------- retypeDraft ----------
{
  const c = { market: 100, tick: TICK };
  const base = pos();
  const a = M.retypeDraft(base, "limit", c);
  ok("limit (long): entry below market, SL/TP shifted with the same distances",
    a.orderType === "buy_limit" && a.orderTypeAuto === false && a.entry.price < 100 &&
    near(a.entry.price - a.stop.price, 5) && near(a.takeProfit.price - a.entry.price, 10));
  const b = M.retypeDraft(pos({ side: "short", stop: { time: 100, price: 105 }, takeProfit: { time: 100, price: 90 } }), "stop", c);
  ok("stop (short): sell_stop below market", b.orderType === "sell_stop" && b.entry.price < 100);
  const sl = M.retypeDraft(base, "stop_limit", c);
  ok("stop-limit: stop above market, limit between, entry = limit", sl.orderType === "buy_stop_limit" && sl.stopPrice > 100 && sl.limitPrice > 100 && sl.limitPrice < sl.stopPrice && sl.entry.price === sl.limitPrice);
  const m = M.retypeDraft(pos({ orderType: "buy_limit", entry: { time: 100, price: 98 }, stop: { time: 100, price: 93 }, takeProfit: { time: 100, price: 108 } }), "market", c);
  ok("market: entry = market, distances kept, stop-limit cleared", m.orderType === "market" && m.entry.price === 100 && m.stop.price === 95 && "stopPrice" in m && m.stopPrice === undefined);
  const au = M.retypeDraft(pos({ orderType: "buy_stop_limit", stopPrice: 103, limitPrice: 101 }), "auto", c);
  ok("auto: clears stop-limit and re-enables detection", au.orderTypeAuto === true && au.orderType === "market" && au.stopPrice === undefined);
  ok("non-draft: no retype", Object.keys(M.retypeDraft(pos({ status: "open" }), "limit", c)).length === 0);
  // retype results validate against the market
  const merged = M.applyEdit(base, a, c);
  ok("retyped limit validates (no errors) vs market", M.validatePosition(merged, 100).length === 0, JSON.stringify(M.validatePosition(merged, 100)));
  const mergedStop = M.applyEdit(pos({ side: "short", stop: { time: 100, price: 105 }, takeProfit: { time: 100, price: 90 } }), b, c);
  ok("retyped short stop validates", M.validatePosition(mergedStop, 100).length === 0, JSON.stringify(M.validatePosition(mergedStop, 100)));
}

// ---------- drag of entry on auto/manual market ----------
{
  const o = (p) => ({ pt: { time: 100, price: 100 }, pos: p });
  const auto = pos();
  const d = M.applyPositionDrag(auto, "entry", { time: 100, price: 98 }, o(auto), { tick: TICK, barSec: 60 });
  ok("auto market draft: entry drag moves the whole order", near(d.entry.price, 98) && near(d.stop.price, 93) && near(d.takeProfit.price, 108));
  const manual = pos({ orderTypeAuto: false });
  {
    const moved = M.applyPositionDrag(manual, "entry", { time: 100, price: 98 }, o(manual), { tick: TICK, barSec: 60 });
    ok("manual market: middle/entry drag moves the whole box", near(moved.entry.price, 98) && near(moved.stop.price, manual.stop.price - 2));
  }
}

// ---------- normalize ----------
{
  ok("bad rrLock dropped", M.normalizePosition(pos({ rrLock: { enabled: true, ratio: -1 } })).rrLock === undefined);
  ok("ratio clamped to 100", M.normalizePosition(pos({ rrLock: { enabled: true, ratio: 500 } })).rrLock.ratio === 100);
  ok("valid rrLock kept", M.normalizePosition(pos({ rrLock: { enabled: true, ratio: 2 } })).rrLock.ratio === 2);
}

// ---------- sizingInfo (what the bar and the box show) ----------
{
  const live = { finalLot: 0.5, pointValue: 10, actualRiskAmount: 25, potentialProfit: 50, actualRiskPercent: 0.25, actualRewardPercent: 0.5, rr: 2, equity: 10000 };
  const d = S.sizingInfo(pos(), live, 100);
  ok("draft shows the LIVE numbers", d.lot === 0.5 && d.riskAmount === 25 && d.rr === 2);
  const pend = pos({ status: "pending", sizing: { lot: 1, atTime: 1, pointValue: 10 }, riskSnapshot: { equity: 10000, pointValue: 10 } });
  const i1 = S.sizingInfo(pend, { ...live, finalLot: 9 }, 100);
  ok("pending shows the CONFIRMED lot (ignores live)", i1.lot === 1 && near(i1.riskAmount, 50) && near(i1.rewardAmount, 100) && near(i1.riskPercent, 0.5));
  const wide = { ...pend, stop: { time: 100, price: 90 } };
  const i2 = S.sizingInfo(wide, live, 100);
  ok("SL moved wider: lot unchanged, risk$ doubles", i2.lot === 1 && near(i2.riskAmount, 100));
  const open = { ...pend, status: "open" };
  const i3 = S.sizingInfo(open, null, 103);
  ok("open: P&L in currency", near(i3.openPnL, 30));
}

console.log(`ticket tests: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
