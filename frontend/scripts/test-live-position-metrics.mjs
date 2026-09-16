/** v3.18.0 live position metrics — mirrors riskModel logic */
function roundDownToStep(lot, step, minLot) {
  if (!(lot > 0) || !(step > 0)) return 0;
  const steps = Math.floor(lot / step + 1e-12);
  const v = Number((steps * step).toFixed(8));
  return v < minLot - 1e-12 ? 0 : v;
}

function calc(opts) {
  const { equity, riskPct, entry, stop, tp, pointValue = 1, minLot = 0.01, maxLot = 100, step = 0.01, freeMargin = null, leverage = 20, contractSize = 1 } = opts;
  const riskAmount = equity * (riskPct / 100);
  const slDistance = Math.abs(entry - stop);
  const tpDistance = tp != null ? Math.abs(tp - entry) : null;
  const rawRiskLot = riskAmount / (slDistance * pointValue);
  const riskBasedLot = roundDownToStep(rawRiskLot, step, minLot);
  const fm = freeMargin != null ? freeMargin : equity;
  const perLot = (entry * contractSize) / leverage;
  const marginMax = perLot > 0 ? roundDownToStep(fm / perLot, step, minLot) : 0;
  let finalLot = Math.min(riskBasedLot, marginMax, maxLot);
  finalLot = roundDownToStep(finalLot, step, minLot);
  if (finalLot < minLot) finalLot = 0;
  const actualRiskAmount = finalLot > 0 ? slDistance * pointValue * finalLot : null;
  const actualRiskPercent = actualRiskAmount != null && equity > 0 ? (actualRiskAmount / equity) * 100 : null;
  const potentialProfit = finalLot > 0 && tpDistance != null ? tpDistance * pointValue * finalLot : null;
  const actualRewardPercent = potentialProfit != null && equity > 0 ? (potentialProfit / equity) * 100 : null;
  const rr = slDistance > 0 && tpDistance != null ? tpDistance / slDistance : null;
  const marginConstrained = finalLot > 0 && riskBasedLot > 0 && finalLot + 1e-12 < riskBasedLot;
  return { riskAmount, riskBasedLot, marginMax, finalLot, actualRiskAmount, actualRiskPercent, potentialProfit, actualRewardPercent, rr, marginConstrained, targetRiskPercent: riskPct, riskDifferencePp: actualRiskPercent != null ? actualRiskPercent - riskPct : null };
}

let f = 0;
function assert(n, c) { if (!c) { console.error("FAIL", n); f++; } else console.log("PASS", n); }

// A exact 2% when unconstrained
const a = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300, maxLot: 100 });
assert("A target 2%", Math.abs(a.targetRiskPercent - 2) < 1e-9);
assert("A actual ~2%", a.actualRiskPercent != null && Math.abs(a.actualRiskPercent - 2) < 0.15);
assert("A no margin constraint", !a.marginConstrained);

// B margin constraint
const b = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300, freeMargin: 50, leverage: 20, maxLot: 100 });
assert("B actual < target", b.actualRiskPercent != null && b.actualRiskPercent < 2 - 0.01);
assert("B marginConstrained", b.marginConstrained);

// C entry change
const c1 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300 });
const c2 = calc({ equity: 5000, riskPct: 2, entry: 42150, stop: 42000, tp: 42300 });
assert("C entry changes risk", Math.abs(c1.actualRiskAmount - c2.actualRiskAmount) > 1e-6);

// D SL change
const d1 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300 });
const d2 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 41980, tp: 42300 });
assert("D SL changes lot/risk", d1.finalLot !== d2.finalLot || Math.abs((d1.actualRiskAmount||0)-(d2.actualRiskAmount||0))>1e-6);

// E TP change
const e1 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300 });
const e2 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42400 });
assert("E TP changes reward", (e1.potentialProfit||0) !== (e2.potentialProfit||0));

// F TP uses actual risk not target
const fx = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300, freeMargin: 80, leverage: 20 });
if (fx.actualRiskPercent != null && fx.rr != null && fx.actualRewardPercent != null) {
  const expectedImpact = fx.actualRiskPercent * fx.rr;
  assert("F TP% ≈ actualRisk% * R", Math.abs(fx.actualRewardPercent - expectedImpact) < 0.05);
} else assert("F constrained has values", false);

// G leverage margin not PnL
const g1 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300, leverage: 20, freeMargin: 5000 });
const g2 = calc({ equity: 5000, riskPct: 2, entry: 42100, stop: 42000, tp: 42300, leverage: 100, freeMargin: 5000 });
assert("G PnL same if same lot unconstrained", Math.abs((g1.potentialProfit||0) - (g2.potentialProfit||0)) < 1 || g1.finalLot !== g2.finalLot);

// H lot step
assert("H step", roundDownToStep(0.379, 0.01, 0.01) === 0.37);

// I no fake 10k
assert("I equity 5k", a.riskAmount === 100);

// J no lot=1 fallback when zero
const j = calc({ equity: 1, riskPct: 0.01, entry: 42100, stop: 42000, tp: 42300, maxLot: 0.01 });
assert("J no forced lot 1", j.finalLot !== 1);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
