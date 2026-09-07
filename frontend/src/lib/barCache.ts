/** Day-sharded IndexedDB cache for 1-second bars.
 *
 * Keys are per UTC day: SYMBOL|YYYY-MM-DD
 * Requesting any sub-range only hits the network for missing days.
 */
import type { Bar } from "./types";

const DB_NAME = "trading-replay-cache";
const DB_VERSION = 2;
const STORE = "days";

function dayId(symbol: string, day: string): string {
  return `${symbol.toUpperCase()}|${day}`;
}

function eachDay(start: string, end: string): string[] {
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
      // v2: day shards
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      // drop legacy full-range store if present
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
        const row = req.result as { bars?: Bar[] } | undefined;
        resolve(row?.bars?.length ? row.bars : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function cachePutDay(symbol: string, day: string, bars: Bar[]): Promise<void> {
  if (!bars.length) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        id: dayId(symbol, day),
        symbol: symbol.toUpperCase(),
        day,
        bars,
        savedAt: Date.now(),
      });
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
    await cachePutDay(symbol, day, dayBars);
  }
  return byDay.size;
}

export type RangeLoadResult = {
  bars: Bar[];
  fromCacheDays: string[];
  missingDays: string[];
};

/**
 * Load any [start, end] range from day shards.
 * Returns bars for days present on device + list of missing days.
 */
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
    const dayBars = await cacheGetDay(symbol, day);
    if (dayBars?.length) {
      fromCacheDays.push(day);
      bars.push(...dayBars);
    } else {
      missingDays.push(day);
    }
  }

  bars.sort((a, b) => a.time - b.time);
  return { bars, fromCacheDays, missingDays };
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
        const rows = (req.result || []) as any[];
        resolve(
          rows.map((r) => ({
            id: r.id,
            symbol: r.symbol,
            day: r.day,
            savedAt: r.savedAt ?? 0,
            count: Array.isArray(r.bars) ? r.bars.length : 0,
          }))
        );
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
