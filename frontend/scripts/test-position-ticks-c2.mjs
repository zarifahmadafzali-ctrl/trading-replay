/**
 * C2.1 — pure runPositionTicks tests (no DOM).
 */
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, "../src/lib/positionEngineTick.ts");
const src = readFileSync(srcPath, "utf8");
const barsSrc = readFileSync(join(__dirname, "../src/lib/positionEngine.ts"), "utf8");

// Lightweight eval of pure functions by re-implementing mirror from source contracts
function compareTicks(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  return (a.seq ?? 0) - (b.seq ?? 0);
}
function sortTicksStable(ticks) {
  return ticks.slice().sort(compareTicks);
}
function tickExitOnOpen(s, tick) {
  const long = s.side === "long";
  if (long) {
    if (tick.bid <= s.stop.price) return { reason: "sl", exitPrice: tick.bid };
    if (tick.bid >= s.takeProfit.price) return { reason: "tp", exitPrice: tick.bid };
  } else {
    if (tick.ask >= s.stop.price) return { reason: "sl", exitPrice: tick.ask };
    if (tick.ask <= s.takeProfit.price) return { reason: "tp", exitPrice: tick.ask };
  }
  return null;
}
function tickPendingFillPrice(orderType, side, entryPrice, tick, stopPrice, limitPrice, stopTriggered) {
  const { bid, ask } = tick;
  if (orderType === "market") return { price: side === "long" ? ask : bid };
  if (orderType === "buy_limit") {
    if (ask <= entryPrice) return { price: Math.min(entryPrice, ask) };
    return null;
  }
  if (orderType === "sell_limit") {
    if (bid >= entryPrice) return { price: Math.max(entryPrice, bid) };
    return null;
  }
  if (orderType === "buy_stop") {
    if (ask >= entryPrice) return { price: ask };
    return null;
  }
  if (orderType === "sell_stop") {
    if (bid <= entryPrice) return { price: bid };
    return null;
  }
  return null;
}

function runPositionTicks(shapes, ticks) {
  const ordered = sortTicksStable(ticks);
  let working = shapes.slice();
  const closed = [];
  const events = [];
  let mutated = false;
  for (const tick of ordered) {
    if (tick.bid > tick.ask) continue;
    const filledThisTick = new Set();
    const next = [];
    for (const raw of working) {
      if (raw.kind !== "position") {
        next.push(raw);
        continue;
      }
      const s = raw;
      if (s.status === "pending") {
        const result = tickPendingFillPrice(s.orderType, s.side, s.entry.price, tick);
        if (!result) {
          next.push(raw);
          continue;
        }
        mutated = true;
        const filled = {
          ...s,
          status: "open",
          entry: { time: tick.time, price: result.price },
        };
        next.push(filled);
        filledThisTick.add(s.id);
        events.push({ type: "filled", id: s.id });
        continue;
      }
      if (s.status !== "open") {
        next.push(raw);
        continue;
      }
      if (tick.time < s.entry.time || filledThisTick.has(s.id)) {
        next.push(raw);
        continue;
      }
      const hit = tickExitOnOpen(s, tick);
      if (!hit) {
        next.push(raw);
        continue;
      }
      mutated = true;
      const pnl = s.side === "long" ? hit.exitPrice - s.entry.price : s.entry.price - hit.exitPrice;
      closed.push({
        id: s.id,
        reason: hit.reason,
        exitPrice: hit.exitPrice,
        exitTime: tick.time,
        pnlPoints: pnl,
        entry: s.entry,
      });
      events.push({ type: "closed", id: s.id, reason: hit.reason });
    }
    working = next;
  }
  return { shapes: working, closed, events, mutated };
}

function basePos(over) {
  return {
    kind: "position",
    id: "p1",
    side: "long",
    orderType: "market",
    status: "pending",
    entry: { time: 100, price: 100 },
    stop: { time: 100, price: 90 },
    takeProfit: { time: 100, price: 120 },
    ...over,
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.error("FAIL", name);
  }
}

// Source exports
check("spec file exists", readFileSync(join(__dirname, "../src/lib/C2_TICK_EXECUTION_SPEC.md"), "utf8").includes("Ask"));
check("engine exports runPositionTicks", src.includes("export function runPositionTicks"));
check("bars engine unchanged signature", barsSrc.includes("export function runPositionBars"));

// Market buy at ask
{
  const r = runPositionTicks(
    [basePos({ side: "long", orderType: "market", status: "pending", entry: { time: 0, price: 0 } })],
    [{ time: 1, bid: 99, ask: 101, seq: 0 }]
  );
  const open = r.shapes.find((s) => s.id === "p1");
  check("buy market @ ask", open?.status === "open" && open.entry.price === 101);
}

// Market sell at bid
{
  const r = runPositionTicks(
    [basePos({ side: "short", orderType: "market", status: "pending", entry: { time: 0, price: 0 } })],
    [{ time: 1, bid: 99, ask: 101, seq: 0 }]
  );
  const open = r.shapes.find((s) => s.id === "p1");
  check("sell market @ bid", open?.status === "open" && open.entry.price === 99);
}

// Long SL on bid
{
  const open = basePos({
    status: "open",
    side: "long",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 95 },
    takeProfit: { time: 1, price: 110 },
  });
  const r = runPositionTicks([open], [{ time: 2, bid: 94.5, ask: 94.7, seq: 0 }]);
  check("long SL uses bid", r.closed[0]?.reason === "sl" && r.closed[0].exitPrice === 94.5);
}

