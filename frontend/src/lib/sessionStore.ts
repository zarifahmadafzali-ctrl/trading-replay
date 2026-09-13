/**
 * v3.16.0 — Backtest Session architecture (IndexedDB).
 *
 * Session state is isolated per sessionId.
 * Market bars remain in the shared day-sharded barCache (symbol|YYYY-MM-DD).
 */

export type SessionDataSource = "demo" | "loaded" | "csv";

export type SessionMeta = {
  id: string;
  name: string;
  symbol: string;
  start: string;
  end: string;
  dataSource: SessionDataSource;
  createdAt: number;
  updatedAt: number;
};

export type SessionRuntime = {
  sessionId: string;
  timeframeSeconds: number;
  customTfs: number[];
  replayStepSeconds: number;
  cursor: number;
  speed: number;
  followPrice: boolean;
  orderType: string;
  drawTool: string;
  activeIndicatorIds: string[];
  message: string;
  /** Always restored paused */
  playing: boolean;
  updatedAt: number;
};

const DB_NAME = "trading-replay-sessions";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";
const STORE_RUNTIME = "sessionRuntime";
const STORE_TRADES = "sessionTrades";
const STORE_SHAPES = "sessionShapes";
const ACTIVE_KEY = "tr-active-session-id";
const MIGRATE_FLAG = "tr-session-migrate-v316";

