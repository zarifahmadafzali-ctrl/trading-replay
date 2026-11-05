/**
 * Position tool v2 — pure model (no React, no canvas, no lightweight-charts).
 * Structural types: a PositionShape from Chart.tsx is assignable to PositionLike.
 * Every new field is OPTIONAL, so shapes saved by older versions load unchanged.
 */

export type Side = "long" | "short";
export type PosOrderType =
  | "market"
  | "buy_limit"
  | "sell_limit"
  | "buy_stop"
  | "sell_stop"
  | "buy_stop_limit"
  | "sell_stop_limit";
export type PosStatus = "draft" | "pending" | "open";
export type Pt = { time: number; price: number };
export type RiskModeId = "percent_equity" | "percent_balance" | "fixed_money" | "fixed_lot";

/** Per-position sizing input (TradingView-like). Frozen with the position, not read from a global panel at fill time. */
export type PositionRiskInput = {
  mode?: RiskModeId;
  percent?: number;
  amount?: number;
  lot?: number;
};

export type PositionStyle = {
  profitColor: string;
  stopColor: string;
  lineColor: string;
  textColor: string;
  profitOpacity: number; // 0..1
  stopOpacity: number; // 0..1
  lineWidth: number;
  fontSize: number;
  showPriceLabels: boolean;
  compactStats: boolean;
  alwaysShowStats: boolean;
};

export const DEFAULT_POSITION_STYLE: PositionStyle = {
  profitColor: "#089981",
  stopColor: "#f23645",
  lineColor: "#787b86",
  textColor: "#ffffff",
  profitOpacity: 0.2,
  stopOpacity: 0.2,
  lineWidth: 1,
  fontSize: 11,
  showPriceLabels: true,
  compactStats: false,
  alwaysShowStats: true, // TradingView default is off; on here so running P&L stays visible in replay
};

export type PositionLike = {
  id: string;
  kind: "position";
  side: Side;
  orderType: PosOrderType;
  status: PosStatus;
  entry: Pt;
  stop: Pt;
  takeProfit: Pt;
  stopPrice?: number;
  limitPrice?: number;
  stopTriggered?: boolean;
  accountId?: string;
  riskSnapshot?: Record<string, unknown>;
  entryScreenshot?: string;
  // ---- v2 optional fields ----
  /** Right edge of the box (unix seconds). Absent = legacy full-width lines. */
  rightTime?: number;
  style?: Partial<PositionStyle>;
  risk?: PositionRiskInput;
  locked?: boolean;
  // ---- Brief 02 optional fields ----
  /** false = the order type was chosen by hand and is never auto-detected. Absent/true = auto. */
  orderTypeAuto?: boolean;
  /** Fixed reward:risk. While enabled, the target follows entry/stop. */
  rrLock?: RRLock;
};

export type RRLock = { enabled: boolean; ratio: number };
export const DEFAULT_RR = 2;

export type PositionPart =
  | "stop"
  | "takeProfit"
  | "entry"
  | "stopTrigger"
  | "left"
  | "right"
  | "body";

// ---------------------------------------------------------------- defaults/style

const DEFAULTS_KEY = "tr-pos-defaults-v1";

export function loadPositionDefaults(): Partial<PositionStyle> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DEFAULTS_KEY) : null;
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Partial<PositionStyle>) : {};
  } catch {
    return {};
  }
}

export function savePositionDefaults(style: Partial<PositionStyle>): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(DEFAULTS_KEY, JSON.stringify(style));
  } catch {
    /* storage unavailable */
  }
}

export function resolveStyle(p: Pick<PositionLike, "style">, saved: Partial<PositionStyle> = {}): PositionStyle {
  return { ...DEFAULT_POSITION_STYLE, ...saved, ...(p.style || {}) };
}

/** Old shapes pass through unchanged; invalid v2 fields are dropped.
 *  Legacy full-width positions (no rightTime) get a finite box so they look like TradingView. */
