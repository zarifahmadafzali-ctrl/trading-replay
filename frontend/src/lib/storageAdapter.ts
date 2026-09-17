/**
 * v3.20.0 — Platform-neutral storage adapter boundary.
 *
 * Web/PWA implementation: IndexedDB via sessionStore (this module).
 * Future Desktop: Tauri + SQLite adapter (NOT implemented in v3.20.0).
 *
 * Domain logic must not call IndexedDB APIs directly for session user-data
 * when going through this adapter. Market-data bars remain in barCache
 * (shared global cache by symbol|day — not duplicated per session).
 *
 * Physical storage is NOT shared between PWA and Desktop; transfer is via
 * platform-neutral backup export/import (see backup.ts).
 */

import type { SessionMeta, SessionRuntime } from "./sessionStore";
import {
  listSessions,
  getSession,
  upsertSession,
  deleteSessionAll,
  getRuntime,
  putRuntime,
  getSessionTrades,
  putSessionTrades,
  getSessionShapes,
  putSessionShapes,
  getActiveSessionId,
  setActiveSessionId,
} from "./sessionStore";
import { STORAGE_SCHEMA_VERSION } from "./storageVersions";

export type StoragePlatform = "web-indexeddb" | "desktop-sqlite-future";

export interface SessionStorageAdapter {
  readonly platform: StoragePlatform;
  readonly schemaVersion: number;

  listSessions(): Promise<SessionMeta[]>;
  getSession(id: string): Promise<SessionMeta | undefined>;
  upsertSession(meta: SessionMeta): Promise<void>;
  /** Deletes session meta + runtime + trades + shapes. Does NOT delete shared market-data cache. */
  deleteSession(id: string): Promise<void>;

  getRuntime(sessionId: string): Promise<SessionRuntime | undefined>;
  putRuntime(runtime: SessionRuntime): Promise<void>;

  getTrades(sessionId: string): Promise<unknown[]>;
  putTrades(sessionId: string, trades: unknown[]): Promise<void>;

  getShapes(sessionId: string): Promise<unknown[]>;
  putShapes(sessionId: string, shapes: unknown[]): Promise<void>;

  getActiveSessionId(): string | null;
  setActiveSessionId(id: string | null): void;
}

/** IndexedDB-backed adapter used by the PWA. */
export const indexedDbSessionAdapter: SessionStorageAdapter = {
  platform: "web-indexeddb",
  schemaVersion: STORAGE_SCHEMA_VERSION,

  listSessions,
  getSession,
  upsertSession,
  deleteSession: deleteSessionAll,
  getRuntime,
  putRuntime,
  getTrades: getSessionTrades,
  putTrades: putSessionTrades,
  getShapes: getSessionShapes,
  putShapes: putSessionShapes,
  getActiveSessionId,
  setActiveSessionId,
};

/** Default adapter for the running app (always IndexedDB in v3.20.0). */
export function getSessionStorageAdapter(): SessionStorageAdapter {
  return indexedDbSessionAdapter;
}
