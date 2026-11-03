/**
 * v3.43.9 — Journal higher-timeframe snapshots (compact bar data, not PNG).
 * Captured at fill/close using the same aggregateVisible path as ReplayView.
 * No look-ahead: only bars with time <= last 1s bar before cursorIndex.
 */

import type { Bar } from "./types";

export type HtfBarTuple = [time: number, open: number, high: number, low: number, close: number];

export type HtfSnapshot = {
  tf: number;
  event: "fill" | "tp" | "sl" | "manual";
  /** Replay unix time of the event (never wall-clock Date.now). */
  t: number;
  bars: HtfBarTuple[];
  entry: number;
  sl: number;
  tp: number;
  exit?: number;
};

/** Per-session journal snapshot preferences. Default = off (PNG-only, current behavior). */
export type JournalSnapshotConfig = {
  enabled: boolean;
  atFill: boolean;
  atClose: { tp: boolean; sl: boolean; manual: boolean };
  /** Timeframe seconds, e.g. [900, 3600, 14400, 86400]. */
  timeframes: number[];
  /** Keep existing visible-TF PNG screenshots. */
  includeCurrentTf: boolean;
};

export const DEFAULT_JOURNAL_SNAPSHOT_CONFIG: JournalSnapshotConfig = {
  enabled: false,
  atFill: true,
  atClose: { tp: true, sl: true, manual: true },
  timeframes: [],
  includeCurrentTf: true,
};

export function normalizeJournalSnapshotConfig(
  raw?: Partial<JournalSnapshotConfig> | null
): JournalSnapshotConfig {
  const d = DEFAULT_JOURNAL_SNAPSHOT_CONFIG;
  if (!raw || typeof raw !== "object") {
    return { ...d, atClose: { ...d.atClose }, timeframes: [] };
  }
  const at = raw.atClose || d.atClose;
  const tfs = Array.isArray(raw.timeframes)
    ? raw.timeframes
        .map((n) => Math.max(1, Math.floor(Number(n) || 0)))
        .filter((n) => n > 0)
    : [];
  return {
    enabled: !!raw.enabled,
    atFill: raw.atFill !== false,
    atClose: {
      tp: at.tp !== false,
      sl: at.sl !== false,
      manual: at.manual !== false,
    },
    timeframes: tfs,
    includeCurrentTf: raw.includeCurrentTf !== false,
  };
}

