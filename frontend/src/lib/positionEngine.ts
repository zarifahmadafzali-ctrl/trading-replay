/**
 * Position tool v2 — order engine (pure). Replaces the inline pending-fill + SL/TP loop in Chart.tsx.
 * With default options it behaves EXACTLY like the previous inline code (differential-tested):
 *   pending → fills at its own price; open → SL checked before TP; same-second-as-entry uses close only;
 *   a position that fills on a bar is not SL/TP-checked on that same bar.
 * Opt-ins (default OFF): gapFill, canFill hook.
 */
import type { PositionLike, Pt } from "./positionModel";

export type BarLike = { time: number; open: number; high: number; low: number; close: number };

export type ClosedInfo = {
  id: string;
  side: "long" | "short";
  orderType: PositionLike["orderType"];
  entry: Pt;
  stop: Pt;
  takeProfit: Pt;
  exitPrice: number;
  exitTime: number;
  reason: "sl" | "tp" | "manual";
  pnlPoints: number;
  riskSnapshot?: Record<string, unknown>;
  screenshot?: string;
  entryScreenshot?: string;
};

export type EngineOpts = {
  /**
   * Realistic gap handling (default false = legacy).
   * Stops/exits that gap through their level fill at the bar OPEN (worse for stops, better for limits/TP),
   * instead of at the exact level.
   */
  gapFill?: boolean;
};

export type EngineHooks<P extends PositionLike = PositionLike> = {
  /** Extra fields merged into a position when it fills (risk snapshot, entry screenshot). */
  onFill?: (filled: P, bar: BarLike) => Partial<P> | null | undefined;
  /** Extra fields merged into the closed record (exit screenshot). */
  onClose?: (pos: P, exitPrice: number, bar: BarLike) => Partial<ClosedInfo> | null | undefined;
  /** Return false to CANCEL a pending order instead of filling it (e.g. prop account no longer allowed to trade). */
  canFill?: (pos: P, bar: BarLike) => boolean | { ok: false; reason: string };
};

export type EngineEvent = {
  type: "filled" | "stop_armed" | "closed" | "cancelled";
  id: string;
  text: string;
};

export type EngineResult<S> = {
  shapes: S[];
  closed: ClosedInfo[];
  events: EngineEvent[];
  mutated: boolean;
};

export function pendingEntryTouched(orderType: string, entryPrice: number, hi: number, lo: number): boolean {
  switch (orderType) {
    case "buy_limit":
      return lo <= entryPrice;
    case "sell_limit":
      return hi >= entryPrice;
    case "buy_stop":
      return hi >= entryPrice;
    case "sell_stop":
      return lo <= entryPrice;
    default:
      return false;
  }
}

function pendingFillPrice(orderType: string, entry: number, bar: BarLike, gap: boolean): number {
  if (!gap) return entry;
  switch (orderType) {
    case "buy_limit":
      return bar.open <= entry ? bar.open : entry; // price improvement
    case "sell_limit":
      return bar.open >= entry ? bar.open : entry;
    case "buy_stop":
      return bar.open >= entry ? bar.open : entry; // slippage
    case "sell_stop":
      return bar.open <= entry ? bar.open : entry;
    default:
      return entry;
  }
}

function extendRight<P extends PositionLike>(orig: P, _fillTime: number): Partial<P> {
  // Keep the box where the user placed it. entry.time is set by the caller to the fill.
  const anchor =
    orig.anchorTime != null && Number.isFinite(orig.anchorTime)
      ? orig.anchorTime
      : orig.entry.time;
  const width =
    orig.rightTime != null && Number.isFinite(orig.rightTime)
      ? Math.max(1, orig.rightTime - anchor)
      : 60 * 18;
  return { anchorTime: anchor, rightTime: anchor + width } as Partial<P>;
}


function fillGate(hooks: EngineHooks<any>, s: PositionLike, bar: BarLike): { ok: boolean; reason: string | null } {
  if (!hooks.canFill) return { ok: true, reason: null };
  const r = hooks.canFill(s, bar);
  if (r === true || r === undefined) return { ok: true, reason: null };
  if (r === false) return { ok: false, reason: null };
  return { ok: false, reason: r.reason };
}

const sideTxt = (s: PositionLike) => s.side.toUpperCase();
const typeTxt = (s: PositionLike) => String(s.orderType || "").replace(/_/g, " ");

