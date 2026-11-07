/**
 * Phase B.1a — Parquet READ helpers via hyparquet (Snappy supported built-in).
 * Write/export is intentionally out of scope (Phase B.1b).
 */

export type ParquetReadResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  error?: string;
};

/** Wrap ArrayBuffer as hyparquet AsyncBuffer (byteLength + slice). */
export function asyncBufferFromArrayBuffer(ab: ArrayBuffer): {
  byteLength: number;
  slice: (start: number, end?: number) => ArrayBuffer;
} {
  return {
    byteLength: ab.byteLength,
    slice: (start: number, end?: number) => ab.slice(start, end),
  };
}

/**
 * Read all rows from a Parquet ArrayBuffer using dynamic import of hyparquet.
 * Snappy is supported by hyparquet without hyparquet-compressors.
 */
export async function readParquetObjects(
  buffer: ArrayBuffer
): Promise<ParquetReadResult> {
  try {
    const mod = await import("hyparquet");
    const parquetReadObjects = (mod as {
      parquetReadObjects?: (opts: {
        file: { byteLength: number; slice: (start: number, end?: number) => ArrayBuffer };
      }) => Promise<Record<string, unknown>[]>;
    }).parquetReadObjects;

    if (typeof parquetReadObjects !== "function") {
      return {
        rows: [],
        rowCount: 0,
        error: "hyparquet loaded but parquetReadObjects is missing",
      };
    }

    const file = asyncBufferFromArrayBuffer(buffer);
    const rows = await parquetReadObjects({ file });
    const list = Array.isArray(rows) ? rows : [];
    return {
      rows: list as Array<Record<string, unknown>>,
      rowCount: list.length,
    };
  } catch (e) {
    return {
      rows: [],
      rowCount: 0,
      error: `Parquet read failed: ${e instanceof Error ? e.message : String(e)}. Ensure hyparquet is installed (npm install).`,
    };
  }
}

const TICK_COLS = ["time", "bid", "ask", "bid_vol", "ask_vol", "mid"] as const;
const BAR_COLS = ["time", "open", "high", "low", "close", "volume"] as const;

/** Normalize parquet row keys to lowercase for schema tolerance. */
function lowerKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

/** Map parquet tick rows to plain objects with TR Market Data column names. */
export function mapTickParquetRows(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((raw) => {
    const r = lowerKeys(raw);
    return {
      time: r.time,
      bid: r.bid,
      ask: r.ask,
      bid_vol: r.bid_vol ?? r.bidvol ?? 0,
      ask_vol: r.ask_vol ?? r.askvol ?? 0,
      mid: r.mid,
    };
  });
}

/** Map parquet 1s bar rows to Bar-like plain objects. */
export function mapBars1sParquetRows(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((raw) => {
    const r = lowerKeys(raw);
    return {
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume ?? 0,
    };
  });
}

export function detectParquetKind(
  rows: Array<Record<string, unknown>>
): "ticks" | "bars_1s" | "unknown" {
  if (!rows.length) return "unknown";
  const r = lowerKeys(rows[0]);
  if ("bid" in r && "ask" in r) return "ticks";
  if ("open" in r && "close" in r && "high" in r) return "bars_1s";
  return "unknown";
}

export { TICK_COLS, BAR_COLS };
