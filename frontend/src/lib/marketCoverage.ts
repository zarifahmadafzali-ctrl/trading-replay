/**
 * C7 — unified day coverage from barCache + tickCache metadata (no full tick payloads).
 */
import { listMarketDays, type MarketDayInfo, type MarketDayStatus } from "./barCache";
import { tickCacheListDays } from "./tickCache";
import { canonicalSymbol, symbolLookupCandidates } from "./symbolAliases";

export type CoverageKind = "both" | "1s_only" | "tick_only" | "partial" | "missing";

export type UnifiedMarketDay = {
  id: string;
  symbol: string;
  day: string;
  coverage: CoverageKind;
  barStatus: MarketDayStatus | "NONE";
  barCount: number;
  tickCount: number;
  tickComplete: boolean;
  estimatedBarBytes: number;
  estimatedTickBytes: number;
  savedAt: number;
};

/** ~bytes per tick (time + bid/ask + seq + mid overhead). Estimate only. */
export function estimateTickBytes(tickCount: number): number {
  return Math.max(0, Math.floor(tickCount) * 48);
}

export function classifyCoverage(
  bar: MarketDayInfo | null | undefined,
  tick: { tickCount: number; complete: boolean } | null | undefined
): CoverageKind {
  const barComplete =
    !!bar &&
    (bar.status === "COMPLETE" ||
      (bar.complete && (bar.barCount > 0 || bar.status === "EMPTY")));
  const barPartial = !!bar && (bar.status === "PARTIAL" || (!!bar.barCount && !barComplete));
  const barEmpty = !!bar && bar.status === "EMPTY";
  const tickComplete = !!(tick && tick.complete && tick.tickCount > 0);
  const tickPartial = !!(tick && tick.tickCount > 0 && !tick.complete);

  if (barComplete && tickComplete) return "both";
  if (barEmpty && tickComplete) return "tick_only"; // empty SUCCESS day + ticks still tick-focused
  if (barComplete && !tickComplete && !tickPartial) return "1s_only";
  if (tickComplete && !barComplete && !barPartial) return "tick_only";
  if (barPartial || tickPartial || (bar && !barComplete) || (tick && !tickComplete)) {
    if (!bar && !tick) return "missing";
    if (tickComplete && !bar) return "tick_only";
    if (barComplete && !tick) return "1s_only";
    return "partial";
  }
  if (barComplete) return "1s_only";
  if (tickComplete) return "tick_only";
  return "missing";
}

/**
 * Merge bar day list + tick day list into unified coverage rows.
 * Uses metadata/counts only (tickCacheListDays does not expand tick arrays beyond stored rows —
 * still uses getAll on tick store metadata objects which include ticks arrays in memory when listed).
 * Prefer listing once per refresh, not per render.
 */
export async function listUnifiedMarketDays(symbolFilter?: string): Promise<UnifiedMarketDay[]> {
  const bars = await listMarketDays(symbolFilter);
  // Tick list: all rows, then filter by symbol if needed (alias-aware via uppercase match on listed symbols)
  let ticks = await tickCacheListDays();
  if (symbolFilter) {
    const want = (canonicalSymbol(symbolFilter) || symbolFilter).toUpperCase();
    const cands = new Set(symbolLookupCandidates(symbolFilter).map((s) => s.toUpperCase()));
    cands.add(want);
    ticks = ticks.filter((r) => cands.has(String(r.symbol || "").toUpperCase()));
  }

  const key = (s: string, d: string) => `${s.toUpperCase()}|${d}`;
  const barMap = new Map<string, MarketDayInfo>();
  for (const b of bars) {
    barMap.set(key(b.symbol, b.day), b);
  }
  const tickMap = new Map<string, { symbol: string; day: string; tickCount: number; complete: boolean }>();
  for (const t of ticks) {
    const k = key(t.symbol, t.day);
    const prev = tickMap.get(k);
    if (!prev || t.tickCount > prev.tickCount || (t.complete && !prev.complete)) {
      tickMap.set(k, t);
    }
  }

  const allKeys = new Set([...barMap.keys(), ...tickMap.keys()]);
  const out: UnifiedMarketDay[] = [];
  for (const k of allKeys) {
    const bar = barMap.get(k);
    const tick = tickMap.get(k);
    const symbol = bar?.symbol || tick!.symbol;
    const day = bar?.day || tick!.day;
    const coverage = classifyCoverage(bar, tick || null);
    const barCount = bar?.barCount ?? 0;
    const tickCount = tick?.tickCount ?? 0;
    out.push({
      id: k,
      symbol,
      day,
      coverage,
      barStatus: bar?.status ?? "NONE",
      barCount,
      tickCount,
      tickComplete: !!tick?.complete && tickCount > 0,
      estimatedBarBytes: bar?.estimatedBytes ?? Math.max(0, barCount * 40),
      estimatedTickBytes: estimateTickBytes(tickCount),
      savedAt: bar?.savedAt ?? 0,
    });
  }
  out.sort((a, b) => {
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return a.day < b.day ? 1 : a.day > b.day ? -1 : 0;
  });
  return out;
}

export async function estimateMarketStorage(): Promise<{
  barBytes: number;
  tickBytes: number;
  combinedBytes: number;
  barDays: number;
  tickDays: number;
}> {
  const rows = await listUnifiedMarketDays();
  let barBytes = 0;
  let tickBytes = 0;
  let barDays = 0;
  let tickDays = 0;
  for (const r of rows) {
    if (r.barCount > 0 || r.barStatus === "EMPTY" || r.barStatus === "COMPLETE") barDays++;
    if (r.tickCount > 0) tickDays++;
    barBytes += r.estimatedBarBytes;
    tickBytes += r.estimatedTickBytes;
  }
  return { barBytes, tickBytes, combinedBytes: barBytes + tickBytes, barDays, tickDays };
}

export async function estimateBrowserQuota(): Promise<{
  supported: boolean;
  usage?: number;
  quota?: number;
}> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
      return { supported: false };
    }
    const est = await navigator.storage.estimate();
    return {
      supported: true,
      usage: est.usage,
      quota: est.quota,
    };
  } catch {
    return { supported: false };
  }
}
