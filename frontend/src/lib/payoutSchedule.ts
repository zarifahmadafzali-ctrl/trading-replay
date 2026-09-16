/**
 * v3.17.8 — Configurable Prop payout schedules (pure, replay-time only).
 * No firm-specific hard-coding. No Date.now() for trading state.
 */

import { toUnixSec, utcDayKey, countTradingDays, type PropTradeLike } from "./propRules";
import type { LifecycleEvent } from "./accountLifecycle";

export type PayoutScheduleMode =
  | "on_demand"
  | "interval"
  | "weekly"
  | "biweekly"
  | "monthly";

export type PayoutScheduleAnchor =
  | "funded_start"
  | "first_funded_trade"
  | "last_payout"
  | "fixed_date";

/** 0 = Sunday … 6 = Saturday (UTC) */
export type PayoutSchedule = {
  mode: PayoutScheduleMode;
  /** Rolling interval in days (mode=interval) */
  intervalDays?: number;
  anchor?: PayoutScheduleAnchor;
  /** Unix seconds for fixed_date / biweekly anchor */
  anchorDate?: number;
  /** UTC weekday for weekly / biweekly */
  weekday?: number;
  /** 1–31 for monthly */
  monthDay?: number;
  minimumTradingDays?: number;
  minimumPayoutPct?: number;
  minimumPayoutAmount?: number;
  profitSplitPct?: number;
  processingDays?: number;
  cooldownDays?: number;
  /** Delay before first payout window after anchor */
  firstPayoutDelayDays?: number;
  /** Legacy: treated as intervalDays when mode missing */
  payoutIntervalDays?: number;
  enabled?: boolean;
};

export type PayoutEligibilityInput = {
  schedule: PayoutSchedule;
  /** Reference account size for % minimums */
  accountSize: number;
  /** Realized currency PnL available for payout (since last paid or funded) */
  availableProfit: number;
  trades: PropTradeLike[];
  accountId: string;
  replayTime: number;
  /** Unix sec when account became funded (FUNDED event) */
  fundedAt?: number;
  /** Unix sec of first filled trade after funded */
  firstFundedTradeAt?: number;
  /** Unix sec of last PAYOUT_PAID */
  lastPayoutAt?: number;
  /** Existing events for dedupe (optional) */
  events?: LifecycleEvent[];
};

export type PayoutEligibilityResult = {
  eligible: boolean;
  reasons: string[];
  windowOpen: boolean;
  nextWindowAt: number | null;
  firstPayoutAt: number | null;
  availableProfit: number;
  minimumRequired: number;
  traderPayout: number;
  firmShare: number;
  processingDays: number;
  cooldownDays: number;
  paidAtIfRequested: number | null;
  reenableAtIfPaid: number | null;
};