export function normalizePosition<T extends PositionLike>(
  p: T,
  opts?: { barSec?: number; widthBars?: number }
): T {
  const out: T = { ...p };
  if (out.rightTime != null && !(Number.isFinite(out.rightTime) && out.rightTime > out.entry.time)) {
    delete (out as { rightTime?: number }).rightTime;
  }
  // Backfill missing rightTime for draft/pending/open so the painter never falls back to full chart width.
  if (out.rightTime == null && out.entry && Number.isFinite(out.entry.time)) {
    const barSec = Math.max(1, opts?.barSec ?? 60);
    const widthBars = Math.max(4, opts?.widthBars ?? 24);
    (out as { rightTime?: number }).rightTime = out.entry.time + barSec * widthBars;
  }
  if (out.rrLock) {
    const lk = out.rrLock;
    if (typeof lk.enabled !== "boolean" || !(Number.isFinite(lk.ratio) && lk.ratio > 0)) delete out.rrLock;
    else if (lk.ratio < 0.1 || lk.ratio > 100) out.rrLock = { enabled: lk.enabled, ratio: Math.max(0.1, Math.min(100, lk.ratio)) };
  }
  if (out.risk) {
    const r = out.risk;
    const ok =
      (r.percent == null || (Number.isFinite(r.percent) && r.percent > 0)) &&
      (r.amount == null || (Number.isFinite(r.amount) && r.amount > 0)) &&
      (r.lot == null || (Number.isFinite(r.lot) && r.lot > 0));
    if (!ok) delete out.risk;
  }
  return out;
}

// ---------------------------------------------------------------- math

export function tickFromDecimals(decimals: number): number {
  const d = Math.max(0, Math.min(8, Math.floor(decimals)));
  return Math.pow(10, -d);
}

export function snapToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.round(price / tick) * tick;
}

export function riskReward(p: Pick<PositionLike, "entry" | "stop" | "takeProfit">): number | null {
  const risk = Math.abs(p.entry.price - p.stop.price);
  const reward = Math.abs(p.takeProfit.price - p.entry.price);
  if (!(risk > 0)) return null;
  return reward / risk;
}

/** Default draft levels (same 0.4% risk / 0.8% reward as before). */
export function defaultLevels(side: Side, price: number, time: number): Pick<PositionLike, "entry" | "stop" | "takeProfit"> {
  const risk = 0.004;
  const reward = 0.008;
  const entry = { time, price };
  return side === "long"
    ? { entry, stop: { time, price: price * (1 - risk) }, takeProfit: { time, price: price * (1 + reward) } }
    : { entry, stop: { time, price: price * (1 + risk) }, takeProfit: { time, price: price * (1 - reward) } };
}

/** Extra fields for a NEW draft so it gets a finite TradingView-style box.
 *  Box starts at entry (drop time) and extends forward `widthBars` display bars (default 18). */
export function draftBoxExtras(time: number, barSec: number, widthBars = 18): { rightTime: number } {
  return { rightTime: time + Math.max(1, barSec) * Math.max(4, widthBars) };
}

// ---------------------------------------------------------------- validation

export type PositionIssue = { code: string; level: "error" | "warn"; message: string };

const EPS = 1e-9;

export function validatePosition(p: PositionLike, market?: number | null): PositionIssue[] {
  const issues: PositionIssue[] = [];
  const long = p.side === "long";
  const e = p.entry.price;
  const sl = p.stop.price;
  const tp = p.takeProfit.price;
  if (![e, sl, tp].every((x) => Number.isFinite(x))) {
    return [{ code: "nan", level: "error", message: "Entry, Stop and Target must be valid numbers" }];
  }
  if (Math.abs(e - sl) < EPS) issues.push({ code: "zero_sl", level: "error", message: "Stop equals entry" });
  if (long ? sl > e - EPS : sl < e + EPS) {
    issues.push({ code: "sl_side", level: "error", message: long ? "Stop must be below entry for a Long" : "Stop must be above entry for a Short" });
  }
  if (long ? tp < e + EPS : tp > e - EPS) {
    issues.push({ code: "tp_side", level: "error", message: long ? "Target must be above entry for a Long" : "Target must be below entry for a Short" });
  }
  const m = market != null && Number.isFinite(market) ? market : null;
  if (m != null) {
    if (p.status === "open") {
      if (long ? m <= sl : m >= sl) issues.push({ code: "sl_crossed", level: "error", message: "Stop is beyond the current price (would close immediately)" });
      if (long ? m >= tp : m <= tp) issues.push({ code: "tp_crossed", level: "error", message: "Target is beyond the current price (would close immediately)" });
    } else {
      const pendingMsg = pendingVsMarket(p, m);
      if (pendingMsg) issues.push({ code: "pending_side", level: "error", message: pendingMsg });
    }
  }
  return issues;
}

