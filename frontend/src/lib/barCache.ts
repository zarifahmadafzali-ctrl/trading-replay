/** Day-sharded IndexedDB cache for 1-second bars.
 *
 * Keys are per UTC day: SYMBOL|YYYY-MM-DD
 * Requesting any sub-range only hits the network for missing days.
 */
import type { Bar } from "./types";
import { normalizeBars } from "./marketDataIntegrity";
import type { DatasetDayMeta } from "./datasetMeta";
import { metaFromDayRow, defaultBars1sMeta } from "./datasetMeta";
import { canonicalSymbol, symbolLookupCandidates } from "./symbolAliases";

const DB_NAME = "trading-replay-cache";
const DB_VERSION = 4;
const STORE = "days";

export type DayCacheRow = {
  id: string;
  symbol: string;
  day: string;
  bars: Bar[];
  savedAt: number;
  /** SUCCESS | EXPECTED_EMPTY */
  classification?: string;
  complete?: boolean;
  barCount?: number;
  /** Phase A dataset metadata (optional on legacy rows). */
  dataKind?: DatasetDayMeta["dataKind"];
  hasTicks?: boolean;
  hasBars1s?: boolean;
  tickCount?: number;
  bars1sCount?: number;
  priceBasis?: DatasetDayMeta["priceBasis"];
  executionBasis?: DatasetDayMeta["executionBasis"];
  source?: string;
};

