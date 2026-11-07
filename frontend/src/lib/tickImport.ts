/**
 * Phase B — import native tick datasets (JSON / CSV bid-ask / optional Parquet).
 * Writes ticks → tickCache and derived 1s bars → barCache.
 * Does not implement tick replay.
 */

import type { Bar } from "./types";
import type { DatasetDayMeta } from "./datasetMeta";
import { normalizeDatasetDayMeta } from "./datasetMeta";
import { cacheGetDay, cacheGetDayRow, cachePutDay } from "./barCache";
import { ticksToOneSecondBars, barsApproximatelyEqual } from "./tickAggregate";
import { tickCacheGetDay, tickCachePutDay } from "./tickCache";
import type { TickRecord } from "./tickTypes";
import { normalizeTicks } from "./tickValidate";

export type TickImportProgress = {
  phase: string;
  symbol?: string;
  day?: string;
  ticksProcessed?: number;
  validTicks?: number;
  rejected?: number;
  barsGenerated?: number;
  error?: string;
};

export type TickImportDayResult = {
  symbol: string;
  day: string;
  validTicks: number;
  rejected: number;
  barsGenerated: number;
  barsWritten: boolean;
  ticksWritten: boolean;
  skippedBarsConflict: boolean;
  warnings: string[];
  errors: string[];
};

export type TickImportBundleResult = {
  days: TickImportDayResult[];
  ok: boolean;
};