function pendingVsMarket(p: PositionLike, m: number): string | null {
  const e = p.entry.price;
  switch (p.orderType) {
    case "buy_limit":
      return e >= m - EPS ? "Buy Limit entry must be below the market" : null;
    case "sell_limit":
      return e <= m + EPS ? "Sell Limit entry must be above the market" : null;
    case "buy_stop":
      return e <= m + EPS ? "Buy Stop entry must be above the market" : null;
    case "sell_stop":
      return e >= m - EPS ? "Sell Stop entry must be below the market" : null;
    case "buy_stop_limit": {
      const stop = p.stopPrice ?? e;
      const limit = p.limitPrice ?? e;
      if (stop <= m + EPS) return "Buy Stop-Limit stop must be above the market";
      if (limit > stop + EPS) return "Buy Stop-Limit limit must be at or below the stop";
      return null;
    }
    case "sell_stop_limit": {
      const stop = p.stopPrice ?? e;
      const limit = p.limitPrice ?? e;
      if (stop >= m - EPS) return "Sell Stop-Limit stop must be below the market";
      if (limit < stop - EPS) return "Sell Stop-Limit limit must be at or above the stop";
      return null;
    }
    default:
      return null;
  }
}

export function hasErrors(issues: PositionIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

/**
 * Confirm step. A MARKET order is refreshed to the CURRENT replay price/time
 * (previously it filled at the stale price from when the draft was dropped).
 * Levels keep the absolute prices the user set; if the market moved past them,
 * validation reports it and the order is NOT confirmed.
 */
export function prepareConfirm<T extends PositionLike>(
  p: T,
  market: { price: number | null | undefined; time: number | null | undefined }
): { ok: boolean; pos: T; issues: PositionIssue[] } {
  const mp = market.price != null && Number.isFinite(market.price) ? market.price : null;
  const mt = market.time != null && Number.isFinite(market.time) ? market.time : null;
  let pos: T = p;
  if (p.orderType === "market" && mp != null && mt != null) {
    pos = { ...p, entry: { time: mt, price: mp } };
    if (pos.rightTime != null && pos.rightTime <= mt) {
      pos = { ...pos, rightTime: mt + Math.max(60, (p.rightTime ?? mt) - p.entry.time) };
    }
  }
  const asOpen: PositionLike = p.orderType === "market" ? { ...pos, status: "open" } : pos;
  const issues = validatePosition(asOpen, mp);
  return { ok: !hasErrors(issues), pos, issues };
}

// ---------------------------------------------------------------- stats / texts

export type TextCtx = {
  priceDecimals: number;
  tick: number;
  lot?: number | null;
  riskAmount?: number | null;
  rewardAmount?: number | null;
  openPnL?: number | null;
};

export type PositionTexts = {
  target: string;
  stop: string;
  center: string;
  rr: number | null;
  entryTag: string;
};

function signed(n: number, d = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
}

export function buildPositionTexts(p: PositionLike, c: TextCtx): PositionTexts {
  const e = p.entry.price;
  const long = p.side === "long";
  const d = Math.max(0, c.priceDecimals);
  const tpDist = Math.abs(p.takeProfit.price - e);
  const slDist = Math.abs(e - p.stop.price);
  const tpPct = e !== 0 ? (tpDist / Math.abs(e)) * 100 : 0;
  const slPct = e !== 0 ? (slDist / Math.abs(e)) * 100 : 0;
  const tpTicks = c.tick > 0 ? Math.round(tpDist / c.tick) : 0;
  const slTicks = c.tick > 0 ? Math.round(slDist / c.tick) : 0;
  const rr = riskReward(p);
  const tpAmt = c.rewardAmount != null && Number.isFinite(c.rewardAmount) ? `, Amount: ${c.rewardAmount.toFixed(2)}` : "";
  const slAmt = c.riskAmount != null && Number.isFinite(c.riskAmount) ? `, Amount: -${Math.abs(c.riskAmount).toFixed(2)}` : "";
  const target = `Target: ${p.takeProfit.price.toFixed(d)} (${tpPct.toFixed(2)}%) ${tpTicks}${tpAmt}`;
  const stop = `Stop: ${p.stop.price.toFixed(d)} (-${slPct.toFixed(2)}%) ${slTicks}${slAmt}`;
  const parts: string[] = [];
  if (p.status === "open" && c.openPnL != null && Number.isFinite(c.openPnL)) parts.push(`Open P&L: ${signed(c.openPnL)}`);
  if (c.lot != null && Number.isFinite(c.lot)) parts.push(`Qty: ${c.lot}`);
  if (rr != null) parts.push(`Risk/Reward Ratio: ${rr.toFixed(2)}`);
  const center = parts.join(", ");
  const entryTag = `${p.status.toUpperCase()} ${long ? "LONG" : "SHORT"} ${String(p.orderType).replace(/_/g, " ")}`;
  return { target, stop, center, rr, entryTag };
}

export function compactCenter(p: PositionLike, c: TextCtx): string {
  const rr = riskReward(p);
  const bits: string[] = [];
  if (p.status === "open" && c.openPnL != null && Number.isFinite(c.openPnL)) bits.push(signed(c.openPnL));
  if (c.lot != null && Number.isFinite(c.lot)) bits.push(String(c.lot));
  if (rr != null) bits.push(`${rr.toFixed(1)}R`);
  return bits.join(" · ");
}

// ---------------------------------------------------------------- geometry

export type Box = { x0: number; x1: number; entryY: number; stopY: number; tpY: number };

export type BoxCtx = {
  xOf: (time: number) => number | null;
  yOf: (price: number) => number | null;
  w: number;
  minWidth?: number;
};

export function positionBox(p: PositionLike, c: BoxCtx): Box | null {
  const entryY = c.yOf(p.entry.price);
  const stopY = c.yOf(p.stop.price);
  const tpY = c.yOf(p.takeProfit.price);
  if (entryY == null || stopY == null || tpY == null) return null;
  const minW = c.minWidth ?? 48;
  let x0 = 0;
  let x1 = c.w;
  if (p.rightTime != null) {
    const a = c.xOf(p.entry.time);
    const b = c.xOf(p.rightTime);
    // Prefer finite box; never silently expand to full chart width when one side fails.
    if (a != null && b != null) {
      x0 = Math.max(0, Math.min(c.w, a));
      x1 = Math.max(0, Math.min(c.w, b));
    } else if (a != null) {
      x0 = Math.max(0, Math.min(c.w, a));
      x1 = Math.min(c.w, x0 + minW);
    } else if (b != null) {
      x1 = Math.max(0, Math.min(c.w, b));
      x0 = Math.max(0, x1 - minW);
    } else {
      // Both null — last resort centered min-width (still not full width)
      x0 = Math.max(0, (c.w - minW) / 2);
      x1 = Math.min(c.w, x0 + minW);
    }
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (x1 - x0 < minW) x1 = Math.min(c.w, x0 + minW);
    if (x1 - x0 < minW) x0 = Math.max(0, x1 - minW);
  }
  return { x0, x1, entryY, stopY, tpY };
}

export type HitOpts = { tol: number; selected?: boolean };

/** Which part of the position is under (x, y)? null = nothing. Open positions only expose stop/target/right/body. */
export function hitTestPosition(p: PositionLike, b: Box, x: number, y: number, o: HitOpts): PositionPart | null {
  const tol = o.tol;
  const draftOrPending = p.status !== "open";
  const near = (a: number, c: number, t = tol) => Math.abs(a - c) <= t;
  const inX = x >= b.x0 - tol && x <= b.x1 + tol;
  // width handle (right end of entry line)
  if (near(x, b.x1, tol * 1.3) && near(y, b.entryY, tol * 1.3)) return "right";
  if (draftOrPending && near(x, b.x0, tol * 1.3) && near(y, b.entryY, tol * 1.3)) return "left";
  if (inX && near(y, b.tpY)) return "takeProfit";
  if (inX && near(y, b.stopY)) return "stop";
  if (inX && near(y, b.entryY)) return draftOrPending ? "entry" : "body";
  const top = Math.min(b.stopY, b.tpY, b.entryY);
  const bottom = Math.max(b.stopY, b.tpY, b.entryY);
  if (x >= b.x0 && x <= b.x1 && y >= top && y <= bottom) return "body";
  return null;
}

// ---------------------------------------------------------------- drag

export type DragOrigin = { pt: { time: number; price: number }; pos: PositionLike };
export type DragOpts = { tick: number; market?: number | null; barSec: number };

/** Pure drag: always computed from the ORIGIN shape captured at pointer-down. */
function dragCore<T extends PositionLike>(
  p: T,
  part: PositionPart,
  pt: { time: number; price: number },
  origin: DragOrigin,
  o: DragOpts
): T {
  if (p.locked) return p;
  const tick = o.tick > 0 ? o.tick : 0.01;
  const og = origin.pos;
  const long = og.side === "long";
  const m = o.market != null && Number.isFinite(o.market) ? o.market : null;
  const snap = (v: number) => snapToTick(v, tick);
  const draftOrPending = og.status !== "open";
  switch (part) {
    case "stop": {
      let v = snap(pt.price);
      const limit = long ? og.entry.price - tick : og.entry.price + tick;
      v = long ? Math.min(v, limit) : Math.max(v, limit);
      if (og.status === "open" && m != null) v = long ? Math.min(v, m - tick) : Math.max(v, m + tick);
      return { ...p, stop: { ...og.stop, price: v } };
    }
    case "takeProfit": {
      let v = snap(pt.price);
      const limit = long ? og.entry.price + tick : og.entry.price - tick;
      v = long ? Math.max(v, limit) : Math.min(v, limit);
      if (og.status === "open" && m != null) v = long ? Math.max(v, m + tick) : Math.min(v, m - tick);
      return { ...p, takeProfit: { ...og.takeProfit, price: v } };
    }
    case "stopTrigger": {
      if (!draftOrPending) return p;
      return { ...p, stopPrice: snap(pt.price) };
    }
    case "entry":
    case "body": {
      if (!draftOrPending) return p;
      // A manual Market order is pinned to the market; an AUTO market draft may be dragged away (becomes limit/stop).
      if (og.orderType === "market" && og.orderTypeAuto === false && part === "entry") return p;
      const dPrice = snap(pt.price) - snap(origin.pt.price);
      const dTime = Math.round(pt.time - origin.pt.time);
      const shift = (q: Pt): Pt => ({ time: q.time + dTime, price: q.price + dPrice });
      const next: PositionLike = {
        ...p,
        entry: shift(og.entry),
        stop: shift(og.stop),
        takeProfit: shift(og.takeProfit),
      };
      if (og.stopPrice != null) next.stopPrice = og.stopPrice + dPrice;
      if (og.limitPrice != null) next.limitPrice = og.limitPrice + dPrice;
      if (og.rightTime != null) next.rightTime = og.rightTime + dTime;
      return next as T;
    }
    case "left": {
      if (!draftOrPending) return p;
      const right = og.rightTime ?? og.entry.time + o.barSec * 24;
      const t = Math.min(Math.round(pt.time), right - o.barSec * 3);
      return { ...p, entry: { ...og.entry, time: t }, stop: { ...og.stop, time: t }, takeProfit: { ...og.takeProfit, time: t } };
    }
    case "right": {
      const t = Math.max(Math.round(pt.time), og.entry.time + o.barSec * 3);
      return { ...p, rightTime: t };
    }
    default:
      return p;
  }
}

// ---------------------------------------------------------------- settings dialog helpers

export type LevelUnit = "price" | "ticks" | "percent";

/** Convert a level typed in the dialog (price / ticks / %) into an absolute price. */
export function levelFromInput(
  side: Side,
  kind: "stop" | "takeProfit",
  entry: number,
  value: number,
  unit: LevelUnit,
  tick: number
): number | null {
  if (!Number.isFinite(value)) return null;
  if (unit === "price") return value;
  const dist = unit === "ticks" ? value * tick : (Math.abs(entry) * value) / 100;
  if (!(dist > 0)) return null;
  const up = (side === "long") === (kind === "takeProfit");
  return up ? entry + dist : entry - dist;
}

export function levelToInput(entry: number, price: number, unit: LevelUnit, tick: number): number {
  const dist = Math.abs(price - entry);
  if (unit === "price") return price;
  if (unit === "ticks") return tick > 0 ? Math.round(dist / tick) : 0;
  return entry !== 0 ? (dist / Math.abs(entry)) * 100 : 0;
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(128,128,128,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, alpha))})`;
}

// ================================================================ Brief 02: auto order type, R:R lock, draft sync

export type TypeChoice = "auto" | "market" | "limit" | "stop" | "stop_limit";

const isStopLimitType = (t: PosOrderType) => t === "buy_stop_limit" || t === "sell_stop_limit";

/** Order type from where the entry sits relative to the market. Stop-Limit is never auto-detected. */
export function detectOrderType(side: Side, entry: number, market: number, tol: number): PosOrderType {
  if (Math.abs(entry - market) <= tol + 1e-12) return "market";
  if (side === "long") return entry < market ? "buy_limit" : "buy_stop";
  return entry > market ? "sell_limit" : "sell_stop";
}

/** Which dropdown choice matches this position (for the bar). */
export function typeChoiceOf(p: Pick<PositionLike, "orderType" | "orderTypeAuto">): TypeChoice {
  if (p.orderTypeAuto !== false) return "auto";
  if (p.orderType === "market") return "market";
  if (p.orderType === "buy_limit" || p.orderType === "sell_limit") return "limit";
  if (p.orderType === "buy_stop" || p.orderType === "sell_stop") return "stop";
  return "stop_limit";
}

export function applyRRLock<T extends PositionLike>(
  p: T,
  changed: "stop" | "entry" | "ratio" | "takeProfit",
  tick: number
): T {
  const lk = p.rrLock;
  if (!lk || !lk.enabled || !(lk.ratio > 0)) return p;
  const e = p.entry.price;
  const risk = Math.abs(e - p.stop.price);
  if (!(risk > 0)) return p;
  if (changed === "takeProfit") {
    const reward = Math.abs(p.takeProfit.price - e);
    if (!(reward > 0)) return p;
    const r = Math.round((reward / risk) * 100) / 100;
    if (!(r > 0) || r === lk.ratio) return p;
    return { ...p, rrLock: { ...lk, ratio: r } };
  }
  const long = p.side === "long";
  const tp = snapToTick(long ? e + lk.ratio * risk : e - lk.ratio * risk, tick);
  if (tp === p.takeProfit.price) return p;
  return { ...p, takeProfit: { ...p.takeProfit, price: tp } };
}

export function enableRRLock<T extends PositionLike>(p: T, ratio: number, tick: number): T {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_RR;
  return applyRRLock({ ...p, rrLock: { enabled: true, ratio: r } }, "ratio", tick);
}

export type SyncCtx = {
  market: number | null | undefined;
  tick: number;
  /** true when the caller just changed the entry/type by hand (drag, dialog, chip) */
  userMovedEntry?: boolean;
};

/**
 * Keeps a DRAFT consistent with the market. Returns the SAME object when nothing changes.
 *  - market draft: the entry price follows the market (SL/TP keep their absolute prices; R:R lock recomputes TP)
 *  - auto draft whose entry was moved by hand: becomes limit/stop (or back to market within one tick)
 *  - pending auto draft: type re-detected as the market moves
 *  - manual type, stop-limit, non-draft: untouched (manual Market still follows)
 */
export function syncDraft<T extends PositionLike>(p: T, c: SyncCtx): T {
  if (p.status !== "draft") return p;
  const m = c.market;
  if (m == null || !Number.isFinite(m)) return p;
  if (isStopLimitType(p.orderType)) return p;
  const auto = p.orderTypeAuto !== false;
  const tick = c.tick > 0 ? c.tick : 0.01;
  const follow = (q: T): T => {
    const price = snapToTick(m, tick);
    if (q.entry.price === price && q.orderType === "market") return q;
    const moved: T = { ...q, orderType: "market", entry: { ...q.entry, price } };
    return applyRRLock(moved, "entry", tick);
  };
  if (p.orderType === "market") {
    if (c.userMovedEntry && auto) {
      const t = detectOrderType(p.side, p.entry.price, m, tick);
      return t === "market" ? follow(p) : { ...p, orderType: t };
    }
    return follow(p);
  }
  if (!auto) return p;
  const t = detectOrderType(p.side, p.entry.price, m, tick);
  if (t === "market") return follow({ ...p, orderType: "market" });
  return t === p.orderType ? p : { ...p, orderType: t };
}

/** Patch for the order-type dropdown in the bar (draft only). Entry/SL/TP shift together so distances are kept. */
export function retypeDraft(p: PositionLike, choice: TypeChoice, c: { market: number; tick: number }): Partial<PositionLike> {
  if (p.status !== "draft") return {};
  const long = p.side === "long";
  const m = c.market;
  const tick = c.tick > 0 ? c.tick : 0.01;
  const off = snapToTick(Math.max(m * 0.003, tick * 5), tick);
  const shiftAll = (entryPrice: number) => {
    const d = entryPrice - p.entry.price;
    return {
      entry: { ...p.entry, price: entryPrice },
      stop: { ...p.stop, price: p.stop.price + d },
      takeProfit: { ...p.takeProfit, price: p.takeProfit.price + d },
    };
  };
  const clearStopLimit = { stopPrice: undefined, limitPrice: undefined, stopTriggered: undefined };
  switch (choice) {
    case "auto":
      return { orderTypeAuto: true, orderType: "market", ...clearStopLimit };
    case "market":
      return { orderTypeAuto: false, orderType: "market", ...clearStopLimit, ...shiftAll(snapToTick(m, tick)) };
    case "limit":
      return { orderTypeAuto: false, orderType: long ? "buy_limit" : "sell_limit", ...clearStopLimit, ...shiftAll(long ? m - off : m + off) };
    case "stop":
      return { orderTypeAuto: false, orderType: long ? "buy_stop" : "sell_stop", ...clearStopLimit, ...shiftAll(long ? m + off : m - off) };
    case "stop_limit": {
      const stopPx = long ? m + off : m - off;
      const limitPx = long ? m + off / 3 : m - off / 3;
      return {
        orderTypeAuto: false,
        orderType: long ? "buy_stop_limit" : "sell_stop_limit",
        stopPrice: stopPx,
        limitPrice: limitPx,
        stopTriggered: false,
        ...shiftAll(limitPx),
      };
    }
    default:
      return {};
  }
}

/** Every user edit (bar, dialog, chip) goes through here: merge, apply the R:R lock, keep drafts in sync with the market. */
export function applyEdit<T extends PositionLike>(prev: T, patch: Partial<T>, c: { market?: number | null; tick: number }): T {
  let next = { ...prev, ...patch } as T;
  const tick = c.tick > 0 ? c.tick : 0.01;
  if (next.rrLock?.enabled) {
    if ("takeProfit" in patch) next = applyRRLock(next, "takeProfit", tick);
    else if ("rrLock" in patch) next = applyRRLock(next, "ratio", tick);
    else if ("stop" in patch || "entry" in patch) next = applyRRLock(next, "stop", tick);
  }
  if (next.status === "draft") {
    next = syncDraft(next, {
      market: c.market,
      tick,
      userMovedEntry: "entry" in patch || "orderType" in patch || "orderTypeAuto" in patch,
    });
  }
  return next;
}

/** Drag = core drag + R:R lock (SL drag moves TP; TP drag updates the ratio). */
export function applyPositionDrag<T extends PositionLike>(
  p: T,
  part: PositionPart,
  pt: { time: number; price: number },
  origin: DragOrigin,
  o: DragOpts
): T {
  const next = dragCore(p, part, pt, origin, o);
  if (next === p || !next.rrLock?.enabled) return next;
  const tick = o.tick > 0 ? o.tick : 0.01;
  if (part === "stop") return applyRRLock(next, "stop", tick);
  if (part === "takeProfit") return applyRRLock(next, "takeProfit", tick);
  return next;
}
