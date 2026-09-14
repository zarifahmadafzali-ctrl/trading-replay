import type { Bar, ReplaySession, WatchlistItem } from "./types";

// In dev, Vite proxies /api and /health to the FastAPI backend (see vite.config.ts).
// In production, set VITE_API_BASE to the deployed backend URL.
const BASE = (import.meta as any).env?.VITE_API_BASE ?? "";

export type RequestOptions = RequestInit & {
  /** Abort after this many ms (default 120_000 for long sync). */
  timeoutMs?: number;
  /** Extra retries for transient failures (default 0). */
  retries?: number;
  onRetry?: (attempt: number, err: unknown) => void;
};

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /signal is aborted|aborted without reason|The operation was aborted/i.test(msg);
}

function isTransient(status: number | undefined, err: unknown): boolean {
  if (status === 502 || status === 503 || status === 504 || status === 408) return true;
  if (isAbortError(err)) return true;
  if (err instanceof TypeError) return true; // network
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|network|timeout|abort/i.test(msg)) return true;
  return false;
}

/** Cold-start only — never AbortError / 409 (unsafe for long-running Sync POST). */
function isSyncTransportTransient(status: number | undefined, _err: unknown): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** Client timed out while backend may still be processing Sync. */
export class SyncClientAbortError extends Error {
  readonly code = "SYNC_CLIENT_ABORT" as const;
  constructor(message = "Sync request timed out or was aborted; server may still be processing") {
    super(message);
    this.name = "SyncClientAbortError";
  }
}

