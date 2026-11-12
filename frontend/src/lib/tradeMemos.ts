/**
 * C8.2 — Optional trade memos (entry/exit/post_analysis/general).
 * Stored on JournalTrade.memos[]; never alters execution or P&L fields.
 */

import type { JournalTrade } from "./journal";
import { loadJournalForSession, normalizeJournalTrade, saveJournalForSession } from "./journal";
import { APP_VERSION } from "./storageVersions";
import { writeZipStored, readZipEntries } from "./zipStore";

export type TradeMemoType = "entry" | "exit" | "post_analysis" | "general";

export type TradeMemo = {
  id: string;
  tradeId: string;
  type: TradeMemoType;
  /** Optional short title / tag shown above the body. */
  title?: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
};

export function newMemoId(): string {
  return `memo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTradeMemo(raw: unknown, fallbackTradeId?: string): TradeMemo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  const titleRaw = typeof o.title === "string" ? o.title.trim() : "";
  // Need at least a title tag or body text
  if (!text && !titleRaw) return null;
  const type = o.type;
  const t: TradeMemoType =
    type === "entry" || type === "exit" || type === "post_analysis" || type === "general"
      ? type
      : "general";
  const tradeId = String(o.tradeId || fallbackTradeId || "");
  if (!tradeId) return null;
  const createdAt =
    typeof o.createdAt === "string" && o.createdAt
      ? o.createdAt
      : new Date().toISOString();
  return {
    id: String(o.id || newMemoId()),
    tradeId,
    type: t,
    ...(titleRaw ? { title: titleRaw } : {}),
    text: text || titleRaw,
    createdAt,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

export function normalizeMemos(raw: unknown, tradeId?: string): TradeMemo[] {
  if (!Array.isArray(raw)) return [];
  const out: TradeMemo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const m = normalizeTradeMemo(item, tradeId);
    if (!m) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export function memosOfType(memos: TradeMemo[] | undefined, type: TradeMemoType): TradeMemo[] {
  return (memos || []).filter((m) => m.type === type);
}

export function createMemo(
  tradeId: string,
  type: TradeMemoType,
  text: string,
  title?: string
): TradeMemo | null {
  const trimmed = (text || "").trim();
  const titleTrim = (title || "").trim();
  if (!trimmed && !titleTrim) return null;
  return {
    id: newMemoId(),
    tradeId,
    type,
    ...(titleTrim ? { title: titleTrim } : {}),
    text: trimmed || titleTrim,
    createdAt: new Date().toISOString(),
  };
}

/** Merge memos by id; never wipe unrelated memos. */
export function mergeMemos(existing: TradeMemo[], incoming: TradeMemo[]): TradeMemo[] {
  const map = new Map<string, TradeMemo>();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) {
    const prev = map.get(m.id);
    if (prev) {
      map.set(m.id, {
        ...prev,
        ...m,
        createdAt: prev.createdAt,
        updatedAt: m.updatedAt || m.createdAt,
      });
    } else {
      map.set(m.id, m);
    }
  }
  return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Attach or update memos on an existing journal trade without changing execution fields.
 */
export async function patchTradeMemos(
  sessionId: string | null,
  tradeIdOrId: string,
  mutator: (prev: TradeMemo[]) => TradeMemo[]
): Promise<JournalTrade | null> {
  const trades = await loadJournalForSession(sessionId);
  const idx = trades.findIndex(
    (t) => t.id === tradeIdOrId || t.tradeId === tradeIdOrId
  );
  if (idx < 0) return null;
  const t = trades[idx]!;
  const prev = normalizeMemos(t.memos, t.tradeId || t.id);
  const nextMemos = mutator(prev);
  const updated = normalizeJournalTrade({
    ...t,
    memos: nextMemos,
  } as JournalTrade & Record<string, unknown>);
  const next = trades.slice();
  next[idx] = updated;
  await saveJournalForSession(sessionId, next);
  return updated;
}

export async function addMemoToTrade(
  sessionId: string | null,
  tradeIdOrId: string,
  type: TradeMemoType,
  text: string,
  title?: string
): Promise<JournalTrade | null> {
  const memo = createMemo(tradeIdOrId, type, text, title);
  if (!memo) return null;
  return patchTradeMemos(sessionId, tradeIdOrId, (prev) => mergeMemos(prev, [memo]));
}

export async function updateMemoText(
  sessionId: string | null,
  tradeIdOrId: string,
  memoId: string,
  text: string
): Promise<JournalTrade | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return patchTradeMemos(sessionId, tradeIdOrId, (prev) =>
    prev.map((m) =>
      m.id === memoId
        ? { ...m, text: trimmed, updatedAt: new Date().toISOString() }
        : m
    )
  );
}

export async function deleteMemoFromTrade(
  sessionId: string | null,
  tradeIdOrId: string,
  memoId: string
): Promise<JournalTrade | null> {
  return patchTradeMemos(sessionId, tradeIdOrId, (prev) =>
    prev.filter((m) => m.id !== memoId)
  );
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (!dataUrl?.startsWith("data:")) return null;
  const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]!);
    if (bin.length > 8 * 1024 * 1024) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime: m[1] || "image/png", bytes };
  } catch {
    return null;
  }
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "png";
}

function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function buildNotesMarkdown(trades: JournalTrade[]): string {
  const lines: string[] = ["# AI Review Package — Trade Notes", ""];
  for (const t of trades) {
    const memos = normalizeMemos(t.memos, t.tradeId || t.id);
    const entry = memosOfType(memos, "entry");
    const exit = memosOfType(memos, "exit");
    const post = memosOfType(memos, "post_analysis");
    const other = memosOfType(memos, "general");
    lines.push(`## Trade ${t.tradeId || t.id}`);
    lines.push("");
    lines.push(`- Symbol: ${t.symbol}`);
    lines.push(`- Side: ${t.side}`);
    lines.push(`- Session: ${t.sessionId || "—"}`);
    lines.push(`- Entry: ${t.entryPrice} @ ${t.entryTime}`);
    lines.push(`- Exit: ${t.exitPrice} @ ${t.exitTime}`);
    lines.push(`- Exit Type: ${t.reason}`);
    lines.push(`- Actual P&L: ${t.currencyPnL ?? t.pnlPoints}`);
    lines.push(`- Actual R: ${t.rMultiple ?? "—"}`);
    lines.push(
      `- Actual Risk: ${t.actualRiskAmount ?? t.riskAmount ?? "—"} (${t.actualRiskPercent ?? t.riskPercent ?? "—"}%)`
    );
    lines.push("");
    lines.push("### Entry Memo");
    lines.push(entry.length ? entry.map((m) => (m.title ? `**${m.title}**\n${m.text}` : m.text)).join("\n\n") : "_No entry memo_");
    lines.push("");
    lines.push("### Exit Memo");
    lines.push(exit.length ? exit.map((m) => (m.title ? `**${m.title}**\n${m.text}` : m.text)).join("\n\n") : "_No exit memo_");
    lines.push("");
    lines.push("### Post Analysis");
    lines.push(post.length ? post.map((m) => m.text).join("\n\n") : "_None_");
    lines.push("");
    lines.push("### Other Notes");
    lines.push(other.length ? other.map((m) => m.text).join("\n\n") : "_None_");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * AI Review Package ZIP — trades + memos + screenshots, no market data.
 */
export function buildAiReviewPackageZip(trades: JournalTrade[]): Uint8Array {
  const enc = new TextEncoder();
  const files: { name: string; data: Uint8Array }[] = [];
  let memoCount = 0;
  let attachmentCount = 0;
  const exportTrades = trades.map((t) => {
    const memos = normalizeMemos(t.memos, t.tradeId || t.id);
    memoCount += memos.length;
    const tid = safeId(t.tradeId || t.id);
    const { entryScreenshot, closeScreenshot, ...rest } = t;
    if (entryScreenshot) {
      const parsed = parseDataUrl(entryScreenshot);
      if (parsed) {
        const name = `attachments/entry/${tid}.${extFromMime(parsed.mime)}`;
        files.push({ name, data: parsed.bytes });
        attachmentCount++;
        (rest as Record<string, unknown>).entryScreenshotPath = name;
      }
    }
    if (closeScreenshot) {
      const parsed = parseDataUrl(closeScreenshot);
      if (parsed) {
        const name = `attachments/exit/${tid}.${extFromMime(parsed.mime)}`;
        files.push({ name, data: parsed.bytes });
        attachmentCount++;
        (rest as Record<string, unknown>).closeScreenshotPath = name;
      }
    }
    return { ...rest, memos };
  });

  const times = trades.map((t) => t.exitTime).filter((x) => Number.isFinite(x));
  const manifest = {
    kind: "trading-replay-ai-review",
    formatVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    tradeCount: exportTrades.length,
    memoCount,
    attachmentCount,
    dateRange:
      times.length > 0
        ? { from: Math.min(...times), to: Math.max(...times) }
        : null,
  };

  files.unshift(
    { name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: "trades.json", data: enc.encode(JSON.stringify({ trades: exportTrades }, null, 2)) },
    { name: "notes.md", data: enc.encode(buildNotesMarkdown(trades)) }
  );

  return writeZipStored(files);
}

export function downloadAiReviewPackage(trades: JournalTrade[], filename?: string): void {
  const bytes = buildAiReviewPackageZip(trades);
  const name =
    filename || `AI-Review-Package_${new Date().toISOString().slice(0, 10)}.zip`;
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
