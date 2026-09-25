/**
 * v3.20.0 — Explicit versioning for storage layers.
 * APP VERSION ≠ STORAGE SCHEMA ≠ BACKUP FORMAT ≠ MARKET DATA CACHE.
 *
 * PWA continues to use IndexedDB. Future Desktop (Tauri/SQLite) is NOT implemented here.
 * Shared domain models + export/import format enable future PWA ↔ Desktop transfer.
 */

/** Application product version (package.json). */
export const APP_VERSION = "3.39.0";

/**
 * IndexedDB session schema version (trading-replay-sessions DB).
 * Bump only when object-store shape changes; pair with onupgradeneeded.
 */
export const STORAGE_SCHEMA_VERSION = 1;

/**
 * Platform-neutral backup JSON format version.
 * Independent of IndexedDB internals and any future SQLite schema.
 */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Market bar cache schema version (day-sharded IndexedDB).
 * Market data is NOT an application binary update.
 */
export const MARKET_DATA_CACHE_VERSION = 1;

/**
 * Portable market-data file format (CSV companion + .trdata JSON package).
 * Independent of BACKUP_FORMAT_VERSION and MARKET_DATA_CACHE_VERSION.
 */
export const MARKET_DATA_EXPORT_FORMAT_VERSION = 1;

/** Prop lifecycle rules engine version (last reconcile semantics). */
export const PROP_LIFECYCLE_RULES_VERSION_TAG = 3;

/** Re-export physical desktop schema version for docs/tests. */
export { DESKTOP_SQLITE_SCHEMA_VERSION } from "./sqliteSchema";
