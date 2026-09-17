/**
 * v3.29.0 — Book/UI pending price relationship checks.
 * Execution remains the final authority; this is advisory only.
 */

import type { OrderType } from "../components/Chart";

export type PendingPriceWarning = {
  ok: boolean;
  message: string | null;
};

/**
 * Relative to current market price (replay close).
 * Buy Limit: entry < market
 * Sell Limit: entry > market
 * Buy Stop: entry > market
 * Sell Stop: entry < market
 * Stop-Limit: stop relative to market; limit relative to stop for typical brokers.
 */
export function validatePendingVsMarket(
  orderType: OrderType | string,
  side: "long" | "short",
  market: number | null | undefined,
  entry: number,
  stopPrice?: number | null,
  limitPrice?: number | null
): PendingPriceWarning {
  if (market == null || !Number.isFinite(market)) {
    return { ok: true, message: null };
  }
  if (!Number.isFinite(entry)) {
    return { ok: false, message: "Entry is not a valid number" };
  }

  const eps = Math.max(1e-8, Math.abs(market) * 1e-10);

  switch (orderType) {
    case "market":
      return { ok: true, message: null };
    case "buy_limit":
      if (entry >= market - eps) {
        return { ok: false, message: `Buy Limit entry should be below market (${market.toFixed(2)})` };
      }
      break;
    case "sell_limit":
      if (entry <= market + eps) {
        return { ok: false, message: `Sell Limit entry should be above market (${market.toFixed(2)})` };
      }
      break;
    case "buy_stop":
      if (entry <= market + eps) {
        return { ok: false, message: `Buy Stop entry should be above market (${market.toFixed(2)})` };
      }
      break;
    case "sell_stop":
      if (entry >= market - eps) {
        return { ok: false, message: `Sell Stop entry should be below market (${market.toFixed(2)})` };
      }
      break;
    case "buy_stop_limit": {
      const stop = stopPrice ?? entry;
      const limit = limitPrice ?? entry;
      if (stop <= market + eps) {
        return { ok: false, message: `Buy Stop-Limit stop should be above market (${market.toFixed(2)})` };
      }
      if (limit > stop + eps) {
        return { ok: false, message: "Buy Stop-Limit limit is usually at or below stop" };
      }
      break;
    }
    case "sell_stop_limit": {
      const stop = stopPrice ?? entry;
      const limit = limitPrice ?? entry;
      if (stop >= market - eps) {
        return { ok: false, message: `Sell Stop-Limit stop should be below market (${market.toFixed(2)})` };
      }
      if (limit < stop - eps) {
        return { ok: false, message: "Sell Stop-Limit limit is usually at or above stop" };
      }
      break;
    }
    default:
      break;
  }

  // SL/TP sanity for long/short (advisory)
  void side;
  return { ok: true, message: null };
}

export function lotFromSnapshot(snap: Record<string, unknown> | null | undefined): number | null {
  if (!snap) return null;
  for (const k of ["finalLot", "riskBasedLot", "lot", "lots"]) {
    const v = snap[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}