function startOfUtcDay(unixSec: number): number {
  const d = new Date(toUnixSec(unixSec) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

function utcWeekday(unixSec: number): number {
  return new Date(toUnixSec(unixSec) * 1000).getUTCDay();
}

/** Last calendar day of UTC month (0-based month). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function normalizePayoutSchedule(raw?: Partial<PayoutSchedule> | null): PayoutSchedule {
  if (!raw) {
    return { mode: "on_demand", enabled: false };
  }
  const mode: PayoutScheduleMode =
    raw.mode ||
    (raw.payoutIntervalDays != null && raw.payoutIntervalDays > 0 ? "interval" : "on_demand");
  return {
    mode,
    intervalDays: raw.intervalDays ?? raw.payoutIntervalDays,
    anchor: raw.anchor || "funded_start",
    anchorDate: raw.anchorDate,
    weekday: raw.weekday,
    monthDay: raw.monthDay,
    minimumTradingDays: raw.minimumTradingDays,
    minimumPayoutPct: raw.minimumPayoutPct,
    minimumPayoutAmount: raw.minimumPayoutAmount,
    profitSplitPct: raw.profitSplitPct,
    processingDays: raw.processingDays,
    cooldownDays: raw.cooldownDays,
    firstPayoutDelayDays: raw.firstPayoutDelayDays,
    payoutIntervalDays: raw.payoutIntervalDays,
    enabled: raw.enabled !== false,
  };
}

/** Resolve schedule anchor unix time. */
export function resolveScheduleAnchor(opts: {
  schedule: PayoutSchedule;
  fundedAt?: number;
  firstFundedTradeAt?: number;
  lastPayoutAt?: number;
}): number | null {
  const a = opts.schedule.anchor || "funded_start";
  if (a === "fixed_date" && opts.schedule.anchorDate != null) {
    return toUnixSec(opts.schedule.anchorDate);
  }
  if (a === "last_payout" && opts.lastPayoutAt != null) {
    return toUnixSec(opts.lastPayoutAt);
  }
  if (a === "first_funded_trade" && opts.firstFundedTradeAt != null) {
    return toUnixSec(opts.firstFundedTradeAt);
  }
  if (opts.fundedAt != null) return toUnixSec(opts.fundedAt);
  if (opts.firstFundedTradeAt != null) return toUnixSec(opts.firstFundedTradeAt);
  if (opts.schedule.anchorDate != null) return toUnixSec(opts.schedule.anchorDate);
  return null;
}

export function getFirstPayoutDate(opts: {
  schedule: PayoutSchedule;
  fundedAt?: number;
  firstFundedTradeAt?: number;
  lastPayoutAt?: number;
}): number | null {
  const sch = normalizePayoutSchedule(opts.schedule);
  if (sch.mode === "on_demand") return null;

  const anchor = resolveScheduleAnchor(opts);
  if (anchor == null) return null;

  const delay = sch.firstPayoutDelayDays != null && sch.firstPayoutDelayDays > 0
    ? sch.firstPayoutDelayDays * 86400
    : 0;
  const base = anchor + delay;

  if (sch.mode === "interval") {
    const days = sch.intervalDays != null && sch.intervalDays > 0 ? sch.intervalDays : 14;
    // First window at base if delay set, else base + interval when delay is 0?
    // Spec: first delay then subsequent interval. If no delay, first = anchor + interval for rolling from trade,
    // or anchor itself when delay is explicit 0.
    if (sch.firstPayoutDelayDays != null) return startOfUtcDay(base);
    return startOfUtcDay(anchor + days * 86400);
  }

  if (sch.mode === "weekly") {
    const wd = sch.weekday != null ? sch.weekday : 5; // default Friday only as unspecified fallback for tests that set weekday
    let t = startOfUtcDay(base);
    for (let i = 0; i < 8; i++) {
      if (utcWeekday(t) === wd) return t;
      t += 86400;
    }
    return t;
  }

  if (sch.mode === "biweekly") {
    const wd = sch.weekday != null ? sch.weekday : utcWeekday(base);
    // Anchor date if fixed; else from base
    let anchorDay = sch.anchorDate != null ? startOfUtcDay(sch.anchorDate) : startOfUtcDay(base);
    // Align anchorDay to weekday
    for (let i = 0; i < 7; i++) {
      if (utcWeekday(anchorDay) === wd) break;
      anchorDay += 86400;
    }
    // First payout is first biweekly slot >= base
    let t = anchorDay;
    while (t < startOfUtcDay(base)) t += 14 * 86400;
    return t;
  }

  if (sch.mode === "monthly") {
    const day = sch.monthDay != null && sch.monthDay >= 1 ? Math.min(31, Math.floor(sch.monthDay)) : 15;
    const d = new Date(startOfUtcDay(base) * 1000);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    const pick = (yy: number, mm: number) => {
      const last = lastDayOfMonth(yy, mm);
      const dd = Math.min(day, last);
      return Date.UTC(yy, mm, dd) / 1000;
    };
    let cand = pick(y, m);
    if (cand < startOfUtcDay(base)) {
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
      cand = pick(y, m);
    }
    return cand;
  }

  return startOfUtcDay(base);
}

export function getNextPayoutWindow(opts: {
  schedule: PayoutSchedule;
  replayTime: number;
  fundedAt?: number;
  firstFundedTradeAt?: number;
  lastPayoutAt?: number;
}): number | null {
  const sch = normalizePayoutSchedule(opts.schedule);
  if (sch.mode === "on_demand") return null;

  const first = getFirstPayoutDate(opts);
  if (first == null) return null;

  const now = startOfUtcDay(opts.replayTime);
  if (now <= first) return first;

  if (sch.mode === "interval") {
    const days = sch.intervalDays != null && sch.intervalDays > 0 ? sch.intervalDays : 14;
    if (sch.anchor === "last_payout" && opts.lastPayoutAt != null) {
      const next = startOfUtcDay(opts.lastPayoutAt) + days * 86400;
      return next > now ? next : startOfUtcDay(now) + days * 86400;
    }
    // Fixed rolling from first
    const elapsed = now - first;
    const steps = Math.ceil(elapsed / (days * 86400));
    const cand = first + steps * days * 86400;
    return cand < now ? cand + days * 86400 : cand;
  }

  if (sch.mode === "weekly") {
    const wd = sch.weekday != null ? sch.weekday : 5;
    let t = now;
    for (let i = 0; i < 8; i++) {
      if (utcWeekday(t) === wd && t >= first) return t;
      t += 86400;
    }
    return t;
  }

  if (sch.mode === "biweekly") {
    const firstBi = first;
    const period = 14 * 86400;
    if (now <= firstBi) return firstBi;
    const steps = Math.ceil((now - firstBi) / period);
    let cand = firstBi + steps * period;
    if (cand < now) cand += period;
    return cand;
  }

  if (sch.mode === "monthly") {
    const day = sch.monthDay != null && sch.monthDay >= 1 ? Math.min(31, Math.floor(sch.monthDay)) : 15;
    const d = new Date(now * 1000);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    const pick = (yy: number, mm: number) => {
      const last = lastDayOfMonth(yy, mm);
      return Date.UTC(yy, mm, Math.min(day, last)) / 1000;
    };
    let cand = pick(y, m);
    if (cand < now || cand < first) {
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
      cand = pick(y, m);
    }
    if (cand < first) {
      // jump until >= first
      while (cand < first) {
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
        cand = pick(y, m);
      }
    }
    return cand;
  }

  return first;
}

export function isPayoutWindowOpen(opts: {
  schedule: PayoutSchedule;
  replayTime: number;
  fundedAt?: number;
  firstFundedTradeAt?: number;
  lastPayoutAt?: number;
}): boolean {
  const sch = normalizePayoutSchedule(opts.schedule);
  if (sch.mode === "on_demand") return true;
  const next = getNextPayoutWindow(opts);
  if (next == null) return false;
  // Window open on the UTC day of the scheduled window (and same day only)
  return utcDayKey(opts.replayTime) === utcDayKey(next) || startOfUtcDay(opts.replayTime) >= next;
}

export function calculatePayoutAmount(
  availableProfit: number,
  profitSplitPct?: number
): { traderPayout: number; firmShare: number } {
  if (!(availableProfit > 0)) return { traderPayout: 0, firmShare: 0 };
  const split =
    profitSplitPct != null && Number.isFinite(profitSplitPct)
      ? Math.min(100, Math.max(0, profitSplitPct))
      : 100;
  const traderPayout = (availableProfit * split) / 100;
  return { traderPayout, firmShare: availableProfit - traderPayout };
}

export function calculatePayoutEligibility(input: PayoutEligibilityInput): PayoutEligibilityResult {
  const sch = normalizePayoutSchedule(input.schedule);
  const reasons: string[] = [];
  const processingDays = sch.processingDays != null && sch.processingDays > 0 ? sch.processingDays : 0;
  const cooldownDays = sch.cooldownDays != null && sch.cooldownDays > 0 ? sch.cooldownDays : 0;

  const minPctAmt =
    sch.minimumPayoutPct != null && input.accountSize > 0
      ? (input.accountSize * sch.minimumPayoutPct) / 100
      : 0;
  const minAbs = sch.minimumPayoutAmount != null && sch.minimumPayoutAmount > 0 ? sch.minimumPayoutAmount : 0;
  const minimumRequired = Math.max(minPctAmt, minAbs);

  const { traderPayout, firmShare } = calculatePayoutAmount(input.availableProfit, sch.profitSplitPct);

  const tradingDays = countTradingDays(input.trades, input.accountId);
  if (sch.minimumTradingDays != null && tradingDays < sch.minimumTradingDays) {
    reasons.push(`Trading days ${tradingDays} < ${sch.minimumTradingDays}`);
  }

  if (input.availableProfit < minimumRequired - 1e-9) {
    reasons.push(`Available profit ${input.availableProfit.toFixed(2)} < minimum ${minimumRequired.toFixed(2)}`);
  }

  const windowOpen = isPayoutWindowOpen({
    schedule: sch,
    replayTime: input.replayTime,
    fundedAt: input.fundedAt,
    firstFundedTradeAt: input.firstFundedTradeAt,
    lastPayoutAt: input.lastPayoutAt,
  });
  if (!windowOpen && sch.mode !== "on_demand") {
    reasons.push("Payout window not open");
  }

  const nextWindowAt = getNextPayoutWindow({
    schedule: sch,
    replayTime: input.replayTime,
    fundedAt: input.fundedAt,
    firstFundedTradeAt: input.firstFundedTradeAt,
    lastPayoutAt: input.lastPayoutAt,
  });
  const firstPayoutAt = getFirstPayoutDate({
    schedule: sch,
    fundedAt: input.fundedAt,
    firstFundedTradeAt: input.firstFundedTradeAt,
    lastPayoutAt: input.lastPayoutAt,
  });

  // Dedupe: already eligible/paid at this window
  const t = toUnixSec(input.replayTime);
  const day = utcDayKey(t);
  const already = (input.events || []).some((e) => {
    if (toUnixSec(e.timestamp) > t) return false;
    if (e.type === "PAYOUT_ELIGIBLE" || e.type === "PAYOUT_PAID") {
      return utcDayKey(e.timestamp) === day;
    }
    return false;
  });
  if (already) reasons.push("Payout already recorded for this window");

  const eligible = reasons.length === 0 && sch.enabled !== false;

  const paidAtIfRequested = eligible ? t + processingDays * 86400 : null;
  const reenableAtIfPaid =
    paidAtIfRequested != null && cooldownDays > 0
      ? paidAtIfRequested + cooldownDays * 86400
      : paidAtIfRequested;

  return {
    eligible,
    reasons,
    windowOpen: sch.mode === "on_demand" ? true : windowOpen,
    nextWindowAt,
    firstPayoutAt,
    availableProfit: input.availableProfit,
    minimumRequired,
    traderPayout,
    firmShare,
    processingDays,
    cooldownDays,
    paidAtIfRequested,
    reenableAtIfPaid,
  };
}

export function getNextReenableTime(paidAt: number, cooldownDays?: number): number {
  const days = cooldownDays != null && cooldownDays > 0 ? cooldownDays : 0;
  return toUnixSec(paidAt) + days * 86400;
}