export function normalizeHtfSnapshots(raw: unknown): HtfSnapshot[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: HtfSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const tf = Number(o.tf);
    const event = o.event;
    if (!Number.isFinite(tf) || tf <= 0) continue;
    if (event !== "fill" && event !== "tp" && event !== "sl" && event !== "manual") continue;
    const barsRaw = Array.isArray(o.bars) ? o.bars : [];
    const bars: HtfBarTuple[] = [];
    for (const b of barsRaw) {
      if (!Array.isArray(b) || b.length < 5) continue;
      const t = Number(b[0]);
      const open = Number(b[1]);
      const high = Number(b[2]);
      const low = Number(b[3]);
      const close = Number(b[4]);
      if (![t, open, high, low, close].every(Number.isFinite)) continue;
      bars.push([t, open, high, low, close]);
    }
    out.push({
      tf,
      event,
      t: Number(o.t) || 0,
      bars,
      entry: Number(o.entry) || 0,
      sl: Number(o.sl) || 0,
      tp: Number(o.tp) || 0,
      exit: o.exit != null && Number.isFinite(Number(o.exit)) ? Number(o.exit) : undefined,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Build compact HTF snapshots from 1s bars.
 * `cursorIndex` is exclusive end index into bars1s (ReplayView aggregateVisible convention).
 */
/** How many HTF candles to keep — denser on low TF, fewer on Daily so bars are not huge. */
export function suggestedCandleCount(tfSeconds: number, override?: number): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const tf = Math.max(1, Math.floor(tfSeconds || 1));
  if (tf <= 60) return 120; // 1m
  if (tf <= 300) return 100; // 5m
  if (tf <= 900) return 80; // 15m
  if (tf <= 1800) return 72; // 30m
  if (tf <= 3600) return 72; // 1H
  if (tf <= 14400) return 60; // 4H
  if (tf <= 86400) return 48; // Daily — fewer bars → readable body width
  return 40; // weekly+
}

export function formatTfLabel(tfSeconds: number): string {
  const tf = Math.max(1, Math.floor(tfSeconds || 1));
  if (tf >= 86400 && tf % 86400 === 0) return `${tf / 86400}D`;
  if (tf >= 3600 && tf % 3600 === 0) return `${tf / 3600}H`;
  if (tf >= 60 && tf % 60 === 0) return `${tf / 60}m`;
  return `${tf}s`;
}

export function buildHtfSnapshots(opts: {
  bars1s: Bar[];
  cursorIndex: number;
  timeframes: number[];
  event: "fill" | "tp" | "sl" | "manual";
  eventTimeUnix: number;
  entry: number;
  sl: number;
  tp: number;
  exit?: number;
  /** Optional global override; when omitted each TF uses suggestedCandleCount(tf). */
  maxCandles?: number;
  aggregateVisible: (rows: Bar[], cursorIndex: number, timeframeSeconds: number) => Bar[];
}): HtfSnapshot[] {
  const cursor = Math.max(0, Math.min(opts.cursorIndex, opts.bars1s.length));
  const last1s = cursor > 0 ? opts.bars1s[cursor - 1]?.time : undefined;
  const out: HtfSnapshot[] = [];

  for (const tf of opts.timeframes) {
    if (!Number.isFinite(tf) || tf < 1) continue;
    const agg = opts.aggregateVisible(opts.bars1s, cursor, tf);
    // No look-ahead: drop any bar whose open time is after the last visible 1s bar.
    const trimmed = last1s != null ? agg.filter((b) => b.time <= last1s) : agg;
    const keep = suggestedCandleCount(tf, opts.maxCandles);
    const window = trimmed.slice(-keep);
    out.push({
      tf,
      event: opts.event,
      t: opts.eventTimeUnix,
      bars: window.map((b) => [b.time, b.open, b.high, b.low, b.close] as HtfBarTuple),
      entry: opts.entry,
      sl: opts.sl,
      tp: opts.tp,
      exit: opts.exit,
    });
  }
  return out;
}

/** Soft budget: never drop trade rows; strip images from oldest rows only. */
export const JOURNAL_IMAGE_KEEP = 200;

export function pruneOldestImages<
  T extends {
    entryScreenshot?: string;
    closeScreenshot?: string;
    htfSnapshots?: HtfSnapshot[];
  },
>(trades: T[], keep = JOURNAL_IMAGE_KEEP): T[] {
  if (trades.length <= keep) return trades;
  return trades.map((t, i) => {
    if (i < keep) return t;
    if (!t.entryScreenshot && !t.closeScreenshot && !(t.htfSnapshots && t.htfSnapshots.length)) {
      return t;
    }
    const next = { ...t };
    delete next.entryScreenshot;
    delete next.closeScreenshot;
    delete next.htfSnapshots;
    return next;
  });
}

export async function compressScreenshotDataUrlAsync(
  dataUrl: string,
  maxWidth = 1280,
  quality = 0.8
): Promise<string> {
  if (typeof document === "undefined" || !dataUrl || !dataUrl.startsWith("data:image")) {
    return dataUrl;
  }
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = img.width > maxWidth ? maxWidth / img.width : 1;
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(dataUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch {
      resolve(dataUrl);
    }
  });
}

/**
 * Draw an HTF snapshot onto a canvas (candles + Entry/SL/TP + optional exit).
 * Used by JournalView — does not create a second lightweight-charts instance.
 */
/**
 * Professional framing for journal HTF canvases:
 * - per-TF bar density (via suggestedCandleCount at capture time)
 * - ~15% price padding so Entry/SL/TP are not glued to edges
 * - capped candle body width so Daily is not one fat bar per slot
 * - sparse windows are centered instead of stretched full-width
 */
export function renderHtfSnapshotToCanvas(
  canvas: HTMLCanvasElement,
  snap: HtfSnapshot,
  opts?: { width?: number; height?: number }
): void {
  const w = opts?.width ?? (canvas.width || 960);
  const h = opts?.height ?? (canvas.height || 360);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, w, h);

  const padL = 12;
  const padR = 12;
  const padT = 22;
  const padB = 18;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);
  const n = snap.bars.length;

  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px system-ui, sans-serif";
  const header = `${formatTfLabel(snap.tf)} · ${snap.event}${n ? ` · ${n} bars` : ""}`;
  ctx.fillText(header, padL, 14);

  if (!n) {
    ctx.fillStyle = "#64748b";
    ctx.fillText("No bars in window", padL, padT + 24);
    return;
  }

  const prices: number[] = [];
  for (const b of snap.bars) {
    prices.push(b[1], b[2], b[3], b[4]);
  }
  prices.push(snap.entry, snap.sl, snap.tp);
  if (snap.exit != null) prices.push(snap.exit);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  // 15% vertical padding so levels stay readable
  const rawSpan = hi - lo;
  const pad = Math.max(rawSpan * 0.15, rawSpan * 0.05 + 1e-6);
  lo -= pad;
  hi += pad;
  const span = hi - lo;
  const yOf = (p: number) => padT + ((hi - p) / span) * plotH;

  // Horizontal layout: avoid over-stretching sparse Daily windows
  const idealSlot = 11;
  const naturalWidth = n * idealSlot;
  let xAt: (i: number) => number;
  let slot: number;
  if (naturalWidth < plotW * 0.85) {
    const total = n * idealSlot;
    const start = padL + (plotW - total) / 2;
    slot = idealSlot;
    xAt = (i) => start + (i + 0.5) * idealSlot;
  } else {
    slot = plotW / n;
    xAt = (i) => padL + (i + 0.5) * slot;
  }
  // Cap body width so higher TFs never look like huge blocks
  const candleW = Math.min(10, Math.max(2, slot * 0.62));

  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const [, o, high, low, c] = snap.bars[i];
    const x = xAt(i);
    const up = c >= o;
    ctx.strokeStyle = up ? "#22c55e" : "#ef4444";
    ctx.fillStyle = up ? "#22c55e" : "#ef4444";
    ctx.beginPath();
    ctx.moveTo(x, yOf(high));
    ctx.lineTo(x, yOf(low));
    ctx.stroke();
    const bodyTop = yOf(Math.max(o, c));
    const bodyBot = yOf(Math.min(o, c));
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, Math.max(1, bodyBot - bodyTop));
  }

  const line = (price: number, color: string, label: string) => {
    if (!Number.isFinite(price)) return;
    const y = yOf(price);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = "11px system-ui, sans-serif";
    const text = `${label} ${price.toFixed(2)}`;
    ctx.fillText(text, padL + 4, Math.max(padT + 10, y - 3));
  };

  line(snap.entry, "#38bdf8", "Entry");
  line(snap.sl, "#f87171", "SL");
  line(snap.tp, "#4ade80", "TP");
  if (snap.exit != null) line(snap.exit, "#fbbf24", "Exit");
}
