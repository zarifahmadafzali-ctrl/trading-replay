/**
 * v3.24.1 — Cross-device market data export/import (CSV + .trdata).
 *
 * Source of truth: barCache (symbol|day). NOT Sessions, Journal, or App Backup.
 * Works with activeSessionId = null.
 *
 * Timestamp unit: unix seconds (Bar.time), no timezone conversion.
 */

import type { Bar } from "./types";
import {
  cacheGetDayRow,
  cachePutDay,
  listMarketDays,
  classifyDayStatus,
  eachDay,
  type DayCacheRow,
  type MarketDayInfo,
} from "./barCache";
import { APP_VERSION, MARKET_DATA_EXPORT_FORMAT_VERSION } from "./storageVersions";

export type MarketDayPackage = {
  symbol: string;
  day: string;
  classification?: string;
  complete?: boolean;
  barCount: number;
  firstTime: number | null;
  lastTime: number | null;
  bars: Bar[];
};

export type TrDataPackage = {
  kind: "trading-replay-market-data";
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  timestampUnit: "unix-seconds";
  days: MarketDayPackage[];
};

export type ImportPreview = {
  symbol: string;
  days: string[];
  rowsDetected: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  firstTime: number | null;
  lastTime: number | null;
  existingBars: number;
  newBars: number;
  byDay: {
    day: string;
    valid: number;
    existing: number;
    willAdd: number;
    statusHint: string;
  }[];
  errors: string[];
  packages: MarketDayPackage[];
};

export type ImportResult = {
  ok: boolean;
  daysWritten: number;
  barsWritten: number;
  errors: string[];
};

function dayFromUnix(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function isValidBar(b: Partial<Bar>): b is Bar {
  if (!b || typeof b.time !== "number" || !Number.isFinite(b.time)) return false;
  if (b.time <= 0 || b.time > 1e12) return false; // seconds, not ms
  for (const k of ["open", "high", "low", "close"] as const) {
    const v = b[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  if ((b.high as number) < (b.low as number)) return false;
  if (b.volume != null && (!Number.isFinite(b.volume) || (b.volume as number) < 0)) return false;
  return true;
}

function dedupeSort(bars: Bar[]): { bars: Bar[]; duplicates: number } {
  const map = new Map<number, Bar>();
  let duplicates = 0;
  for (const b of bars) {
    if (map.has(b.time)) duplicates += 1;
    map.set(b.time, b);
  }
  const out = Array.from(map.values()).sort((a, b) => a.time - b.time);
  return { bars: out, duplicates };
}

/** CSV header — canonical Bar fields, time = unix seconds. */
export const MARKET_CSV_HEADER = "time,open,high,low,close,volume";

export function barsToCsv(bars: Bar[]): string {
  const lines = [MARKET_CSV_HEADER];
  for (const b of bars) {
    lines.push(
      [b.time, b.open, b.high, b.low, b.close, b.volume ?? 0].join(",")
    );
  }
  return lines.join("\n");
}

export function parseMarketCsv(text: string): {
  bars: Bar[];
  invalidRows: number;
  errors: string[];
} {
  const errors: string[] = [];
  const bars: Bar[] = [];
  let invalidRows = 0;
  const raw = text.replace(/^\uFEFF/, "").trim();
  if (!raw) {
    return { bars: [], invalidRows: 0, errors: ["Empty CSV"] };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) {
    return { bars: [], invalidRows: 0, errors: ["Empty CSV"] };
  }
  let start = 0;
  const header = lines[0].toLowerCase();
  if (header.includes("time") && header.includes("open")) {
    start = 1;
    if (!header.includes("time") || !header.includes("open") || !header.includes("close")) {
      errors.push("CSV header missing required columns (time,open,high,low,close)");
    }
  }
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length < 5) {
      invalidRows += 1;
      continue;
    }
    let time = Number(cols[0]);
    // Accept ms if clearly ms
    if (time > 1e12) time = Math.floor(time / 1000);
    const bar: Partial<Bar> = {
      time,
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volume: cols[5] != null && cols[5] !== "" ? Number(cols[5]) : 0,
    };
    if (!isValidBar(bar)) {
      invalidRows += 1;
      continue;
    }
    bars.push(bar);
  }
  return { bars, invalidRows, errors };
}

export function parseTrData(raw: unknown): { ok: true; pkg: TrDataPackage } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Not a JSON object"] };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind !== "trading-replay-market-data") {
    errors.push("Not a trading-replay-market-data package");
  }
  if (typeof o.formatVersion !== "number") {
    errors.push("Missing formatVersion");
  } else if (o.formatVersion > MARKET_DATA_EXPORT_FORMAT_VERSION) {
    errors.push(
      `formatVersion ${o.formatVersion} newer than supported ${MARKET_DATA_EXPORT_FORMAT_VERSION}`
    );
  } else if (o.formatVersion < 1) {
    errors.push("Unsupported formatVersion");
  }
  if (o.timestampUnit && o.timestampUnit !== "unix-seconds") {
    errors.push(`Unsupported timestampUnit: ${String(o.timestampUnit)}`);
  }
  if (!Array.isArray(o.days) || !o.days.length) {
    errors.push("No days array");
  }
  if (errors.length) return { ok: false, errors };

  const days: MarketDayPackage[] = [];
  for (const d of o.days as unknown[]) {
    if (!d || typeof d !== "object") continue;
    const row = d as Record<string, unknown>;
    const symbol = String(row.symbol || "").toUpperCase();
    const day = String(row.day || "");
    if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      errors.push(`Invalid day entry symbol/day`);
      continue;
    }
    const rawBars = Array.isArray(row.bars) ? row.bars : [];
    const bars: Bar[] = [];
    for (const b of rawBars) {
      if (b && typeof b === "object" && isValidBar(b as Partial<Bar>)) {
        bars.push(b as Bar);
      }
    }
    const { bars: unique } = dedupeSort(bars);
    days.push({
      symbol,
      day,
      classification: typeof row.classification === "string" ? row.classification : undefined,
      complete: row.complete === true,
      barCount: unique.length,
      firstTime: unique[0]?.time ?? null,
      lastTime: unique[unique.length - 1]?.time ?? null,
      bars: unique,
    });
  }
  if (!days.length) {
    return { ok: false, errors: errors.length ? errors : ["No valid days in package"] };
  }
  return {
    ok: true,
    pkg: {
      kind: "trading-replay-market-data",
      formatVersion: o.formatVersion as number,
      appVersion: String(o.appVersion || ""),
      exportedAt: String(o.exportedAt || new Date().toISOString()),
      timestampUnit: "unix-seconds",
      days,
    },
  };
}

