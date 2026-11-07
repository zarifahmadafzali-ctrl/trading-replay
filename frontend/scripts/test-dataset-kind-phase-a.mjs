/**
 * Phase A — dataset kind detection & metadata (no tick storage).
 * Run: node frontend/scripts/test-dataset-kind-phase-a.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Load compiled-free pure TS via dynamic transpile is heavy; mirror pure functions by importing from dist if any.
// Instead: inline-evaluate by spawning tsx or copy logic - project uses plain node tests that re-implement.
// Prefer importing the TS via node --experimental if available. Fallback: duplicate pure logic for assert parity.

function assert(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("PASS", name);
  }
}

// --- Mirror of datasetMeta.ts (keep in sync) ---
function defaultBars1sMeta(opts) {
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

function normalizeDatasetDayMeta(input, context) {
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
  const hasTicksExplicit =
    input?.hasTicks === true || explicitKind === "ticks" || (tickCount != null && tickCount > 0);
  if (!input || (explicitKind == null && input.hasTicks !== true && (tickCount == null || tickCount === 0))) {
    if (!hasTicksExplicit) return defaultBars1sMeta({ bars1sCount, source });
  }
  let dataKind = explicitKind ?? (hasTicksExplicit ? "ticks" : "bars_1s");
  if (dataKind === "ticks" && !hasTicksExplicit && !(tickCount != null && tickCount > 0) && input?.hasTicks !== true) {
    dataKind = "bars_1s";
  }
  const hasTicks = dataKind === "ticks" || input?.hasTicks === true || (tickCount != null && tickCount > 0);
  return {
    dataKind: hasTicks ? "ticks" : "bars_1s",
    hasTicks: !!hasTicks,
    hasBars1s: input?.hasBars1s === true || (bars1sCount != null && bars1sCount > 0) || dataKind === "bars_1s",
    tickCount: hasTicks ? tickCount : undefined,
    bars1sCount,
    priceBasis: "mid",
    executionBasis: "bars_1s",
    source,
  };
}

function detectKindFromColumnNames(columns) {
  const set = new Set(columns.map((c) => c.trim().toLowerCase()).filter(Boolean));
  const hasBid = set.has("bid");
  const hasAsk = set.has("ask");
  const hasOhlc = set.has("open") && set.has("high") && set.has("low") && set.has("close");
  if (hasBid && hasAsk && !hasOhlc) return "ticks";
  if (hasBid && hasAsk && hasOhlc) return "ticks";
  return "bars_1s";
}

function metaForImportPackage(opts) {
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

function metaFromDayRow(row) {
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

// --- Tests ---

// 1) Legacy OHLCV columns
assert(
  "legacy OHLCV columns → bars_1s",
  detectKindFromColumnNames(["time", "open", "high", "low", "close", "volume"]) === "bars_1s"
);

// 2) Tick columns
assert(
  "bid/ask columns → ticks",
  detectKindFromColumnNames(["time", "bid", "ask", "bid_vol", "ask_vol"]) === "ticks"
);

// 3) Missing metadata → bars_1s
const missing = normalizeDatasetDayMeta(null, { bars1sCount: 100 });
assert("null meta → bars_1s", missing.dataKind === "bars_1s" && missing.hasTicks === false);
assert("null meta executionBasis bars_1s", missing.executionBasis === "bars_1s");
assert("null meta priceBasis mid", missing.priceBasis === "mid");

// 4) Incomplete metadata
const incomplete = normalizeDatasetDayMeta({ source: "x" }, { bars1sCount: 5 });
assert("incomplete → bars_1s", incomplete.dataKind === "bars_1s" && incomplete.source === "x");

// 5) Explicit ticks
const tickMeta = normalizeDatasetDayMeta(
  { dataKind: "ticks", hasTicks: true, tickCount: 96027, hasBars1s: true, bars1sCount: 36497 },
  {}
);
assert("explicit ticks", tickMeta.dataKind === "ticks" && tickMeta.tickCount === 96027);
assert("explicit ticks still execution 1s", tickMeta.executionBasis === "bars_1s");

// 6) Legacy CSV import package path
const csvMeta = metaForImportPackage({
  columns: ["time", "open", "high", "low", "close", "volume"],
  bars1sCount: 2,
  source: "csv-import",
});
assert("csv OHLCV package bars_1s", csvMeta.dataKind === "bars_1s" && csvMeta.hasTicks === false);

// 7) Legacy .trdata day without kind fields
const trLegacy = metaForImportPackage({
  explicit: {},
  bars1sCount: 50,
  source: undefined,
});
assert("trdata legacy day bars_1s", trLegacy.dataKind === "bars_1s");

// 8) .trdata with explicit tick metadata
const trTick = metaForImportPackage({
  explicit: { dataKind: "ticks", hasTicks: true, tickCount: 10, hasBars1s: true, bars1sCount: 3 },
  bars1sCount: 3,
});
assert("trdata explicit ticks", trTick.dataKind === "ticks" && trTick.hasTicks === true);

// 9) Legacy IndexedDB row (no meta fields)
const fromRow = metaFromDayRow({ barCount: 42, bars: { length: 42 } });
assert("legacy row defaults bars_1s", fromRow.dataKind === "bars_1s" && fromRow.bars1sCount === 42);

// 10) Fake "ticks" without evidence coerced? explicit dataKind ticks without hasTicks/tickCount
const fake = normalizeDatasetDayMeta({ dataKind: "ticks" }, { bars1sCount: 1 });
// dataKind ticks is explicit → keep ticks but hasTicks should be true from explicitKind
assert("explicit dataKind ticks honored", fake.dataKind === "ticks" && fake.hasTicks === true);

// 11) Replay contract: Phase A never sets executionBasis to ticks
assert(
  "never tick execution in Phase A defaults",
  [missing, csvMeta, trLegacy, tickMeta].every((m) => m.executionBasis === "bars_1s")
);

if (process.exitCode) {
  console.error("\nPhase A dataset-kind tests FAILED");
  process.exit(1);
}
console.log("\nPhase A dataset-kind tests: ALL PASS");