function dayId(symbol: string, day: string): string {
  return `${symbol.toUpperCase()}|${day}`;
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return out;
  const cur = new Date(s);
  while (cur <= e) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (db.objectStoreNames.contains("bars")) {
        db.deleteObjectStore("bars");
      }
      // Phase B: separate tick store (raw ticks, not mixed into bars)
      if (!db.objectStoreNames.contains("ticks")) {
        db.createObjectStore("ticks", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGetDay(symbol: string, day: string): Promise<Bar[] | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(dayId(symbol, day));
      req.onsuccess = () => {
        const row = req.result as DayCacheRow | undefined;
        if (!row) {
          resolve(null);
          return;
        }
        if (row.complete && row.classification === "EXPECTED_EMPTY") {
          resolve([]);
          return;
        }
        resolve(row.bars?.length ? row.bars : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function cacheGetDayRow(symbol: string, day: string): Promise<DayCacheRow | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(dayId(symbol, day));
      req.onsuccess = () => resolve((req.result as DayCacheRow) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * D1 — Resolve a day row across symbol aliases (US30 ↔ USA30IDXUSD).
 * Conflict policy when multiple keys have bars for the same day:
 *   1. Prefer the row whose symbol equals canonicalSymbol(query).
 *   2. Else prefer a COMPLETE row with the most bars.
 *   3. Else first non-empty candidate in symbolLookupCandidates order.
 * Never merges bars from two keys; never writes/migrates storage.
 */
export async function cacheGetDayRowWithAlias(
  symbol: string,
  day: string
): Promise<{ row: DayCacheRow; symbolUsed: string } | null> {
  const canon = canonicalSymbol(symbol);
  const candidates = symbolLookupCandidates(symbol);
  const found: Array<{ row: DayCacheRow; symbolUsed: string }> = [];
  for (const cand of candidates) {
    const row = await cacheGetDayRow(cand, day);
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

export async function cacheGetDayWithAlias(symbol: string, day: string): Promise<Bar[] | null> {
  const hit = await cacheGetDayRowWithAlias(symbol, day);
  if (!hit) return null;
  const row = hit.row;
  if (row.complete && row.classification === "EXPECTED_EMPTY") return [];
  return row.bars?.length ? row.bars : null;
}

/** Idempotent put for one UTC day. Empty bars allowed for EXPECTED_EMPTY. */
export async function cachePutDay(
  symbol: string,
  day: string,
  bars: Bar[],
  opts?: {
    classification?: string;
    complete?: boolean;
    meta?: DatasetDayMeta;
  }
): Promise<void> {
  const classification = opts?.classification || (bars.length ? "SUCCESS" : "EXPECTED_EMPTY");
  const complete = opts?.complete ?? true;
  // Validate OHLC + dedupe by timestamp (last wins) — v3.30.0
  const unique = normalizeBars(bars).bars;
  const meta =
    opts?.meta ??
    defaultBars1sMeta({ bars1sCount: unique.length });
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        id: dayId(symbol, day),
        symbol: symbol.toUpperCase(),
        day,
        bars: unique,
        savedAt: Date.now(),
        classification,
        complete,
        barCount: unique.length,
        dataKind: meta.dataKind,
        hasTicks: meta.hasTicks,
        hasBars1s: meta.hasBars1s,
        tickCount: meta.tickCount,
        bars1sCount: meta.bars1sCount ?? unique.length,
        priceBasis: meta.priceBasis,
        executionBasis: meta.executionBasis,
        source: meta.source,
      } satisfies DayCacheRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* quota */
  }
}

/** Split a bar array into UTC calendar days and save each shard. */
export async function cachePutBars(symbol: string, bars: Bar[]): Promise<number> {
  if (!bars.length) return 0;
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const day = new Date(b.time * 1000).toISOString().slice(0, 10);
    let arr = byDay.get(day);
    if (!arr) {
      arr = [];
      byDay.set(day, arr);
    }
    arr.push(b);
  }
  for (const [day, dayBars] of byDay) {
    await cachePutDay(symbol, day, dayBars, { classification: "SUCCESS", complete: true });
  }
  return byDay.size;
}

export type RangeLoadDiagnostics = {
  daysHit: number;
  daysMiss: number;
  daysEmpty: number;
  barCount: number;
  loadMs: number;
  sorted: boolean;
};

export type RangeLoadResult = {
  bars: Bar[];
  fromCacheDays: string[];
  missingDays: string[];
  diagnostics: RangeLoadDiagnostics;
};

export async function cacheGetRange(
  symbol: string,
  start: string,
  end: string
): Promise<RangeLoadResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const days = eachDay(start, end);
  const fromCacheDays: string[] = [];
  const missingDays: string[] = [];
  const bars: Bar[] = [];
  let daysEmpty = 0;
  let needsSort = false;
  let lastTime = -Infinity;

  for (const day of days) {
    // D1: resolve US30 / USA30IDXUSD (and other aliases) without migrating storage.
    const hit = await cacheGetDayRowWithAlias(symbol, day);
    const row = hit?.row ?? null;
    if (row?.complete && row.classification === "EXPECTED_EMPTY") {
      fromCacheDays.push(day);
      daysEmpty += 1;
      continue;
    }
    if (row?.bars?.length) {
      fromCacheDays.push(day);
      for (const b of row.bars) {
        if (b.time < lastTime) needsSort = true;
        lastTime = b.time;
        bars.push(b);
      }
    } else {
      missingDays.push(day);
    }
  }

  if (needsSort) {
    bars.sort((a, b) => a.time - b.time);
  }

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    bars,
    fromCacheDays,
    missingDays,
    diagnostics: {
      daysHit: fromCacheDays.length - daysEmpty,
      daysMiss: missingDays.length,
      daysEmpty,
      barCount: bars.length,
      loadMs: Math.round(t1 - t0),
      sorted: needsSort,
    },
  };
}

export type LocalCacheSummary = {
  daysRequested: number;
  daysCached: number;
  barsCached: number;
  cachedDays: string[];
  missingDays: string[];
};

export async function summarizeLocalCache(
  symbol: string,
  start: string,
  end: string
): Promise<LocalCacheSummary> {
  const days = eachDay(start, end);
  const cachedDays: string[] = [];
  const missingDays: string[] = [];
  let barsCached = 0;
  for (const day of days) {
    const hit = await cacheGetDayRowWithAlias(symbol, day);
    const row = hit?.row ?? null;
    if (row?.complete) {
      cachedDays.push(day);
      barsCached += row.barCount ?? row.bars?.length ?? 0;
    } else if (row?.bars?.length) {
      cachedDays.push(day);
      barsCached += row.bars.length;
    } else {
      missingDays.push(day);
    }
  }
  return {
    daysRequested: days.length,
    daysCached: cachedDays.length,
    barsCached,
    cachedDays,
    missingDays,
  };
}

export async function cacheListDays(): Promise<
  { id: string; symbol: string; day: string; savedAt: number; count: number }[]
> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result || []) as DayCacheRow[];
        resolve(
          rows.map((r) => ({
            id: r.id,
            symbol: r.symbol,
            day: r.day,
            savedAt: r.savedAt ?? 0,
            count: r.barCount ?? (Array.isArray(r.bars) ? r.bars.length : 0),
          }))
        );
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}


/** Canonical day-level market-data status (v3.22.0). */
export type MarketDayStatus =
  | "MISSING"
  | "PARTIAL"
  | "COMPLETE"
  | "EMPTY"
  | "FAILED"
  | "LOADING";

/**
 * Classify a local day row. LOADING is supplied by the caller when an
 * acquisition is in progress for that symbol|day.
 */
export function classifyDayStatus(
  row: DayCacheRow | null | undefined,
  opts?: { loading?: boolean; failed?: boolean }
): MarketDayStatus {
  if (opts?.loading) return "LOADING";
  if (opts?.failed) return "FAILED";
  if (!row) return "MISSING";
  if (row.complete && row.classification === "EXPECTED_EMPTY") return "EMPTY";
  if (row.complete && (row.classification === "SUCCESS" || (row.barCount ?? row.bars?.length ?? 0) > 0)) {
    return "COMPLETE";
  }
  if (row.complete && row.classification === "FAILED") return "FAILED";
  if ((row.bars?.length ?? 0) > 0 || (row.barCount ?? 0) > 0) return "PARTIAL";
  return "MISSING";
}

/** ~bytes estimate: barCount * ~40 bytes (OHLCV + time). Marked as estimate only. */
export function estimateDayBytes(barCount: number): number {
  return Math.max(0, Math.floor(barCount) * 40);
}

export type MarketDayInfo = {
  id: string;
  symbol: string;
  day: string;
  status: MarketDayStatus;
  barCount: number;
  savedAt: number;
  classification?: string;
  complete?: boolean;
  /** Approximate size in bytes; not exact IndexedDB usage. */
  estimatedBytes: number;
  /** Phase A — dataset kind (defaults applied for legacy rows). */
  dataKind?: DatasetDayMeta["dataKind"];
  hasTicks?: boolean;
  hasBars1s?: boolean;
  tickCount?: number;
  bars1sCount?: number;
  priceBasis?: DatasetDayMeta["priceBasis"];
  executionBasis?: DatasetDayMeta["executionBasis"];
  source?: string;
};

export async function listMarketDays(symbolFilter?: string): Promise<MarketDayInfo[]> {
  try {
    const db = await openDb();
    const rows: DayCacheRow[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []) as DayCacheRow[]);
      req.onerror = () => reject(req.error);
    });
    const filterCands = symbolFilter
      ? new Set(symbolLookupCandidates(symbolFilter).map((s) => s.toUpperCase()))
      : null;

    // D1: collapse alias duplicates (US30 vs USA30IDXUSD same day) into one listing row.
    type Agg = MarketDayInfo & { _canon: string; _prefer: number };
    const byKey = new Map<string, Agg>();
    for (const r of rows) {
      const stored = String(r.symbol || "").toUpperCase();
      if (filterCands && !filterCands.has(stored)) continue;
      const canon = canonicalSymbol(stored);
      const barCount = r.barCount ?? (Array.isArray(r.bars) ? r.bars.length : 0);
      const meta = metaFromDayRow(r);
      const prefer =
        (stored === canon ? 100 : 0) +
        (r.complete ? 10 : 0) +
        Math.min(9, Math.floor(Math.log10(Math.max(1, barCount))));
      const info: Agg = {
        id: r.id,
        symbol: canon,
        day: r.day,
        status: classifyDayStatus(r),
        barCount,
        savedAt: r.savedAt ?? 0,
        classification: r.classification,
        complete: r.complete,
        estimatedBytes: estimateDayBytes(barCount),
        dataKind: meta.dataKind,
        hasTicks: meta.hasTicks,
        hasBars1s: meta.hasBars1s,
        tickCount: meta.tickCount,
        bars1sCount: meta.bars1sCount ?? barCount,
        priceBasis: meta.priceBasis,
        executionBasis: meta.executionBasis,
        source: meta.source
          ? meta.source
          : stored !== canon
            ? `provider:${stored}`
            : meta.source,
        _canon: canon,
        _prefer: prefer,
      };
      if (stored !== canon && info.source && !String(info.source).includes(stored)) {
        info.source = `provider:${stored}`;
      }
      const k = `${canon}|${r.day}`;
      const prev = byKey.get(k);
      if (!prev || info._prefer > prev._prefer) byKey.set(k, info);
    }
    return Array.from(byKey.values())
      .map(({ _canon, _prefer, ...rest }) => rest)
      .sort((a, b) =>
        a.symbol === b.symbol ? (a.day < b.day ? 1 : -1) : a.symbol.localeCompare(b.symbol)
      );
  } catch {
    return [];
  }
}

