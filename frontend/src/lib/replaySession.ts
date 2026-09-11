/**
 * Replay session persistence (v3.15.2 / v3.15.2.1).
 *
 * localStorage holds only lightweight session metadata — never full 1s bar arrays.
 * Market data is reloaded from the existing day-sharded device cache (barCache)
 * and/or the backend using the saved symbol + date range.
 *
 * Migration note for v3.16:
 * - Move this meta store to IndexedDB alongside bar shards if needed.
 * - CSV-only sessions without cache shards still cannot fully restore bars
 *   until raw series are stored in IndexedDB.
 */

export type ReplayDataSource = "demo" | "loaded" | "csv";

export type ReplaySessionMeta = {
  version: 1;
  symbol: string;
  start: string;
  end: string;
  dataSource: ReplayDataSource;
  timeframeSeconds: number;
  customTfs: number[];
  /** How many 1s bars the cursor advances per Next/Prev/Play tick. Execution still scans every 1s bar. */
  replayStepSeconds: number;
  cursor: number;
  speed: number;
  /** Always restored as false (PAUSED). Stored for completeness. */
  playing: boolean;
  followPrice: boolean;
  orderType: string;
  drawTool: string;
  message: string;
  updatedAt: number;
};

const KEY = "tr-replay-session-v1";

export function loadReplaySession(): ReplaySessionMeta | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReplaySessionMeta;
    if (!parsed || parsed.version !== 1) return null;
    if (typeof parsed.symbol !== "string" || !parsed.symbol) return null;
    if (typeof parsed.timeframeSeconds !== "number" || parsed.timeframeSeconds < 1) return null;
    if (typeof parsed.cursor !== "number" || parsed.cursor < 0) return null;
    if (typeof parsed.replayStepSeconds !== "number" || parsed.replayStepSeconds < 1) {
      parsed.replayStepSeconds = 1;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveReplaySession(
  meta: Omit<ReplaySessionMeta, "version" | "updatedAt" | "playing"> & { playing?: boolean }
): void {
  try {
    const payload: ReplaySessionMeta = {
      version: 1,
      symbol: meta.symbol,
      start: meta.start,
      end: meta.end,
      dataSource: meta.dataSource,
      timeframeSeconds: meta.timeframeSeconds,
      customTfs: meta.customTfs,
      replayStepSeconds: Math.max(1, Math.floor(meta.replayStepSeconds || 1)),
      cursor: meta.cursor,
      speed: meta.speed,
      playing: false,
      followPrice: meta.followPrice,
      orderType: meta.orderType,
      drawTool: meta.drawTool,
      message: meta.message,
      updatedAt: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function clearReplaySession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* */
  }
}