function dayFromUnixSeconds(t: number): string {
  const ms = t >= 1e12 ? t : t * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function dominantDay(ticks: TickRecord[]): string | null {
  if (!ticks.length) return null;
  const counts = new Map<string, number>();
  for (const t of ticks) {
    const d = dayFromUnixSeconds(t.time);
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best: string | null = null;
  let n = -1;
  for (const [d, c] of counts) {
    if (c > n) {
      n = c;
      best = d;
    }
  }
  return best;
}

function splitTicksByDay(ticks: TickRecord[]): Map<string, TickRecord[]> {
  const m = new Map<string, TickRecord[]>();
  for (const t of ticks) {
    const d = dayFromUnixSeconds(t.time);
    const arr = m.get(d);
    if (arr) arr.push(t);
    else m.set(d, [t]);
  }
  return m;
}

/**
 * Import one symbol-day of already-parsed tick objects.
 * Bounded to a single day — caller must not pass multi-month arrays without splitting.
 */
export async function importTicksForDay(opts: {
  symbol: string;
  day?: string;
  rawTicks: Array<Record<string, unknown>>;
  sourceBars1s?: Bar[];
  source?: string;
  onProgress?: (p: TickImportProgress) => void;
  /** When true, refuse to overwrite existing SUCCESS bars that disagree. Default true. */
  protectExistingBars?: boolean;
}): Promise<TickImportDayResult> {
  const symbol = opts.symbol.toUpperCase();
  const protect = opts.protectExistingBars !== false;
  const warnings: string[] = [];
  const errors: string[] = [];

  opts.onProgress?.({ phase: "validate", symbol, ticksProcessed: opts.rawTicks.length });

  const normalized = normalizeTicks(opts.rawTicks);
  const day = opts.day || dominantDay(normalized.ticks);
  if (!day) {
    return {
      symbol,
      day: opts.day || "",
      validTicks: 0,
      rejected: normalized.rejected,
      barsGenerated: 0,
      barsWritten: false,
      ticksWritten: false,
      skippedBarsConflict: false,
      warnings,
      errors: ["No valid ticks / could not determine day"],
    };
  }

  if (normalized.outOfOrderSource) {
    warnings.push("Source ticks were out of chronological order; sorted by time+seq");
  }

  opts.onProgress?.({
    phase: "store-ticks",
    symbol,
    day,
    validTicks: normalized.ticks.length,
    rejected: normalized.rejected,
  });

  // Mark incomplete until both tick write + bar write succeed
  try {
    await tickCachePutDay(symbol, day, normalized.ticks, {
      complete: false,
      source: opts.source || "tick-import",
    });
  } catch (e) {
    errors.push(`Tick store failed: ${e instanceof Error ? e.message : String(e)}`);
    return {
      symbol,
      day,
      validTicks: normalized.ticks.length,
      rejected: normalized.rejected,
      barsGenerated: 0,
      barsWritten: false,
      ticksWritten: false,
      skippedBarsConflict: false,
      warnings,
      errors,
    };
  }

  const bars = ticksToOneSecondBars(normalized.ticks);
  opts.onProgress?.({
    phase: "aggregate",
    symbol,
    day,
    validTicks: normalized.ticks.length,
    rejected: normalized.rejected,
    barsGenerated: bars.length,
  });

  if (opts.sourceBars1s && opts.sourceBars1s.length) {
    const cmp = barsApproximatelyEqual(bars, opts.sourceBars1s);
    if (!cmp.ok) {
      warnings.push(
        `bars_1s cross-check: mismatches=${cmp.mismatches} extraGen=${cmp.extraA} extraSrc=${cmp.extraB}`
      );
    }
  }

  let barsWritten = false;
  let skippedBarsConflict = false;
  const existing = await cacheGetDayRow(symbol, day);
  const existingBars = existing?.bars?.length ? existing.bars : await cacheGetDay(symbol, day);

  if (existingBars && existingBars.length > 0 && protect) {
    const cmp = barsApproximatelyEqual(bars, existingBars);
    if (!cmp.ok && bars.length > 0) {
      skippedBarsConflict = true;
      warnings.push(
        "Existing 1s bars differ from tick-aggregated bars; left existing bars unchanged"
      );
    } else {
      // compatible — still refresh meta
      const meta: DatasetDayMeta = normalizeDatasetDayMeta({
        dataKind: "ticks",
        hasTicks: true,
        hasBars1s: true,
        tickCount: normalized.ticks.length,
        bars1sCount: existingBars.length,
        source: opts.source || existing?.source || "tick-import",
      });
      await cachePutDay(symbol, day, existingBars, {
        classification: existing?.classification || "SUCCESS",
        complete: true,
        meta,
      });
      barsWritten = true;
    }
  } else {
    const meta: DatasetDayMeta = normalizeDatasetDayMeta({
      dataKind: "ticks",
      hasTicks: true,
      hasBars1s: bars.length > 0,
      tickCount: normalized.ticks.length,
      bars1sCount: bars.length,
      source: opts.source || "tick-import",
    });
    await cachePutDay(symbol, day, bars, { classification: "SUCCESS", complete: true, meta });
    barsWritten = true;
  }

  // Finalize tick row as complete
  await tickCachePutDay(symbol, day, normalized.ticks, {
    complete: true,
    source: opts.source || "tick-import",
  });

  opts.onProgress?.({
    phase: "done",
    symbol,
    day,
    validTicks: normalized.ticks.length,
    rejected: normalized.rejected,
    barsGenerated: bars.length,
  });

  return {
    symbol,
    day,
    validTicks: normalized.ticks.length,
    rejected: normalized.rejected,
    barsGenerated: bars.length,
    barsWritten,
    ticksWritten: true,
    skippedBarsConflict,
    warnings,
    errors,
  };
}

/** Split multi-day tick arrays and import day-by-day (bounded memory per day). */
export async function importTicksMultiDay(opts: {
  symbol: string;
  rawTicks: Array<Record<string, unknown>>;
  source?: string;
  onProgress?: (p: TickImportProgress) => void;
}): Promise<TickImportBundleResult> {
  const normalized = normalizeTicks(opts.rawTicks);
  const byDay = splitTicksByDay(normalized.ticks);
  const days: TickImportDayResult[] = [];
  for (const [day, list] of byDay) {
    opts.onProgress?.({ phase: "day", symbol: opts.symbol, day, validTicks: list.length });
    const r = await importTicksForDay({
      symbol: opts.symbol,
      day,
      rawTicks: list as unknown as Array<Record<string, unknown>>,
      source: opts.source,
      onProgress: opts.onProgress,
    });
    days.push(r);
  }
  return { days, ok: days.every((d) => d.errors.length === 0) };
}

/** Parse tick CSV with header containing time,bid,ask. */
export function parseTickCsv(text: string): {
  rows: Array<Record<string, unknown>>;
  errors: string[];
  columns: string[];
} {
  const errors: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const raw = text.replace(/^\uFEFF/, "").trim();
  if (!raw) return { rows: [], errors: ["Empty CSV"], columns: [] };
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], errors: ["Empty CSV"], columns: [] };

  let columns: string[] = [];
  let start = 0;
  const header = lines[0].toLowerCase();
  if (header.includes("time") && (header.includes("bid") || header.includes("ask"))) {
    columns = lines[0].split(",").map((c) => c.trim());
    start = 1;
  } else {
    columns = ["time", "bid", "ask", "bid_vol", "ask_vol", "mid"];
  }
  const lower = columns.map((c) => c.toLowerCase());
  const idx = (name: string) => lower.indexOf(name);

  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const get = (name: string, fallbackIndex: number) => {
      const j = idx(name);
      return j >= 0 ? cols[j] : cols[fallbackIndex];
    };
    rows.push({
      time: Number(get("time", 0)),
      bid: Number(get("bid", 1)),
      ask: Number(get("ask", 2)),
      bid_vol: Number(get("bid_vol", 3) || 0),
      ask_vol: Number(get("ask_vol", 4) || 0),
      mid: get("mid", 5) != null && get("mid", 5) !== "" ? Number(get("mid", 5)) : undefined,
    });
  }
  return { rows, errors, columns };
}