/**
 * Delete one symbol|day across all known aliases for that market.
 * UI lists canonical symbols; storage may still hold provider keys (USA30IDXUSD).
 * Does not touch Sessions/Journal/Accounts. Never migrates other days.
 */
export async function cacheDeleteDay(symbol: string, day: string): Promise<boolean> {
  try {
    const candidates = symbolLookupCandidates(symbol);
    // Always include the raw key in case it is not in the alias map.
    const raw = String(symbol || "").trim().toUpperCase();
    const keys = new Set(candidates.map((c) => dayId(c, day)));
    if (raw) keys.add(dayId(raw, day));
    const db = await openDb();
    let any = false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const id of keys) {
        store.delete(id);
        any = true;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return any;
  } catch {
    return false;
  }
}

/**
 * Delete all cached days for one market (canonical + provider aliases).
 * Uses alias-aware listing so USA30IDXUSD rows are included when deleting US30.
 */
export async function cacheDeleteSymbol(symbol: string): Promise<number> {
  const rows = await listMarketDays(symbol);
  let n = 0;
  for (const r of rows) {
    // Prefer the underlying id's day; delete all aliases for that day.
    if (await cacheDeleteDay(r.symbol, r.day)) n += 1;
  }
  return n;
}

/** Delete entire market-data object store contents. Sessions untouched. */
export async function cacheDeleteAll(): Promise<number> {
  const rows = await listMarketDays();
  let n = 0;
  for (const r of rows) {
    if (await cacheDeleteDay(r.symbol, r.day)) n += 1;
  }
  return n;
}

/** In-flight day fetch dedup (same symbol|day shares one promise). */
const inflightDayFetches = new Map<string, Promise<Bar[]>>();

export function getDayFetchInflight(symbol: string, day: string): Promise<Bar[]> | undefined {
  return inflightDayFetches.get(dayId(symbol, day));
}

export function setDayFetchInflight(symbol: string, day: string, p: Promise<Bar[]>): Promise<Bar[]> {
  const id = dayId(symbol, day);
  inflightDayFetches.set(id, p);
  p.finally(() => {
    if (inflightDayFetches.get(id) === p) inflightDayFetches.delete(id);
  });
  return p;
}
