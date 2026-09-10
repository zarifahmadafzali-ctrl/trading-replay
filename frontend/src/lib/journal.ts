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
  /** Absolute price points (exit - entry for long, entry - exit for short) */
  pnlPoints: number;
  rMultiple: number | null;
  note?: string;
};

const KEY = "tr-trade-journal-v1";

export function loadJournal(): JournalTrade[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveJournal(trades: JournalTrade[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(trades.slice(0, 500)));
  } catch {
    /* quota */
  }
}

export function appendTrade(trade: JournalTrade): JournalTrade[] {
  const next = [trade, ...loadJournal()].slice(0, 500);
  saveJournal(next);
  return next;
}

export function clearJournal() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* */
  }
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
