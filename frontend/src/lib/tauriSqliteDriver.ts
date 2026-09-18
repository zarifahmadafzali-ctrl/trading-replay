/**
 * v3.36.0 — SQLite driver over Tauri invoke commands.
 * Requires Rust commands: sqlite_exec, sqlite_query, sqlite_transaction
 * (see src-tauri). Without Tauri, createMemorySqliteDriver is used in tests.
 */

import type { SqliteDriver, SqlParam, SqlRow } from "./sqliteDriver";

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): InvokeFn | null {
  try {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn }; __TAURI__?: { core?: { invoke?: InvokeFn } } };
    if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    if (w.__TAURI__?.core?.invoke) return w.__TAURI__.core.invoke.bind(w.__TAURI__.core);
  } catch {
    /* not in Tauri */
  }
  return null;
}

export function createTauriSqliteDriver(): SqliteDriver | null {
  const invoke = getInvoke();
  if (!invoke) return null;

  return {
    location: "app-data://trading-replay.sqlite",
    async exec(sql: string, params: SqlParam[] = []): Promise<void> {
      await invoke("sqlite_exec", { sql, params });
    },
    async query(sql: string, params: SqlParam[] = []): Promise<SqlRow[]> {
      const rows = await invoke("sqlite_query", { sql, params });
      return Array.isArray(rows) ? (rows as SqlRow[]) : [];
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      await invoke("sqlite_exec", { sql: "BEGIN", params: [] });
      try {
        const result = await fn();
        await invoke("sqlite_exec", { sql: "COMMIT", params: [] });
        return result;
      } catch (e) {
        try {
          await invoke("sqlite_exec", { sql: "ROLLBACK", params: [] });
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
  };
}

/**
 * Desktop boot: register SQLite adapter when Tauri is present.
 * Safe no-op on web.
 */
export async function bootDesktopSqliteIfNeeded(): Promise<"sqlite" | "indexeddb" | "skipped"> {
  const { getAppPlatform } = await import("./platform");
  if (getAppPlatform() !== "desktop") return "skipped";
  const driver = createTauriSqliteDriver();
  if (!driver) return "indexeddb";
  const { createSqliteSessionAdapter, hydrateActiveSessionId } = await import("./sqliteSessionAdapter");
  const { registerDesktopSessionAdapter } = await import("./storageAdapter");
  await hydrateActiveSessionId(driver);
  registerDesktopSessionAdapter(createSqliteSessionAdapter(driver));
  return "sqlite";
}
