/**
 * v3.36.0 — Desktop SQLite physical schema (SessionStorageAdapter only).
 * Market-data bars stay in IndexedDB barCache — not stored here.
 */

/** Physical SQLite schema version (independent of STORAGE_SCHEMA_VERSION). */
export const DESKTOP_SQLITE_SCHEMA_VERSION = 1;

export const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_runtime (
  session_id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_shapes (
  session_id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_trades (
  session_id TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

export const META_SCHEMA_VERSION_KEY = "desktop_sqlite_schema_version";
export const KV_ACTIVE_SESSION = "active_session_id";
