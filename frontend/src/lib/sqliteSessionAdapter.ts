/**
 * v3.36.0 — SessionStorageAdapter backed by SQLite (desktop).
 * Domain code must only use SessionStorageAdapter — never SQL.
 */

import type { SessionMeta, SessionRuntime } from "./sessionStore";
import type { SessionStorageAdapter } from "./storageAdapter";
import type { SqliteDriver } from "./sqliteDriver";
import {
  DESKTOP_SQLITE_SCHEMA_VERSION,
  SQLITE_SCHEMA_SQL,
  META_SCHEMA_VERSION_KEY,
  KV_ACTIVE_SESSION,
} from "./sqliteSchema";
import { STORAGE_SCHEMA_VERSION } from "./storageVersions";

function now(): number {
  return Date.now();
}

function parseJson<T>(raw: unknown): T | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function ensureSqliteSchema(driver: SqliteDriver): Promise<void> {
  const statements = SQLITE_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await driver.exec(stmt);
  }
  const rows = await driver.query("SELECT * FROM meta WHERE key = ?", [META_SCHEMA_VERSION_KEY]);
  if (!rows.length) {
    await driver.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
      META_SCHEMA_VERSION_KEY,
      String(DESKTOP_SQLITE_SCHEMA_VERSION),
    ]);
  }
}

export function createSqliteSessionAdapter(driver: SqliteDriver): SessionStorageAdapter {
  let ready: Promise<void> | null = null;
  const ensure = () => {
    if (!ready) ready = ensureSqliteSchema(driver);
    return ready;
  };

  return {
    platform: "desktop-sqlite",
    schemaVersion: STORAGE_SCHEMA_VERSION,

    async listSessions(): Promise<SessionMeta[]> {
      await ensure();
      const rows = await driver.query("SELECT * FROM sessions");
      const out: SessionMeta[] = [];
      for (const r of rows) {
        const meta = parseJson<SessionMeta>(r.json);
        if (meta?.id) out.push(meta);
      }
      return out;
    },

    async getSession(id: string): Promise<SessionMeta | undefined> {
      await ensure();
      const rows = await driver.query("SELECT * FROM sessions WHERE id = ?", [id]);
      if (!rows[0]) return undefined;
      return parseJson<SessionMeta>(rows[0].json);
    },

    async upsertSession(meta: SessionMeta): Promise<void> {
      await ensure();
      await driver.exec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", [
        meta.id,
        JSON.stringify(meta),
        now(),
      ]);
    },

    async deleteSession(id: string): Promise<void> {
      await ensure();
      await driver.transaction(async () => {
        await driver.exec("DELETE FROM sessions WHERE id = ?", [id]);
        await driver.exec("DELETE FROM session_runtime WHERE session_id = ?", [id]);
        await driver.exec("DELETE FROM session_shapes WHERE session_id = ?", [id]);
        await driver.exec("DELETE FROM journal_trades WHERE session_id = ?", [id]);
      });
    },

    async getRuntime(sessionId: string): Promise<SessionRuntime | undefined> {
      await ensure();
      const rows = await driver.query("SELECT * FROM session_runtime WHERE session_id = ?", [sessionId]);
      if (!rows[0]) return undefined;
      return parseJson<SessionRuntime>(rows[0].json);
    },

    async putRuntime(runtime: SessionRuntime): Promise<void> {
      await ensure();
      await driver.exec(
        "INSERT OR REPLACE INTO session_runtime (session_id, json, updated_at) VALUES (?, ?, ?)",
        [runtime.sessionId, JSON.stringify(runtime), now()]
      );
    },

    async getTrades(sessionId: string): Promise<unknown[]> {
      await ensure();
      const rows = await driver.query("SELECT * FROM journal_trades WHERE session_id = ?", [sessionId]);
      if (!rows[0]) return [];
      const arr = parseJson<unknown[]>(rows[0].json);
      return Array.isArray(arr) ? arr : [];
    },

    async putTrades(sessionId: string, trades: unknown[]): Promise<void> {
      await ensure();
      await driver.exec(
        "INSERT OR REPLACE INTO journal_trades (session_id, json, updated_at) VALUES (?, ?, ?)",
        [sessionId, JSON.stringify(trades), now()]
      );
    },

    async getShapes(sessionId: string): Promise<unknown[]> {
      await ensure();
      const rows = await driver.query("SELECT * FROM session_shapes WHERE session_id = ?", [sessionId]);
      if (!rows[0]) return [];
      const arr = parseJson<unknown[]>(rows[0].json);
      return Array.isArray(arr) ? arr : [];
    },

    async putShapes(sessionId: string, shapes: unknown[]): Promise<void> {
      await ensure();
      await driver.exec(
        "INSERT OR REPLACE INTO session_shapes (session_id, json, updated_at) VALUES (?, ?, ?)",
        [sessionId, JSON.stringify(shapes), now()]
      );
    },

    getActiveSessionId(): string | null {
      // sync API required by interface — use cached value; hydrated async via hydrateActiveSessionId
      return _activeSessionCache;
    },

    setActiveSessionId(id: string | null): void {
      _activeSessionCache = id;
      void ensure().then(() =>
        driver.exec("INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)", [
          KV_ACTIVE_SESSION,
          id ?? "",
        ])
      );
    },
  };
}

let _activeSessionCache: string | null = null;

/** Load active session id from DB into sync cache (call on desktop boot). */
export async function hydrateActiveSessionId(driver: SqliteDriver): Promise<string | null> {
  await ensureSqliteSchema(driver);
  const rows = await driver.query("SELECT * FROM app_kv WHERE key = ?", [KV_ACTIVE_SESSION]);
  const v = rows[0]?.value;
  _activeSessionCache = typeof v === "string" && v.length ? v : null;
  return _activeSessionCache;
}

export function peekActiveSessionCache(): string | null {
  return _activeSessionCache;
}
