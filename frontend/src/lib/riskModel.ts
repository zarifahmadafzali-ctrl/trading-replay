/**
 * v3.16.1 — Risk / Lot model (pure functions, no hard-coded broker values).
 */

export type AccountProfile = {
  accountId: string;
  name: string;
  initialBalance: number;
  /** Current balance after closed trades (backtest). */
  balance: number;
  currency: string;
  /** e.g. 20 means 1:20 */
  leverage: number;
  enabled: boolean;
  /** Future prop support — no rule engine in v3.17.4 */
  accountType?: "personal" | "prop";
};

export type InstrumentSpec = {
  symbol: string;
  /** Units per 1.0 lot (e.g. 1 for index CFD, 100000 for FX). */
  contractSize: number;
  tickSize: number;
  /** Monetary value of one tick per 1.0 lot. */
  tickValue: number;
  /** Monetary value of one point (price unit) per 1.0 lot. If 0, derived from tick. */
  pointValue: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
};

export type PropFirmConfig = {
  enabled: boolean;
  accountSize: number;
  phase: string;
  profitTargetPercent: number;
  dailyDdPercent: number;
  overallDdPercent: number;
  minTradingDays: number;
  maxTradingDays?: number | null;
  consistencyRulePercent?: number | null;
  profitCapPercent?: number | null;
  trailingDrawdownPercent?: number | null;
  staticDrawdownPercent?: number | null;
};

export type RiskCalcInput = {
  account: AccountProfile;
  instrument: InstrumentSpec;
  /** Risk percent, e.g. 1 = 1% */
  riskPercent: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice?: number;
  side: "long" | "short";
  /** Floating P&L of other open positions (optional). */
  openPnL?: number;
  usedMargin?: number;
};

export type RiskCalcResult = {
  balance: number;
  equity: number;
  freeMargin: number;
  leverage: number;
  riskPercent: number;
  riskAmount: number;
  slDistance: number;
  tpDistance: number | null;
  pointValue: number;
  riskBasedLot: number | null;
  marginMaxLot: number | null;
  volumeMaxLot: number;
  finalLot: number | null;
  marginRequired: number | null;
  actualRiskAmount: number | null;
  actualRiskPercent: number | null;
  potentialProfit: number | null;
  rr: number | null;
  missingSpec: string | null;
};

export function defaultAccount(partial?: Partial<AccountProfile>): AccountProfile {
  return {
    accountId: partial?.accountId || `acc_${Math.random().toString(36).slice(2, 8)}`,
    name: partial?.name || "Account 1",
    initialBalance: partial?.initialBalance ?? 5000,
    balance: partial?.balance ?? partial?.initialBalance ?? 5000,
    currency: partial?.currency || "USD",
    leverage: partial?.leverage ?? 20,
    enabled: partial?.enabled !== false,
    accountType: partial?.accountType || "personal",
  };
}

/** Sensible defaults for known symbols — still configurable, not locked broker values. */
export function defaultInstrument(symbol: string): InstrumentSpec {
  const s = symbol.toUpperCase();
  if (s === "US30" || s === "DJ30") {
    return {
      symbol: s,
      contractSize: 1,
      tickSize: 0.01,
      tickValue: 1,
      pointValue: 1,
      pipValue: 1,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
    };
  }
  if (s === "XAUUSD") {
    return {
      symbol: s,
      contractSize: 100,
      tickSize: 0.01,
      tickValue: 1,
      pointValue: 1,
      pipValue: 1,
      minLot: 0.01,
      maxLot: 50,
      lotStep: 0.01,
    };
  }
  if (s === "BTCUSD") {
    return {
      symbol: s,
      contractSize: 1,
      tickSize: 0.01,
      tickValue: 1,
      pointValue: 1,
      pipValue: 1,
      minLot: 0.01,
      maxLot: 10,
      lotStep: 0.01,
    };
  }
  // FX default
  return {
    symbol: s,
    contractSize: 100000,
    tickSize: 0.00001,
    tickValue: 1,
    pointValue: 10,
    pipValue: 10,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
  };
}

export function defaultPropFirm(): PropFirmConfig {
  return {
    enabled: false,
    accountSize: 5000,
    phase: "Phase 1",
    profitTargetPercent: 8,
    dailyDdPercent: 5,
    overallDdPercent: 10,
    minTradingDays: 4,
    maxTradingDays: null,
    consistencyRulePercent: null,
    profitCapPercent: null,
    trailingDrawdownPercent: null,
    staticDrawdownPercent: null,
  };
}

