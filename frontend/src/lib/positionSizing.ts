/**
 * Brief 01 — lot frozen at Confirm (pure, no React). Like a live broker:
 * the LOT is fixed the moment the order is confirmed; moving SL/TP afterwards only changes the risk AMOUNT.
 * Currency formula (same as riskModel): risk = |entry - stop| * pointValue * lot.
 */
import type { PositionRiskInput, Side } from "./positionModel";

export type PositionSizing = {
  /** Lot frozen at Confirm. Never changes afterwards. */
  lot: number;
  /** Replay time (unix s) of the Confirm. */
  atTime: number;
  mode?: string;
  /** Risk amount at Confirm (informational; risk is re-derived from the current SL). */
  riskAmountAtConfirm?: number | null;
  pointValue?: number | null;
};

export type SnapLike = {
  finalLot?: number | null;
  pointValue?: number | null;
  actualRiskAmount?: number | null;
  equity?: number | null;
  volumeBlockReason?: string | null;
  sizingDebug?: { volumeBlockReason?: string | null } | null;
  [k: string]: unknown;
};

const isPos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export type FreezeResult = { sizing: PositionSizing | null; blocked: boolean; reason: string | null };

/**
 * Turn the Confirm-time risk snapshot into a frozen sizing.
 *  - no snapshot (no session/account)  -> legacy behavior: not blocked, no sizing
 *  - positive finalLot                 -> frozen
 *  - otherwise                         -> BLOCKED with the reason (never open an order with no lot)
 */
export function freezeSizing(snap: SnapLike | null | undefined, time: number, mode?: string): FreezeResult {
  if (!snap) return { sizing: null, blocked: false, reason: null };
  if (isPos(snap.finalLot)) {
    return {
      sizing: {
        lot: snap.finalLot,
        atTime: time,
        ...(mode ? { mode } : {}),
        riskAmountAtConfirm: typeof snap.actualRiskAmount === "number" ? snap.actualRiskAmount : null,
        pointValue: isPos(snap.pointValue) ? snap.pointValue : null,
      },
      blocked: false,
      reason: null,
    };
  }
  const reason =
    (typeof snap.volumeBlockReason === "string" && snap.volumeBlockReason) ||
    (snap.sizingDebug && typeof snap.sizingDebug.volumeBlockReason === "string" && snap.sizingDebug.volumeBlockReason) ||
    "No valid lot (check risk, stop distance and margin)";
  return { sizing: null, blocked: true, reason };
}

/** Risk input that forces the frozen lot when the snapshot is recalculated at fill. */
export function lotOverrideRisk(s: PositionSizing): PositionRiskInput {
  return { mode: "fixed_lot", lot: s.lot };
}

/** At fill: if margin/volume caps would shrink the lot, the pending order is cancelled instead of silently resized. */
export function checkFillLot(frozenLot: number, fillFinalLot: number | null | undefined): { ok: boolean; reason: string | null } {
  if (isPos(fillFinalLot) && fillFinalLot >= frozenLot - 1e-9) return { ok: true, reason: null };
  return { ok: false, reason: "Cancelled · insufficient margin for the confirmed lot" };
}

/** Which lot to show/use: confirmed lot > lot frozen at fill (old positions) > live calculation (drafts). */
export function effectiveLot(
  p: { sizing?: PositionSizing; riskSnapshot?: Record<string, unknown> },
  live?: SnapLike | null
): number | null {
  if (p.sizing && isPos(p.sizing.lot)) return p.sizing.lot;
  const fz = p.riskSnapshot?.["finalLot"];
  if (isPos(fz)) return fz;
  return isPos(live?.finalLot) ? (live!.finalLot as number) : null;
}

export function pointValueOf(
  p: { sizing?: PositionSizing; riskSnapshot?: Record<string, unknown> },
  live?: SnapLike | null
): number | null {
  const a = p.riskSnapshot?.["pointValue"];
  if (isPos(a)) return a;
  if (p.sizing && isPos(p.sizing.pointValue)) return p.sizing.pointValue;
  return isPos(live?.pointValue) ? (live!.pointValue as number) : null;
}

export type DerivedRisk = {
  riskAmount: number;
  rewardAmount: number;
  riskPercent: number | null;
  rewardPercent: number | null;
  rr: number | null;
};

/** Risk/reward in currency for a FIXED lot at the CURRENT stop/target. */
export function deriveRisk(i: {
  lot: number;
  pointValue: number;
  entry: number;
  stop: number;
  tp: number;
  equity?: number | null;
}): DerivedRisk | null {
  if (!isPos(i.lot) || !isPos(i.pointValue)) return null;
  const riskAmount = Math.abs(i.entry - i.stop) * i.pointValue * i.lot;
  const rewardAmount = Math.abs(i.tp - i.entry) * i.pointValue * i.lot;
  const eq = isPos(i.equity) ? i.equity : null;
  return {
    riskAmount,
    rewardAmount,
    riskPercent: eq != null ? (riskAmount / eq) * 100 : null,
    rewardPercent: eq != null ? (rewardAmount / eq) * 100 : null,
    rr: riskAmount > 0 ? rewardAmount / riskAmount : null,
  };
}

export function openPnLCurrency(side: Side, entry: number, mark: number, lot: number, pointValue: number): number | null {
  if (!isPos(lot) || !isPos(pointValue)) return null;
  const pts = side === "long" ? mark - entry : entry - mark;
  return pts * pointValue * lot;
}

/** Tick and display decimals from the instrument's tickSize (replaces the hard-coded 0.01 / 2). */
export function tickAndDecimals(tickSize: number | null | undefined): { tick: number; decimals: number } {
  const tick = typeof tickSize === "number" && Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01;
  let d = 0;
  while (d < 10 && Math.abs(tick * Math.pow(10, d) - Math.round(tick * Math.pow(10, d))) > 1e-9) d++;
  return { tick, decimals: d };
}
