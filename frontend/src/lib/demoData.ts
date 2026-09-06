import type { Bar } from "./types";

export function generateDemoBars(): Bar[] {
  const bars: Bar[] = [];
  let price = 42000;
  const start = Date.UTC(2025, 0, 2, 14, 30) / 1000;

  for (let i = 0; i < 5000; i++) {
    const drift = Math.sin(i / 13) * 18 + Math.sin(i / 3) * 5 + ((i % 11) - 5);
    const open = price;
    const close = open + drift;
    const high = Math.max(open, close) + 8;
    const low = Math.min(open, close) - 8;
    bars.push({
      time: start + i,
      open,
      high,
      low,
      close,
      volume: 100 + Math.random() * 200,
    });
    price = close;
  }
  return bars;
}

export function parseCsvBars(text: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  if (!header) return [];

  const cols = header.split(",").map((c) => c.toLowerCase().trim());
  const indexOf = (names: string[]) => {
    for (const n of names) {
      const i = cols.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const timeIdx = indexOf(["time", "timestamp", "datetime"]);
  const openIdx = indexOf(["open", "o"]);
  const highIdx = indexOf(["high", "h"]);
  const lowIdx = indexOf(["low", "l"]);
  const closeIdx = indexOf(["close", "c"]);
  const volIdx = indexOf(["volume", "vol", "v"]);

  const out: Bar[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(",");

    let t = Number(parts[timeIdx]);
    if (!Number.isFinite(t)) {
      t = Date.parse(parts[timeIdx]) / 1000;
    }
    if (t > 1e12) t /= 1000;

    const bar: Bar = {
      time: Math.floor(t),
      open: Number(parts[openIdx]),
      high: Number(parts[highIdx]),
      low: Number(parts[lowIdx]),
      close: Number(parts[closeIdx]),
      volume: volIdx < 0 ? 0 : Number(parts[volIdx]) || 0,
    };

    if (Object.values(bar).every((v) => Number.isFinite(v))) {
      out.push(bar);
    }
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

export function readCsvFile(file: File): Promise<Bar[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(parseCsvBars(String(reader.result)));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
