/**
 * Phase A — Dataset kind detection & day metadata (no tick storage / no tick replay).
 *
 * dataKind:
 *   - "bars_1s": OHLCV one-second bars (legacy CSV / .trdata / default)
 *   - "ticks":   dataset is known to include tick-level data (metadata only in Phase A)
 *
 * Legacy rows without metadata always resolve to bars_1s.
 */

export type DatasetKind = "ticks" | "bars_1s";

export type DatasetDayMeta = {
  dataKind: DatasetKind;
  hasTicks: boolean;
  hasBars1s: boolean;
  tickCount?: number;
  bars1sCount?: number;
  priceBasis: "mid";
  executionBasis: "bars_1s";
  source?: string;
};

export type DatasetMetaInput = Partial<{
  dataKind: string;
  hasTicks: boolean;
  hasBars1s: boolean;
  tickCount: number;
  bars1sCount: number;
  priceBasis: string;
  executionBasis: string;
  source: string;
}>;

/** Default for any legacy OHLCV-only day (CSV, old .trdata, old IndexedDB rows). */
export function defaultBars1sMeta(opts?: {
  bars1sCount?: number;
  source?: string;
}): DatasetDayMeta {
  const n = opts?.bars1sCount;
  return {
    dataKind: "bars_1s",
    hasTicks: false,
    hasBars1s: n == null ? true : n > 0,
    tickCount: undefined,
    bars1sCount: n,
    priceBasis: "mid",
    executionBasis: "bars_1s",
    source: opts?.source,
  };
}

/**
 * Normalize partial / explicit metadata.
 * Incomplete or contradictory inputs fall back safely toward bars_1s unless
 * ticks are explicitly asserted.
 */
export function normalizeDatasetDayMeta(
  input: DatasetMetaInput | null | undefined,
  context?: { bars1sCount?: number; source?: string }
): DatasetDayMeta {
  const bars1sCount =
    typeof input?.bars1sCount === "number" && Number.isFinite(input.bars1sCount)
      ? Math.max(0, Math.floor(input.bars1sCount))
      : context?.bars1sCount;

  const tickCount =
    typeof input?.tickCount === "number" && Number.isFinite(input.tickCount)
      ? Math.max(0, Math.floor(input.tickCount))
      : undefined;

  const source =
    typeof input?.source === "string" && input.source.trim()
      ? input.source.trim()
      : context?.source;

  const explicitKind =
    input?.dataKind === "ticks" || input?.dataKind === "bars_1s" ? input.dataKind : undefined;

  const hasTicksExplicit = input?.hasTicks === true || explicitKind === "ticks" || (tickCount != null && tickCount > 0);
  const hasBarsExplicit =
    input?.hasBars1s === true ||
    explicitKind === "bars_1s" ||
    (bars1sCount != null && bars1sCount > 0);

  // Legacy / missing: never invent ticks
  if (!input || (explicitKind == null && input.hasTicks !== true && (tickCount == null || tickCount === 0))) {
    if (!hasTicksExplicit) {
      return defaultBars1sMeta({ bars1sCount, source });
    }
  }

  let dataKind: DatasetKind = explicitKind ?? (hasTicksExplicit ? "ticks" : "bars_1s");

  // OHLCV-only package claiming ticks without tick evidence → coerce to bars_1s
  if (dataKind === "ticks" && !hasTicksExplicit && !(tickCount != null && tickCount > 0) && input?.hasTicks !== true) {
    dataKind = "bars_1s";
  }

  const hasTicks = dataKind === "ticks" || input?.hasTicks === true || (tickCount != null && tickCount > 0);
  const hasBars1s =
    input?.hasBars1s === true ||
    (bars1sCount != null && bars1sCount > 0) ||
    dataKind === "bars_1s" ||
    hasBarsExplicit;

  // Phase A: execution always 1s path
  return {
    dataKind: hasTicks && dataKind === "ticks" ? "ticks" : hasTicks ? "ticks" : "bars_1s",
    hasTicks: !!hasTicks,
    hasBars1s: hasBars1s || (bars1sCount != null && bars1sCount > 0) || dataKind === "bars_1s",
    tickCount: hasTicks ? tickCount : undefined,
    bars1sCount,
    priceBasis: "mid",
    executionBasis: "bars_1s",
    source,
  };
}

