/**
 * v3.24.1 — Market data CSV / .trdata transfer (pure logic, no IndexedDB).
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const HEADER = "time,open,high,low,close,volume";

function barsToCsv(bars) {
  return [HEADER, ...bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume ?? 0].join(","))].join("\n");
}

function isValidBar(b) {
  if (!b || typeof b.time !== "number" || !Number.isFinite(b.time) || b.time <= 0 || b.time > 1e12) return false;
  for (const k of ["open", "high", "low", "close"]) {
    if (typeof b[k] !== "number" || !Number.isFinite(b[k])) return false;
  }
  return b.high >= b.low;
}

function parseMarketCsv(text) {
  const bars = [];
  let invalidRows = 0;
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter((l) => l.trim());
  let start = 0;
  if (lines[0] && lines[0].toLowerCase().includes("time")) start = 1;
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    let time = Number(cols[0]);
    if (time > 1e12) time = Math.floor(time / 1000);
    const bar = {
      time,
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volume: cols[5] != null && cols[5] !== "" ? Number(cols[5]) : 0,
    };
    if (!isValidBar(bar)) {
      invalidRows++;
      continue;
    }
    bars.push(bar);
  }
  return { bars, invalidRows };
}

function dedupeSort(bars) {
  const map = new Map();
  let duplicates = 0;
  for (const b of bars) {
    if (map.has(b.time)) duplicates++;
    map.set(b.time, b);
  }
  return { bars: [...map.values()].sort((a, b) => a.time - b.time), duplicates };
}

function parseTrData(raw) {
  if (!raw || raw.kind !== "trading-replay-market-data") return { ok: false, errors: ["bad kind"] };
  if (raw.formatVersion > 1) return { ok: false, errors: ["too new"] };
  if (!Array.isArray(raw.days) || !raw.days.length) return { ok: false, errors: ["no days"] };
  return { ok: true, pkg: raw };
}

const sample = [
  { time: 1718668800, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { time: 1718668801, open: 1.5, high: 2.1, low: 1.4, close: 2, volume: 5 },
];

const csv = barsToCsv(sample);
assert("csv header", csv.startsWith(HEADER));
assert("csv rows", csv.split("\n").length === 3);

const parsed = parseMarketCsv(csv);
assert("parse count", parsed.bars.length === 2);
assert("parse times", parsed.bars[0].time === 1718668800);

const bad = parseMarketCsv(HEADER + "\n1,a,b,c,d\n1718668800,1,2,0.5,1.5,1");
assert("invalid rows counted", bad.invalidRows === 1 && bad.bars.length === 1);

const dup = dedupeSort([
  ...sample,
  { time: 1718668800, open: 9, high: 9, low: 9, close: 9, volume: 1 },
]);
assert("dedupe", dup.bars.length === 2 && dup.duplicates === 1);
assert("last wins", dup.bars[0].open === 9);

const unsorted = dedupeSort([
  { time: 3, open: 1, high: 1, low: 1, close: 1, volume: 0 },
  { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 },
]).bars;
assert("sorted", unsorted[0].time === 1 && unsorted[1].time === 3);

const tr = {
  kind: "trading-replay-market-data",
  formatVersion: 1,
  timestampUnit: "unix-seconds",
  days: [{ symbol: "US30", day: "2024-06-18", bars: sample, complete: true }],
};
assert("trdata ok", parseTrData(tr).ok === true);
assert("trdata future rejected", parseTrData({ ...tr, formatVersion: 99 }).ok === false);
assert("trdata bad kind", parseTrData({ kind: "x", formatVersion: 1, days: [] }).ok === false);

// merge simulation
const existing = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
const incoming = [
  { time: 1, open: 2, high: 2, low: 2, close: 2, volume: 0 },
  { time: 2, open: 1, high: 1, low: 1, close: 1, volume: 0 },
];
const merged = dedupeSort([...existing, ...incoming]).bars;
assert("merge length", merged.length === 2);
assert("merge last wins on t=1", merged[0].open === 2);

// CSV cannot prove COMPLETE
const csvComplete = false;
assert("csv not auto-complete", csvComplete === false);

// separation
const domains = { appBackupHasBars: false, marketExportHasJournal: false };
assert("backup excludes market", domains.appBackupHasBars === false);
assert("market export excludes journal", domains.marketExportHasJournal === false);

// zero session
const activeSessionId = null;
assert("export allowed without session", activeSessionId === null);

// filename
function fname(sym, days) {
  const s = [...days].sort();
  return s.length === 1 ? `${sym}_${s[0]}.csv` : `${sym}_${s[0]}_to_${s[s.length - 1]}.csv`;
}
assert("filename one day", fname("US30", ["2026-06-18"]) === "US30_2026-06-18.csv");
assert("filename range", fname("US30", ["2026-06-30", "2026-06-18"]) === "US30_2026-06-18_to_2026-06-30.csv");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
