import type { Bar, ReplaySession, WatchlistItem } from "./types";

// In dev, Vite proxies /api and /health to the FastAPI backend (see vite.config.ts).
// In production, set VITE_API_BASE to the deployed backend URL.
const BASE = (import.meta as any).env?.VITE_API_BASE ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const r = await request<{ ok: boolean }>("/health");
    return r.ok === true;
  } catch {
    return false;
  }
}

export async function fetchBars(symbol: string, seconds: number, start?: string, end?: string) {
  return request<{ symbol: string; source: string; seconds: number; bars: Bar[] }>(
    `/api/bars?symbol=${encodeURIComponent(symbol)}&seconds=${seconds}&start=${encodeURIComponent(start ?? "")}&end=${encodeURIComponent(end ?? "")}`
  );
}

export async function syncDukascopy(symbol: string, start: string, end: string) {
  return request<{ ok: boolean; symbol: string; days: number; ticks: number; seconds: number; files_ok: number; files_missing: number; files_failed: number; errors: string[] }>(
    `/api/dukascopy/sync?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`,
    { method: "POST" }
  );
}

export async function fetchCapability() {
  return request<{ true_1s: boolean; base_resolution: string; derived: string[]; warning: string }>(
    "/api/data/capability"
  );
}

export async function fetchDataStatus(symbol: string, start: string, end: string) {
  return request<{ symbol: string; has_1s_cache: boolean; note: string }>(
    `/api/data/status?symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`
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
