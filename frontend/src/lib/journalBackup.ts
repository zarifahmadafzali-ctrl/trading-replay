/**
 * C6 — Portable Journal backup (ZIP) with real screenshot bytes.
 * Screenshots in-app are data URLs on JournalTrade; export extracts files,
 * import re-embeds data URLs so existing UI/storage continues to work.
 */

import type { JournalTrade } from "./journal";
import { normalizeJournalTrade, loadJournalForSession, saveJournalForSession } from "./journal";
import { APP_VERSION } from "./storageVersions";
import { readZipEntries, writeZipStored } from "./zipStore";

export const JOURNAL_BACKUP_FORMAT_VERSION = 1;
export const JOURNAL_BACKUP_KIND = "trading-replay-journal-backup";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_TRADES = 50_000;

export type JournalBackupManifest = {
  kind: typeof JOURNAL_BACKUP_KIND;
  formatVersion: number;
  appVersion?: string;
  exportedAt: string;
  tradeCount: number;
  screenshotCount: number;
  sessionIds: string[];
  integrity?: { journalSha256?: string };
};

export type JournalBackupPreview = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: JournalBackupManifest | null;
  trades: JournalTrade[];
  screenshotCount: number;
  sessionIds: string[];
  duplicateIdsInPackage: string[];
};

export type ImportMode = "merge" | "replace";

export type JournalImportResult = {
  ok: boolean;
  mode: ImportMode;
  imported: number;
  skipped: number;
  replaced: number;
  totalAfter: number;
  errors: string[];
  warnings: string[];
};

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(u: Uint8Array): string {
  return new TextDecoder().decode(u);
}

