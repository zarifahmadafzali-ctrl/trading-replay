/**
 * P4 — Real domain tests importing lib/propRules.ts (not mirrors).
 * Run: node --experimental-strip-types scripts/test-domain-prop-rules.ts
 */
import {
  isDailyLossBreached,
  sumCurrencyPnL,
  countTradingDays,
  belongsToAccount,
  stampUntaggedTrades,
  tradingDayKey,
  utcDayKey,
  evaluatePropRules,
  type PropTradeLike,
} from "../src/lib/propRules.ts";
import type { AccountProfile } from "../src/lib/riskModel.ts";

let failed = 0;
function assert(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL", name);
    failed++;
  } else console.log("PASS", name);
}

// --- P1 daily loss ---
assert(
  "P1 legacy: carried -300 with 0 day PnL breaches 5% of 5000",
  isDailyLossBreached(5000, 0, -300, 5, 0, "legacy") === true
);
assert(
  "P1 day_start: carried -300 unchanged today does NOT breach",
  isDailyLossBreached(5000, 0, -300, 5, -300, "day_start") === false
);
assert(
  "P1 day_start: new -250 move from -300 baseline breaches",
  isDailyLossBreached(5000, 0, -550, 5, -300, "day_start") === true
);
assert(
  "P1 default baseline is legacy (5th arg only)",
  isDailyLossBreached(5000, 0, -300, 5) === true
);

// --- P2 account attribution ---
const untagged: PropTradeLike = {
  entryTime: 1_700_000_000,
  exitTime: 1_700_000_100,
  currencyPnL: 100,
};
assert("P2 untagged does not belong to A without legacy", belongsToAccount(untagged, "A") === false);
assert("P2 untagged belongs to A with legacyOwnerId A", belongsToAccount(untagged, "A", "A") === true);
assert("P2 untagged does not belong to B with legacy A", belongsToAccount(untagged, "B", "A") === false);

assert(
  "P2 sumCurrencyPnL untagged not counted for A without legacy",
  sumCurrencyPnL([untagged], "A") === 0
);
assert(
  "P2 sumCurrencyPnL untagged counted once with legacy A",
  sumCurrencyPnL([untagged], "A", "A") === 100
);
assert(
  "P2 sumCurrencyPnL untagged NOT counted for B with legacy A",
  sumCurrencyPnL([untagged], "B", "A") === 0
);

const stamped = stampUntaggedTrades([untagged], "A");
assert("P2 stamp assigns accountId A", stamped[0].accountId === "A");
assert("P2 after stamp only A gets PnL", sumCurrencyPnL(stamped, "A") === 100 && sumCurrencyPnL(stamped, "B") === 0);

// --- P3 trading day key ---
assert("P3 UTC hour0 equals utcDayKey", tradingDayKey(1_700_000_000) === utcDayKey(1_700_000_000));
// Two times 1h apart across UTC midnight
const before = Date.UTC(2024, 0, 2, 23, 30, 0) / 1000; // 2024-01-02 23:30 UTC
const after = Date.UTC(2024, 0, 3, 0, 30, 0) / 1000; // 2024-01-03 00:30 UTC
assert("P3 UTC different days across midnight", tradingDayKey(before) !== tradingDayKey(after));
assert("P3 countTradingDays two closes across UTC midnight = 2", countTradingDays([
  { entryTime: before - 60, exitTime: before, currencyPnL: -10, accountId: "A" },
  { entryTime: after, exitTime: after + 60, currencyPnL: -10, accountId: "A" },
], "A") === 2);

// Europe/Prague reset hour 0 — still two distinct local dates near UTC midnight in winter
const pragueBefore = tradingDayKey(before, "Europe/Prague", 0);
const pragueAfter = tradingDayKey(after, "Europe/Prague", 0);
assert("P3 Prague keys defined", !!pragueBefore && !!pragueAfter);

// --- evaluatePropRules integration day_start ---
const account = {
  accountId: "A",
  name: "Test",
  balance: 5000,
  initialBalance: 5000,
  currency: "USD",
  leverage: 20,
  enabled: true,
  accountType: "prop" as const,
  propProgram: {
    id: "p1",
    firmName: "TestFirm",
    programName: "Test",
    phases: [
      {
        id: "ph1",
        name: "Phase 1",
        type: "challenge" as const,
        rules: {
          accountSize: 5000,
          dailyLossLimitPct: 5,
          dailyLossBaseline: "day_start" as const,
          profitTargetPct: 8,
          minimumTradingDays: 1,
        },
      },
    ],
  },
  activePropPhaseId: "ph1",
} as AccountProfile;

const ev = evaluatePropRules({
  account,
  trades: [],
  currentTime: 1_700_100_000,
  unrealizedPnL: -300,
  dayStartUnrealizedPnL: -300,
});
assert("P1 evaluatePropRules day_start no breach when flat today", ev.dailyLossBreached === false);

const evLegacy = evaluatePropRules({
  account: {
    ...account,
    propProgram: {
      ...account.propProgram!,
      phases: [
        {
          ...account.propProgram!.phases[0],
          rules: {
            ...account.propProgram!.phases[0].rules,
            dailyLossBaseline: "legacy",
          },
        },
      ],
    },
  },
  trades: [],
  currentTime: 1_700_100_000,
  unrealizedPnL: -300,
  dayStartUnrealizedPnL: -300,
});
assert("P1 evaluatePropRules legacy still breaches", evLegacy.dailyLossBreached === true);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll domain propRules tests PASS");
process.exit(0);
