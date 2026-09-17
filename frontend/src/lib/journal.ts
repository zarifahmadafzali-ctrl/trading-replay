import { getSessionStorageAdapter } from "./storageAdapter";

import type { TradeRiskSnapshot } from "./riskModel";

export type CloseReason = "sl" | "tp" | "manual";

/**
 * Professional automated Journal trade record (v3.19.0).
 * Created only after a real position is filled and later closed.
 * Historical fields are frozen at fill/close — never rewritten from current account settings.
 */
export type JournalTrade = {
  id: string;
  symbol: string;
  side: "long" | "short";
  orderType: string;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  entryTime: number;
  exitTime: number;
  reason: CloseReason;
  pnlPoints: number;
  rMultiple: number | null;
  note?: string;
  sessionId?: string;

  accountId?: string;
  balanceBefore?: number;
  equityBefore?: number;
  freeMarginBefore?: number;
  leverage?: number;
  riskPercent?: number;
  riskAmount?: number;
  riskBasedLot?: number | null;
  marginMaxLot?: number | null;
  finalLot?: number | null;
  actualRiskAmount?: number | null;
  actualRiskPercent?: number | null;
  slDistance?: number;
  tpDistance?: number | null;
  durationSeconds?: number;
  snapshot?: TradeRiskSnapshot;
  closeScreenshot?: string;

  /** v3.19.0 extensions (optional for legacy rows) */
  tradeId?: string;
  currencyPnL?: number | null;
  balanceAfter?: number | null;
  rewardAmount?: number | null;
  rewardPercent?: number | null;
  targetRiskPercent?: number | null;
  marginUsed?: number | null;
  pointValue?: number | null;
  fillStatus?: "filled" | "closed";
  entrySource?: string;
  accountType?: "personal" | "prop";
  propFirmName?: string;
  propProgramName?: string;
  propPhaseId?: string;
  propPhaseName?: string;
  createdAt?: number;
};

const LEGACY_KEY = "tr-trade-journal-v1";
const JOURNAL_AUDIT_KEY = "tr-journal-audit-v1";

/** Fired after journal mutate so Analytics/Journal can reload (v3.24.0). */
export const JOURNAL_CHANGED_EVENT = "tr-journal-changed";

export function emitJournalChanged(sessionId?: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(JOURNAL_CHANGED_EVENT, { detail: { sessionId: sessionId ?? null } })
  );
}

/** Lightweight audit trail (dev / diagnostics). Caps size. */
export function auditJournalEvent(event: string, detail?: Record<string, unknown>) {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(JOURNAL_AUDIT_KEY);
    const prev: unknown[] = raw ? JSON.parse(raw) : [];
    const arr = Array.isArray(prev) ? prev : [];
    arr.push({ t: Date.now(), event, ...detail });
    localStorage.setItem(JOURNAL_AUDIT_KEY, JSON.stringify(arr.slice(-80)));
  } catch {
    /* */
  }
}

