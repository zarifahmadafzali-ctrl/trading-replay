/**
 * v3.21.0 — Central storage adapter boundary (PWA-safe).
 *
 * Architecture:
 *
 *   UI / Domain
 *        ↓
 *   Storage Adapter  (this module)
 *        ↓
 *   Web: IndexedDB via sessionStore
 *   Future Desktop: Tauri + SQLite (NOT implemented)
 *
 * Canonical ownership (one authoritative path each):
 *   SessionMeta        → adapter.listSessions / getSession / upsertSession / deleteSession
 *   SessionRuntime     → adapter.getRuntime / putRuntime
 *   SessionShapes      → adapter.getShapes / putShapes
 *   SessionTrades/Journal → journal.loadJournalForSession / saveJournalForSession
 *                         (which use adapter.getTrades / putTrades)
 *   Accounts + Prop lifecycle → embedded on SessionMeta.accounts[]
 *   Market-data bars   → barCache (symbol|day), NOT session-scoped, NOT in backup
 *
 * Market data remains a specialized cache interface (performance / shared lifecycle).
 * Physical storage is never shared between PWA and a future Desktop client;
 * transfer is via platform-neutral backup export/import (backup.ts).
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
import { getAppPlatform } from "./platform";


export type StoragePlatform = "web-indexeddb" | "desktop-sqlite-future";

/**
 * Platform-neutral session persistence surface.
 * Implementations must not leak IndexedDB/SQLite types to callers.
 */
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

/**
 * Default adapter for the running app.
 * v3.32.0: both web and desktop shells still use IndexedDB via this adapter.
 * Future: desktop may return a SQLite-backed SessionStorageAdapter implementing
 * the same interface — callers must not assume IndexedDB APIs.
 */
export function getSessionStorageAdapter(): SessionStorageAdapter {
  // Platform detection is centralized; storage backend switch is future work.
  void getAppPlatform();
  return indexedDbSessionAdapter;
}

/** @deprecated alias — use getSessionStorageAdapter */
export const getActiveStorageAdapter = getSessionStorageAdapter;