/** Header / column names → kind. OHLCV-only always bars_1s. */
export function detectKindFromColumnNames(columns: string[]): DatasetKind {
  const set = new Set(columns.map((c) => c.trim().toLowerCase()).filter(Boolean));
  const hasBid = set.has("bid");
  const hasAsk = set.has("ask");
  const hasOhlc =
    set.has("open") && set.has("high") && set.has("low") && set.has("close");
  // Tick stream: time + bid + ask (volume columns optional)
  if (hasBid && hasAsk && !hasOhlc) return "ticks";
  if (hasBid && hasAsk && hasOhlc) {
    // Mixed header — treat as ticks-capable dataset only if not pure OHLCV legacy
    return "ticks";
  }
  return "bars_1s";
}

/**
 * Build meta for a day package being imported.
 * Priority: explicit package fields > column detection > bars-only default.
 */
export function metaForImportPackage(opts: {
  explicit?: DatasetMetaInput | null;
  columns?: string[];
  bars1sCount: number;
  source?: string;
}): DatasetDayMeta {
  if (opts.explicit && (opts.explicit.dataKind || opts.explicit.hasTicks || opts.explicit.tickCount)) {
    return normalizeDatasetDayMeta(opts.explicit, {
      bars1sCount: opts.bars1sCount,
      source: opts.source ?? opts.explicit.source,
    });
  }
  if (opts.columns && opts.columns.length) {
    const kind = detectKindFromColumnNames(opts.columns);
    if (kind === "ticks") {
      return normalizeDatasetDayMeta(
        {
          dataKind: "ticks",
          hasTicks: true,
          hasBars1s: opts.bars1sCount > 0,
          bars1sCount: opts.bars1sCount,
          source: opts.source,
        },
        { bars1sCount: opts.bars1sCount, source: opts.source }
      );
    }
  }
  return defaultBars1sMeta({ bars1sCount: opts.bars1sCount, source: opts.source });
}

/** Read path: fill defaults for pre-Phase-A IndexedDB rows. */
export function metaFromDayRow(row: {
  dataKind?: string;
  hasTicks?: boolean;
  hasBars1s?: boolean;
  tickCount?: number;
  bars1sCount?: number;
  priceBasis?: string;
  executionBasis?: string;
  source?: string;
  barCount?: number;
  bars?: { length: number };
} | null | undefined): DatasetDayMeta {
  if (!row) return defaultBars1sMeta();
  const bars1sCount =
    typeof row.bars1sCount === "number"
      ? row.bars1sCount
      : typeof row.barCount === "number"
        ? row.barCount
        : row.bars?.length;
  return normalizeDatasetDayMeta(
    {
      dataKind: row.dataKind,
      hasTicks: row.hasTicks,
      hasBars1s: row.hasBars1s,
      tickCount: row.tickCount,
      bars1sCount,
      priceBasis: row.priceBasis,
      executionBasis: row.executionBasis,
      source: row.source,
    },
    { bars1sCount, source: row.source }
  );
}

export function mergeDatasetMeta(
  existing: DatasetDayMeta | null | undefined,
  incoming: DatasetDayMeta
): DatasetDayMeta {
  if (!existing) return incoming;
  const hasTicks = existing.hasTicks || incoming.hasTicks;
  const tickCount = Math.max(existing.tickCount ?? 0, incoming.tickCount ?? 0) || undefined;
  const bars1sCount =
    incoming.bars1sCount != null
      ? incoming.bars1sCount
      : existing.bars1sCount;
  return normalizeDatasetDayMeta(
    {
      dataKind: hasTicks ? "ticks" : "bars_1s",
      hasTicks,
      hasBars1s: existing.hasBars1s || incoming.hasBars1s || (bars1sCount != null && bars1sCount > 0),
      tickCount: hasTicks ? tickCount : undefined,
      bars1sCount,
      source: incoming.source || existing.source,
    },
    { bars1sCount, source: incoming.source || existing.source }
  );
}
