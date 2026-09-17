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
  platform: "web-indexeddb" | "desktop-sqlite-future" | string;
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
      // trades may be missing on corrupt exports — warn in metadata but allow import of meta
      const trades = extractBundleTrades(b);
      if (b.trades != null && !Array.isArray(b.trades) && !Array.isArray(b.journal)) {
        errors.push(`sessions[${i}].trades must be an array when present`);
      }
      if (b.shapes != null && !Array.isArray(b.shapes)) {
        errors.push(`sessions[${i}].shapes must be an array when present`);
      }
      void trades;
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, backup: o as unknown as TradingReplayBackup };
}

/**
 * Build backup using the same Journal load path as JournalView/Analytics.
 * Deep-clones trades so JSON serialization cannot hold live references.
 */
export async function exportBackup(): Promise<TradingReplayBackup> {
  const adapter = getSessionStorageAdapter();
  const sessions = await adapter.listSessions();
  const bundles: BackupSessionBundle[] = [];
  let totalTrades = 0;

  for (const meta of sessions) {
    const [runtime, journalRows, shapes] = await Promise.all([
      adapter.getRuntime(meta.id),
      loadJournalForSession(meta.id),
      adapter.getShapes(meta.id),
    ]);
    // Deep clone via JSON to guarantee serializable plain objects
    const trades: JournalTrade[] = JSON.parse(JSON.stringify(journalRows || [])) as JournalTrade[];
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
      note: "Journal trades use sessionTrades store (same as Journal UI). Market-data bars excluded.",
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
 * Import validated backup.
 * Journal is restored via saveJournalForSession (same path as live trading).
 * Never touches market-data bar cache.
 * Never fabricates trades.
 */
export async function importBackup(
  raw: unknown,
  mode: ImportMode = "merge"
): Promise<ImportResult> {
  const v = validateBackup(raw);
  if (!v.ok) {
    return { imported: 0, skipped: 0, errors: v.errors, sessionIds: [], tradesRestored: 0 };
  }
  const adapter = getSessionStorageAdapter();
  const existing = await adapter.listSessions();
  const existingIds = new Set(existing.map((s) => s.id));
  let imported = 0;
  let skipped = 0;
  let tradesRestored = 0;
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

      // Journal: same write path as appendTradeAsync / JournalView
      const rawTrades = extractBundleTrades(bundle as unknown as Record<string, unknown>);
      const normalized = rawTrades.map((t) =>
        normalizeJournalTrade({
          ...(t as object),
          sessionId: id, // always bind to restored session id
        } as Partial<JournalTrade> & Record<string, unknown>)
      );
      await saveJournalForSession(id, normalized);

      // Verify write (catches silent IDB failures)
      const verified = await loadJournalForSession(id);
      if (normalized.length > 0 && verified.length === 0) {
        // Retry once via adapter
        await adapter.putTrades(id, normalized);
        const verified2 = await loadJournalForSession(id);
        if (verified2.length === 0) {
          errors.push(
            `Session ${id}: failed to persist ${normalized.length} journal trade(s) to IndexedDB`
          );
        } else {
          tradesRestored += verified2.length;
        }
      } else {
        tradesRestored += verified.length;
        if (normalized.length > 0 && verified.length < normalized.length) {
          errors.push(
            `Session ${id}: restored ${verified.length}/${normalized.length} trades`
          );
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

  // Activate first imported session if none active (so Journal/Analytics load immediately)
  if (sessionIds.length && !adapter.getActiveSessionId()) {
    adapter.setActiveSessionId(sessionIds[0]);
  }

  // Notify JournalView / AnalyticsView to reload
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
