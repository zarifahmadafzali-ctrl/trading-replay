function roundDownToStep(lot, step, minLot) {
  if (!Number.isFinite(lot) || lot <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  const steps = Math.floor(lot / step + 1e-12);
  const rounded = steps * step;
  const precision = Math.max(0, (step.toString().split(".")[1] || "").length);
  const v = Number(rounded.toFixed(precision));
  return v < minLot - 1e-12 ? 0 : v;
}

function calc({ balance, leverage, riskPct, sl, entry, minLot, maxLot, lotStep, instMax, pointValue = 1, cs = 1, usedMargin = 0, openPnL = 0 }) {
  const equity = balance + openPnL;
  const freeMargin = Math.max(0, equity - usedMargin);
  const riskAmount = equity * (riskPct / 100);
  const riskBased = roundDownToStep(riskAmount / (sl * pointValue), lotStep, minLot);
  const perLot = (entry * cs) / Math.max(1, leverage);
  const marginMax = roundDownToStep(freeMargin / perLot, lotStep, minLot);
  const raw = Math.min(riskBased, marginMax, maxLot, instMax);
  const finalLot = roundDownToStep(raw, lotStep, minLot);
  const actualRisk = finalLot > 0 ? sl * pointValue * finalLot : 0;
  return { riskAmount, riskBased, marginMax, finalLot, actualRisk };
}

let failed = 0;
function assert(name, cond) {
  if (!cond) { console.error("FAIL", name); failed++; }
  else console.log("PASS", name);
}

const base = { entry: 5000, sl: 50, pointValue: 1, cs: 1, instMax: 100, lotStep: 0.01, minLot: 0.01 };
const A = calc({ balance: 5000, leverage: 20, riskPct: 3, maxLot: 100, ...base });
const B = calc({ balance: 12000, leverage: 50, riskPct: 3, maxLot: 100, ...base });
const C = calc({ balance: 25000, leverage: 100, riskPct: 3, maxLot: 100, ...base });
const D = calc({ balance: 25000, leverage: 100, riskPct: 3, maxLot: 100, ...base });

assert("A risk ~150", Math.abs(A.riskAmount - 150) < 0.01);
assert("B risk ~360", Math.abs(B.riskAmount - 360) < 0.01);
assert("C risk ~750", Math.abs(C.riskAmount - 750) < 0.01);
assert("D risk ~750", Math.abs(D.riskAmount - 750) < 0.01);
assert("A finalLot 3", Math.abs(A.finalLot - 3) < 0.001);
assert("B finalLot 7.2", Math.abs(B.finalLot - 7.2) < 0.001);
assert("C finalLot 15", Math.abs(C.finalLot - 15) < 0.001);

const total = 2 * A.actualRisk + 2 * B.actualRisk - C.actualRisk - D.actualRisk;
assert("Total PnL ~-480", Math.abs(total - -480) < 1);

const B2 = calc({ balance: 12000, leverage: 50, riskPct: 3, maxLot: 0.37, ...base });
assert("B capped at 0.37 only", Math.abs(B2.finalLot - 0.37) < 0.001);
assert("A not 0.37", Math.abs(A.finalLot - 0.37) > 0.01);

const lowLev = calc({ balance: 5000, leverage: 1, riskPct: 3, maxLot: 100, ...base });
const highLev = calc({ balance: 5000, leverage: 100, riskPct: 3, maxLot: 100, ...base });
assert("higher lev more margin lot", highLev.marginMax >= lowLev.marginMax);

const afterWin = calc({ balance: 5300, leverage: 20, riskPct: 3, maxLot: 100, ...base });
assert("win increases risk $", afterWin.riskAmount > A.riskAmount);
const afterLoss = calc({ balance: 4850, leverage: 20, riskPct: 3, maxLot: 100, ...base });
assert("loss decreases risk $", afterLoss.riskAmount < A.riskAmount);
const withUsed = calc({ balance: 5000, leverage: 20, riskPct: 3, maxLot: 100, usedMargin: 4000, ...base });
assert("used margin lowers capacity", withUsed.marginMax < A.marginMax);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