function safeTradeFolder(id: string): string {
  return String(id || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  if (!dataUrl.startsWith("data:")) return null;
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const mime = m[1] || "application/octet-stream";
    const bin = atob(m[2]!);
    if (bin.length > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  } catch {
    return null;
  }
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "bin";
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(sub) as number[]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function tradeKey(t: JournalTrade): string {
  const tid = t.tradeId || t.id;
  const sid = t.sessionId || "";
  return `${sid}::${tid}`;
}

/** Strip embedded data URLs from trade for journal.json (paths live in attachments). */
function stripImages(t: JournalTrade): JournalTrade {
  const { closeScreenshot, entryScreenshot, ...rest } = t;
  return { ...rest } as JournalTrade;
}

/**
 * Build a portable ZIP backup from journal trades.
 * Images are written under attachments/trade_<id>/ as real bytes.
 */
export function buildJournalBackupZip(trades: JournalTrade[]): {
  bytes: Uint8Array;
  manifest: JournalBackupManifest;
  screenshotCount: number;
} {
  if (trades.length > MAX_TRADES) {
    throw new Error(`Too many trades to export (max ${MAX_TRADES})`);
  }
  const files: { name: string; data: Uint8Array }[] = [];
  const exportTrades: JournalTrade[] = [];
  let screenshotCount = 0;
  const sessionIds = new Set<string>();

  for (const raw of trades) {
    const t = normalizeJournalTrade(raw as JournalTrade & Record<string, unknown>);
    if (t.sessionId) sessionIds.add(t.sessionId);
    const folder = `attachments/trade_${safeTradeFolder(t.tradeId || t.id)}`;
    const out: JournalTrade = { ...stripImages(t) };

    if (t.entryScreenshot) {
      const parsed = parseDataUrl(t.entryScreenshot);
      if (parsed) {
        const name = `${folder}/entry.${extFromMime(parsed.mime)}`;
        files.push({ name, data: parsed.bytes });
        (out as Record<string, unknown>).entryScreenshotPath = name;
        screenshotCount++;
      }
    }
    if (t.closeScreenshot) {
      const parsed = parseDataUrl(t.closeScreenshot);
      if (parsed) {
        const name = `${folder}/close.${extFromMime(parsed.mime)}`;
        files.push({ name, data: parsed.bytes });
        (out as Record<string, unknown>).closeScreenshotPath = name;
        screenshotCount++;
      }
    }
    exportTrades.push(out);
  }

  const journalJson = JSON.stringify(
    { schema: "journal_trades", formatVersion: JOURNAL_BACKUP_FORMAT_VERSION, trades: exportTrades },
    null,
    2
  );
  const analyticsJson = JSON.stringify(
    {
      schema: "analytics_snapshot",
      note: "Analytics is derived from Journal; this is a summary only, not authoritative trade data.",
      tradeCount: exportTrades.length,
      sessionIds: [...sessionIds],
      exportedAt: new Date().toISOString(),
    },
    null,
    2
  );

  const manifest: JournalBackupManifest = {
    kind: JOURNAL_BACKUP_KIND,
    formatVersion: JOURNAL_BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    tradeCount: exportTrades.length,
    screenshotCount,
    sessionIds: [...sessionIds],
  };

  files.unshift(
    { name: "manifest.json", data: enc(JSON.stringify(manifest, null, 2)) },
    { name: "journal.json", data: enc(journalJson) },
    { name: "analytics.json", data: enc(analyticsJson) }
  );

  const bytes = writeZipStored(files);
  if (bytes.byteLength > MAX_ZIP_BYTES) {
    throw new Error(`Backup exceeds size limit (${MAX_ZIP_BYTES} bytes)`);
  }
  return { bytes, manifest, screenshotCount };
}

export function downloadJournalBackupZip(trades: JournalTrade[], filename?: string): void {
  const { bytes } = buildJournalBackupZip(trades);
  const name =
    filename ||
    `TradingReplay_Journal_Backup_${new Date().toISOString().slice(0, 10)}.zip`;
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function mimeFromPath(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/**
 * Parse and validate a journal backup ZIP (preview before import).
 */
export async function parseJournalBackupZip(buf: ArrayBuffer): Promise<JournalBackupPreview> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (buf.byteLength > MAX_ZIP_BYTES) {
    return {
      ok: false,
      errors: [`ZIP too large (${buf.byteLength} > ${MAX_ZIP_BYTES})`],
      warnings: [],
      manifest: null,
      trades: [],
      screenshotCount: 0,
      sessionIds: [],
      duplicateIdsInPackage: [],
    };
  }

  let entries: { name: string; data: Uint8Array }[];
  try {
    entries = await readZipEntries(buf);
  } catch (e) {
    return {
      ok: false,
      errors: [`Invalid ZIP: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
      manifest: null,
      trades: [],
      screenshotCount: 0,
      sessionIds: [],
      duplicateIdsInPackage: [],
    };
  }

  for (const e of entries) {
    if (e.name.includes("..") || e.name.startsWith("/")) {
      return {
        ok: false,
        errors: [`Unsafe path in ZIP: ${e.name}`],
        warnings: [],
        manifest: null,
        trades: [],
        screenshotCount: 0,
        sessionIds: [],
        duplicateIdsInPackage: [],
      };
    }
  }

  const byName = new Map(entries.map((e) => [e.name.replace(/^\/+/, ""), e.data]));
  const manRaw = byName.get("manifest.json");
  const journalRaw = byName.get("journal.json");
  if (!manRaw || !journalRaw) {
    return {
      ok: false,
      errors: ["Missing manifest.json or journal.json"],
      warnings: [],
      manifest: null,
      trades: [],
      screenshotCount: 0,
      sessionIds: [],
      duplicateIdsInPackage: [],
    };
  }

  let manifest: JournalBackupManifest;
  try {
    manifest = JSON.parse(dec(manRaw)) as JournalBackupManifest;
  } catch {
    return {
      ok: false,
      errors: ["manifest.json is not valid JSON"],
      warnings: [],
      manifest: null,
      trades: [],
      screenshotCount: 0,
      sessionIds: [],
      duplicateIdsInPackage: [],
    };
  }

  if (manifest.kind !== JOURNAL_BACKUP_KIND) {
    errors.push(`Unsupported backup kind: ${String(manifest.kind)}`);
  }
  if (typeof manifest.formatVersion !== "number" || manifest.formatVersion > JOURNAL_BACKUP_FORMAT_VERSION) {
    errors.push(`Unsupported formatVersion: ${String(manifest.formatVersion)}`);
  }

  let journalObj: { trades?: unknown[] };
  try {
    journalObj = JSON.parse(dec(journalRaw));
  } catch {
    return {
      ok: false,
      errors: ["journal.json is not valid JSON"],
      warnings: [],
      manifest,
      trades: [],
      screenshotCount: 0,
      sessionIds: [],
      duplicateIdsInPackage: [],
    };
  }

  if (!Array.isArray(journalObj.trades)) {
    errors.push("journal.json missing trades array");
    return {
      ok: false,
      errors,
      warnings,
      manifest,
      trades: [],
      screenshotCount: 0,
      sessionIds: [],
      duplicateIdsInPackage: [],
    };
  }

  if (journalObj.trades.length > MAX_TRADES) {
    errors.push(`Too many trades in package`);
  }

  const trades: JournalTrade[] = [];
  const seen = new Map<string, number>();
  const duplicateIdsInPackage: string[] = [];
  let screenshotCount = 0;

  for (const raw of journalObj.trades) {
    if (!raw || typeof raw !== "object") {
      warnings.push("Skipped non-object trade row");
      continue;
    }
    const rec = raw as Record<string, unknown>;
    const entryPath = typeof rec.entryScreenshotPath === "string" ? rec.entryScreenshotPath : null;
    const closePath = typeof rec.closeScreenshotPath === "string" ? rec.closeScreenshotPath : null;
    delete rec.entryScreenshotPath;
    delete rec.closeScreenshotPath;

    let entryScreenshot: string | undefined;
    let closeScreenshot: string | undefined;

    if (entryPath) {
      if (entryPath.includes("..")) {
        errors.push(`Unsafe entryScreenshotPath: ${entryPath}`);
        continue;
      }
      const bytes = byName.get(entryPath.replace(/^\/+/, ""));
      if (!bytes) {
        warnings.push(`Missing attachment ${entryPath}`);
      } else if (bytes.byteLength > MAX_IMAGE_BYTES) {
        warnings.push(`Attachment too large: ${entryPath}`);
      } else {
        entryScreenshot = toDataUrl(mimeFromPath(entryPath), bytes);
        screenshotCount++;
      }
    } else if (typeof rec.entryScreenshot === "string" && rec.entryScreenshot.startsWith("data:")) {
      entryScreenshot = rec.entryScreenshot;
      screenshotCount++;
    }

    if (closePath) {
      if (closePath.includes("..")) {
        errors.push(`Unsafe closeScreenshotPath: ${closePath}`);
        continue;
      }
      const bytes = byName.get(closePath.replace(/^\/+/, ""));
      if (!bytes) {
        warnings.push(`Missing attachment ${closePath}`);
      } else if (bytes.byteLength > MAX_IMAGE_BYTES) {
        warnings.push(`Attachment too large: ${closePath}`);
      } else {
        closeScreenshot = toDataUrl(mimeFromPath(closePath), bytes);
        screenshotCount++;
      }
    } else if (typeof rec.closeScreenshot === "string" && rec.closeScreenshot.startsWith("data:")) {
      closeScreenshot = rec.closeScreenshot;
      screenshotCount++;
    }

    const trade = normalizeJournalTrade({
      ...rec,
      entryScreenshot,
      closeScreenshot,
    } as JournalTrade & Record<string, unknown>);

    const k = tradeKey(trade);
    if (seen.has(k)) {
      duplicateIdsInPackage.push(k);
      warnings.push(`Duplicate trade in package: ${k}`);
      continue;
    }
    seen.set(k, 1);
    trades.push(trade);
  }

  const sessionIds = [
    ...new Set(trades.map((t) => t.sessionId).filter(Boolean) as string[]),
  ];

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    trades,
    screenshotCount,
    sessionIds,
    duplicateIdsInPackage,
  };
}

/**
 * Import a validated backup into a target session store.
 * MERGE: skip existing keys (sessionId::tradeId).
 * REPLACE: replace only trades whose sessionId is in the backup's session set
 *          (or all trades of targetSessionId if backup has no session ids and scope is current).
 */
export async function importJournalBackup(
  preview: JournalBackupPreview,
  mode: ImportMode,
  targetSessionId: string | null
): Promise<JournalImportResult> {
  const errors = [...preview.errors];
  const warnings = [...preview.warnings];
  if (!preview.ok || errors.length) {
    return {
      ok: false,
      mode,
      imported: 0,
      skipped: 0,
      replaced: 0,
      totalAfter: 0,
      errors: errors.length ? errors : ["Invalid backup"],
      warnings,
    };
  }

  const sid = targetSessionId;
  const existing = await loadJournalForSession(sid);
  const existingKeys = new Set(existing.map(tradeKey));

  if (mode === "merge") {
    const toAdd: JournalTrade[] = [];
    let skipped = 0;
    for (const t of preview.trades) {
      // Preserve original sessionId; do not silently rebind to active session.
      const row = normalizeJournalTrade({
        ...t,
        // Keep source sessionId; if missing, leave undefined (not forced to active).
      } as JournalTrade & Record<string, unknown>);
      const k = tradeKey(row);
      if (existingKeys.has(k) || existing.some((e) => e.id === row.id || e.tradeId === row.tradeId)) {
        skipped++;
        continue;
      }
      toAdd.push(row);
      existingKeys.add(k);
    }
    const next = [...toAdd, ...existing];
    await saveJournalForSession(sid, next);
    return {
      ok: true,
      mode,
      imported: toAdd.length,
      skipped,
      replaced: 0,
      totalAfter: next.length,
      errors: [],
      warnings,
    };
  }

  // REPLACE: only within sessions represented in the backup (or current session if backup has none)
  const scopeSessions = new Set(
    preview.sessionIds.length
      ? preview.sessionIds
      : sid
        ? [sid]
        : []
  );
  if (!scopeSessions.size && sid) scopeSessions.add(sid);

  const kept = existing.filter((t) => {
    const s = t.sessionId || sid || "";
    return !scopeSessions.has(s);
  });

  const incoming: JournalTrade[] = [];
  const seen = new Set<string>();
  for (const t of preview.trades) {
    const row = normalizeJournalTrade(t as JournalTrade & Record<string, unknown>);
    const k = tradeKey(row);
    if (seen.has(k)) continue;
    seen.add(k);
    incoming.push(row);
  }

  const next = [...incoming, ...kept];
  await saveJournalForSession(sid, next);
  return {
    ok: true,
    mode,
    imported: incoming.length,
    skipped: 0,
    replaced: existing.length - kept.length,
    totalAfter: next.length,
    errors: [],
    warnings,
  };
}

/** Analytics JSON export (filtered trades) — not a full journal backup. */
export function exportAnalyticsJson(trades: JournalTrade[]): string {
  return JSON.stringify(
    {
      schema: "analytics_report",
      note: "Derived from Journal; import of this file does not restore screenshots. Use Journal ZIP backup for full restore.",
      exportedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      tradeCount: trades.length,
      trades: trades.map((t) => {
        const { entryScreenshot, closeScreenshot, ...rest } = t;
        return rest;
      }),
    },
    null,
    2
  );
}

export function downloadAnalyticsJson(trades: JournalTrade[], filename = "analytics-report.json"): void {
  const blob = new Blob([exportAnalyticsJson(trades)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
