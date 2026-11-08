/**
 * C2.1 — pure Tick execution engine.
 * Does not touch Chart, ReplayView, caches, or runPositionBars.
 */
import type { PositionLike } from "./positionModel";
import type { ClosedInfo, EngineEvent, EngineHooks, EngineResult } from "./positionEngine";

export type TickLike = {
  time: number;
  bid: number;
  ask: number;
  seq?: number;
};

export type TickEngineOpts = {
  /** Reserved; C2 uses quote-touch fills only (no extra slippage model). */
  gapFill?: boolean;
};

function sideTxt(s: PositionLike) {
  return s.side.toUpperCase();
}
function typeTxt(s: PositionLike) {
  return String(s.orderType || "").replace(/_/g, " ");
}

function extendRight<P extends PositionLike>(orig: P): Partial<P> {
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

function fillGate(
  hooks: EngineHooks<any>,
  s: PositionLike,
  tick: TickLike
): { ok: boolean; reason: string | null } {
  if (!hooks.canFill) return { ok: true, reason: null };
  const mid = (tick.bid + tick.ask) / 2;
  const barLike = { time: tick.time, open: tick.bid, high: tick.ask, low: tick.bid, close: mid };
  const r = hooks.canFill(s, barLike as any);
  if (r === true || r === undefined) return { ok: true, reason: null };
  if (r === false) return { ok: false, reason: null };
  return { ok: false, reason: r.reason };
}

/** Stable sort key: time then seq (missing seq → 0). */
export function compareTicks(a: TickLike, b: TickLike): number {
  if (a.time !== b.time) return a.time - b.time;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

export function sortTicksStable(ticks: TickLike[]): TickLike[] {
  return ticks.slice().sort(compareTicks);
}


/**
 * Pending entry: returns fill price or null if not marketable on this tick.
 */
export function tickPendingFillPrice(
  orderType: string,
  side: "long" | "short",
  entryPrice: number,
  tick: TickLike,
  stopPrice?: number,
  limitPrice?: number,
  stopTriggered?: boolean
): { price: number; stopTriggered?: boolean } | null {
  const { bid, ask } = tick;

  if (orderType === "market") {
    return { price: side === "long" ? ask : bid };
  }

  if (orderType === "buy_limit") {
    if (ask <= entryPrice) return { price: Math.min(entryPrice, ask) };
    return null;
  }
  if (orderType === "sell_limit") {
    if (bid >= entryPrice) return { price: Math.max(entryPrice, bid) };
    return null;
  }
  if (orderType === "buy_stop") {
    if (ask >= entryPrice) return { price: ask };
    return null;
  }
  if (orderType === "sell_stop") {
    if (bid <= entryPrice) return { price: bid };
    return null;
  }

  if (orderType === "buy_stop_limit") {
    const sp = stopPrice ?? entryPrice;
    const lp = limitPrice ?? entryPrice;
    let triggered = !!stopTriggered;
    if (!triggered && ask >= sp) triggered = true;
    if (!triggered) return null;
    if (ask <= lp) return { price: Math.min(lp, ask), stopTriggered: true };
    return { price: NaN, stopTriggered: true }; // armed only — signal via NaN handled by caller
  }
  if (orderType === "sell_stop_limit") {
    const sp = stopPrice ?? entryPrice;
    const lp = limitPrice ?? entryPrice;
    let triggered = !!stopTriggered;
    if (!triggered && bid <= sp) triggered = true;
    if (!triggered) return null;
    if (bid >= lp) return { price: Math.max(lp, bid), stopTriggered: true };
    return { price: NaN, stopTriggered: true };
  }

  return null;
}

/**
 * Open position exit on one tick. SL before TP.
 * Long uses bid; short uses ask.
 */
export function tickExitOnOpen(
  s: PositionLike,
  tick: TickLike
): { reason: "sl" | "tp"; exitPrice: number } | null {
  const long = s.side === "long";
  if (long) {
    if (tick.bid <= s.stop.price) return { reason: "sl", exitPrice: tick.bid };
    if (tick.bid >= s.takeProfit.price) return { reason: "tp", exitPrice: tick.bid };
  } else {
    if (tick.ask >= s.stop.price) return { reason: "sl", exitPrice: tick.ask };
    if (tick.ask <= s.takeProfit.price) return { reason: "tp", exitPrice: tick.ask };
  }
  return null;
}

export function runPositionTicks<S extends { kind: string }>(
  shapes: S[],
  ticks: TickLike[],
  hooks: EngineHooks<any> = {},
  _opts: TickEngineOpts = {}
): EngineResult<S> {
  const ordered = sortTicksStable(ticks);
  let working: S[] = shapes.slice();
  const closed: ClosedInfo[] = [];
  const events: EngineEvent[] = [];
  let mutated = false;

  for (const tick of ordered) {
    if (!Number.isFinite(tick.time) || !Number.isFinite(tick.bid) || !Number.isFinite(tick.ask)) {
      continue;
    }
    if (tick.bid > tick.ask) continue;

    const filledThisTick = new Set<string>();
    const next: S[] = [];
    for (const raw of working) {
      if (raw.kind !== "position") {
        next.push(raw);
        continue;
      }
      const s = raw as unknown as PositionLike;

      // ---------------- PENDING ----------------
      if (s.status === "pending") {
        const isStopLimit = s.orderType === "buy_stop_limit" || s.orderType === "sell_stop_limit";
        if (isStopLimit) {
          const result = tickPendingFillPrice(
            s.orderType,
            s.side,
            s.entry.price,
            tick,
            s.stopPrice,
            s.limitPrice,
            s.stopTriggered
          );
          if (!result) {
            next.push(raw);
            continue;
          }
          if (!Number.isFinite(result.price)) {
            // Armed only
            if (!s.stopTriggered) {
              mutated = true;
              next.push({ ...s, stopTriggered: true } as unknown as S);
              events.push({
                type: "stop_armed",
                id: s.id,
                text: `Stop triggered · ${sideTxt(s)} (tick)`,
              });
            } else {
              next.push(raw);
            }
            continue;
          }
          const gate = fillGate(hooks, s, tick);
          if (!gate.ok) {
            mutated = true;
            events.push({
              type: "cancelled",
              id: s.id,
              text: gate.reason || `Cancelled · ${sideTxt(s)} stop-limit (trading not allowed)`,
            });
            continue;
          }
          mutated = true;
          const filled: PositionLike = {
            ...s,
            status: "open",
            stopTriggered: true,
            entry: { time: tick.time, price: result.price },
            ...extendRight(s),
          };
          const barLike = {
            time: tick.time,
            open: tick.bid,
            high: tick.ask,
            low: tick.bid,
            close: (tick.bid + tick.ask) / 2,
          };
          const extra = hooks.onFill?.(filled, barLike as any) || {};
          next.push({ ...filled, ...extra } as unknown as S);
          filledThisTick.add(s.id);
          events.push({
            type: "filled",
            id: s.id,
            text: `Filled · ${sideTxt(s)} stop-limit @ ${result.price.toFixed(2)}`,
          });
          continue;
        }

        const result = tickPendingFillPrice(s.orderType, s.side, s.entry.price, tick);
        if (!result || !Number.isFinite(result.price)) {
          next.push(raw);
          continue;
        }
        const gate = fillGate(hooks, s, tick);
        if (!gate.ok) {
          mutated = true;
          events.push({
            type: "cancelled",
            id: s.id,
            text: gate.reason || `Cancelled · ${sideTxt(s)} ${typeTxt(s)} (trading not allowed)`,
          });
          continue;
        }
        mutated = true;
        const filled: PositionLike = {
          ...s,
          status: "open",
          entry: { time: tick.time, price: result.price },
          ...extendRight(s),
        };
        const barLike = {
          time: tick.time,
          open: tick.bid,
          high: tick.ask,
          low: tick.bid,
          close: (tick.bid + tick.ask) / 2,
        };
        const extra = hooks.onFill?.(filled, barLike as any) || {};
        next.push({ ...filled, ...extra } as unknown as S);
        filledThisTick.add(s.id);
        events.push({
          type: "filled",
          id: s.id,
          text: `Filled · ${sideTxt(s)} ${typeTxt(s)} @ ${result.price.toFixed(2)}`,
        });
        continue;
      }

      // ---------------- OPEN ----------------
      if (s.status !== "open") {
        next.push(raw);
        continue;
      }

      if (tick.time < s.entry.time) {
        next.push(raw);
        continue;
      }
      // Spec: no SL/TP on the same tick event that filled this position.
      if (filledThisTick.has(s.id)) {
        next.push(raw);
        continue;
      }

      const hit = tickExitOnOpen(s, tick);
      if (!hit) {
        next.push(raw);
        continue;
      }
      mutated = true;
      const exitPrice = hit.exitPrice;
      const pnlPoints = s.side === "long" ? exitPrice - s.entry.price : s.entry.price - exitPrice;
      const barLike = {
        time: tick.time,
        open: tick.bid,
        high: tick.ask,
        low: tick.bid,
        close: (tick.bid + tick.ask) / 2,
      };
      const extra = hooks.onClose?.(s, exitPrice, barLike as any) || {};
      const c: ClosedInfo = {
        id: s.id,
        side: s.side,
        orderType: s.orderType,
        entry: s.entry,
        stop: s.stop,
        takeProfit: s.takeProfit,
        exitPrice,
        exitTime: tick.time,
        reason: hit.reason,
        pnlPoints,
        riskSnapshot: s.riskSnapshot,
        entryScreenshot: s.entryScreenshot,
        ...extra,
      };
      closed.push(c);
      events.push({
        type: "closed",
        id: s.id,
        text: `${hit.reason.toUpperCase()} · ${sideTxt(s)} @ ${exitPrice.toFixed(2)} · ${pnlPoints >= 0 ? "+" : ""}${pnlPoints.toFixed(1)} pts`,
      });
    }
    working = next;
  }

  return { shapes: working, closed, events, mutated: mutated || closed.length > 0 };
}
