import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = process.env.POSITION_TEST_LIB;
const S = require(`${L}/positionSizing.js`);
const M = require(`${L}/positionModel.js`);
const E = require(`${L}/positionEngine.js`);
const RM = require(`${L}/riskModel.js`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL:", name, extra); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// ---------- freezeSizing ----------
{
  const r = S.freezeSizing({ finalLot: 0.5, pointValue: 1, actualRiskAmount: 50 }, 1000, "percent_equity");
  ok("freeze: positive lot is frozen", r.sizing && r.sizing.lot === 0.5 && r.sizing.atTime === 1000 && !r.blocked);
  ok("freeze: no snapshot = legacy, not blocked", S.freezeSizing(null, 1).blocked === false && S.freezeSizing(null, 1).sizing === null);
  const b = S.freezeSizing({ finalLot: null, volumeBlockReason: "Not enough free margin" }, 1);
  ok("freeze: null lot is BLOCKED with the reason", b.blocked && b.reason === "Not enough free margin");
  ok("freeze: zero lot is blocked", S.freezeSizing({ finalLot: 0 }, 1).blocked);
  ok("freeze: reason from sizingDebug", S.freezeSizing({ finalLot: null, sizingDebug: { volumeBlockReason: "dbg" } }, 1).reason === "dbg");
  ok("override risk forces fixed lot", JSON.stringify(S.lotOverrideRisk({ lot: 0.3, atTime: 1 })) === JSON.stringify({ mode: "fixed_lot", lot: 0.3 }));
}

// ---------- effectiveLot / derive ----------
{
  const pos = { sizing: { lot: 2, atTime: 1, pointValue: 10 }, riskSnapshot: { finalLot: 9, pointValue: 5 } };
  ok("effectiveLot: confirmed lot wins", S.effectiveLot(pos, { finalLot: 7 }) === 2);
  ok("effectiveLot: old position falls back to lot frozen at fill", S.effectiveLot({ riskSnapshot: { finalLot: 9 } }, { finalLot: 7 }) === 9);
  ok("effectiveLot: draft uses live", S.effectiveLot({}, { finalLot: 7 }) === 7);
  ok("pointValue: snapshot first", S.pointValueOf(pos, { pointValue: 1 }) === 5);
  const d1 = S.deriveRisk({ lot: 2, pointValue: 10, entry: 100, stop: 95, tp: 110, equity: 10000 });
  ok("derive: risk/reward/rr", d1 && near(d1.riskAmount, 100) && near(d1.rewardAmount, 200) && near(d1.rr, 2) && near(d1.riskPercent, 1));
  const d2 = S.deriveRisk({ lot: 2, pointValue: 10, entry: 100, stop: 90, tp: 110, equity: 10000 });
  ok("moving SL doubles risk$ but the lot is the same", near(d2.riskAmount, 200) && S.effectiveLot(pos) === 2);
  ok("derive: invalid lot -> null", S.deriveRisk({ lot: 0, pointValue: 10, entry: 1, stop: 0.5, tp: 2 }) === null);
  ok("open pnl currency (long)", near(S.openPnLCurrency("long", 100, 103, 2, 10), 60));
  ok("open pnl currency (short)", near(S.openPnLCurrency("short", 100, 103, 2, 10), -60));
}

// ---------- fill check ----------
{
  ok("fill: same lot ok", S.checkFillLot(0.5, 0.5).ok);
  ok("fill: bigger lot ok", S.checkFillLot(0.5, 0.6).ok);
  const c = S.checkFillLot(0.5, 0.3);
  ok("fill: margin shortfall cancels", !c.ok && /margin/i.test(c.reason));
  ok("fill: null lot cancels", !S.checkFillLot(0.5, null).ok);
}

// ---------- tick/decimals ----------
{
  const t = (x) => S.tickAndDecimals(x);
  ok("tick 0.00001 -> 5 decimals", t(0.00001).decimals === 5 && near(t(0.00001).tick, 0.00001, 1e-12));
  ok("tick 0.01 -> 2", t(0.01).decimals === 2);
  ok("tick 0.001 -> 3", t(0.001).decimals === 3);
  ok("tick 0.25 -> 2", t(0.25).decimals === 2);
  ok("tick 0.5 -> 1", t(0.5).decimals === 1);
  ok("tick 1 -> 0", t(1).decimals === 0);
  ok("bad tick falls back to 0.01 / 2", t(0).tick === 0.01 && t(NaN).decimals === 2 && t(undefined).decimals === 2);
  ok("drag snap uses the real tick", near(M.snapToTick(1.085123456, 0.00001), 1.08512, 1e-9));
}

// ---------- REAL riskModel: freeze at confirm, resize never at fill ----------
{
  const account = RM.defaultAccount({ balance: 10000, leverage: 1000 });
  const instrument = RM.defaultInstrument("XAUUSD");
  const calc = (o) => RM.calculateRisk({ account, instrument, riskPercent: 1, side: "long", usedMargin: 0, ...o });
  // Confirm: 1% of 10000 = $100 risk, entry 2000, SL 1990 -> sl distance 10
  const atConfirm = calc({ entryPrice: 2000, stopPrice: 1990, takeProfitPrice: 2020, riskMode: "percent_equity" });
  const fz = S.freezeSizing({ ...atConfirm, pointValue: atConfirm.pointValue }, 1000, "percent_equity");
  ok("real riskModel: lot computed at confirm", fz.sizing && fz.sizing.lot > 0, JSON.stringify(atConfirm.finalLot));
  // Trader moves SL before the pending order fills (SL now 1980): percent mode WOULD resize, frozen lot must not
  const naive = calc({ entryPrice: 2000, stopPrice: 1980, takeProfitPrice: 2020, riskMode: "percent_equity" });
  ok("(control) percent mode WOULD change the lot when SL moves", naive.finalLot !== atConfirm.finalLot);
  const risk = S.lotOverrideRisk(fz.sizing);
  const atFill = calc({ entryPrice: 2000, stopPrice: 1980, takeProfitPrice: 2020, riskMode: risk.mode, fixedLot: risk.lot });
  ok("real riskModel: lot at fill == lot at confirm even after SL moved", near(atFill.finalLot, fz.sizing.lot, 1e-9), `${atFill.finalLot} vs ${fz.sizing.lot}`);
  ok("real riskModel: risk$ at fill scales with the new SL", atFill.actualRiskAmount > atConfirm.actualRiskAmount * 1.9, `${atFill.actualRiskAmount} vs ${atConfirm.actualRiskAmount}`);
  const derived = S.deriveRisk({ lot: fz.sizing.lot, pointValue: atFill.pointValue, entry: 2000, stop: 1980, tp: 2020, equity: atFill.equity });
  ok("derived risk$ == riskModel actualRiskAmount", near(derived.riskAmount, atFill.actualRiskAmount, 0.01), `${derived.riskAmount} vs ${atFill.actualRiskAmount}`);
  // Margin shortfall: tiny account cannot hold the confirmed lot
  const tiny = RM.defaultAccount({ balance: 50, leverage: 1 });
  const small = RM.calculateRisk({ account: tiny, instrument, riskPercent: 1, side: "long", usedMargin: 0, entryPrice: 2000, stopPrice: 1980, takeProfitPrice: 2020, riskMode: "fixed_lot", fixedLot: fz.sizing.lot });
  ok("real riskModel: margin shortfall -> checkFillLot cancels", !S.checkFillLot(fz.sizing.lot, small.finalLot).ok, `finalLot=${small.finalLot}`);
  ok("riskModel fix: no free margin for min lot => finalLot null + reason (was: margin silently ignored)", small.finalLot === null && small.insufficientVolume === true && /free margin/i.test(small.volumeBlockReason || ""), JSON.stringify([small.finalLot, small.insufficientVolume, small.volumeBlockReason]));
  const tinyPct = RM.calculateRisk({ account: tiny, instrument, riskPercent: 1, side: "long", usedMargin: 0, entryPrice: 2000, stopPrice: 1980, takeProfitPrice: 2020, riskMode: "percent_equity" });
  ok("riskModel fix applies to percent mode too", tinyPct.finalLot === null && tinyPct.insufficientVolume === true);
  const drained = RM.calculateRisk({ account, instrument, riskPercent: 1, side: "long", usedMargin: 1e9, entryPrice: 2000, stopPrice: 1980, takeProfitPrice: 2020, riskMode: "percent_equity" });
  ok("riskModel fix: zero free margin blocks", drained.finalLot === null && drained.insufficientVolume === true);
  const normal = calc({ entryPrice: 2000, stopPrice: 1980, takeProfitPrice: 2020, riskMode: "percent_equity" });
  ok("riskModel fix: normal sizing unchanged (5 lots, $100 risk)", normal.finalLot === 5 && near(normal.actualRiskAmount, 100), JSON.stringify([normal.finalLot, normal.actualRiskAmount]));
  const fz2 = S.freezeSizing(small, 1);
  ok("freeze blocks Confirm on that shortfall with the model's reason", fz2.blocked && /free margin/i.test(fz2.reason || ""));
}

// ---------- engine: cancel reason from canFill ----------
{
  const pend = { id: "p", kind: "position", side: "long", orderType: "buy_limit", status: "pending", entry: { time: 1, price: 98 }, stop: { time: 1, price: 95 }, takeProfit: { time: 1, price: 110 } };
  const bar = { time: 5, open: 100, high: 101, low: 97, close: 99 };
  const r = E.runPositionBars([pend], [bar], { canFill: () => ({ ok: false, reason: "Cancelled · insufficient margin for the confirmed lot" }) });
  ok("engine: canFill reason becomes the cancel event text", r.shapes.length === 0 && r.events[0].text === "Cancelled · insufficient margin for the confirmed lot");
  const r2 = E.runPositionBars([pend], [bar], { canFill: () => false });
  ok("engine: boolean false still cancels (old contract)", r2.shapes.length === 0 && /trading not allowed/.test(r2.events[0].text));
  const r3 = E.runPositionBars([pend], [bar], { canFill: () => true });
  ok("engine: true fills", r3.shapes[0].status === "open");
}

console.log(`sizing tests: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