export function normalizeJournalTrade(raw: Partial<JournalTrade> & Record<string, unknown>): JournalTrade {
  const id = String(raw.id || raw.tradeId || `legacy-${Math.random().toString(36).slice(2, 9)}`);
  const side = raw.side === "short" ? "short" : "long";
  const reason: CloseReason =
    raw.reason === "sl" || raw.reason === "tp" || raw.reason === "manual" ? raw.reason : "manual";
  return {
    id,
    tradeId: (raw.tradeId as string) || id,
    symbol: String(raw.symbol || ""),
    side,
    orderType: String(raw.orderType || "market"),
    entryPrice: Number(raw.entryPrice) || 0,
    exitPrice: Number(raw.exitPrice) || 0,
    stopPrice: Number(raw.stopPrice) || 0,
    takeProfitPrice: Number(raw.takeProfitPrice) || 0,
    entryTime: Number(raw.entryTime) || 0,
    exitTime: Number(raw.exitTime) || 0,
    reason,
    pnlPoints: Number(raw.pnlPoints) || 0,
    rMultiple: raw.rMultiple != null && Number.isFinite(Number(raw.rMultiple)) ? Number(raw.rMultiple) : null,
    note: raw.note as string | undefined,
    sessionId: raw.sessionId as string | undefined,
    accountId: raw.accountId as string | undefined,
    balanceBefore: numOrUndef(raw.balanceBefore),
    equityBefore: numOrUndef(raw.equityBefore),
    freeMarginBefore: numOrUndef(raw.freeMarginBefore),
    leverage: numOrUndef(raw.leverage),
    riskPercent: numOrUndef(raw.riskPercent),
    riskAmount: numOrUndef(raw.riskAmount),
    riskBasedLot: numOrNull(raw.riskBasedLot),
    marginMaxLot: numOrNull(raw.marginMaxLot),
    finalLot: numOrNull(raw.finalLot),
    actualRiskAmount: numOrNull(raw.actualRiskAmount),
    actualRiskPercent: numOrNull(raw.actualRiskPercent),
    slDistance: numOrUndef(raw.slDistance),
    tpDistance: numOrNull(raw.tpDistance),
    durationSeconds: numOrUndef(raw.durationSeconds),
    snapshot: raw.snapshot as TradeRiskSnapshot | undefined,
    closeScreenshot: raw.closeScreenshot as string | undefined,
    currencyPnL: numOrNull(raw.currencyPnL),
    balanceAfter: numOrNull(raw.balanceAfter),
    rewardAmount: numOrNull(raw.rewardAmount),
    rewardPercent: numOrNull(raw.rewardPercent),
    targetRiskPercent: numOrNull(raw.targetRiskPercent),
    marginUsed: numOrNull(raw.marginUsed),
    pointValue: numOrNull(raw.pointValue),
    fillStatus: raw.fillStatus === "filled" || raw.fillStatus === "closed" ? raw.fillStatus : "closed",
    entrySource: raw.entrySource as string | undefined,
    accountType: raw.accountType === "prop" || raw.accountType === "personal" ? raw.accountType : undefined,
    propFirmName: raw.propFirmName as string | undefined,
    propProgramName: raw.propProgramName as string | undefined,
    propPhaseId: raw.propPhaseId as string | undefined,
    propPhaseName: raw.propPhaseName as string | undefined,
    createdAt: numOrUndef(raw.createdAt) ?? Date.now(),
  };
}

function numOrUndef(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function numOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function loadJournalForSession(sessionId: string | null): Promise<JournalTrade[]> {
  if (!sessionId) {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map((t) => normalizeJournalTrade(t)) : [];
    } catch {
      return [];
    }
  }
  const adapter = getSessionStorageAdapter();
  const rows = await adapter.getTrades(sessionId);
  return (rows || []).map((t: any) => normalizeJournalTrade(t));
}

export async function saveJournalForSession(sessionId: string | null, trades: JournalTrade[]) {
  if (!sessionId) {
    try {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(trades.slice(0, 500)));
      emitJournalChanged(null);
    } catch {
      /* */
    }
    return;
  }
  await getSessionStorageAdapter().putTrades(sessionId, trades);
  emitJournalChanged(sessionId);
}

/**
 * Append a closed trade once. Idempotent on trade.id / tradeId.
 * Pending orders that never fill never call this.
 */
export async function appendTradeAsync(trade: JournalTrade): Promise<JournalTrade[]> {
  const sessionId = trade.sessionId || getSessionStorageAdapter().getActiveSessionId();
  const normalized = normalizeJournalTrade({
    ...trade,
    sessionId: sessionId || undefined,
    tradeId: trade.tradeId || trade.id,
    createdAt: trade.createdAt ?? Date.now(),
    fillStatus: "closed",
  });
  const prev = await loadJournalForSession(sessionId);
  const key = normalized.tradeId || normalized.id;
  if (prev.some((t) => t.id === key || t.tradeId === key || t.id === normalized.id)) {
    auditJournalEvent("journal_skip_duplicate", { id: key, sessionId });
    return prev;
  }
  const next = [normalized, ...prev].slice(0, 500);
  await saveJournalForSession(sessionId, next);
  auditJournalEvent("journal_persisted", {
    id: key,
    sessionId,
    reason: normalized.reason,
    side: normalized.side,
    currencyPnL: normalized.currencyPnL,
  });
  return next;
}

