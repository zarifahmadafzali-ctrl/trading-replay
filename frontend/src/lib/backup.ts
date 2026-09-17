/**
 * v3.20.0 — Platform-neutral backup export/import.
 *
 * Transfer path (future): PWA ↔ Desktop via JSON file.
 * Does NOT claim shared physical DB between IndexedDB and SQLite.
 *
 * Journal trades are exported as-is (immutable historical records).
 * Market-data bars are intentionally EXCLUDED (large, shared cache; re-syncable).
 */

import type { SessionMeta, SessionRuntime } from "./sessionStore";
import { getSessionStorageAdapter } from "./storageAdapter";
import { APP_VERSION, BACKUP_FORMAT_VERSION } from "./storageVersions";

export type BackupSessionBundle = {
  meta: SessionMeta;
  runtime?: SessionRuntime | null;
  trades: unknown[];
  shapes: unknown[];
};

export type TradingReplayBackup = {
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  platform: "web-indexeddb" | "desktop-sqlite-future" | string;
  sessions: BackupSessionBundle[];
  /** Active session id at export time (optional). */
  activeSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

export type BackupValidationResult =
  | { ok: true; backup: TradingReplayBackup }
  | { ok: false; errors: string[] };

export function validateBackup(raw: unknown): BackupValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Backup is not an object"] };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.formatVersion !== "number" || !Number.isFinite(o.formatVersion)) {
    errors.push("Missing or invalid formatVersion");
  } else if (o.formatVersion > BACKUP_FORMAT_VERSION) {
    errors.push(
      `Backup formatVersion ${o.formatVersion} is newer than supported ${BACKUP_FORMAT_VERSION}`
    );
  } else if (o.formatVersion < 1) {
    errors.push(`Unsupported formatVersion ${o.formatVersion}`);
  }
  if (!Array.isArray(o.sessions)) {
    errors.push("Missing sessions array");
  } else {
    o.sessions.forEach((s, i) => {
      if (!s || typeof s !== "object") {
        errors.push(`sessions[${i}] is not an object`);
        return;
      }
      const b = s as Record<string, unknown>;
      const meta = b.meta as Record<string, unknown> | undefined;
      if (!meta || typeof meta !== "object") {
        errors.push(`sessions[${i}].meta missing`);
      } else if (typeof meta.id !== "string" || !meta.id) {
        errors.push(`sessions[${i}].meta.id missing`);
      }
      if (!Array.isArray(b.trades)) errors.push(`sessions[${i}].trades must be an array`);
      if (!Array.isArray(b.shapes)) errors.push(`sessions[${i}].shapes must be an array`);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, backup: o as unknown as TradingReplayBackup };
}

/** Build a full user-data backup (sessions, accounts-in-meta, journal trades, shapes, runtime). */
export async function exportBackup(): Promise<TradingReplayBackup> {
  const adapter = getSessionStorageAdapter();
  const sessions = await adapter.listSessions();
  const bundles: BackupSessionBundle[] = [];
  for (const meta of sessions) {
    const [runtime, trades, shapes] = await Promise.all([
      adapter.getRuntime(meta.id),
      adapter.getTrades(meta.id),
      adapter.getShapes(meta.id),
    ]);
    bundles.push({
      meta: { ...meta },
      runtime: runtime ?? null,
      trades: Array.isArray(trades) ? trades : [],
      shapes: Array.isArray(shapes) ? shapes : [],
    });
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    platform: adapter.platform,
    sessions: bundles,
    activeSessionId: adapter.getActiveSessionId(),
    metadata: {
      storageSchemaVersion: adapter.schemaVersion,
      excludesMarketDataBars: true,
      note: "Market-data day cache is not included; re-sync or keep local barCache separately.",
    },
  };
}

export type ImportMode = "merge" | "replace-matching-ids";

export type ImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
  sessionIds: string[];
};

/**
 * Import validated backup.
 * - merge: skip sessions whose id already exists
 * - replace-matching-ids: overwrite meta/runtime/trades/shapes for matching ids
 * Never deletes unrelated sessions. Never touches market-data bar cache.
 * Never rewrites trade field values beyond storing the exported JSON as-is.
 */
export async function importBackup(
  raw: unknown,
  mode: ImportMode = "merge"
): Promise<ImportResult> {
  const v = validateBackup(raw);
  if (!v.ok) {
    return { imported: 0, skipped: 0, errors: v.errors, sessionIds: [] };
  }
  const adapter = getSessionStorageAdapter();
  const existing = await adapter.listSessions();
  const existingIds = new Set(existing.map((s) => s.id));
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  const sessionIds: string[] = [];

  for (const bundle of v.backup.sessions) {
    try {
      const id = bundle.meta.id;
      if (existingIds.has(id) && mode === "merge") {
        skipped++;
        continue;
      }
      await adapter.upsertSession({
        ...bundle.meta,
        updatedAt: Date.now(),
      });
      if (bundle.runtime && typeof bundle.runtime === "object") {
        await adapter.putRuntime({
          ...bundle.runtime,
          sessionId: id,
          playing: false,
          updatedAt: Date.now(),
        });
      }
      await adapter.putTrades(id, Array.isArray(bundle.trades) ? bundle.trades : []);
      await adapter.putShapes(id, Array.isArray(bundle.shapes) ? bundle.shapes : []);
      existingIds.add(id);
      sessionIds.push(id);
      imported++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { imported, skipped, errors, sessionIds };
}

/** Download backup as JSON file in the browser. */
export function downloadBackupJson(backup: TradingReplayBackup, filename?: string): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `trading-replay-backup-${backup.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
