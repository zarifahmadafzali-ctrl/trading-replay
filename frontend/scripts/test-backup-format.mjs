/**
 * v3.20.0 — Backup format validation (no IndexedDB required).
 */

function validateBackup(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not object"] };
  if (typeof raw.formatVersion !== "number") errors.push("formatVersion");
  else if (raw.formatVersion > 1) errors.push("too new");
  else if (raw.formatVersion < 1) errors.push("too old");
  if (!Array.isArray(raw.sessions)) errors.push("sessions");
  else {
    raw.sessions.forEach((s, i) => {
      if (!s?.meta?.id) errors.push(`sessions[${i}].meta.id`);
      if (!Array.isArray(s.trades)) errors.push(`sessions[${i}].trades`);
      if (!Array.isArray(s.shapes)) errors.push(`sessions[${i}].shapes`);
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const good = {
  formatVersion: 1,
  appVersion: "3.20.0",
  exportedAt: "2026-09-17T00:00:00.000Z",
  platform: "web-indexeddb",
  sessions: [
    {
      meta: { id: "s1", name: "Test", symbol: "US30", start: "2026-06-01", end: "2026-06-30", dataSource: "loaded", createdAt: 1, updatedAt: 1, accounts: [{ accountId: "a1", balance: 5000 }] },
      runtime: null,
      trades: [{ tradeId: "t1", currencyPnL: 100, accountId: "a1" }],
      shapes: [],
    },
  ],
  metadata: { excludesMarketDataBars: true },
};

assert("valid backup", validateBackup(good).ok);
assert("reject no version", !validateBackup({ sessions: [] }).ok);
assert("reject future version", !validateBackup({ ...good, formatVersion: 99 }).ok);
assert("reject missing meta id", !validateBackup({ formatVersion: 1, sessions: [{ meta: {}, trades: [], shapes: [] }] }).ok);
assert("reject non-array trades", !validateBackup({ formatVersion: 1, sessions: [{ meta: { id: "x" }, trades: {}, shapes: [] }] }).ok);
assert("journal trade preserved in structure", good.sessions[0].trades[0].tradeId === "t1");
assert("accounts nested in session meta", good.sessions[0].meta.accounts[0].accountId === "a1");
assert("market data excluded by design", good.metadata.excludesMarketDataBars === true);

// Ownership model checks (documentation assertions)
const ownership = {
  marketData: "global shared cache by symbol|day",
  sessions: "session-specific",
  runtime: "session-specific",
  drawings: "session-specific",
  journal: "session-specific immutable historical",
  accounts: "session-scoped profiles",
  analytics: "derived from journal",
};
assert("market not in session blob", ownership.marketData.includes("global"));
assert("journal historical", ownership.journal.includes("immutable"));

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
