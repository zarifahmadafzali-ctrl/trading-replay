/**
 * v3.17.5 — Account-level risk / lot / margin model.
 *
 * Account owns: balance, leverage, minLot/maxLot/lotStep
 * Instrument owns: point/tick/contract + optional instrumentMaxLot hard cap
 * Leverage affects margin capacity only — never multiplies PnL.
 */

export type AccountProfile = {
  accountId: string;
  name: string;
  /** Immutable starting capital (analytics / drawdown baseline). */
  initialBalance: number;
  /** Realized balance after closed trades (risk basis). */
  balance: number;
  currency: string;
  /** e.g. 20 means 1:20 — margin capacity only */
  leverage: number;
  enabled: boolean;
  accountType?: "personal" | "prop";
  /** Account-specific volume limits (v3.17.5). */
  minLot?: number;
  maxLot?: number;
  lotStep?: number;
};

export type InstrumentSpec = {
  symbol: string;
  contractSize: number;
  tickSize: number;
  tickValue: number;
  pointValue: number;
  pipValue: number;
  /**
   * Broker/instrument hard volume floor (shared). Prefer account.minLot when set.
   * Kept for backward compatibility with stored sessions.
   */
  minLot: number;
  /**
   * Broker/instrument hard volume ceiling (shared intentionally).
   * NOT the same as account.maxLot — both are applied with min().
   */
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

/** Frozen fields at fill — stored on JournalTrade.snapshot */
export type TradeRiskSnapshot = {
  accountId?: string;
  initialBalance?: number;
  balance?: number;
  balanceBefore?: number;
  equity?: number;
  equityBefore?: number;
  freeMargin?: number;
  freeMarginBefore?: number;
  leverage?: number;
  riskPercent?: number;
  riskAmount?: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number | null;
  slDistance?: number;
  tpDistance?: number | null;
  pointValue?: number;
  contractSize?: number;
  accountMinLot?: number;
  accountMaxLot?: number;
  instrumentMaxLot?: number;
  lotStep?: number;
  riskBasedLot?: number | null;
  marginMaxLot?: number | null;
  finalLot?: number | null;
  marginRequired?: number | null;
  actualRiskAmount?: number | null;
  actualRiskPercent?: number | null;
  entryTime?: number;
  [key: string]: unknown;
};

export type RiskCalcInput = {
  account: AccountProfile;
  instrument: InstrumentSpec;
  riskPercent: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice?: number;
  side: "long" | "short";
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
  /** Effective account volume ceiling used */
  accountMaxLot: number;
  accountMinLot: number;
  /** Instrument/broker hard ceiling */
  instrumentMaxLot: number;
  volumeMaxLot: number;
  finalLot: number | null;
  marginRequired: number | null;
  actualRiskAmount: number | null;
  actualRiskPercent: number | null;
  potentialProfit: number | null;
  rr: number | null;
  missingSpec: string | null;
  /** True when constraints leave no valid volume */
  insufficientVolume: boolean;
  volumeBlockReason: string | null;
};

export function defaultAccount(partial?: Partial<AccountProfile>): AccountProfile {
  const initial = partial?.initialBalance ?? partial?.balance ?? 5000;
  return {
    accountId: partial?.accountId || `acc_${Math.random().toString(36).slice(2, 8)}`,
    name: partial?.name || "Account 1",
    initialBalance: initial,
    balance: partial?.balance ?? initial,
    currency: partial?.currency || "USD",
    leverage: partial?.leverage ?? 20,
    enabled: partial?.enabled !== false,
    accountType: partial?.accountType || "personal",
    minLot: partial?.minLot ?? 0.01,
    maxLot: partial?.maxLot ?? 100,
    lotStep: partial?.lotStep ?? 0.01,
  };
}

/** Normalize legacy accounts: copy instrument defaults only when account fields missing. */
export function normalizeAccount(
  account: AccountProfile,
  instrument?: InstrumentSpec | null
): AccountProfile {
  const inst = instrument || defaultInstrument("US30");
  const initial = account.initialBalance ?? account.balance ?? 5000;
  return {
    ...account,
    initialBalance: initial,
    balance: Number.isFinite(account.balance) ? account.balance : initial,
    minLot: account.minLot ?? inst.minLot ?? 0.01,
    // Do NOT copy a suspicious low instrument maxLot into account unless already set on account.
    // Default account max stays generous (100) so one session instrument cap cannot poison all accounts.
    maxLot: account.maxLot ?? 100,
    lotStep: account.lotStep ?? inst.lotStep ?? 0.01,
    accountType: account.accountType || "personal",
    enabled: account.enabled !== false,
  };
}

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

export function roundDownToStep(lot: number, step: number, minLot: number): number {
  if (!Number.isFinite(lot) || lot <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  const steps = Math.floor(lot / step + 1e-12);
  const rounded = steps * step;
  const precision = Math.max(0, (step.toString().split(".")[1] || "").length);
  const v = Number(rounded.toFixed(precision));
  return v < minLot - 1e-12 ? 0 : v;
}

export function resolvePointValue(inst: InstrumentSpec): number | null {
  if (inst.pointValue > 0) return inst.pointValue;
  if (inst.tickSize > 0 && inst.tickValue > 0) return inst.tickValue / inst.tickSize;
  if (inst.pipValue > 0) return inst.pipValue;
  return null;
}

/** Margin required for `lots` at entry (notional / leverage). */
export function calculateRequiredMargin(
  entryPrice: number,
  lots: number,
  instrument: InstrumentSpec,
  leverage: number
): number {
  const lev = Math.max(1, leverage || 1);
  if (!(entryPrice > 0) || !(lots > 0) || !(instrument.contractSize > 0)) return 0;
  return (entryPrice * instrument.contractSize * lots) / lev;
}

export function calculateMarginBasedMaxLot(
  freeMargin: number,
  entryPrice: number,
  instrument: InstrumentSpec,
  leverage: number,
  lotStep: number,
  minLot: number
): number {
  const lev = Math.max(1, leverage || 1);
  // freeMargin is already equity-derived capacity in account currency.
  // Per-lot margin at 1.0 lot:
  const perLot = calculateRequiredMargin(entryPrice, 1, instrument, lev);
  if (!(perLot > 0) || !(freeMargin > 0)) return 0;
  const raw = freeMargin / perLot;
  return roundDownToStep(raw, lotStep, minLot);
}

export function calculateRisk(input: RiskCalcInput): RiskCalcResult {
  const { account: rawAccount, instrument, riskPercent, entryPrice, stopPrice, takeProfitPrice } = input;
  const account = normalizeAccount(rawAccount, instrument);
  const openPnL = input.openPnL ?? 0;
  const usedMargin = input.usedMargin ?? 0;

  const balance = account.balance;
  const equity = balance + openPnL;
  const leverage = Math.max(1, account.leverage || 1);
  // Free margin in account currency (equity already reflects open PnL)
  const freeMargin = Math.max(0, equity - usedMargin);

  const slDistance = Math.abs(entryPrice - stopPrice);
  const tpDistance =
    takeProfitPrice != null && Number.isFinite(takeProfitPrice)
      ? Math.abs(takeProfitPrice - entryPrice)
      : null;

  const pointValue = resolvePointValue(instrument);
  const missing: string[] = [];
  if (!pointValue || pointValue <= 0) missing.push("point/tick value");
  if (!(instrument.contractSize > 0)) missing.push("contract size");
  if (!(entryPrice > 0)) missing.push("entry price");
  if (!(slDistance > 0)) missing.push("stop distance");

  const accMin = account.minLot ?? 0.01;
  const accMax = account.maxLot ?? 100;
  const accStep = account.lotStep ?? 0.01;
  const instMin = instrument.minLot > 0 ? instrument.minLot : accMin;
  const instMax = instrument.maxLot > 0 ? instrument.maxLot : Infinity;
  const step = accStep > 0 ? accStep : instrument.lotStep || 0.01;
  const effectiveMin = Math.max(accMin, instMin);

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
  let insufficientVolume = false;
  let volumeBlockReason: string | null = null;

  if (missing.length === 0 && pointValue) {
    const rawRiskLot = riskAmount / (slDistance * pointValue);
    riskBasedLot = roundDownToStep(rawRiskLot, step, effectiveMin);

    marginMaxLot = calculateMarginBasedMaxLot(
      freeMargin,
      entryPrice,
      instrument,
      leverage,
      step,
      effectiveMin
    );

    const candidates = [riskBasedLot, marginMaxLot, accMax, instMax].filter(
      (x): x is number => x != null && Number.isFinite(x) && x > 0
    );
    if (candidates.length) {
      const rawFinal = Math.min(...candidates);
      finalLot = roundDownToStep(rawFinal, step, effectiveMin);
      if (finalLot <= 0) {
        finalLot = null;
        insufficientVolume = true;
        volumeBlockReason = "Volume below minimum lot after constraints (risk/margin/account/instrument).";
      }
    } else {
      insufficientVolume = true;
      volumeBlockReason = "No valid volume under current risk/margin limits.";
    }

    if (finalLot != null && finalLot > 0) {
      marginRequired = calculateRequiredMargin(entryPrice, finalLot, instrument, leverage);
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
    accountMaxLot: accMax,
    accountMinLot: effectiveMin,
    instrumentMaxLot: Number.isFinite(instMax) ? instMax : 0,
    volumeMaxLot: Number.isFinite(instMax) ? Math.min(accMax, instMax) : accMax,
    finalLot,
    marginRequired,
    actualRiskAmount,
    actualRiskPercent,
    potentialProfit,
    rr,
    missingSpec: missing.length ? missing.join(", ") : null,
    insufficientVolume,
    volumeBlockReason,
  };
}

/** Currency PnL from historical journal fields (never live account settings). */
export function currencyPnLFromTradeFields(opts: {
  rMultiple?: number | null;
  actualRiskAmount?: number | null;
  riskAmount?: number | null;
  pnlPoints?: number | null;
  finalLot?: number | null;
  riskBasedLot?: number | null;
  pointValue?: number | null;
}): number {
  if (
    opts.rMultiple != null &&
    Number.isFinite(opts.rMultiple) &&
    opts.actualRiskAmount != null &&
    Number.isFinite(opts.actualRiskAmount)
  ) {
    return opts.rMultiple * opts.actualRiskAmount;
  }
  if (
    opts.rMultiple != null &&
    Number.isFinite(opts.rMultiple) &&
    opts.riskAmount != null &&
    Number.isFinite(opts.riskAmount)
  ) {
    return opts.rMultiple * opts.riskAmount;
  }
  const lot = opts.finalLot ?? opts.riskBasedLot;
  const pv = opts.pointValue;
  if (
    opts.pnlPoints != null &&
    Number.isFinite(opts.pnlPoints) &&
    lot != null &&
    Number.isFinite(lot) &&
    pv != null &&
    Number.isFinite(pv)
  ) {
    return opts.pnlPoints * pv * lot;
  }
  // Explicit: no silent lot=1 if lot unknown
  return 0;
}

/** Unrealized currency PnL for an open position at mark price. */
export function unrealizedPnLCurrency(opts: {
  side: "long" | "short";
  entryPrice: number;
  markPrice: number;
  finalLot: number;
  pointValue: number;
}): number {
  if (!(opts.finalLot > 0) || !(opts.pointValue > 0)) return 0;
  const points =
    opts.side === "long" ? opts.markPrice - opts.entryPrice : opts.entryPrice - opts.markPrice;
  return points * opts.pointValue * opts.finalLot;
}

/** Apply realized currency PnL to account.balance; initialBalance stays immutable. */
export function applyRealizedPnL(account: AccountProfile, currencyPnL: number): AccountProfile {
  const nextBal = (Number.isFinite(account.balance) ? account.balance : account.initialBalance) + currencyPnL;
  return {
    ...account,
    balance: nextBal,
  };
}
