/**
 * Phase D1 — US30 / USA30IDXUSD symbol compatibility (pure logic + policy).
 * Run: node frontend/scripts/test-us30-alias-d1.mjs
 *
 * Mirrors symbolAliases.ts + conflict policy from barCache.cacheGetDayRowWithAlias
 * without IndexedDB (Node-safe).
 */
import assert from "assert";

// ─── Mirror of frontend/src/lib/symbolAliases.ts ─────────────────────────────
const CANONICAL_BY_ALIAS = {
  US30: "US30",
  USA30IDXUSD: "US30",
  US30IDXUSD: "US30",
  "US30.CASH": "US30",
  DJI: "US30",
  DOW: "US30",
  EURUSD: "EURUSD",
  XAUUSD: "XAUUSD",
  GOLD: "XAUUSD",
  BTCUSD: "BTCUSD",
  BTCUSDT: "BTCUSD",
};

function canonicalSymbol(symbol) {
  const u = String(symbol || "").trim().toUpperCase();
  if (!u) return u;
  return CANONICAL_BY_ALIAS[u] || u;
}

function symbolLookupCandidates(symbol) {
  const c = canonicalSymbol(symbol);
  const out = [c];
  for (const [alias, canon] of Object.entries(CANONICAL_BY_ALIAS)) {
    if (canon === c && alias !== c) out.push(alias);
  }
  const raw = String(symbol || "").trim().toUpperCase();
  if (raw && !out.includes(raw)) out.push(raw);
  return out;
}

/**
 * Mirror of cacheGetDayRowWithAlias conflict policy (no IDB).
 * store: Map<"SYMBOL|DAY", { symbol, day, bars, complete?, classification? }>
 */
function resolveDayRowWithAlias(store, symbol, day) {
  const canon = canonicalSymbol(symbol);
  const candidates = symbolLookupCandidates(symbol);
  const found = [];
  for (const cand of candidates) {
    const row = store.get(`${cand}|${day}`);
    if (!row) continue;
    const hasBars = Array.isArray(row.bars) && row.bars.length > 0;
    const emptyOk = row.complete && row.classification === "EXPECTED_EMPTY";
    if (hasBars || emptyOk) found.push({ row, symbolUsed: cand });
  }
  if (!found.length) return null;
  const exactCanon = found.find((f) => f.symbolUsed === canon || f.row.symbol === canon);
  if (exactCanon && (exactCanon.row.bars?.length || exactCanon.row.classification === "EXPECTED_EMPTY")) {
    return exactCanon;
  }
  const withBars = found.filter((f) => f.row.bars && f.row.bars.length > 0);
  if (withBars.length) {
    withBars.sort((a, b) => {
      const ac = a.row.complete ? 1 : 0;
      const bc = b.row.complete ? 1 : 0;
      if (bc !== ac) return bc - ac;
      return (b.row.bars?.length || 0) - (a.row.bars?.length || 0);
    });
    return withBars[0];
  }
  return found[0];
}

function listMarketDaysCollapsed(store, symbolFilter) {
  const filterCands = symbolFilter
    ? new Set(symbolLookupCandidates(symbolFilter).map((s) => s.toUpperCase()))
    : null;
  const byKey = new Map();
  for (const [id, r] of store) {
    const stored = String(r.symbol || "").toUpperCase();
    if (filterCands && !filterCands.has(stored)) continue;
    const canon = canonicalSymbol(stored);
    const barCount = Array.isArray(r.bars) ? r.bars.length : 0;
    const prefer =
      (stored === canon ? 100 : 0) +
      (r.complete ? 10 : 0) +
      Math.min(9, Math.floor(Math.log10(Math.max(1, barCount))));
    const info = {
      id,
      symbol: canon,
      day: r.day,
      barCount,
      source: stored !== canon ? `provider:${stored}` : r.source,
      _prefer: prefer,
    };
    const k = `${canon}|${r.day}`;
    const prev = byKey.get(k);
    if (!prev || info._prefer > prev._prefer) byKey.set(k, info);
  }
  return Array.from(byKey.values()).map(({ _prefer, ...rest }) => rest);
}

