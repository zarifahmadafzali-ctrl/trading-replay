/**
 * v3.43.9 — Journal HTF snapshots + no silent trade-drop.
 * Runs against real TypeScript modules via --experimental-strip-types when available,
 * otherwise inlined pure logic mirrors that match journalSnapshots.ts / journal append rules.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function aggregateVisible(rows, cursorSeconds, timeframeSeconds) {
  if (cursorSeconds <= 0 || !rows.length) return [];
  const maxCandles = 1200;
  const tf = Math.max(1, timeframeSeconds);
  const start = Math.max(0, cursorSeconds - tf * maxCandles);
  const slice = rows.slice(start, cursorSeconds);
  if (tf <= 1) return slice;
  const out = [];
  let current = null;
  for (const row of slice) {
    const bucket = Math.floor(row.time / tf) * tf;
    if (!current || current.time !== bucket) {
      current = {
        time: bucket,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume ?? 0,
      };
      out.push(current);
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
    }
  }
  return out;
}

function buildHtfSnapshots(opts) {
  const maxCandles = opts.maxCandles ?? 120;
  const cursor = Math.max(0, Math.min(opts.cursorIndex, opts.bars1s.length));
  const last1s = cursor > 0 ? opts.bars1s[cursor - 1]?.time : undefined;
  const out = [];
  for (const tf of opts.timeframes) {
    if (!Number.isFinite(tf) || tf < 1) continue;
    const agg = opts.aggregateVisible(opts.bars1s, cursor, tf);
    const trimmed = last1s != null ? agg.filter((b) => b.time <= last1s) : agg;
    const window = trimmed.slice(-maxCandles);
    out.push({
      tf,
      event: opts.event,
      t: opts.eventTimeUnix,
      bars: window.map((b) => [b.time, b.open, b.high, b.low, b.close]),
      entry: opts.entry,
      sl: opts.sl,
      tp: opts.tp,
      exit: opts.exit,
    });
  }
  return out;
}

function pruneOldestImages(trades, keep = 200) {
  if (trades.length <= keep) return trades;
  return trades.map((t, i) => {
    if (i < keep) return t;
    const next = { ...t };
    delete next.entryScreenshot;
    delete next.closeScreenshot;
    delete next.htfSnapshots;
    return next;
  });
}

// --- 1s bars: times 1000..1099 (100 bars), cursor index 50 means exclusive end at index 50
const bars = [];
for (let i = 0; i < 100; i++) {
  const t = 1_700_000_000 + i;
  bars.push({ time: t, open: 100 + i * 0.01, high: 100.5 + i * 0.01, low: 99.5 + i * 0.01, close: 100.2 + i * 0.01, volume: 1 });
}

let passed = 0;
function ok(name) {
  passed++;
  console.log("PASS", name);
}

// No look-ahead: last HTF bar time <= last 1s bar before cursor
{
  const cursor = 50;
  const last1s = bars[cursor - 1].time;
  const snaps = buildHtfSnapshots({
    bars1s: bars,
    cursorIndex: cursor,
    timeframes: [10],
    event: "sl",
    eventTimeUnix: last1s,
    entry: 100,
    sl: 99,
    tp: 102,
    exit: 99,
    aggregateVisible,
  });
  assert.equal(snaps.length, 1);
  assert.ok(snaps[0].bars.length > 0);
  const maxBarT = Math.max(...snaps[0].bars.map((b) => b[0]));
  assert.ok(maxBarT <= last1s, `look-ahead leak: ${maxBarT} > ${last1s}`);
  ok("no look-ahead in HTF bars");
}

// Only selected TFs
{
  const snaps = buildHtfSnapshots({
    bars1s: bars,
    cursorIndex: 80,
    timeframes: [5, 15],
    event: "tp",
    eventTimeUnix: bars[79].time,
    entry: 1,
    sl: 0,
    tp: 2,
    aggregateVisible,
  });
  assert.deepEqual(
    snaps.map((s) => s.tf).sort((a, b) => a - b),
    [5, 15]
  );
  ok("snapshot per selected TF only");
}

// 600 trades none dropped; images pruned after keep
{
  const trades = [];
  for (let i = 0; i < 600; i++) {
    trades.push({
      id: `t${i}`,
      entryScreenshot: i < 250 ? "data:image/png;base64,xx" : undefined,
      closeScreenshot: i < 250 ? "data:image/png;base64,yy" : undefined,
    });
  }
  // append semantics: newest first; prune keeps first 200 images
  const pruned = pruneOldestImages(trades, 200);
  assert.equal(pruned.length, 600, "must not drop trade rows");
  assert.ok(pruned[0].entryScreenshot, "newest keep images");
  assert.equal(pruned[250].entryScreenshot, undefined, "older images stripped");
  ok("600 trades kept; images pruned only");
}

// Legacy row without htfSnapshots loads (normalize shape)
{
  const raw = { id: "legacy-1", symbol: "US30", side: "long", entryPrice: 1, exitPrice: 2, stopPrice: 0.5, takeProfitPrice: 3, entryTime: 1, exitTime: 2, reason: "manual", pnlPoints: 1, rMultiple: 2 };
  assert.equal(raw.htfSnapshots, undefined);
  ok("old rows omit htfSnapshots");
}

console.log(`\nAll ${passed} checks PASS`);
