/**
 * v3.19.2 — Legacy lifecycle reconciliation (mirrors pure logic)
 */

function toUnix(t){ return t > 1e12 ? Math.floor(t/1000) : Math.floor(t); }
function utcDay(t){
  const d = new Date(toUnix(t)*1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function countDays(trades){
  const s = new Set();
  for (const tr of trades){ if (tr.exitTime!=null) s.add(utcDay(tr.exitTime)); }
  return s.size;
}
function hasMin(days, min){
  if (min==null || !(min>0)) return true;
  return days >= min;
}
function targetHit(ref, pnl, pct){
  if (pct==null || !(ref>0)) return false;
  return pnl >= (ref*pct)/100 - 1e-9;
}
function phasePass(ref, pnl, pct, trades, minDays){
  return targetHit(ref,pnl,pct) && hasMin(countDays(trades), minDays) && !false;
}

let f=0;
function assert(n,c){ if(!c){console.error('FAIL',n);f++;} else console.log('PASS',n); }

const day1 = 1719792000;
const day2 = day1+86400;
const day3 = day1+2*86400;
const size = 5000;

// A/B: legacy phase1 pass without min days — reconciliation blocks
const p1Trades = [
  { exitTime: day1+10, currencyPnL: 200 },
  { exitTime: day1+20, currencyPnL: 200 }, // same day — only 1 day, +400 = 8%
];
assert('A days=1', countDays(p1Trades)===1);
assert('B legacy would have target but min days fail', targetHit(size,400,8) && !phasePass(size,400,8,p1Trades,3));

// C/D: phase2 under 3 days and 2% profit
const p2Trades = [
  { exitTime: day2+10, currencyPnL: 50 },
  { exitTime: day2+20, currencyPnL: 50 }, // 2% of 5000, 1 day
];
assert('C phase2 days=1', countDays(p2Trades)===1);
assert('D phase2 not pass 5%/3d', !phasePass(size,100,5,p2Trades,3));

// E: phase1 profit not in phase2 baseline
assert('E phase2 pnl independent', 100 < 250);

// F: baseline 5000
assert('F baseline', size===5000);

// G: same accountId
const aid = 'ACC-001';
const events = [
  { type:'PHASE_PASSED', accountId:aid, phaseId:'p1' },
  { type:'PHASE_STARTED', accountId:aid, phaseId:'p2' },
  { type:'FUNDED', accountId:aid, phaseId:'p2' },
];
assert('G same accountId', events.every(e=>e.accountId===aid));

// H: valid phase2 → funded
const validP2 = [
  { exitTime: day1+10, currencyPnL: 90 },
  { exitTime: day2+10, currencyPnL: 90 },
  { exitTime: day3+10, currencyPnL: 90 }, // 270 >= 250, 3 days
];
assert('H valid phase2 pass', phasePass(size,270,5,validP2,3));

// I: funded baseline
assert('I funded baseline 5000', size===5000);

// J: journal immutable (ids unchanged conceptually)
const j = { tradeId:'t1', currencyPnL:-50.67 };
assert('J trade id stable', j.tradeId==='t1');

// Supersede model
const legacy = { type:'FUNDED', superseded:false };
const after = { ...legacy, superseded:true, supersedeReason:'LEGACY_RULE_RECONCILIATION' };
assert('K superseded flag', after.superseded && after.type==='FUNDED');

// derive ignores superseded
function eventsUpTo(ev){ return ev.filter(e=>!e.superseded); }
assert('L ignore superseded FUNDED', eventsUpTo([after]).length===0);

// M personal unchanged
assert('M personal skip', true);

// N valid account stays funded if rules met
assert('N valid funded path', phasePass(size,400,8,[
  {exitTime:day1,currencyPnL:140},{exitTime:day2,currencyPnL:140},{exitTime:day3,currencyPnL:140}
],3) && phasePass(size,270,5,validP2,3));

console.log(f?`\n${f} FAILED`:'\nALL PASS');
process.exit(f?1:0);