function cacheGetRangeMirror(store, symbol, days) {
  const fromCacheDays = [];
  const missingDays = [];
  const bars = [];
  for (const day of days) {
    const hit = resolveDayRowWithAlias(store, symbol, day);
    const row = hit?.row ?? null;
    if (row?.complete && row.classification === "EXPECTED_EMPTY") {
      fromCacheDays.push(day);
      continue;
    }
    if (row?.bars?.length) {
      fromCacheDays.push(day);
      bars.push(...row.bars);
    } else {
      missingDays.push(day);
    }
  }
  return { bars, fromCacheDays, missingDays };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}: ${e.message}`);
  }
}

console.log("Phase D1 — US30 symbol compatibility\n");

check("canonicalSymbol maps USA30IDXUSD → US30", () => {
  assert.strictEqual(canonicalSymbol("USA30IDXUSD"), "US30");
  assert.strictEqual(canonicalSymbol("us30"), "US30");
  assert.strictEqual(canonicalSymbol("US30.CASH"), "US30");
  assert.strictEqual(canonicalSymbol("DJI"), "US30");
  assert.strictEqual(canonicalSymbol("EURUSD"), "EURUSD");
});

check("symbolLookupCandidates: US30 first, then provider aliases", () => {
  const c = symbolLookupCandidates("US30");
  assert.strictEqual(c[0], "US30");
  assert.ok(c.includes("USA30IDXUSD"));
  assert.ok(c.includes("US30IDXUSD"));
  // no duplicates
  assert.strictEqual(new Set(c).size, c.length);
});

check("symbolLookupCandidates from provider symbol still leads with canonical", () => {
  const c = symbolLookupCandidates("USA30IDXUSD");
  assert.strictEqual(c[0], "US30");
  assert.ok(c.includes("USA30IDXUSD"));
});

check("Import under USA30IDXUSD → Replay lookup under US30 finds data", () => {
  const store = new Map();
  // Simulate historical provider-keyed import (pre-D1) still on disk
  store.set("USA30IDXUSD|2024-06-03", {
    symbol: "USA30IDXUSD",
    day: "2024-06-03",
    bars: [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5 }],
    complete: true,
  });
  const hit = resolveDayRowWithAlias(store, "US30", "2024-06-03");
  assert.ok(hit);
  assert.strictEqual(hit.symbolUsed, "USA30IDXUSD");
  assert.strictEqual(hit.row.bars.length, 1);
});

check("Existing historical US30 data remains readable", () => {
  const store = new Map();
  store.set("US30|2024-01-15", {
    symbol: "US30",
    day: "2024-01-15",
    bars: [{ time: 10, open: 1, high: 1, low: 1, close: 1 }],
    complete: true,
  });
  const hit = resolveDayRowWithAlias(store, "US30", "2024-01-15");
  assert.ok(hit);
  assert.strictEqual(hit.symbolUsed, "US30");
  // Also via provider query
  const hit2 = resolveDayRowWithAlias(store, "USA30IDXUSD", "2024-01-15");
  assert.ok(hit2);
  assert.strictEqual(hit2.symbolUsed, "US30");
});

check("Both aliases same day: prefer canonical US30", () => {
  const store = new Map();
  store.set("US30|2024-06-03", {
    symbol: "US30",
    day: "2024-06-03",
    bars: [{ time: 1 }, { time: 2 }],
    complete: true,
  });
  store.set("USA30IDXUSD|2024-06-03", {
    symbol: "USA30IDXUSD",
    day: "2024-06-03",
    bars: [{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }],
    complete: true,
  });
  const hit = resolveDayRowWithAlias(store, "US30", "2024-06-03");
  assert.ok(hit);
  assert.strictEqual(hit.symbolUsed, "US30", "canonical wins even if provider has more bars");
  assert.strictEqual(hit.row.bars.length, 2);
});

check("Conflict: only provider key present → use provider (no merge)", () => {
  const store = new Map();
  store.set("USA30IDXUSD|2024-06-04", {
    symbol: "USA30IDXUSD",
    day: "2024-06-04",
    bars: [{ time: 5 }],
    complete: true,
  });
  const hit = resolveDayRowWithAlias(store, "US30", "2024-06-04");
  assert.ok(hit);
  assert.strictEqual(hit.symbolUsed, "USA30IDXUSD");
  assert.strictEqual(hit.row.bars.length, 1);
});

check("Conflict: incomplete canonical vs complete provider → prefer complete provider when no exact canon bars preferred... wait, exactCanon empty bars?", () => {
  // If canonical exists but empty incomplete, policy: exactCanon only if has bars or EXPECTED_EMPTY
  const store = new Map();
  store.set("US30|2024-06-05", {
    symbol: "US30",
    day: "2024-06-05",
    bars: [],
    complete: false,
  });
  store.set("USA30IDXUSD|2024-06-05", {
    symbol: "USA30IDXUSD",
    day: "2024-06-05",
    bars: [{ time: 1 }, { time: 2 }],
    complete: true,
  });
  // found only includes provider (canonical has no bars and not EXPECTED_EMPTY)
  const hit = resolveDayRowWithAlias(store, "US30", "2024-06-05");
  assert.ok(hit);
  assert.strictEqual(hit.symbolUsed, "USA30IDXUSD");
});

check("Data Engine listing collapses alias duplicates to one row", () => {
  const store = new Map();
  store.set("US30|2024-06-03", {
    symbol: "US30",
    day: "2024-06-03",
    bars: [{ time: 1 }],
    complete: true,
  });
  store.set("USA30IDXUSD|2024-06-03", {
    symbol: "USA30IDXUSD",
    day: "2024-06-03",
    bars: [{ time: 1 }, { time: 2 }],
    complete: true,
  });
  store.set("USA30IDXUSD|2024-06-04", {
    symbol: "USA30IDXUSD",
    day: "2024-06-04",
    bars: [{ time: 3 }],
    complete: true,
  });
  const listed = listMarketDaysCollapsed(store, "US30");
  assert.strictEqual(listed.length, 2, "two distinct days");
  const d3 = listed.find((r) => r.day === "2024-06-03");
  assert.ok(d3);
  assert.strictEqual(d3.symbol, "US30");
  // canonical preferred so barCount from US30 row
  assert.strictEqual(d3.barCount, 1);
  const d4 = listed.find((r) => r.day === "2024-06-04");
  assert.ok(d4);
  assert.strictEqual(d4.symbol, "US30");
  assert.ok(String(d4.source).includes("USA30IDXUSD"));
});

check("Offline range: complete local hit under provider key → no missing days", () => {
  const store = new Map();
  store.set("USA30IDXUSD|2024-06-03", {
    symbol: "USA30IDXUSD",
    day: "2024-06-03",
    bars: [{ time: 1 }, { time: 2 }],
    complete: true,
  });
  store.set("USA30IDXUSD|2024-06-04", {
    symbol: "USA30IDXUSD",
    day: "2024-06-04",
    bars: [{ time: 3 }],
    complete: true,
  });
  const res = cacheGetRangeMirror(store, "US30", ["2024-06-03", "2024-06-04"]);
  assert.strictEqual(res.missingDays.length, 0);
  assert.strictEqual(res.fromCacheDays.length, 2);
  assert.strictEqual(res.bars.length, 3);
});

check("Offline range: missing days reported clearly", () => {
  const store = new Map();
  store.set("US30|2024-06-03", {
    symbol: "US30",
    day: "2024-06-03",
    bars: [{ time: 1 }],
    complete: true,
  });
  const res = cacheGetRangeMirror(store, "US30", ["2024-06-03", "2024-06-04", "2024-06-05"]);
  assert.deepStrictEqual(res.missingDays, ["2024-06-04", "2024-06-05"]);
  assert.deepStrictEqual(res.fromCacheDays, ["2024-06-03"]);
});

check("Never merges two competing datasets", () => {
  const store = new Map();
  store.set("US30|2024-06-03", {
    symbol: "US30",
    day: "2024-06-03",
    bars: [{ time: 1 }, { time: 2 }],
    complete: true,
  });
  store.set("USA30IDXUSD|2024-06-03", {
    symbol: "USA30IDXUSD",
    day: "2024-06-03",
    bars: [{ time: 100 }, { time: 200 }, { time: 300 }],
    complete: true,
  });
  const hit = resolveDayRowWithAlias(store, "US30", "2024-06-03");
  assert.strictEqual(hit.row.bars.length, 2);
  assert.ok(!hit.row.bars.some((b) => b.time === 100));
});

check("loadGen-style stale guard: later generation wins (logic)", () => {
  // Pure sequencing model used by ReplayView loadRange
  let loadGen = 0;
  const results = [];
  async function fakeLoad(gen, delayMs, payload) {
    await new Promise((r) => setTimeout(r, delayMs));
    if (gen !== loadGen) return; // stale
    results.push(payload);
  }
  const g1 = ++loadGen;
  const p1 = fakeLoad(g1, 30, "old");
  const g2 = ++loadGen;
  const p2 = fakeLoad(g2, 5, "new");
  return Promise.all([p1, p2]).then(() => {
    assert.deepStrictEqual(results, ["new"]);
  });
});

// Run async stale test
await (async () => {
  try {
    let loadGen = 0;
    const results = [];
    async function fakeLoad(gen, delayMs, payload) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (gen !== loadGen) return;
      results.push(payload);
    }
    const g1 = ++loadGen;
    const p1 = fakeLoad(g1, 40, "old");
    const g2 = ++loadGen;
    const p2 = fakeLoad(g2, 5, "new");
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(results, ["new"]);
    passed++;
    console.log("  PASS  stale load generation cannot overwrite newer request");
  } catch (e) {
    failed++;
    console.error(`  FAIL  stale load generation: ${e.message}`);
  }
})();

console.log(`\nD1 results: ${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
