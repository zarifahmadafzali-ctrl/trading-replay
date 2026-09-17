/**
 * Incremental device cache: pull SUCCESS / EXPECTED_EMPTY days from backend
 * one day at a time into IndexedDB. Never downloads the full range in one shot.
 */
import { fetchBarsDay } from "./api";
import {
  cacheGetDayRow,
  cachePutDay,
  summarizeLocalCache,
  getDayFetchInflight,
  setDayFetchInflight,
  type LocalCacheSummary,
} from "./barCache";

export type PullProgress = {
  day: string;
  status: "cached" | "fetched" | "empty" | "failed" | "skipped";
  bars?: number;
  error?: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensure listed days are present in IndexedDB.
 * Skips days already complete locally. Retries failed days with backoff.
 */
export async function pullDaysToLocalCache(
  symbol: string,
  days: string[],
  opts?: {
    onProgress?: (p: PullProgress, summary: LocalCacheSummary) => void;
    /** Optional abort: return true to stop early */
    shouldStop?: () => boolean;
    rangeStart?: string;
    rangeEnd?: string;
  }
): Promise<{ ok: boolean; failed: string[]; summary: LocalCacheSummary }> {
  const failed: string[] = [];
  const rangeStart = opts?.rangeStart || days[0];
  const rangeEnd = opts?.rangeEnd || days[days.length - 1];

  for (const day of days) {
    if (opts?.shouldStop?.()) break;

    const existing = await cacheGetDayRow(symbol, day);
    if (existing?.complete) {
      const summary = await summarizeLocalCache(symbol, rangeStart, rangeEnd);
      opts?.onProgress?.({ day, status: "skipped", bars: existing.barCount }, summary);
      continue;
    }

    let attempt = 0;
    let done = false;
    while (attempt < 3 && !done) {
      attempt += 1;
      try {
        // Concurrent requests for the same symbol|day share one fetch (v3.22.0).
        let bars: Awaited<ReturnType<typeof fetchBarsDay>>["bars"] = [];
        let cls = "SUCCESS";
        const inflight = getDayFetchInflight(symbol, day);
        if (inflight) {
          bars = await inflight;
          const row = await cacheGetDayRow(symbol, day);
          cls = row?.classification || (bars.length ? "SUCCESS" : "EXPECTED_EMPTY");
        } else {
          const res = await setDayFetchInflight(
            symbol,
            day,
            (async () => {
              const r = await fetchBarsDay(symbol, day);
              const c = r.classification || (r.bars?.length ? "SUCCESS" : "EXPECTED_EMPTY");
              await cachePutDay(symbol, day, r.bars || [], {
                classification: c,
                complete: true,
              });
              return r.bars || [];
            })()
          );
          bars = res;
          const row = await cacheGetDayRow(symbol, day);
          cls = row?.classification || (bars.length ? "SUCCESS" : "EXPECTED_EMPTY");
        }
        const summary = await summarizeLocalCache(symbol, rangeStart, rangeEnd);
        opts?.onProgress?.(
          {
            day,
            status: cls === "EXPECTED_EMPTY" ? "empty" : "fetched",
            bars: bars.length,
          },
          summary
        );
        done = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= 3) {
          failed.push(day);
          const summary = await summarizeLocalCache(symbol, rangeStart, rangeEnd);
          opts?.onProgress?.({ day, status: "failed", error: msg }, summary);
        } else {
          await sleep(Math.min(8000, 600 * 2 ** attempt));
        }
      }
    }
  }

  const summary = await summarizeLocalCache(symbol, rangeStart, rangeEnd);
  return { ok: failed.length === 0, failed, summary };
}

/**
 * Given backend status lists, pull only SUCCESS + EXPECTED_EMPTY days not yet local.
 */
export async function reconcileLocalFromBackendStatus(
  symbol: string,
  start: string,
  end: string,
  backend: {
    success_days?: string[];
    expected_empty_days?: string[];
  },
  opts?: {
    onProgress?: (p: PullProgress, summary: LocalCacheSummary) => void;
    shouldStop?: () => boolean;
  }
) {
  const want = [
    ...new Set([...(backend.success_days || []), ...(backend.expected_empty_days || [])]),
  ].sort();
  const toFetch: string[] = [];
  for (const day of want) {
    const row = await cacheGetDayRow(symbol, day);
    if (!row?.complete) toFetch.push(day);
  }
  return pullDaysToLocalCache(symbol, toFetch, {
    ...opts,
    rangeStart: start,
    rangeEnd: end,
  });
}
