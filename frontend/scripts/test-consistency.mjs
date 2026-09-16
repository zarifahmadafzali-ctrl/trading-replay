function calcConsistency(trades, required) {
  let largest = 0, totalWin = 0;
  for (const tr of trades) {
    const pnl = tr.currencyPnL || 0;
    if (pnl > 0) { totalWin += pnl; if (pnl > largest) largest = pnl; }
  }
  if (required == null) return { status: "NOT_CONFIGURED", passed: true, actual: totalWin > 0 ? (largest/totalWin)*100 : null };
  if (!(totalWin > 0)) return { status: "NOT_YET_QUALIFIED", passed: false, actual: null };
  const actual = (largest / totalWin) * 100;
  const pass = actual <= required + 1e-9;
  return { status: pass ? "PASS" : "FAIL", passed: pass, actual, largest, totalWin };
}
let f = 0;
function assert(n,c){ if(!c){console.error("FAIL",n);f++;} else console.log("PASS",n); }
assert("1 not qualified", calcConsistency([], 40).status === "NOT_YET_QUALIFIED");
assert("2 pass", calcConsistency([{currencyPnL:100},{currencyPnL:100},{currencyPnL:100}], 40).status === "PASS");
assert("3 fail", calcConsistency([{currencyPnL:500},{currencyPnL:100}], 40).status === "FAIL");
assert("4 actual 50%", Math.abs(calcConsistency([{currencyPnL:100},{currencyPnL:100}], 40).actual - 50) < 1e-9);
assert("5 not configured", calcConsistency([{currencyPnL:100}], null).status === "NOT_CONFIGURED");
assert("6 pass 33%", calcConsistency([{currencyPnL:100},{currencyPnL:100},{currencyPnL:100}], 40).passed);
console.log(f?`\n${f} FAILED`:"\nALL PASS");
process.exit(f?1:0);