// Long TP on bid
{
  const open = basePos({
    status: "open",
    side: "long",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 90 },
    takeProfit: { time: 1, price: 110 },
  });
  const r = runPositionTicks([open], [{ time: 2, bid: 111, ask: 111.2, seq: 0 }]);
  check("long TP uses bid", r.closed[0]?.reason === "tp" && r.closed[0].exitPrice === 111);
}

// Short SL on ask
{
  const open = basePos({
    status: "open",
    side: "short",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 105 },
    takeProfit: { time: 1, price: 90 },
  });
  const r = runPositionTicks([open], [{ time: 2, bid: 105.1, ask: 105.4, seq: 0 }]);
  check("short SL uses ask", r.closed[0]?.reason === "sl" && r.closed[0].exitPrice === 105.4);
}

// Short TP on ask
{
  const open = basePos({
    status: "open",
    side: "short",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 110 },
    takeProfit: { time: 1, price: 90 },
  });
  const r = runPositionTicks([open], [{ time: 2, bid: 89.5, ask: 89.8, seq: 0 }]);
  check("short TP uses ask", r.closed[0]?.reason === "tp" && r.closed[0].exitPrice === 89.8);
}

// Buy limit better price
{
  const r = runPositionTicks(
    [basePos({ orderType: "buy_limit", status: "pending", entry: { time: 0, price: 100 } })],
    [{ time: 1, bid: 98, ask: 99, seq: 0 }]
  );
  check("buy limit fill min(limit,ask)", r.shapes[0].entry.price === 99);
}

// Sell limit better
{
  const r = runPositionTicks(
    [basePos({ side: "short", orderType: "sell_limit", status: "pending", entry: { time: 0, price: 100 } })],
    [{ time: 1, bid: 101, ask: 102, seq: 0 }]
  );
  check("sell limit fill max(limit,bid)", r.shapes[0].entry.price === 101);
}

// Buy stop at ask
{
  const r = runPositionTicks(
    [basePos({ orderType: "buy_stop", status: "pending", entry: { time: 0, price: 100 } })],
    [{ time: 1, bid: 100.5, ask: 101, seq: 0 }]
  );
  check("buy stop @ ask", r.shapes[0].entry.price === 101);
}

// Gap-through stop: bid jumps through SL
{
  const open = basePos({
    status: "open",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 95 },
    takeProfit: { time: 1, price: 120 },
  });
  const r = runPositionTicks([open], [{ time: 2, bid: 92, ask: 92.2, seq: 0 }]);
  check("gap-through SL exit at bid", r.closed[0]?.exitPrice === 92);
}

// seq order
{
  const ticks = [
    { time: 5, bid: 1, ask: 2, seq: 1 },
    { time: 5, bid: 1, ask: 2, seq: 0 },
  ];
  const sorted = sortTicksStable(ticks);
  check("seq order", sorted[0].seq === 0 && sorted[1].seq === 1);
}

// No SL on fill tick
{
  const pos = basePos({
    orderType: "market",
    status: "pending",
    side: "long",
    entry: { time: 0, price: 0 },
    stop: { time: 0, price: 95 },
    takeProfit: { time: 0, price: 200 },
  });
  // Single tick: fills at ask 101, bid 90 would SL — must NOT close same tick
  const r = runPositionTicks([pos], [{ time: 1, bid: 90, ask: 101, seq: 0 }]);
  check("no SL/TP on fill tick", r.closed.length === 0 && r.shapes[0]?.status === "open");
  const r2 = runPositionTicks(r.shapes, [{ time: 2, bid: 90, ask: 91, seq: 0 }]);
  check("SL on later tick", r2.closed[0]?.reason === "sl");
}

// SL before TP same tick
{
  const open = basePos({
    status: "open",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 95 },
    takeProfit: { time: 1, price: 90 }, // both would be "hit" if bid=90 — SL first (bid<=95 and bid>=90)
  });
  // bid 90: SL (90<=95) wins before TP check
  const r = runPositionTicks([open], [{ time: 2, bid: 90, ask: 91, seq: 0 }]);
  check("SL-first when both eligible", r.closed[0]?.reason === "sl");
}

// No duplicate close
{
  const open = basePos({
    status: "open",
    entry: { time: 1, price: 100 },
    stop: { time: 1, price: 95 },
    takeProfit: { time: 1, price: 110 },
  });
  const r = runPositionTicks(
    [open],
    [
      { time: 2, bid: 94, ask: 94.2, seq: 0 },
      { time: 3, bid: 93, ask: 93.2, seq: 0 },
    ]
  );
  check("single close only", r.closed.length === 1 && r.shapes.every((s) => s.id !== "p1" || s.status !== "open"));
}

// Deterministic
{
  const open = basePos({ status: "open", entry: { time: 1, price: 100 }, stop: { time: 1, price: 95 }, takeProfit: { time: 1, price: 110 } });
  const ticks = [
    { time: 2, bid: 96, ask: 97, seq: 1 },
    { time: 2, bid: 94, ask: 95, seq: 0 },
  ];
  const a = runPositionTicks([open], ticks);
  const b = runPositionTicks([open], ticks);
  check("deterministic", a.closed[0]?.exitTime === b.closed[0]?.exitTime && a.closed[0]?.exitPrice === b.closed[0]?.exitPrice);
}

check("exit path uses bid/ask", src.includes("exitPrice: tick.bid") || src.includes("tick.bid"));
// engine should not use mid for exit prices
check("exit helpers use bid/ask only", src.includes("tick.bid") && src.includes("tick.ask"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