export function runPositionBars<S extends { kind: string }>(
  shapes: S[],
  bars: BarLike[],
  hooks: EngineHooks<any> = {},
  opts: EngineOpts = {}
): EngineResult<S> {
  const gap = !!opts.gapFill;
  let working: S[] = shapes.slice();
  const closed: ClosedInfo[] = [];
  const events: EngineEvent[] = [];
  let mutated = false;

  for (const bar of bars) {
    const next: S[] = [];
    for (const raw of working) {
      if (raw.kind !== "position") {
        next.push(raw);
        continue;
      }
      const s = raw as unknown as PositionLike;

      // ---------------- PENDING ----------------
      if (s.status === "pending") {
        const hi = bar.high;
        const lo = bar.low;
        const isStopLimit = s.orderType === "buy_stop_limit" || s.orderType === "sell_stop_limit";

        if (isStopLimit) {
          const stopPx = s.stopPrice;
          const limitPx = s.limitPrice;
          if (stopPx == null || limitPx == null) {
            next.push(raw);
            continue;
          }
          let triggered = !!s.stopTriggered;
          if (!triggered) {
            if (s.orderType === "buy_stop_limit" && hi >= stopPx) triggered = true;
            if (s.orderType === "sell_stop_limit" && lo <= stopPx) triggered = true;
          }
          if (triggered) {
            const limitHit = s.orderType === "buy_stop_limit" ? lo <= limitPx : hi >= limitPx;
            if (limitHit) {
              const gate = fillGate(hooks, s, bar);
              if (!gate.ok) {
                mutated = true;
                events.push({ type: "cancelled", id: s.id, text: gate.reason || `Cancelled · ${sideTxt(s)} stop-limit (trading not allowed)` });
                continue;
              }
              mutated = true;
              const filled: PositionLike = {
                ...s,
                status: "open",
                stopTriggered: true,
                entry: { time: bar.time, price: limitPx },
                ...extendRight(s, bar.time),
              };
              const extra = hooks.onFill?.(filled, bar) || {};
              next.push({ ...filled, ...extra } as unknown as S);
              events.push({ type: "filled", id: s.id, text: `Filled · ${sideTxt(s)} stop-limit @ ${limitPx.toFixed(2)}` });
              continue;
            }
          }
          if (triggered !== !!s.stopTriggered) {
            mutated = true;
            next.push({ ...(raw as object), stopTriggered: triggered } as unknown as S);
            events.push({ type: "stop_armed", id: s.id, text: `Stop triggered · ${sideTxt(s)} @ ${stopPx.toFixed(2)}` });
          } else {
            next.push(raw);
          }
          continue;
        }

        if (pendingEntryTouched(s.orderType, s.entry.price, hi, lo)) {
          const gate = fillGate(hooks, s, bar);
          if (!gate.ok) {
            mutated = true;
            events.push({ type: "cancelled", id: s.id, text: gate.reason || `Cancelled · ${sideTxt(s)} ${typeTxt(s)} (trading not allowed)` });
            continue;
          }
          mutated = true;
          const px = pendingFillPrice(s.orderType, s.entry.price, bar, gap);
          const filled: PositionLike = {
            ...s,
            status: "open",
            entry: { time: bar.time, price: px },
            ...extendRight(s, bar.time),
          };
          const extra = hooks.onFill?.(filled, bar) || {};
          next.push({ ...filled, ...extra } as unknown as S);
          events.push({ type: "filled", id: s.id, text: `Filled · ${sideTxt(s)} ${typeTxt(s)} @ ${px.toFixed(2)}` });
        } else {
          next.push(raw);
        }
        continue;
      }

      // ---------------- OPEN ----------------
      if (s.status !== "open") {
        next.push(raw);
        continue;
      }
      const sameSecondAsEntry = bar.time <= s.entry.time;
      const hi = sameSecondAsEntry ? bar.close : bar.high;
      const lo = sameSecondAsEntry ? bar.close : bar.low;
      const long = s.side === "long";
      let reason: "sl" | "tp" | null = null;
      let exitPrice = bar.close;

      if (long) {
        if (lo <= s.stop.price) {
          reason = "sl";
          exitPrice = gap && !sameSecondAsEntry && bar.open <= s.stop.price ? bar.open : s.stop.price;
        } else if (hi >= s.takeProfit.price) {
          reason = "tp";
          exitPrice = gap && !sameSecondAsEntry && bar.open >= s.takeProfit.price ? bar.open : s.takeProfit.price;
        }
      } else {
        if (hi >= s.stop.price) {
          reason = "sl";
          exitPrice = gap && !sameSecondAsEntry && bar.open >= s.stop.price ? bar.open : s.stop.price;
        } else if (lo <= s.takeProfit.price) {
          reason = "tp";
          exitPrice = gap && !sameSecondAsEntry && bar.open <= s.takeProfit.price ? bar.open : s.takeProfit.price;
        }
      }
      if (!reason) {
        next.push(raw);
        continue;
      }
      mutated = true;
      const pnlPoints = long ? exitPrice - s.entry.price : s.entry.price - exitPrice;
      const extra = hooks.onClose?.(s, exitPrice, bar) || {};
      const c: ClosedInfo = {
        id: s.id,
        side: s.side,
        orderType: s.orderType,
        entry: s.entry,
        stop: s.stop,
        takeProfit: s.takeProfit,
        exitPrice,
        exitTime: bar.time,
        reason,
        pnlPoints,
        riskSnapshot: s.riskSnapshot,
        entryScreenshot: s.entryScreenshot,
        ...extra,
      };
      closed.push(c);
      events.push({
        type: "closed",
        id: s.id,
        text: `${reason.toUpperCase()} · ${sideTxt(s)} @ ${exitPrice.toFixed(2)} · ${pnlPoints >= 0 ? "+" : ""}${pnlPoints.toFixed(1)} pts`,
      });
    }
    working = next;
  }
  return { shapes: working, closed, events, mutated: mutated || closed.length > 0 };
}

/** Manual close at the current replay price. Returns null if the position is not open or there is no price. */
export function manualClose(
  p: PositionLike,
  market: { price: number | null | undefined; time: number | null | undefined },
  extra: Partial<ClosedInfo> = {}
): ClosedInfo | null {
  if (p.status !== "open") return null;
  const px = market.price;
  const t = market.time;
  if (px == null || t == null || !Number.isFinite(px) || !Number.isFinite(t)) return null;
  const pnlPoints = p.side === "long" ? px - p.entry.price : p.entry.price - px;
  return {
    id: p.id,
    side: p.side,
    orderType: p.orderType,
    entry: p.entry,
    stop: p.stop,
    takeProfit: p.takeProfit,
    exitPrice: px,
    exitTime: t,
    reason: "manual",
    pnlPoints,
    riskSnapshot: p.riskSnapshot,
    entryScreenshot: p.entryScreenshot,
    ...extra,
  };
}