function roundDownToStep(lot: number, step: number, minLot: number): number {
  if (!Number.isFinite(lot) || lot <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  const steps = Math.floor(lot / step + 1e-12);
  const rounded = steps * step;
  // Fix float noise
  const precision = Math.max(0, (step.toString().split(".")[1] || "").length);
  const v = Number(rounded.toFixed(precision));
  return v < minLot ? 0 : v;
}

/** Monetary value of 1 price-point move for 1.0 lot. */
export function resolvePointValue(inst: InstrumentSpec): number | null {
  if (inst.pointValue > 0) return inst.pointValue;
  if (inst.tickSize > 0 && inst.tickValue > 0) {
    // 1 point ≈ 1 / tickSize ticks when price is quoted in absolute units
    return inst.tickValue / inst.tickSize;
  }
  if (inst.pipValue > 0) return inst.pipValue;
  return null;
}

export function calculateRisk(input: RiskCalcInput): RiskCalcResult {
  const { account, instrument, riskPercent, entryPrice, stopPrice, takeProfitPrice, side } = input;
  const openPnL = input.openPnL ?? 0;
  const usedMargin = input.usedMargin ?? 0;

  const balance = account.balance;
  const equity = balance + openPnL;
  const leverage = Math.max(1, account.leverage || 1);
  // Notional capacity: equity * leverage
  const freeMargin = Math.max(0, equity * leverage - usedMargin);

  const slDistance = Math.abs(entryPrice - stopPrice);
  const tpDistance =
    takeProfitPrice != null && Number.isFinite(takeProfitPrice)
      ? Math.abs(takeProfitPrice - entryPrice)
      : null;

  const pointValue = resolvePointValue(instrument);
  const missing: string[] = [];
  if (!pointValue || pointValue <= 0) missing.push("point/tick value");
  if (!(instrument.contractSize > 0)) missing.push("contract size");
  if (!(instrument.lotStep > 0)) missing.push("lot step");
  if (!(entryPrice > 0)) missing.push("entry price");
  if (!(slDistance > 0)) missing.push("stop distance");

  const riskPct = Math.max(0, riskPercent);
  const riskAmount = equity * (riskPct / 100);

  let riskBasedLot: number | null = null;
  let marginMaxLot: number | null = null;
  let finalLot: number | null = null;
  let marginRequired: number | null = null;
  let actualRiskAmount: number | null = null;
  let actualRiskPercent: number | null = null;
  let potentialProfit: number | null = null;
  let rr: number | null = null;

  if (missing.length === 0 && pointValue) {
    // Risk-based lot: riskAmount / (slDistance * pointValue per lot)
    const rawRiskLot = riskAmount / (slDistance * pointValue);
    riskBasedLot = roundDownToStep(rawRiskLot, instrument.lotStep, instrument.minLot);

    // Margin: notional = entry * contractSize * lots; margin = notional / leverage
    // => maxLots = freeMargin * leverage / (entry * contractSize)
    // For index CFDs contractSize is often 1 and pointValue is $1/pt/lot;
    // margin uses notional ≈ entry * contractSize * lots.
    const denom = entryPrice * instrument.contractSize;
    const rawMarginLot = denom > 0 ? freeMargin / denom : 0;
    // freeMargin already includes leverage factor as equity*leverage - usedMargin
    // so max lots = freeMargin / (entry * contractSize)
    marginMaxLot = roundDownToStep(rawMarginLot, instrument.lotStep, instrument.minLot);

    const volumeMax = instrument.maxLot > 0 ? instrument.maxLot : Infinity;
    const candidates = [riskBasedLot, marginMaxLot, volumeMax].filter(
      (x): x is number => x != null && Number.isFinite(x) && x > 0
    );
    if (candidates.length) {
      const rawFinal = Math.min(...candidates);
      finalLot = roundDownToStep(rawFinal, instrument.lotStep, instrument.minLot);
      if (finalLot <= 0) finalLot = null;
    }

    if (finalLot != null && finalLot > 0) {
      marginRequired = (entryPrice * instrument.contractSize * finalLot) / leverage;
      actualRiskAmount = slDistance * pointValue * finalLot;
      actualRiskPercent = equity > 0 ? (actualRiskAmount / equity) * 100 : null;
      if (tpDistance != null && tpDistance > 0) {
        potentialProfit = tpDistance * pointValue * finalLot;
        rr = slDistance > 0 ? tpDistance / slDistance : null;
      }
    }
  }

  return {
    balance,
    equity,
    freeMargin,
    leverage,
    riskPercent: riskPct,
    riskAmount,
    slDistance,
    tpDistance,
    pointValue: pointValue ?? 0,
    riskBasedLot,
    marginMaxLot,
    volumeMaxLot: instrument.maxLot,
    finalLot,
    marginRequired,
    actualRiskAmount,
    actualRiskPercent,
    potentialProfit,
    rr,
    missingSpec: missing.length ? missing.join(", ") : null,
  };
}

/** Snapshot frozen at fill — immutable for journal history. */
export type TradeRiskSnapshot = {
  accountId: string;
  balanceBefore: number;
  equityBefore: number;
  freeMarginBefore: number;
  leverage: number;
  riskPercent: number;
  riskAmount: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  slDistance: number;
  tpDistance: number | null;
  pointValue: number;
  riskBasedLot: number | null;
  marginMaxLot: number | null;
  finalLot: number | null;
  marginRequired: number | null;
  actualRiskAmount: number | null;
  actualRiskPercent: number | null;
  entryTime: number;
};