/**
 * Parse a TR Market Data style JSON payload:
 * { symbol, day?, ticks: [...], bars_1s?: [...], metadata?: {...} }
 * or a bare tick array.
 */
export function parseTickJson(raw: unknown): {
  symbol?: string;
  day?: string;
  ticks: Array<Record<string, unknown>>;
  bars1s?: Bar[];
  metadata?: Record<string, unknown>;
  errors: string[];
} {
  const errors: string[] = [];
  if (Array.isArray(raw)) {
    return { ticks: raw as Array<Record<string, unknown>>, errors };
  }
  if (!raw || typeof raw !== "object") {
    return { ticks: [], errors: ["Not a JSON object or array"] };
  }
  const o = raw as Record<string, unknown>;
  const ticks = Array.isArray(o.ticks)
    ? (o.ticks as Array<Record<string, unknown>>)
    : Array.isArray(o.data)
      ? (o.data as Array<Record<string, unknown>>)
      : [];
  if (!ticks.length) errors.push("No ticks array found");
  let bars1s: Bar[] | undefined;
  const barsRaw = o.bars_1s || o.bars1s || o.bars;
  if (Array.isArray(barsRaw)) {
    bars1s = barsRaw
      .map((b) => {
        if (!b || typeof b !== "object") return null;
        const x = b as Record<string, unknown>;
        return {
          time: Number(x.time),
          open: Number(x.open),
          high: Number(x.high),
          low: Number(x.low),
          close: Number(x.close),
          volume: Number(x.volume ?? 0),
        } as Bar;
      })
      .filter((b): b is Bar => !!b && Number.isFinite(b.time));
  }
  return {
    symbol: typeof o.symbol === "string" ? o.symbol : undefined,
    day: typeof o.day === "string" ? o.day : undefined,
    ticks,
    bars1s,
    metadata: typeof o.metadata === "object" && o.metadata ? (o.metadata as Record<string, unknown>) : undefined,
    errors,
  };
}

/**
 * Optional Parquet read via hyparquet when available.
 * Returns null if the dependency is not installed.
 */
export async function tryReadTicksParquet(
  buffer: ArrayBuffer
): Promise<{ rows: Array<Record<string, unknown>>; error?: string } | null> {
  try {
    // Dynamic import — optional dependency
    const mod = await import(
      /* @vite-ignore */
      "hyparquet"
    );
    const parquetReadObjects =
      (mod as { parquetReadObjects?: (opts: { file: ArrayBuffer }) => Promise<unknown[]> })
        .parquetReadObjects ||
      (mod as { default?: { parquetReadObjects?: (opts: { file: ArrayBuffer }) => Promise<unknown[]> } })
        .default?.parquetReadObjects;
    if (!parquetReadObjects) {
      return { rows: [], error: "hyparquet loaded but parquetReadObjects missing" };
    }
    const objects = await parquetReadObjects({ file: buffer });
    return { rows: objects as Array<Record<string, unknown>> };
  } catch (e) {
    return {
      rows: [],
      error: `Parquet support unavailable: ${e instanceof Error ? e.message : String(e)}. Use tick JSON/CSV or install hyparquet.`,
    };
  }
}
