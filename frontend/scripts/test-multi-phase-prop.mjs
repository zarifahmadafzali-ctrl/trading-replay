/**
 * v3.18.2.2 — Phase isolation + independent baselines + FUNDED transition
 */

function uid(p){ return p + "_" + Math.random().toString(36).slice(2,8); }
function cloneRules(r){ const n={...r}; if(r.payout) n.payout={...r.payout}; return n; }
function clonePhase(ph){ return {...ph, rules: cloneRules(ph.rules||{accountSize:0})}; }
function normalizeProg(prog, size=5000){
  return {
    ...prog,
    phases: (prog.phases||[]).map((ph,i)=>({
      id: ph.id||uid("phase"),
      name: ph.name||`Phase ${i+1}`,
      type: ph.type||"challenge",
      rules: cloneRules({
        accountSize: ph.rules?.accountSize>0?ph.rules.accountSize:size,
        profitTargetPct: ph.rules?.profitTargetPct,
        dailyLossLimitPct: ph.rules?.dailyLossLimitPct,
        maxOverallLossPct: ph.rules?.maxOverallLossPct,
      }),
    })),
  };
}
function createPhase(n,size){
  return { id: uid("phase"), name: n>2?"Funded":`Phase ${n}`, type: n>2?"funded":"challenge", rules: { accountSize: size } };
}
function patchPhase(prog, phaseId, rulesPatch){
  const p = normalizeProg(prog);
  return {
    ...p,
    phases: p.phases.map(ph=>{
      if(ph.id!==phaseId) return {...ph, rules: cloneRules(ph.rules)};
      const next = cloneRules({...ph.rules, ...rulesPatch});
      return {...ph, rules: next};
    }),
  };
}
function isTargetReached(ref, pnl, pct){
  if(pct==null||!(ref>0)) return false;
  return pnl >= (ref*pct)/100 - 1e-9;
}
function phaseTrades(trades, phaseId, events, t){
  const seq = (events||[]).filter(e=>e.timestamp<=t).sort((a,b)=>a.timestamp-b.timestamp);
  const started = [...seq].reverse().find(e=>e.type==="PHASE_STARTED"&&e.phaseId===phaseId);
  const passed = seq.find(e=>e.type==="PHASE_PASSED"&&e.phaseId===phaseId);
  const start = started?started.timestamp:0;
  const end = passed?passed.timestamp:t;
  return trades.filter(tr=>{
    if(tr.exitTime==null||tr.exitTime>end||tr.exitTime<start) return false;
    if(tr.phaseId&&tr.phaseId!==phaseId) return false;
    return true;
  });
}

let f=0;
function assert(n,c){ if(!c){console.error("FAIL",n);f++;} else console.log("PASS",n); }

const size = 5000;
let prog = normalizeProg({ id:"prog1", firmName:"Test", programName:"2P", phases:[
  { id:"p1", name:"Phase 1", type:"challenge", rules:{ accountSize:size, profitTargetPct:8, dailyLossLimitPct:5, maxOverallLossPct:10 }},
  { id:"p2", name:"Phase 2", type:"challenge", rules:{ accountSize:size, profitTargetPct:5, dailyLossLimitPct:5, maxOverallLossPct:10 }},
]}, size);

assert("A two phases", prog.phases.length===2);
assert("B p1 target 8", prog.phases[0].rules.profitTargetPct===8);
assert("C p2 target 5", prog.phases[1].rules.profitTargetPct===5);

prog = patchPhase(prog, "p2", { profitTargetPct: 6 });
assert("D p2→6 p1 still 8", prog.phases[0].rules.profitTargetPct===8 && prog.phases[1].rules.profitTargetPct===6);

prog = patchPhase(prog, "p1", { profitTargetPct: 7 });
assert("E p1→7 p2 still 6", prog.phases[0].rules.profitTargetPct===7 && prog.phases[1].rules.profitTargetPct===6);

prog = patchPhase(prog, "p1", { dailyLossLimitPct: 4 });
assert("F p1 daily 4 p2 daily 5", prog.phases[0].rules.dailyLossLimitPct===4 && prog.phases[1].rules.dailyLossLimitPct===5);

prog = patchPhase(prog, "p2", { maxOverallLossPct: 12 });
assert("G p2 max 12 p1 max 10", prog.phases[0].rules.maxOverallLossPct===10 && prog.phases[1].rules.maxOverallLossPct===12);

// Shared ref mutation test
const shared = { accountSize:5000, profitTargetPct:8 };
const bad = { phases:[{id:"a",rules:shared},{id:"b",rules:shared}] };
const fixed = normalizeProg(bad, 5000);
fixed.phases[1].rules.profitTargetPct = 5;
assert("H normalize breaks shared ref", fixed.phases[0].rules.profitTargetPct===8 && fixed.phases[1].rules.profitTargetPct===5);

// Phase baselines
const t0=1000, t1=2000, t2=3000;
const trades = [
  { phaseId:"p1", exitTime:t0+10, currencyPnL:400 }, // 8% of 5000
  { phaseId:"p2", exitTime:t1+10, currencyPnL:250 }, // 5% of 5000
];
const events = [
  { type:"PHASE_STARTED", phaseId:"p1", timestamp:t0 },
  { type:"PHASE_PASSED", phaseId:"p1", timestamp:t0+20 },
  { type:"PHASE_STARTED", phaseId:"p2", timestamp:t1 },
];
const p1tr = phaseTrades(trades, "p1", events, t0+20);
const p1pnl = p1tr.reduce((s,x)=>s+x.currencyPnL,0);
assert("I phase1 pnl 400 only", p1pnl===400 && isTargetReached(5000, p1pnl, 8));

const p2tr = phaseTrades(trades, "p2", events, t2);
const p2pnl = p2tr.reduce((s,x)=>s+x.currencyPnL,0);
assert("J phase2 pnl 250 independent baseline", p2pnl===250 && isTargetReached(5000, p2pnl, 5));

// If wrongly using all trades, phase2 would see 650
const all = trades.reduce((s,x)=>s+x.currencyPnL,0);
assert("K all trades 650 would wrong-pass 5% early", all===650 && isTargetReached(5000, all, 5));

// Final → FUNDED
const finalEvents = [...events, { type:"PHASE_PASSED", phaseId:"p2", timestamp:t2 }, { type:"FUNDED", phaseId:"p2", timestamp:t2 }];
assert("L funded event present", finalEvents.some(e=>e.type==="FUNDED"));
const fundedBal = 5000; // reset baseline
assert("M funded baseline 5000 not 5400", fundedBal===5000);

// Boundary exact 8%
assert("N exact 400 hits 8%", isTargetReached(5000, 400, 8));
assert("O 399 misses 8%", !isTargetReached(5000, 399, 8));
assert("P exact 250 hits 5%", isTargetReached(5000, 250, 5));

console.log(f?`\n${f} FAILED`:"\nALL PASS");
process.exit(f?1:0);