export async function buildDayPackage(symbol: string, day: string): Promise<MarketDayPackage | null> {
  const row = await cacheGetDayRow(symbol, day);
  if (!row) return null;
  const bars = Array.isArray(row.bars) ? [...row.bars] : [];
  const { bars: unique } = dedupeSort(bars);
  return {
    symbol: symbol.toUpperCase(),
    day,
    classification: row.classification,
    complete: row.complete === true,
    barCount: unique.length,
    firstTime: unique[0]?.time ?? null,
    lastTime: unique[unique.length - 1]?.time ?? null,
    bars: unique,
  };
}

export async function exportDaysToCsv(symbol: string, days: string[]): Promise<{ csv: string; barCount: number; filename: string }> {
  const all: Bar[] = [];
  for (const day of days) {
    const pkg = await buildDayPackage(symbol, day);
    if (pkg) all.push(...pkg.bars);
  }
  const { bars } = dedupeSort(all);
  const sortedDays = [...days].sort();
  const filename =
    sortedDays.length === 1
      ? `${symbol.toUpperCase()}_${sortedDays[0]}.csv`
      : `${symbol.toUpperCase()}_${sortedDays[0]}_to_${sortedDays[sortedDays.length - 1]}.csv`;
  return { csv: barsToCsv(bars), barCount: bars.length, filename };
}

export async function exportDaysToTrData(
  symbol: string,
  days: string[]
): Promise<{ json: string; barCount: number; filename: string }> {
  const packages: MarketDayPackage[] = [];
  let barCount = 0;
  for (const day of days) {
    const pkg = await buildDayPackage(symbol, day);
    if (pkg) {
      packages.push(pkg);
      barCount += pkg.barCount;
    }
  }
  const sortedDays = [...days].sort();
  const tr: TrDataPackage = {
    kind: "trading-replay-market-data",
    formatVersion: MARKET_DATA_EXPORT_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    timestampUnit: "unix-seconds",
    days: packages,
  };
  const filename =
    sortedDays.length === 1
      ? `${symbol.toUpperCase()}_${sortedDays[0]}.trdata`
      : `${symbol.toUpperCase()}_${sortedDays[0]}_to_${sortedDays[sortedDays.length - 1]}.trdata`;
  return { json: JSON.stringify(tr), barCount, filename };
}

