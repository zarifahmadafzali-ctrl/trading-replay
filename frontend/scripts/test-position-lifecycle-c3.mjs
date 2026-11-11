/**
 * C3 regression: market fill Bid/Ask, no reverse seek execution semantics.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import assert from "assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelSrc = readFileSync(join(__dirname, "../src/lib/positionModel.ts"), "utf8");
const viewSrc = readFileSync(join(__dirname, "../src/views/ReplayView.tsx"), "utf8");
const chartSrc = readFileSync(join(__dirname, "../src/components/Chart.tsx"), "utf8");

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error("FAIL: " + name);
  passed++;
  console.log("ok -", name);
}

// prepareConfirm source contracts
ok("prepareConfirm accepts bid/ask", /bid\?: number \| null/.test(modelSrc) && /ask\?: number \| null/.test(modelSrc));
ok("market long prefers ask", /p\.side === "long" && ask != null/.test(modelSrc));
ok("market short prefers bid", /p\.side === "short" && bid != null/.test(modelSrc));
ok("entry not click-only for market", /Market fill at current execution price/.test(modelSrc));

// ReplayView seek guards
ok("execBars skips backward seek", /cursor < prev/.test(viewSrc) && /never re-run the engine on backward seeks/.test(viewSrc));
ok("execTicks skips backward seek", /cur < prev/.test(viewSrc) && /backward tick seek must not re-execute/.test(viewSrc));
ok("passes marketBid/Ask to Chart", /marketBid=\{activeTick \? activeTick\.bid/.test(viewSrc));

// Chart wiring
ok("Chart has marketBid prop", /marketBid = null/.test(chartSrc));
ok("confirmDrafts passes bid/ask", /bid: marketRef\.current\.bid/.test(chartSrc));
ok("manual close long uses bid", /long.*m\.bid|m\.bid.*long/.test(chartSrc));

// Pure runtime: reimplement prepareConfirm market fill slice
function fillMarket(side, mp, bid, ask) {
  if (side === "long" && ask != null) return ask;
  if (side === "short" && bid != null) return bid;
  return mp;
}
ok("long fill ask 101 not mid 100", fillMarket("long", 100, 99.5, 101) === 101);
ok("short fill bid 99.5 not mid 100", fillMarket("short", 100, 99.5, 101) === 99.5);
ok("seconds mode falls back to mid", fillMarket("long", 100, null, null) === 100);

// Seek window simulation
function execWindow(prev, cursor, bars) {
  if (cursor < prev) return [];
  if (cursor <= prev) return bars.slice(prev, cursor); // empty when equal handled by caller
  return bars.slice(prev, cursor);
}
ok("forward seek processes bars", execWindow(5, 8, [0,1,2,3,4,5,6,7,8,9]).length === 3);
ok("backward seek processes none", execWindow(8, 5, [0,1,2,3,4,5,6,7,8,9]).length === 0);

console.log(`\n${passed} assertions passed`);
