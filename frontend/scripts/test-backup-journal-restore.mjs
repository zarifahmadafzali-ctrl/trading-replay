/**
 * v3.20.1 — Export → delete → import must restore Journal trades.
 * Simulates the backup pipeline without IndexedDB (pure structure + validate/extract).
 */

function extractBundleTrades(bundle) {
  if (Array.isArray(bundle.trades)) return bundle.trades;
  if (Array.isArray(bundle.journal)) return bundle.journal;
  if (Array.isArray(bundle.sessionTrades)) return bundle.sessionTrades;
  return [];
}

function validateBackup(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not object"] };
  if (typeof raw.formatVersion !== "number") errors.push("formatVersion");
  if (!Array.isArray(raw.sessions)) errors.push("sessions");
  return errors.length ? { ok: false, errors } : { ok: true, backup: raw };
}

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

// Simulate store
const store = {
  sessions: new Map(),
  trades: new Map(),
  shapes: new Map(),
  runtime: new Map(),
};

function createSession() {
  const id = "sess-restore-test";
  const meta = {
    id,
    name: "US30 Test",
    symbol: "US30",
    start: "2026-06-01",
    end: "2026-06-30",
    dataSource: "loaded",
    createdAt: 1,
    updatedAt: 1,
    accounts: [
      {
        accountId: "acc1",
        name: "Prop 5k",
        initialBalance: 5000,
        balance: 5100,
        currency: "USD",
        leverage: 20,
        enabled: true,
        accountType: "prop",
      },
    ],
    activeAccountId: "acc1",
  };
  const trades = [
    {
      id: "t1",
      tradeId: "t1",
      sessionId: id,
      accountId: "acc1",
      symbol: "US30",
      side: "long",
      orderType: "market",
      entryPrice: 39000,
      exitPrice: 39100,
      stopPrice: 38950,
      takeProfitPrice: 39100,
      entryTime: 1000,
      exitTime: 2000,
      reason: "tp",
      pnlPoints: 100,
      rMultiple: 2,
      currencyPnL: 100,
      balanceBefore: 5000,
      balanceAfter: 5100,
    },
    {
      id: "t2",
      tradeId: "t2",
      sessionId: id,
      accountId: "acc1",
      symbol: "US30",
      side: "short",
      orderType: "market",
      entryPrice: 39100,
      exitPrice: 39050,
      stopPrice: 39150,
      takeProfitPrice: 39050,
      entryTime: 3000,
      exitTime: 4000,
      reason: "tp",
      pnlPoints: 50,
      rMultiple: 1,
      currencyPnL: 50,
      balanceBefore: 5100,
      balanceAfter: 5150,
    },
  ];
  store.sessions.set(id, meta);
  store.trades.set(id, trades);
  store.shapes.set(id, [{ type: "hline", price: 39000 }]);
  store.runtime.set(id, { sessionId: id, cursor: 10, playing: false, timeframeSeconds: 300 });
  return { id, meta, trades };
}

function exportBackup() {
  const sessions = [...store.sessions.values()];
  return {
    formatVersion: 1,
    appVersion: "3.20.1",
    exportedAt: new Date().toISOString(),
    platform: "web-indexeddb",
    sessions: sessions.map((meta) => {
      const trades = store.trades.get(meta.id) || [];
      return {
        meta: JSON.parse(JSON.stringify(meta)),
        runtime: store.runtime.get(meta.id) || null,
        trades: JSON.parse(JSON.stringify(trades)),
        journal: JSON.parse(JSON.stringify(trades)),
        shapes: JSON.parse(JSON.stringify(store.shapes.get(meta.id) || [])),
        tradeCount: trades.length,
      };
    }),
    metadata: { totalJournalTrades: [...store.trades.values()].reduce((a, t) => a + t.length, 0) },
  };
}

function deleteSession(id) {
  store.sessions.delete(id);
  store.trades.delete(id);
  store.shapes.delete(id);
  store.runtime.delete(id);
}

function importBackup(raw, mode) {
  const v = validateBackup(raw);
  if (!v.ok) return { imported: 0, tradesRestored: 0, errors: v.errors };
  let imported = 0;
  let tradesRestored = 0;
  for (const bundle of v.backup.sessions) {
    const id = bundle.meta.id;
    if (store.sessions.has(id) && mode === "merge") continue;
    store.sessions.set(id, bundle.meta);
    const trades = extractBundleTrades(bundle).map((t) => ({ ...t, sessionId: id }));
    store.trades.set(id, trades);
    store.shapes.set(id, bundle.shapes || []);
    if (bundle.runtime) store.runtime.set(id, { ...bundle.runtime, sessionId: id });
    imported++;
    tradesRestored += trades.length;
  }
  return { imported, tradesRestored, errors: [] };
}

