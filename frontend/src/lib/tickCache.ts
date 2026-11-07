/**
 * Phase B — separate IndexedDB store for raw ticks (day-sharded).
 * Shares DB name with barCache; bumps version to add `ticks` store.
 * Does NOT put ticks into the bars array.
 */

import type { TickDayRow, TickRecord } from "./tickTypes";
import { normalizeTicks, tickIdentityKey } from "./tickValidate";

const DB_NAME = "trading-replay-cache";
/** v3 = days only; v4 = + ticks store */
const DB_VERSION = 4;
const STORE_DAYS = "days";
const STORE_TICKS = "ticks";

export function tickDayId(symbol: string, day: string): string {
  return `${symbol.toUpperCase()}|${day}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DAYS)) {
        db.createObjectStore(STORE_DAYS, { keyPath: "id" });
      }
      if (db.objectStoreNames.contains("bars")) {
        db.deleteObjectStore("bars");
      }
      if (!db.objectStoreNames.contains(STORE_TICKS)) {
        db.createObjectStore(STORE_TICKS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Align barCache open path to the same version so upgrades stay consistent. */
export { DB_NAME, DB_VERSION, STORE_TICKS };

export async function tickCacheGetDay(
  symbol: string,
  day: string
): Promise<TickDayRow | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TICKS, "readonly");
      const req = tx.objectStore(STORE_TICKS).get(tickDayId(symbol, day));
      req.onsuccess = () => resolve((req.result as TickDayRow) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function tickCacheGetCount(symbol: string, day: string): Promise<number> {
  const row = await tickCacheGetDay(symbol, day);
  if (!row) return 0;
  return row.tickCount ?? row.ticks?.length ?? 0;
}

/**
 * Replace-or-write a complete day of ticks.
 * Call only after the full day is validated — incomplete imports must not set complete=true.
 */
export async function tickCachePutDay(
  symbol: string,
  day: string,
  ticks: TickRecord[],
  opts?: { complete?: boolean; source?: string }
): Promise<void> {
  const normalized = normalizeTicks(ticks as unknown as Array<Record<string, unknown>>);
  const row: TickDayRow = {
    id: tickDayId(symbol, day),
    symbol: symbol.toUpperCase(),
    day,
    ticks: normalized.ticks,
    tickCount: normalized.ticks.length,
    savedAt: Date.now(),
    complete: opts?.complete ?? true,
    source: opts?.source,
    priceBasis: "mid",
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_TICKS, "readwrite");
    tx.objectStore(STORE_TICKS).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Merge incoming ticks into an existing day without collapsing equal timestamps
 * unless the full identity matches.
 */
export async function tickCacheMergeDay(
  symbol: string,
  day: string,
  incoming: TickRecord[],
  opts?: { source?: string }
): Promise<{ written: number; skippedDuplicates: number; total: number }> {
  const existing = await tickCacheGetDay(symbol, day);
  const base = existing?.ticks ? [...existing.ticks] : [];
  const seen = new Set(base.map((t) => tickIdentityKey(t)));
  let skipped = 0;
  for (const t of incoming) {
    const k = tickIdentityKey(t);
    if (seen.has(k)) {
      skipped += 1;
      continue;
    }
    seen.add(k);
    base.push(t);
  }
  const normalized = normalizeTicks(base as unknown as Array<Record<string, unknown>>);
  await tickCachePutDay(symbol, day, normalized.ticks, {
    complete: true,
    source: opts?.source ?? existing?.source,
  });
  return {
    written: normalized.ticks.length - (existing?.tickCount ?? 0) + skipped > 0
      ? normalized.ticks.length
      : normalized.ticks.length,
    skippedDuplicates: skipped + normalized.exactDuplicatesSkipped,
    total: normalized.ticks.length,
  };
}

export async function tickCacheDeleteDay(symbol: string, day: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_TICKS, "readwrite");
    tx.objectStore(STORE_TICKS).delete(tickDayId(symbol, day));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function tickCacheListDays(symbol?: string): Promise<
  Array<{ symbol: string; day: string; tickCount: number; complete: boolean }>
> {
  try {
    const db = await openDb();
    const rows = await new Promise<TickDayRow[]>((resolve, reject) => {
      const tx = db.transaction(STORE_TICKS, "readonly");
      const req = tx.objectStore(STORE_TICKS).getAll();
      req.onsuccess = () => resolve((req.result as TickDayRow[]) || []);
      req.onerror = () => reject(req.error);
    });
    const sym = symbol?.toUpperCase();
    return rows
      .filter((r) => !sym || r.symbol === sym)
      .map((r) => ({
        symbol: r.symbol,
        day: r.day,
        tickCount: r.tickCount ?? r.ticks?.length ?? 0,
        complete: !!r.complete,
      }));
  } catch {
    return [];
  }
}