export function downloadTextFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Build import preview from parsed packages (CSV collapsed to days or .trdata days). */
export async function previewMarketImport(packages: MarketDayPackage[]): Promise<ImportPreview> {
  const errors: string[] = [];
  const symbols = new Set(packages.map((p) => p.symbol));
  if (symbols.size > 1) {
    errors.push(`Mixed symbols in one import: ${[...symbols].join(", ")}`);
  }
  const symbol = packages[0]?.symbol || "";
  let rowsDetected = 0;
  let validRows = 0;
  let duplicateRows = 0;
  let existingBars = 0;
  let newBars = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const byDay: ImportPreview["byDay"] = [];

  for (const pkg of packages) {
    rowsDetected += pkg.bars.length;
    const { bars, duplicates } = dedupeSort(pkg.bars);
    duplicateRows += duplicates;
    validRows += bars.length;
    if (bars[0]) {
      firstTime = firstTime == null ? bars[0].time : Math.min(firstTime, bars[0].time);
    }
    if (bars[bars.length - 1]) {
      lastTime =
        lastTime == null
          ? bars[bars.length - 1].time
          : Math.max(lastTime, bars[bars.length - 1].time);
    }
    const existing = await cacheGetDayRow(pkg.symbol, pkg.day);
    const existCount = existing?.barCount ?? existing?.bars?.length ?? 0;
    existingBars += existCount;
    const existSet = new Set((existing?.bars || []).map((b) => b.time));
    let willAdd = 0;
    for (const b of bars) {
      if (!existSet.has(b.time)) willAdd += 1;
    }
    newBars += willAdd;
    byDay.push({
      day: pkg.day,
      valid: bars.length,
      existing: existCount,
      willAdd,
      statusHint: pkg.complete ? "will preserve COMPLETE if metadata says so" : "PARTIAL unless already complete locally",
    });
  }

  return {
    symbol,
    days: packages.map((p) => p.day),
    rowsDetected,
    validRows,
    invalidRows: 0,
    duplicateRows,
    firstTime,
    lastTime,
    existingBars,
    newBars,
    byDay,
    errors,
    packages,
  };
}

/** CSV text → day packages (split by UTC day). */
export function csvTextToDayPackages(
  text: string,
  forcedSymbol?: string
): { packages: MarketDayPackage[]; invalidRows: number; errors: string[] } {
  const parsed = parseMarketCsv(text);
  const { bars, duplicates } = dedupeSort(parsed.bars);
  const byDay = new Map<string, Bar[]>();
  for (const b of bars) {
    const day = dayFromUnix(b.time);
    let arr = byDay.get(day);
    if (!arr) {
      arr = [];
      byDay.set(day, arr);
    }
    arr.push(b);
  }
  const symbol = (forcedSymbol || "IMPORT").toUpperCase();
  const packages: MarketDayPackage[] = [];
  for (const [day, dayBars] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { bars: unique } = dedupeSort(dayBars);
    packages.push({
      symbol,
      day,
      complete: false, // CSV cannot prove full-day completeness
      classification: "SUCCESS",
      barCount: unique.length,
      firstTime: unique[0]?.time ?? null,
      lastTime: unique[unique.length - 1]?.time ?? null,
      bars: unique,
    });
  }
  return {
    packages,
    invalidRows: parsed.invalidRows,
    errors: parsed.errors,
  };
}

/**
 * Merge import into barCache.
 * complete: only true if package says complete OR existing was complete and we merge more data.
 * Never marks COMPLETE solely because CSV had some rows.
 */
export async function importMarketPackages(
  packages: MarketDayPackage[],
  opts?: { replaceDays?: boolean }
): Promise<ImportResult> {
  const errors: string[] = [];
  let daysWritten = 0;
  let barsWritten = 0;
  for (const pkg of packages) {
    try {
      const existing = await cacheGetDayRow(pkg.symbol, pkg.day);
      let merged: Bar[];
      if (opts?.replaceDays) {
        merged = dedupeSort(pkg.bars).bars;
      } else {
        const prev = existing?.bars || [];
        merged = dedupeSort([...prev, ...pkg.bars]).bars;
      }
      const wasComplete = existing?.complete === true;
      const complete = opts?.replaceDays
        ? pkg.complete === true
        : wasComplete || pkg.complete === true;
      const classification =
        pkg.classification ||
        existing?.classification ||
        (merged.length ? "SUCCESS" : "EXPECTED_EMPTY");
      await cachePutDay(pkg.symbol, pkg.day, merged, {
        classification,
        complete: complete && merged.length > 0 ? true : pkg.complete === true && merged.length === 0,
      });
      // If not proven complete and wasn't complete, force partial
      if (!wasComplete && pkg.complete !== true && merged.length > 0) {
        await cachePutDay(pkg.symbol, pkg.day, merged, {
          classification: "SUCCESS",
          complete: false,
        });
      }
      daysWritten += 1;
      barsWritten += merged.length;
    } catch (e) {
      errors.push(`${pkg.symbol}|${pkg.day}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: errors.length === 0, daysWritten, barsWritten, errors };
}

export async function listDaysForSymbol(symbol: string): Promise<MarketDayInfo[]> {
  return listMarketDays(symbol);
}

export { eachDay, classifyDayStatus };
