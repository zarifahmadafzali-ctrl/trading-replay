export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type WatchlistItem = {
  symbol: string;
  note: string;
};

export type ReplaySession = {
  name: string;
  symbol: string;
  timeframe_seconds: number;
  cursor: number;
  speed: number;
  notes: string;
};

export type ViewName = "replay" | "watchlist" | "session" | "dataEngine" | "journal";

export const TIMEFRAMES: { label: string; seconds: number }[] = [
  { label: "1s", seconds: 1 },
  { label: "2s", seconds: 2 },
  { label: "5s", seconds: 5 },
  { label: "10s", seconds: 10 },
  { label: "15s", seconds: 15 },
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1H", seconds: 3600 },
  { label: "4H", seconds: 14400 },
  { label: "1D", seconds: 86400 },
];

export const SYMBOLS = ["US30", "EURUSD", "XAUUSD", "BTCUSD"];


export function formatTf(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = seconds / 60;
    return Number.isInteger(m) ? `${m}m` : `${seconds}s`;
  }
  if (seconds < 86400) {
    const h = seconds / 3600;
    return Number.isInteger(h) ? `${h}H` : `${Math.round(seconds / 60)}m`;
  }
  const d = seconds / 86400;
  return Number.isInteger(d) ? `${d}D` : `${Math.round(seconds / 3600)}H`;
}