function analyticsFromJournal(trades) {
  const wins = trades.filter((t) => (t.currencyPnL || 0) > 0).length;
  const losses = trades.filter((t) => (t.currencyPnL || 0) < 0).length;
  const pnl = trades.reduce((s, t) => s + (t.currencyPnL || 0), 0);
  const totalR = trades.reduce((s, t) => s + (t.rMultiple || 0), 0);
  return { tradeCount: trades.length, wins, losses, pnl, totalR };
}

// ── Scenario: EXPORT → DELETE → IMPORT → JOURNAL + ANALYTICS ──
const { id, trades: originalTrades } = createSession();
const before = analyticsFromJournal(store.trades.get(id));
assert("setup 2 trades", originalTrades.length === 2);
assert("setup balance 5100 on account", store.sessions.get(id).accounts[0].balance === 5100);

const backup = exportBackup();
assert("export contains trades", backup.sessions[0].trades.length === 2);
assert("export journal alias", backup.sessions[0].journal.length === 2);
assert("export tradeCount", backup.sessions[0].tradeCount === 2);
assert("export metadata total", backup.metadata.totalJournalTrades === 2);
assert("export preserves trade ids", backup.sessions[0].trades[0].id === "t1");
assert("export preserves accountId", backup.sessions[0].trades[0].accountId === "acc1");
assert("export preserves sessionId", backup.sessions[0].trades[0].sessionId === id);
assert("export preserves currencyPnL", backup.sessions[0].trades[1].currencyPnL === 50);

deleteSession(id);
assert("deleted session gone", !store.sessions.has(id));
assert("deleted trades gone", !store.trades.has(id));

const result = importBackup(backup, "merge");
assert("import session count", result.imported === 1);
assert("import trades restored count", result.tradesRestored === 2);
assert("session restored", store.sessions.has(id));
assert("account restored", store.sessions.get(id).accounts[0].accountId === "acc1");
assert("balance restored", store.sessions.get(id).accounts[0].balance === 5100);

const restored = store.trades.get(id) || [];
assert("journal 2 trades", restored.length === 2);
assert("trade1 sessionId", restored[0].sessionId === id);
assert("trade2 accountId", restored[1].accountId === "acc1");
assert("trade fields intact", restored[0].entryPrice === 39000 && restored[0].reason === "tp");

const after = analyticsFromJournal(restored);
assert("analytics trade count", after.tradeCount === before.tradeCount);
assert("analytics wins", after.wins === before.wins);
assert("analytics pnl", after.pnl === before.pnl);
assert("analytics totalR", after.totalR === before.totalR);

// Merge skip on second import
const r2 = importBackup(backup, "merge");
assert("merge skips existing", r2.imported === 0);
assert("no duplicate trades", store.trades.get(id).length === 2);

// Replace mode updates trades
const backup2 = JSON.parse(JSON.stringify(backup));
backup2.sessions[0].trades.push({
  id: "t3",
  tradeId: "t3",
  sessionId: id,
  accountId: "acc1",
  currencyPnL: -25,
  rMultiple: -0.5,
  entryPrice: 1,
  exitPrice: 2,
  stopPrice: 0,
  takeProfitPrice: 0,
  entryTime: 5,
  exitTime: 6,
  side: "long",
  orderType: "market",
  reason: "sl",
  pnlPoints: -25,
  symbol: "US30",
});
backup2.sessions[0].journal = backup2.sessions[0].trades;
const r3 = importBackup(backup2, "replace-matching-ids");
assert("replace imported", r3.imported === 1);
assert("replace has 3 trades", store.trades.get(id).length === 3);

// Empty trades export detection (diagnose)
const emptyBackup = {
  formatVersion: 1,
  sessions: [{ meta: { id: "x" }, trades: [], shapes: [] }],
};
assert("diagnose empty", extractBundleTrades(emptyBackup.sessions[0]).length === 0);

// v3.20.0 backup that only had trades key
const v320 = {
  formatVersion: 1,
  sessions: [
    {
      meta: { id: "old" },
      trades: [{ id: "a", sessionId: "old", accountId: "acc1", currencyPnL: 10 }],
      shapes: [],
    },
  ],
};
assert("v320 trades extract", extractBundleTrades(v320.sessions[0]).length === 1);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