export function appendTrade(trade: JournalTrade): JournalTrade[] {
  void appendTradeAsync(trade);
  return [normalizeJournalTrade(trade)];
}


/**
 * Remove one historical Journal trade by id/tradeId.
 * Does NOT reverse AccountProfile.balance or Prop lifecycle events
 * (those are independent working state; use Prop reconciliation if needed).
 * Analytics is derived from remaining Journal rows after delete.
 */
export async function deleteJournalTrade(
  tradeIdOrId: string,
  sessionId?: string | null
): Promise<JournalTrade[]> {
  const sid = sessionId !== undefined ? sessionId : getSessionStorageAdapter().getActiveSessionId();
  const prev = await loadJournalForSession(sid);
  const next = prev.filter(
    (t) => t.id !== tradeIdOrId && t.tradeId !== tradeIdOrId
  );
  if (next.length === prev.length) {
    auditJournalEvent("journal_delete_miss", { id: tradeIdOrId, sessionId: sid });
    return prev;
  }
  await saveJournalForSession(sid, next);
  auditJournalEvent("journal_deleted", {
    id: tradeIdOrId,
    sessionId: sid,
    remaining: next.length,
  });
  return next;
}

export function clearJournal() {
  const sessionId = getSessionStorageAdapter().getActiveSessionId();
  void saveJournalForSession(sessionId, []);
  auditJournalEvent("journal_cleared", { sessionId });
}

export function rMultiple(
  side: "long" | "short",
  entry: number,
  stop: number,
  exit: number
): number | null {
  const risk = Math.abs(entry - stop);
  if (risk < 1e-12) return null;
  const pnl = side === "long" ? exit - entry : entry - exit;
  return pnl / risk;
}

export function loadJournal(): JournalTrade[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((t) => normalizeJournalTrade(t)) : [];
  } catch {
    return [];
  }
}

/** Derive currency PnL preference: explicit → r*risk → null (never invent). */
export function resolveCurrencyPnL(t: JournalTrade): number | null {
  if (t.currencyPnL != null && Number.isFinite(t.currencyPnL)) return t.currencyPnL;
  if (
    t.rMultiple != null &&
    Number.isFinite(t.rMultiple) &&
    t.actualRiskAmount != null &&
    Number.isFinite(t.actualRiskAmount)
  ) {
    return t.rMultiple * t.actualRiskAmount;
  }
  return null;
}


/** CSV export of canonical Journal rows (no market data). */
export function exportJournalCsv(trades: JournalTrade[]): string {
  const headers = [
    "id",
    "tradeId",
    "sessionId",
    "accountId",
    "symbol",
    "side",
    "orderType",
    "entryTime",
    "entryPrice",
    "exitTime",
    "exitPrice",
    "reason",
    "stopLoss",
    "takeProfit",
    "pnlPoints",
    "currencyPnL",
    "rMultiple",
    "riskPercent",
    "actualRiskAmount",
    "finalLot",
    "durationSeconds",
    "balanceBefore",
    "balanceAfter",
  ];
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const t of trades) {
    lines.push(
      [
        t.id,
        t.tradeId || t.id,
        t.sessionId || "",
        t.accountId || "",
        t.symbol,
        t.side,
        t.orderType,
        t.entryTime,
        t.entryPrice,
        t.exitTime,
        t.exitPrice,
        t.reason,
        t.stopPrice,
        t.takeProfitPrice,
        t.pnlPoints,
        t.currencyPnL ?? "",
        t.rMultiple ?? "",
        t.riskPercent ?? "",
        t.actualRiskAmount ?? t.riskAmount ?? "",
        t.finalLot ?? "",
        t.durationSeconds ?? "",
        t.balanceBefore ?? "",
        t.balanceAfter ?? "",
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function downloadJournalCsv(trades: JournalTrade[], filename = "journal-export.csv"): void {
  const csv = exportJournalCsv(trades);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