/** Backend _sync_lock held — another sync is in progress. */
export class SyncConflictError extends Error {
  readonly code = "SYNC_CONFLICT" as const;
  readonly status = 409;
  constructor(message = "Another sync is already running") {
    super(message);
    this.name = "SyncConflictError";
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Fetch with optional timeout + bounded exponential backoff retries. */
export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 60_000;
  const retries = init?.retries ?? 0;
  const { timeoutMs: _t, retries: _r, onRetry, ...rest } = init || {};

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...rest,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`${res.status} ${res.statusText}: ${text}`);
        (err as any).status = res.status;
        if (attempt < retries && isTransient(res.status, err)) {
          onRetry?.(attempt + 1, err);
          await sleep(Math.min(8000, 600 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const status = (err as any)?.status as number | undefined;
      if (attempt < retries && isTransient(status, err)) {
        onRetry?.(attempt + 1, err);
        await sleep(Math.min(8000, 600 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function checkHealth(): Promise<boolean> {
  try {
    const r = await request<{ ok: boolean }>("/health", { timeoutMs: 15_000, retries: 2 });
    return r.ok === true;
  } catch {
    return false;
  }
}

export async function fetchBars(symbol: string, seconds: number, start?: string, end?: string) {
  return request<{ symbol: string; source: string; seconds: number; bars: Bar[] }>(
    `/api/bars?symbol=${encodeURIComponent(symbol)}&seconds=${seconds}&start=${encodeURIComponent(start ?? "")}&end=${encodeURIComponent(end ?? "")}`,
    { timeoutMs: 90_000, retries: 2 }
  );
}

export type SyncReport = {
  ok: boolean;
  symbol: string;
  start?: string;
  end?: string;
  days: number;
  ticks: number;
  seconds: number;
  files_ok: number;
  files_missing: number;
  files_failed: number;
  errors: string[];
  day_results?: Array<{
    date: string;
    status: string;
    ticks?: number | null;
    bars1s?: number;
    successfulHours?: number;
    failedHours?: number;
    note?: string;
  }>;
  skipped_verified?: string[];
  backend_verified?: boolean;
  success_days?: string[];
  expected_empty_days?: string[];
  failed_days?: string[];
  missing_days?: string[];
  log?: string[];
};

/**
 * Long-running sequential Dukascopy sync (Design A: single HTTP POST).
 *
 * - AbortError / client timeout: NO automatic re-POST (backend may still hold the lock).
 * - HTTP 409: NO automatic re-POST (another sync is running).
 * - 502/503/504 only: bounded cold-start retry before work is assumed started.
 */
export async function syncDukascopy(
  symbol: string,
  start: string,
  end: string,
  opts?: { onRetry?: (attempt: number, err: unknown) => void }
): Promise<SyncReport> {
  const path =
    `/api/dukascopy/sync?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`;
  const timeoutMs = 240_000;
  const coldStartRetries = 1; // only 502/503/504
  let lastErr: unknown;

  for (let attempt = 0; attempt <= coldStartRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 409) {
        const text = await res.text().catch(() => "");
        throw new SyncConflictError(text || "Another sync is already running");
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`${res.status} ${res.statusText}: ${text}`);
        (err as any).status = res.status;
        if (attempt < coldStartRetries && isSyncTransportTransient(res.status, err)) {
          opts?.onRetry?.(attempt + 1, err);
          await sleep(Math.min(8000, 600 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      return (await res.json()) as SyncReport;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof SyncConflictError) throw err;
      if (isAbortError(err)) {
        throw new SyncClientAbortError();
      }
      lastErr = err;
      const status = (err as any)?.status as number | undefined;
      if (attempt < coldStartRetries && isSyncTransportTransient(status, err)) {
        opts?.onRetry?.(attempt + 1, err);
        await sleep(Math.min(8000, 600 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchCapability() {
  return request<{ true_1s: boolean; base_resolution: string; derived: string[]; warning: string }>(
    "/api/data/capability",
    { timeoutMs: 20_000, retries: 1 }
  );
}

export type DataStatus = {
  symbol: string;
  start?: string;
  end?: string;
  has_1s_cache: boolean;
  backend_verified?: boolean;
  usable_bars?: number;
  success_days?: string[];
  expected_empty_days?: string[];
  failed_days?: string[];
  cached_days?: string[];
  missing_days?: string[];
  day_details?: Array<Record<string, unknown>>;
  note: string;
};

export async function fetchDataStatus(symbol: string, start: string, end: string) {
  return request<DataStatus>(
    `/api/data/status?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`,
    { timeoutMs: 30_000, retries: 1 }
  );
}

export async function fetchWatchlist() {
  return request<{ items: WatchlistItem[] }>("/api/watchlist");
}

export async function addWatchlistItem(item: WatchlistItem) {
  return request<{ ok: boolean; items: WatchlistItem[] }>("/api/watchlist", {
    method: "POST",
    body: JSON.stringify(item),
  });
}

export async function removeWatchlistItem(symbol: string) {
  return request<{ ok: boolean; items: WatchlistItem[] }>(
    `/api/watchlist/${encodeURIComponent(symbol)}`,
    { method: "DELETE" }
  );
}

export async function fetchSessions() {
  return request<{ sessions: ReplaySession[] }>("/api/sessions");
}

export async function saveSession(session: ReplaySession) {
  return request<{ ok: boolean; sessions: ReplaySession[] }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(session),
  });
}

export async function deleteSession(name: string) {
  return request<{ ok: boolean; sessions: ReplaySession[] }>(
    `/api/sessions/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
}

export type Trade = {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  exit_price: number;
  size: number;
  stop_price?: number | null;
  take_profit_price?: number | null;
  opened_at?: number | null;
  closed_at?: number | null;
  notes: string;
};

export type TradeStats = {
  total: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_r: number | null;
  total_r: number | null;
  best_r: number | null;
  worst_r: number | null;
};

export async function fetchTrades() {
  return request<{ trades: Trade[] }>("/api/journal");
}

export async function fetchTradeStats() {
  return request<TradeStats>("/api/journal/stats");
}

export async function addTrade(t: Omit<Trade, "id">) {
  return request<{ ok: boolean; trades: Trade[] }>("/api/journal", {
    method: "POST",
    body: JSON.stringify(t),
  });
}

export async function deleteTrade(id: string) {
  return request<{ ok: boolean; trades: Trade[] }>(`/api/journal/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
