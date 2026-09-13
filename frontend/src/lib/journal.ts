import { getActiveSessionId, getSessionTrades, putSessionTrades } from "./sessionStore";

export type CloseReason = "sl" | "tp" | "manual";

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
};

const LEGACY_KEY = "tr-trade-journal-v1";

export async function loadJournalForSession(sessionId: string | null): Promise<JournalTrade[]> {
  if (!sessionId) {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return getSessionTrades(sessionId);
}

export async function saveJournalForSession(sessionId: string | null, trades: JournalTrade[]) {
  if (!sessionId) {
    try {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(trades.slice(0, 500)));
    } catch {
      /* */
    }
    return;
  }
  await putSessionTrades(sessionId, trades);
}

export function appendTrade(trade: JournalTrade): JournalTrade[] {
  const sessionId = trade.sessionId || getActiveSessionId();
  void (async () => {
    const prev = await loadJournalForSession(sessionId);
    const next = [{ ...trade, sessionId: sessionId || undefined }, ...prev].slice(0, 500);
    await saveJournalForSession(sessionId, next);
  })();
  return [trade];
}

export async function appendTradeAsync(trade: JournalTrade): Promise<JournalTrade[]> {
  const sessionId = trade.sessionId || getActiveSessionId();
  const prev = await loadJournalForSession(sessionId);
  const next = [{ ...trade, sessionId: sessionId || undefined }, ...prev].slice(0, 500);
  await saveJournalForSession(sessionId, next);
  return next;
}

export function clearJournal() {
  const sessionId = getActiveSessionId();
  void saveJournalForSession(sessionId, []);
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
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
