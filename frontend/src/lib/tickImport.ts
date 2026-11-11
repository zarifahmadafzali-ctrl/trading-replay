/**
 * Phase B — import native tick datasets (JSON / CSV bid-ask / optional Parquet).
 * Writes ticks → tickCache and derived 1s bars → barCache.
 * Does not implement tick replay.
 */

import type { Bar } from "./types";
import type { DatasetDayMeta } from "./datasetMeta";
import { normalizeDatasetDayMeta } from "./datasetMeta";
import { cacheGetDay, cacheGetDayRow, cacheGetDayRowWithAlias, cachePutDay } from "./barCache";
import { ticksToOneSecondBars, barsApproximatelyEqual } from "./tickAggregate";
import { tickCacheGetDay, tickCachePutDay } from "./tickCache";
import type { TickRecord } from "./tickTypes";
import { normalizeTicks } from "./tickValidate";
import { canonicalSymbol } from "./symbolAliases";
import {
  readParquetObjects,
  mapTickParquetRows,
  mapBars1sParquetRows,
} from "./parquetCodec";
import { groupZipByDay, readZipEntries } from "./zipStore";

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
  const providerSymbol = String(opts.symbol || "").trim().toUpperCase();
  // D1: store under canonical key (US30) so Replay US30 sessions hit local cache.
  // Preserve original provider symbol in metadata when it differs from canonical.
  const symbol = canonicalSymbol(providerSymbol) || providerSymbol;
  const providerSource =
    providerSymbol && providerSymbol !== symbol
      ? `provider:${providerSymbol}`
      : undefined;
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
  // D1: detect existing bars under any alias (US30 or USA30IDXUSD) without migrating.
  const existingHit = await cacheGetDayRowWithAlias(symbol, day);
  const existing = existingHit?.row ?? (await cacheGetDayRow(symbol, day));
  const existingBars = existing?.bars?.length ? existing.bars : await cacheGetDay(symbol, day);
  const resolvedSource =
    opts.source || providerSource || existing?.source || "tick-import";

  if (existingBars && existingBars.length > 0 && protect) {
    const cmp = barsApproximatelyEqual(bars, existingBars);
    if (!cmp.ok && bars.length > 0) {
      skippedBarsConflict = true;
      warnings.push(
        "Existing 1s bars differ from tick-aggregated bars; left existing bars unchanged"
      );
    } else {
      // compatible — still refresh meta under canonical key (does not delete provider key)
      const meta: DatasetDayMeta = normalizeDatasetDayMeta({
        dataKind: "ticks",
        hasTicks: true,
        hasBars1s: true,
        tickCount: normalized.ticks.length,
        bars1sCount: existingBars.length,
        source: resolvedSource,
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
      source: resolvedSource,
    });
    await cachePutDay(symbol, day, bars, { classification: "SUCCESS", complete: true, meta });
    barsWritten = true;
  }

  // Finalize tick row as complete (canonical key)
  await tickCachePutDay(symbol, day, normalized.ticks, {
    complete: true,
    source: resolvedSource,
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
 * Read ticks.parquet via hyparquet (Snappy supported by default).
 */
export async function tryReadTicksParquet(
  buffer: ArrayBuffer
): Promise<{ rows: Array<Record<string, unknown>>; error?: string }> {
  const res = await readParquetObjects(buffer);
  if (res.error) return { rows: [], error: res.error };
  return { rows: mapTickParquetRows(res.rows) };
}

/**
 * Read bars_1s.parquet via hyparquet.
 */
export async function tryReadBars1sParquet(
  buffer: ArrayBuffer
): Promise<{ bars: Bar[]; error?: string }> {
  const res = await readParquetObjects(buffer);
  if (res.error) return { bars: [], error: res.error };
  const mapped = mapBars1sParquetRows(res.rows);
  const bars: Bar[] = [];
  for (const r of mapped) {
    const time = Number(r.time);
    if (!Number.isFinite(time)) continue;
    const t = time > 1e12 ? Math.floor(time / 1000) : Math.floor(time);
    const open = Number(r.open);
    const high = Number(r.high);
    const low = Number(r.low);
    const close = Number(r.close);
    const volume = Number(r.volume ?? 0);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    if (!Number.isFinite(volume) || volume < 0) continue;
    bars.push({ time: t, open, high, low, close, volume });
  }
  return { bars };
}

export type TrMarketDataMetadata = {
  symbol?: string;
  provider?: string;
  day?: string;
  tick_count?: number;
  bars_1s_count?: number;
  status?: string;
  tick_status?: string;
  bars_1s_status?: string;
  successful_hours?: number;
  empty_hours?: number;
  failed_hours?: number;
  ohlc_price?: string;
  tick_schema?: string[];
  bars_1s_schema?: string[];
  raw?: Record<string, unknown>;
};

/** Parse optional metadata.json from TR Market Data (fields may be missing). */
export function parseTrMarketDataMetadata(raw: unknown): {
  meta: TrMarketDataMetadata;
  errors: string[];
} {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { meta: {}, errors: ["metadata.json is not an object"] };
  }
  const o = raw as Record<string, unknown>;
  const num = (k: string): number | undefined => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const str = (k: string): string | undefined => {
    const v = o[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const meta: TrMarketDataMetadata = {
    symbol: str("symbol"),
    provider: str("provider"),
    day: str("day"),
    tick_count: num("tick_count"),
    bars_1s_count: num("bars_1s_count"),
    status: str("status"),
    tick_status: str("tick_status"),
    bars_1s_status: str("bars_1s_status"),
    successful_hours: num("successful_hours"),
    empty_hours: num("empty_hours"),
    failed_hours: num("failed_hours"),
    ohlc_price: str("ohlc_price"),
    tick_schema: Array.isArray(o.tick_schema) ? (o.tick_schema as string[]) : undefined,
    bars_1s_schema: Array.isArray(o.bars_1s_schema) ? (o.bars_1s_schema as string[]) : undefined,
    raw: o,
  };
  if (meta.day && !/^\d{4}-\d{2}-\d{2}$/.test(meta.day)) {
    errors.push(`metadata day format invalid: ${meta.day}`);
  }
  return { meta, errors };
}

export type TrMarketDataImportInput = {
  ticksParquet: ArrayBuffer;
  bars1sParquet?: ArrayBuffer | null;
  metadataJsonText?: string | null;
  symbolFallback?: string;
  onProgress?: (p: TickImportProgress) => void;
  protectExistingBars?: boolean;
};

/**
 * Import one TR Market Data day package:
 * ticks.parquet + optional bars_1s.parquet + optional metadata.json
 */
export async function importTrMarketDataDay(
  input: TrMarketDataImportInput
): Promise<TickImportDayResult & { metadata?: TrMarketDataMetadata }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  let meta: TrMarketDataMetadata | undefined;

  if (input.metadataJsonText) {
    try {
      const parsed = parseTrMarketDataMetadata(JSON.parse(input.metadataJsonText));
      meta = parsed.meta;
      errors.push(...parsed.errors);
    } catch (e) {
      warnings.push(
        `metadata.json parse failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  input.onProgress?.({ phase: "read-ticks-parquet" });
  const tickRead = await tryReadTicksParquet(input.ticksParquet);
  if (tickRead.error) {
    return {
      symbol: (meta?.symbol || input.symbolFallback || "").toUpperCase(),
      day: meta?.day || "",
      validTicks: 0,
      rejected: 0,
      barsGenerated: 0,
      barsWritten: false,
      ticksWritten: false,
      skippedBarsConflict: false,
      warnings,
      errors: [...errors, tickRead.error],
      metadata: meta,
    };
  }

  const providerSymbol = (meta?.symbol || input.symbolFallback || "UNKNOWN").toUpperCase();
  // D1: normalize provider aliases (USA30IDXUSD → US30) for storage; keep provider in source.
  const symbol = canonicalSymbol(providerSymbol) || providerSymbol;
  let sourceBars: Bar[] | undefined;

  if (input.bars1sParquet && input.bars1sParquet.byteLength > 0) {
    input.onProgress?.({ phase: "read-bars1s-parquet", symbol });
    const barRead = await tryReadBars1sParquet(input.bars1sParquet);
    if (barRead.error) {
      warnings.push(barRead.error);
    } else {
      sourceBars = barRead.bars;
    }
  }

  if (meta?.tick_count != null && meta.tick_count !== tickRead.rows.length) {
    warnings.push(
      `metadata tick_count=${meta.tick_count} differs from parquet rows=${tickRead.rows.length}`
    );
  }
  if (meta?.bars_1s_count != null && sourceBars && meta.bars_1s_count !== sourceBars.length) {
    warnings.push(
      `metadata bars_1s_count=${meta.bars_1s_count} differs from parquet bars=${sourceBars.length}`
    );
  }

  const dayResult = await importTicksForDay({
    symbol,
    day: meta?.day,
    rawTicks: tickRead.rows,
    sourceBars1s: sourceBars,
    source: meta?.provider
      ? `tr-market-data:${meta.provider}`
      : "tr-market-data:parquet",
    onProgress: input.onProgress,
    protectExistingBars: input.protectExistingBars,
  });

  dayResult.warnings = [...warnings, ...dayResult.warnings];
  dayResult.errors = [...errors, ...dayResult.errors];
  return { ...dayResult, metadata: meta };
}

/** Classify a File by name for multi-file picker. */
export function classifyTrMarketDataFile(
  name: string
): "ticks" | "bars_1s" | "metadata" | "other" {
  const n = name.toLowerCase().replace(/\\/g, "/");
  const base = n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n;
  if (base === "metadata.json" || (base.includes("metadata") && base.endsWith(".json"))) {
    return "metadata";
  }
  if (base.includes("bars_1s") && base.endsWith(".parquet")) return "bars_1s";
  if (base.includes("tick") && base.endsWith(".parquet")) return "ticks";
  if (base.endsWith(".parquet")) return "other";
  return "other";
}

export type TrMarketZipImportSummary = {
  symbol: string;
  packageMeta: Record<string, unknown> | null;
  daysAttempted: number;
  daysOk: number;
  daysFailed: number;
  dayResults: Array<TickImportDayResult & { metadata?: TrMarketDataMetadata }>;
  warnings: string[];
  errors: string[];
};

function pickDayFile(files: Map<string, Uint8Array>, kind: "ticks" | "bars_1s" | "metadata"): Uint8Array | null {
  for (const [name, data] of files) {
    const c = classifyTrMarketDataFile(name);
    if (c === kind) return data;
  }
  // exact names
  const exact =
    kind === "ticks"
      ? ["ticks.parquet"]
      : kind === "bars_1s"
        ? ["bars_1s.parquet"]
        : ["metadata.json"];
  for (const e of exact) {
    if (files.has(e)) return files.get(e)!;
  }
  return null;
}

/**
 * Import a TR Market Data range ZIP (ephemeral delivery package).
 * Merges into IndexedDB tick + 1s bar caches by day; existing compatible bars are kept.
 */
export async function importTrMarketDataZip(
  zipBytes: ArrayBuffer,
  opts?: {
    symbolFallback?: string;
    protectExistingBars?: boolean;
    onProgress?: (p: TickImportProgress & { day?: string; dayIndex?: number; dayCount?: number }) => void;
  }
): Promise<TrMarketZipImportSummary> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const entries = await readZipEntries(zipBytes);
  const grouped = groupZipByDay(entries);

  let packageMeta: Record<string, unknown> | null = null;
  if (grouped.packageJson) {
    try {
      packageMeta = JSON.parse(new TextDecoder().decode(grouped.packageJson)) as Record<string, unknown>;
    } catch {
      warnings.push("package.json present but not valid JSON");
    }
  }

  const symbolFallback =
    opts?.symbolFallback ||
    (typeof packageMeta?.symbol === "string" ? packageMeta.symbol : null) ||
    grouped.symbolHint ||
    "";

  const dayKeys = [...grouped.days.keys()].sort();
  const dayResults: Array<TickImportDayResult & { metadata?: TrMarketDataMetadata }> = [];
  let daysOk = 0;
  let daysFailed = 0;

  for (let i = 0; i < dayKeys.length; i++) {
    const day = dayKeys[i]!;
    const files = grouped.days.get(day)!;
    opts?.onProgress?.({
      phase: "validate",
      day,
      dayIndex: i + 1,
      dayCount: dayKeys.length,
      symbol: symbolFallback,
    });

    const ticksU8 = pickDayFile(files, "ticks");
    const barsU8 = pickDayFile(files, "bars_1s");
    const metaU8 = pickDayFile(files, "metadata");

    if (!ticksU8 && barsU8) {
      // 1s-only package day
      const barRead = await tryReadBars1sParquet(barsU8.buffer.slice(barsU8.byteOffset, barsU8.byteOffset + barsU8.byteLength));
      if (barRead.error || !barRead.bars.length) {
        daysFailed++;
        errors.push(`${day}: bars_1s only but read failed (${barRead.error || "empty"})`);
        continue;
      }
      const symbol = canonicalSymbol(symbolFallback) || symbolFallback.toUpperCase() || "UNKNOWN";
      const existingHit = await cacheGetDayRowWithAlias(symbol, day);
      const existingBars = existingHit?.row?.bars?.length
        ? existingHit.row.bars
        : await cacheGetDay(symbol, day);
      if (existingBars && existingBars.length && opts?.protectExistingBars !== false) {
        const cmp = barsApproximatelyEqual(barRead.bars, existingBars);
        if (!cmp.ok) {
          warnings.push(`${day}: existing 1s bars differ; left unchanged`);
          daysOk++;
          dayResults.push({
            symbol,
            day,
            validTicks: 0,
            rejected: 0,
            barsGenerated: existingBars.length,
            barsWritten: false,
            ticksWritten: false,
            skippedBarsConflict: true,
            warnings: [`${day}: kept existing bars`],
            errors: [],
          });
          continue;
        }
      }
      const meta = normalizeDatasetDayMeta({
        dataKind: "bars_1s",
        hasTicks: false,
        hasBars1s: true,
        bars1sCount: barRead.bars.length,
        source: "tr-market-data:zip",
      });
      await cachePutDay(symbol, day, barRead.bars, {
        classification: "SUCCESS",
        complete: true,
        meta,
      });
      daysOk++;
      dayResults.push({
        symbol,
        day,
        validTicks: 0,
        rejected: 0,
        barsGenerated: barRead.bars.length,
        barsWritten: true,
        ticksWritten: false,
        skippedBarsConflict: false,
        warnings: [],
        errors: [],
      });
      continue;
    }

    if (!ticksU8) {
      daysFailed++;
      errors.push(`${day}: no ticks.parquet (and no bars_1s.parquet)`);
      continue;
    }

    const ticksBuf = ticksU8.buffer.slice(ticksU8.byteOffset, ticksU8.byteOffset + ticksU8.byteLength);
    const barsBuf = barsU8
      ? barsU8.buffer.slice(barsU8.byteOffset, barsU8.byteOffset + barsU8.byteLength)
      : undefined;
    const metaText = metaU8 ? new TextDecoder().decode(metaU8) : undefined;

    const r = await importTrMarketDataDay({
      ticksParquet: ticksBuf,
      bars1sParquet: barsBuf,
      metadataJsonText: metaText,
      symbolFallback: symbolFallback || undefined,
      protectExistingBars: opts?.protectExistingBars,
      onProgress: opts?.onProgress,
    });
    // Force day from path if metadata missing
    if (!r.day) r.day = day;
    dayResults.push(r);
    if (r.errors.length && !r.ticksWritten && !r.barsWritten) daysFailed++;
    else daysOk++;
  }

  const symbol =
    dayResults.find((d) => d.symbol)?.symbol ||
    canonicalSymbol(symbolFallback) ||
    symbolFallback.toUpperCase() ||
    "";

  return {
    symbol,
    packageMeta,
    daysAttempted: dayKeys.length,
    daysOk,
    daysFailed,
    dayResults,
    warnings,
    errors,
  };
}
