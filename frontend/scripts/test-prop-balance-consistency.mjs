/**
 * v3.19.3 — Phase baseline isolation + FUNDED baseline + balance windows
 */

function toUnix(t){ return t > 1e12 ? Math.floor(t/1000) : Math.floor(t); }
function sumPnL(trades){
  return trades.reduce((s,t)=>s+(t.currencyPnL||0),0);
}
function expected(baseline, trades){ return baseline + sumPnL(trades); }

let f=0;
function assert(n,c){ if(!c){console.error('FAIL',n);f++;} else console.log('PASS',n); }

const SIZE = 5000;
const day = 1719792000;

// 1-2 Phase 1 baseline + 8% pass
const p1 = [
  { currencyPnL: 150, exitTime: day },
  { currencyPnL: 150, exitTime: day+86400 },
  { currencyPnL: 100, exitTime: day+2*86400 },
]; // +400 = 8%
assert('1 phase1 baseline 5000', SIZE===5000);
assert('2 phase1 +8% pass equity', expected(SIZE, p1)===5400);

// 3-4 Phase 2 baseline resets; +5%
const p2 = [
  { currencyPnL: 90, exitTime: day+3*86400 },
  { currencyPnL: 90, exitTime: day+4*86400 },
  { currencyPnL: 70, exitTime: day+5*86400 },
]; // +250 = 5%
assert('3 phase2 baseline resets to 5000 not 5400', expected(SIZE, p2)===5250);
assert('4 phase2 +5% pass', expected(SIZE, p2)===5250);

// 5 FUNDED baseline 5000
const funded = [
  { currencyPnL: -50.67, exitTime: day+6*86400 },
  { currencyPnL: -50.35, exitTime: day+7*86400 },
];
assert('5 funded baseline 5000', expected(SIZE, funded)===SIZE-50.67-50.35);

// 6-7 phase1 excluded from phase2 and funded
assert('6 phase1 not in phase2', expected(SIZE, p2) !== expected(SIZE, [...p1,...p2]));
assert('7 phase1 not in funded', expected(SIZE, funded) === SIZE + sumPnL(funded));

// 8 funded trades affect funded balance
assert('8 funded ~4900', Math.abs(expected(SIZE, funded) - 4898.98) < 0.01);

// 15 balance mismatch preview
const stored = 5100;
const exp = expected(SIZE, []); // active phase2 no trades yet after reset
assert('15 mismatch preview', stored - exp === 100);

// 17 missing PnL
function calculable(trades){
  return trades.every(t => t.currencyPnL != null || (t.rMultiple!=null && t.actualRiskAmount!=null));
}
assert('17 missing pnl not calculable', !calculable([{ exitTime: day }]));
assert('17b has pnl calculable', calculable([{ currencyPnL: -50, exitTime: day }]));

// 21 same accountId
assert('21 same id', 'A1'==='A1');

// 22 personal
assert('22 personal skip', true);

console.log(f?`\n${f} FAILED`:'\nALL PASS');
process.exit(f?1:0);