function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_RUNTIME)) {
        db.createObjectStore(STORE_RUNTIME, { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains(STORE_TRADES)) {
        db.createObjectStore(STORE_TRADES, { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains(STORE_SHAPES)) {
        db.createObjectStore(STORE_SHAPES, { keyPath: "sessionId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbPut(store: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbDelete(store: string, key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbGetAll<T>(store: string): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve((req.result as T[]) || []);
        req.onerror = () => reject(req.error);
      })
  );
}

export function getActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* */
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  const all = await idbGetAll<SessionMeta>(STORE_SESSIONS);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSession(id: string): Promise<SessionMeta | undefined> {
  return idbGet<SessionMeta>(STORE_SESSIONS, id);
}

export async function upsertSession(meta: SessionMeta): Promise<void> {
  await idbPut(STORE_SESSIONS, { ...meta, updatedAt: Date.now() });
}

export async function deleteSessionAll(id: string): Promise<void> {
  await idbDelete(STORE_SESSIONS, id);
  await idbDelete(STORE_RUNTIME, id);
  await idbDelete(STORE_TRADES, id);
  await idbDelete(STORE_SHAPES, id);
  if (getActiveSessionId() === id) setActiveSessionId(null);
}

export async function getRuntime(sessionId: string): Promise<SessionRuntime | undefined> {
  return idbGet<SessionRuntime>(STORE_RUNTIME, sessionId);
}

export async function putRuntime(runtime: SessionRuntime): Promise<void> {
  await idbPut(STORE_RUNTIME, { ...runtime, updatedAt: Date.now() });
}

export async function getSessionTrades(sessionId: string): Promise<any[]> {
  const row = await idbGet<{ sessionId: string; trades: any[] }>(STORE_TRADES, sessionId);
  return row?.trades ?? [];
}

export async function putSessionTrades(sessionId: string, trades: any[]): Promise<void> {
  await idbPut(STORE_TRADES, { sessionId, trades: trades.slice(0, 500) });
}

export async function getSessionShapes(sessionId: string): Promise<unknown[]> {
  const row = await idbGet<{ sessionId: string; shapes: unknown[] }>(STORE_SHAPES, sessionId);
  return row?.shapes ?? [];
}

export async function putSessionShapes(sessionId: string, shapes: unknown[]): Promise<void> {
  await idbPut(STORE_SHAPES, { sessionId, shapes });
}

export function defaultRuntime(sessionId: string, partial?: Partial<SessionRuntime>): SessionRuntime {
  return {
    sessionId,
    timeframeSeconds: 300,
    customTfs: [],
    replayStepSeconds: 1,
    cursor: 800,
    speed: 1,
    followPrice: false,
    orderType: "market",
    drawTool: "crosshair",
    activeIndicatorIds: [],
    message: "New session",
    playing: false,
    updatedAt: Date.now(),
    ...partial,
  };
}

export async function createSession(input: {
  name: string;
  symbol: string;
  start: string;
  end: string;
  dataSource?: SessionDataSource;
}): Promise<SessionMeta> {
  const id = uid();
  const now = Date.now();
  const meta: SessionMeta = {
    id,
    name: input.name.trim(),
    symbol: input.symbol,
    start: input.start,
    end: input.end,
    dataSource: input.dataSource ?? "demo",
    createdAt: now,
    updatedAt: now,
  };
  await upsertSession(meta);
  await putRuntime(
    defaultRuntime(id, {
      message: `${meta.name} · ready`,
    })
  );
  await putSessionTrades(id, []);
  await putSessionShapes(id, []);
  setActiveSessionId(id);
  return meta;
}

/**
 * One-time migration from localStorage (v3.15.x) into a default Session.
 * Idempotent via MIGRATE_FLAG.
 */
export async function migrateLegacyToSessionIfNeeded(): Promise<string | null> {
  try {
    if (localStorage.getItem(MIGRATE_FLAG)) {
      return getActiveSessionId();
    }

    const existing = await listSessions();
    if (existing.length > 0) {
      localStorage.setItem(MIGRATE_FLAG, "1");
      if (!getActiveSessionId()) setActiveSessionId(existing[0].id);
      return getActiveSessionId();
    }

    // Build from old replay session meta if present
    let symbol = "US30";
    let start = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    let end = new Date().toISOString().slice(0, 10);
    let dataSource: SessionDataSource = "demo";
    let runtimePartial: Partial<SessionRuntime> = {};

    try {
      const raw = localStorage.getItem("tr-replay-session-v1");
      if (raw) {
        const m = JSON.parse(raw);
        if (m?.symbol) symbol = m.symbol;
        if (m?.start) start = m.start;
        if (m?.end) end = m.end;
        if (m?.dataSource) dataSource = m.dataSource;
        runtimePartial = {
          timeframeSeconds: m.timeframeSeconds || 300,
          customTfs: Array.isArray(m.customTfs) ? m.customTfs : [],
          replayStepSeconds: Math.max(1, m.replayStepSeconds || 1),
          cursor: Math.max(1, m.cursor || 800),
          speed: m.speed || 1,
          followPrice: !!m.followPrice,
          orderType: m.orderType || "market",
          drawTool: m.drawTool || "crosshair",
          message: m.message || "Migrated session",
        };
      }
    } catch {
      /* */
    }

    let indicators: string[] = [];
    try {
      const raw = localStorage.getItem("tr-indicators");
      if (raw) indicators = JSON.parse(raw);
    } catch {
      /* */
    }

    let shapes: unknown[] = [];
    try {
      const raw = localStorage.getItem(`tr-shapes-${symbol}`);
      if (raw) shapes = JSON.parse(raw);
    } catch {
      /* */
    }

    let trades: any[] = [];
    try {
      const raw = localStorage.getItem("tr-trade-journal-v1");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) trades = arr;
      }
    } catch {
      /* */
    }

    const meta = await createSession({
      name: `Migrated · ${symbol}`,
      symbol,
      start,
      end,
      dataSource,
    });
    await putRuntime(
      defaultRuntime(meta.id, {
        ...runtimePartial,
        activeIndicatorIds: indicators,
      })
    );
    await putSessionShapes(meta.id, shapes);
    await putSessionTrades(meta.id, trades);

    localStorage.setItem(MIGRATE_FLAG, "1");
    return meta.id;
  } catch {
    return getActiveSessionId();
  }
}

/** Notify app that active session changed (ReplayView listens). */
export const SESSION_CHANGED_EVENT = "tr-session-changed";

export function emitSessionChanged(sessionId: string | null): void {
  window.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT, { detail: { sessionId } }));
}
