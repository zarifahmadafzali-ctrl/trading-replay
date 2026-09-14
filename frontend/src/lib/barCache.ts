/** Day-sharded IndexedDB cache for 1-second bars.
 *
 * Keys are per UTC day: SYMBOL|YYYY-MM-DD
 * Requesting any sub-range only hits the network for missing days.
 */
import type { Bar } from "./types";

const DB_NAME = "trading-replay-cache";
const DB_VERSION = 3;
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

/** Idempotent put for one UTC day. Empty bars allowed for EXPECTED_EMPTY. */
export async function cachePutDay(
  symbol: string,
  day: string,
  bars: Bar[],
  opts?: { classification?: string; complete?: boolean }
): Promise<void> {
  const classification = opts?.classification || (bars.length ? "SUCCESS" : "EXPECTED_EMPTY");
  const complete = opts?.complete ?? true;
  // Deduplicate by timestamp
  const byT = new Map<number, Bar>();
  for (const b of bars) {
    if (b && typeof b.time === "number") byT.set(b.time, b);
  }
  const unique = Array.from(byT.values()).sort((a, b) => a.time - b.time);
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

export type RangeLoadResult = {
  bars: Bar[];
  fromCacheDays: string[];
  missingDays: string[];
};

export async function cacheGetRange(
  symbol: string,
  start: string,
  end: string
): Promise<RangeLoadResult> {
  const days = eachDay(start, end);
  const fromCacheDays: string[] = [];
  const missingDays: string[] = [];
  const bars: Bar[] = [];

  for (const day of days) {
    const row = await cacheGetDayRow(symbol, day);
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

  bars.sort((a, b) => a.time - b.time);
  return { bars, fromCacheDays, missingDays };
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
    const row = await cacheGetDayRow(symbol, day);
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
