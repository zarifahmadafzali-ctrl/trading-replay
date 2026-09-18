/**
 * v3.20.0 / v3.20.1 — Platform-neutral backup export/import.
 *
 * Journal trades are authoritative historical data (sessionTrades IndexedDB store
 * via journal.ts). Analytics is derived from Journal — not stored separately.
 *
 * Market-data bars are intentionally EXCLUDED.
 */

import type { SessionMeta, SessionRuntime } from "./sessionStore";
import { getSessionStorageAdapter } from "./storageAdapter";
import { APP_VERSION, BACKUP_FORMAT_VERSION } from "./storageVersions";
import {
  loadJournalForSession,
  saveJournalForSession,
  normalizeJournalTrade,
  type JournalTrade,
} from "./journal";

export type BackupSessionBundle = {
  meta: SessionMeta;
  runtime?: SessionRuntime | null;
  /** Authoritative journal trades for this session (same path as JournalView). */
  trades: JournalTrade[];
  /** Alias for older tooling / diagnostics — same array as trades. */
  journal?: JournalTrade[];
  shapes: unknown[];
  /** Diagnostic: number of trades at export time. */
  tradeCount?: number;
};

export type TradingReplayBackup = {
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  /** Physical source at export time — logical payload is platform-neutral. */
  platform: "web-indexeddb" | "desktop-sqlite" | string;
  sessions: BackupSessionBundle[];
  activeSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

export type BackupValidationResult =
  | { ok: true; backup: TradingReplayBackup }
  | { ok: false; errors: string[] };

/** Extract trades array from a session bundle (supports legacy property names). */
export function extractBundleTrades(bundle: Record<string, unknown>): unknown[] {
  if (Array.isArray(bundle.trades)) return bundle.trades;
  if (Array.isArray(bundle.journal)) return bundle.journal;
  if (Array.isArray(bundle.sessionTrades)) return bundle.sessionTrades;
  if (Array.isArray(bundle.journalTrades)) return bundle.journalTrades;
  return [];
}

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
  // Market-data bars must never appear in app backup
  if (o.bars != null || o.marketData != null || o.barCache != null || o.ticks != null) {
    errors.push("Backup must not include market-data bars (bars/marketData/barCache/ticks)");
  }
  if (!Array.isArray(o.sessions)) {
    errors.push("Missing sessions array");
  } else {
    const seenIds = new Set<string>();
    o.sessions.forEach((s, i) => {
      if (!s || typeof s !== "object") {
        errors.push(`sessions[${i}] is not an object`);
        return;
      }
      const b = s as Record<string, unknown>;
      if (b.bars != null || b.marketData != null) {
        errors.push(`sessions[${i}] must not embed market-data bars`);
      }
      const meta = b.meta as Record<string, unknown> | undefined;
      if (!meta || typeof meta !== "object") {
        errors.push(`sessions[${i}].meta missing`);
      } else if (typeof meta.id !== "string" || !meta.id.trim()) {
        errors.push(`sessions[${i}].meta.id missing`);
      } else {
        if (seenIds.has(meta.id)) {
          errors.push(`Duplicate session id in backup: ${meta.id}`);
        }
        seenIds.add(meta.id);
      }
      if (b.trades != null && !Array.isArray(b.trades) && !Array.isArray(b.journal)) {
        errors.push(`sessions[${i}].trades must be an array when present`);
      }
      if (b.shapes != null && !Array.isArray(b.shapes)) {
        errors.push(`sessions[${i}].shapes must be an array when present`);
      }
      // Soft-check trade identity when present
      const trades = extractBundleTrades(b);
      trades.forEach((t, ti) => {
        if (!t || typeof t !== "object") {
          errors.push(`sessions[${i}].trades[${ti}] is not an object`);
          return;
        }
        const tr = t as Record<string, unknown>;
        const tid = tr.tradeId ?? tr.id;
        if (tid != null && typeof tid !== "string") {
          errors.push(`sessions[${i}].trades[${ti}] tradeId/id must be string when present`);
        }
      });
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, backup: o as unknown as TradingReplayBackup };
}

/**
 * Build backup from the active (or injected) SessionStorageAdapter.
 * Logical JSON is platform-neutral: same shape from IndexedDB or SQLite.
 * Deep-clones trades so JSON serialization cannot hold live references.
 * Never includes market-data bars.
 *
 * @param storage Optional adapter for tests / cross-platform tooling.
 *                Defaults to getSessionStorageAdapter().
 */
export async function exportBackup(
  storage?: import("./storageAdapter").SessionStorageAdapter
): Promise<TradingReplayBackup> {
  const adapter = storage ?? getSessionStorageAdapter();
  const sessions = await adapter.listSessions();
  const bundles: BackupSessionBundle[] = [];
  let totalTrades = 0;

  for (const meta of sessions) {
    // Prefer adapter trades (works for SQLite without registering global desktop adapter).
    // Fall back to journal helper when using default web path.
    let journalRows: unknown[] = [];
    if (storage) {
      journalRows = await adapter.getTrades(meta.id);
    } else {
      journalRows = await loadJournalForSession(meta.id);
    }
    const [runtime, shapes] = await Promise.all([
      adapter.getRuntime(meta.id),
      adapter.getShapes(meta.id),
    ]);
    const trades: JournalTrade[] = JSON.parse(JSON.stringify(journalRows || [])).map(
      (t: Partial<JournalTrade> & Record<string, unknown>) =>
        normalizeJournalTrade({ ...t, sessionId: meta.id })
    ) as JournalTrade[];
    totalTrades += trades.length;
    bundles.push({
      meta: JSON.parse(JSON.stringify(meta)) as SessionMeta,
      runtime: runtime ? (JSON.parse(JSON.stringify(runtime)) as SessionRuntime) : null,
      trades,
      journal: trades,
      shapes: JSON.parse(JSON.stringify(Array.isArray(shapes) ? shapes : [])),
      tradeCount: trades.length,
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
      totalJournalTrades: totalTrades,
      portable: true,
      note:
        "Logical session/journal/shapes only. Market-data bars excluded. Importable on web IndexedDB or desktop SQLite.",
    },
  };
}

export type ImportMode = "merge" | "replace-matching-ids";

export type ImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
  sessionIds: string[];
  tradesRestored: number;
};

/**
 * Import validated backup into the active (or injected) SessionStorageAdapter.
 * Never touches market-data bar cache.
 * Never fabricates trades.
 *
 * @param storage Optional adapter (tests / SQLite without Tauri GUI).
 */
export async function importBackup(
  raw: unknown,
  mode: ImportMode = "merge",
  storage?: import("./storageAdapter").SessionStorageAdapter
): Promise<ImportResult> {
  const v = validateBackup(raw);
  if (!v.ok) {
    return { imported: 0, skipped: 0, errors: v.errors, sessionIds: [], tradesRestored: 0 };
  }
  const adapter = storage ?? getSessionStorageAdapter();
  const existing = await adapter.listSessions();
  const existingIds = new Set(existing.map((s) => s.id));
  let imported = 0;
  let skipped = 0;
  let tradesRestored = 0;
  const errors: string[] = [];
  const sessionIds: string[] = [];

  for (const bundle of v.backup.sessions) {
    try {
      const id = bundle.meta?.id;
      if (!id || typeof id !== "string") {
        errors.push("Session bundle missing meta.id");
        skipped++;
        continue;
      }
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

      const rawTrades = extractBundleTrades(bundle as unknown as Record<string, unknown>);
      const normalized = rawTrades.map((t) =>
        normalizeJournalTrade({
          ...(t as object),
          sessionId: id, // always bind to restored session id
        } as Partial<JournalTrade> & Record<string, unknown>)
      );

      // Prefer direct adapter writes so SQLite and IndexedDB share the same import path.
      await adapter.putTrades(id, normalized);
      if (!storage) {
        // Keep journal helper path warm for web listeners / audit when using default adapter.
        try {
          await saveJournalForSession(id, normalized);
        } catch {
          /* adapter already holds data */
        }
      }

      const verified = storage
        ? ((await adapter.getTrades(id)) as unknown[])
        : await loadJournalForSession(id);
      if (normalized.length > 0 && verified.length === 0) {
        await adapter.putTrades(id, normalized);
        const verified2 = storage
          ? await adapter.getTrades(id)
          : await loadJournalForSession(id);
        if (!verified2.length) {
          errors.push(
            `Session ${id}: failed to persist ${normalized.length} journal trade(s) via ${adapter.platform}`
          );
        } else {
          tradesRestored += verified2.length;
        }
      } else {
        tradesRestored += verified.length;
        if (normalized.length > 0 && verified.length < normalized.length) {
          errors.push(`Session ${id}: restored ${verified.length}/${normalized.length} trades`);
        }
      }

      await adapter.putShapes(id, Array.isArray(bundle.shapes) ? bundle.shapes : []);
      existingIds.add(id);
      sessionIds.push(id);
      imported++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Restore activeSessionId from backup when present and valid; else first imported.
  const wanted = v.backup.activeSessionId;
  if (wanted && sessionIds.includes(wanted)) {
    adapter.setActiveSessionId(wanted);
  } else if (sessionIds.length && !adapter.getActiveSessionId()) {
    adapter.setActiveSessionId(sessionIds[0]);
  }

  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("tr-session-changed"));
      window.dispatchEvent(new CustomEvent("tr-session-accounts-updated"));
    }
  } catch {
    /* */
  }

  return { imported, skipped, errors, sessionIds, tradesRestored };
}

export function downloadBackupJson(backup: TradingReplayBackup, filename?: string): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `trading-replay-backup-${backup.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Diagnose whether a backup object contains journal trades. */
export function diagnoseBackupJournal(raw: unknown): {
  sessionCount: number;
  totalTrades: number;
  perSession: { id: string; tradeCount: number; source: string }[];
} {
  const v = validateBackup(raw);
  if (!v.ok) return { sessionCount: 0, totalTrades: 0, perSession: [] };
  const perSession = v.backup.sessions.map((s) => {
    const b = s as unknown as Record<string, unknown>;
    let source = "none";
    if (Array.isArray(b.trades) && b.trades.length) source = "trades";
    else if (Array.isArray(b.journal) && (b.journal as unknown[]).length) source = "journal";
    else if (Array.isArray(b.trades)) source = "trades(empty)";
    const arr = extractBundleTrades(b);
    return { id: s.meta?.id || "?", tradeCount: arr.length, source };
  });
  return {
    sessionCount: perSession.length,
    totalTrades: perSession.reduce((a, p) => a + p.tradeCount, 0),
    perSession,
  };
}
