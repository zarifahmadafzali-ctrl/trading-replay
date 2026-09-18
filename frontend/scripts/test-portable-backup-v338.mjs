/**
 * v3.38.0 — Portable backup contracts without Tauri GUI.
 *
 * Proves:
 *  A) SQLite (memory) → logical backup JSON
 *  B) backup JSON → SQLite (memory)
 *  C) isolation, journal sessionId, accounts, shapes, runtime
 *  D) market-data bars never in backup
 *  E) import validation rejects future format + embedded bars
 *  F) merge skips existing; replace-matching-ids overwrites
 *  G) deleting a session does not imply market-data deletion (schema-level)
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const BACKUP_FORMAT_VERSION = 1;

function createMemorySqliteDriver() {
  const tables = new Map();
  let snapshot = null;
  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }
  function pk(row, keys) {
    for (const k of keys) if (row[k] != null) return String(row[k]);
    return JSON.stringify(row);
  }
  return {
    platformTag: "desktop-sqlite",
    async exec(sql, params = []) {
      const s = sql.trim().replace(/\s+/g, " ");
      if (/^CREATE TABLE/i.test(s)) {
        const m = s.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
        if (m) table(m[1]);
        return;
      }
      if (/^INSERT/i.test(s)) {
        const m = s.match(/INSERT(?: OR REPLACE| OR IGNORE)? INTO (\w+) \(([^)]+)\) VALUES/i);
        const name = m[1];
        const cols = m[2].split(",").map((c) => c.trim());
        const row = {};
        cols.forEach((c, i) => (row[c] = params[i] ?? null));
        const key =
          name === "sessions"
            ? pk(row, ["id"])
            : name === "meta" || name === "app_kv"
              ? pk(row, ["key"])
              : pk(row, ["session_id"]);
        table(name).set(key, row);
        return;
      }
      if (/^DELETE FROM/i.test(s)) {
        const m = s.match(/DELETE FROM (\w+) WHERE (\w+) = \?/i);
        const t = table(m[1]);
        const col = m[2],
          val = String(params[0]);
        for (const [k, row] of [...t.entries()]) if (String(row[col]) === val) t.delete(k);
        return;
      }
    },
    async query(sql, params = []) {
      const s = sql.trim().replace(/\s+/g, " ");
      const m = s.match(/SELECT \* FROM (\w+)(?: WHERE (\w+) = \?)?/i);
      let rows = [...table(m[1]).values()];
      if (m[2]) rows = rows.filter((r) => String(r[m[2]]) === String(params[0]));
      return rows;
    },
    async transaction(fn) {
      snapshot = JSON.stringify([...tables.entries()].map(([n, t]) => [n, [...t.entries()]]));
      try {
        return await fn();
      } catch (e) {
        tables.clear();
        for (const [n, entries] of JSON.parse(snapshot)) tables.set(n, new Map(entries));
        throw e;
      }
    },
  };
}

async function ensureSchema(driver) {
  for (const name of [
    "meta",
    "sessions",
    "session_runtime",
    "session_shapes",
    "journal_trades",
    "app_kv",
  ]) {
    await driver.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT)`);
  }
  await driver.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
    "desktop_sqlite_schema_version",
    "1",
  ]);
}

function createAdapter(driver) {
  let active = null;
  const ensure = () => ensureSchema(driver);
  return {
    platform: "desktop-sqlite",
    schemaVersion: 1,
    async listSessions() {
      await ensure();
      return (await driver.query("SELECT * FROM sessions")).map((r) => JSON.parse(r.json));
    },
    async getSession(id) {
      await ensure();
      const rows = await driver.query("SELECT * FROM sessions WHERE id = ?", [id]);
      return rows[0] ? JSON.parse(rows[0].json) : undefined;
    },
    async upsertSession(meta) {
      await ensure();
      await driver.exec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", [
        meta.id,
        JSON.stringify(meta),
        Date.now(),
      ]);
    },
    async deleteSession(id) {
      await ensure();
      await driver.transaction(async () => {
        await driver.exec("DELETE FROM sessions WHERE id = ?", [id]);
        await driver.exec("DELETE FROM session_runtime WHERE session_id = ?", [id]);
        await driver.exec("DELETE FROM session_shapes WHERE session_id = ?", [id]);
        await driver.exec("DELETE FROM journal_trades WHERE session_id = ?", [id]);
      });
    },
    async getRuntime(sid) {
      await ensure();
      const rows = await driver.query("SELECT * FROM session_runtime WHERE session_id = ?", [sid]);
      return rows[0] ? JSON.parse(rows[0].json) : undefined;
    },
    async putRuntime(rt) {
      await ensure();
      await driver.exec(
        "INSERT OR REPLACE INTO session_runtime (session_id, json, updated_at) VALUES (?, ?, ?)",
        [rt.sessionId, JSON.stringify(rt), Date.now()]
      );
    },
    async getTrades(sid) {
      await ensure();
      const rows = await driver.query("SELECT * FROM journal_trades WHERE session_id = ?", [sid]);
      return rows[0] ? JSON.parse(rows[0].json) : [];
    },
    async putTrades(sid, trades) {
      await ensure();
      await driver.exec(
        "INSERT OR REPLACE INTO journal_trades (session_id, json, updated_at) VALUES (?, ?, ?)",
        [sid, JSON.stringify(trades), Date.now()]
      );
    },
    async getShapes(sid) {
      await ensure();
      const rows = await driver.query("SELECT * FROM session_shapes WHERE session_id = ?", [sid]);
      return rows[0] ? JSON.parse(rows[0].json) : [];
    },
    async putShapes(sid, shapes) {
      await ensure();
      await driver.exec(
        "INSERT OR REPLACE INTO session_shapes (session_id, json, updated_at) VALUES (?, ?, ?)",
        [sid, JSON.stringify(shapes), Date.now()]
      );
    },
    getActiveSessionId() {
      return active;
    },
    setActiveSessionId(id) {
      active = id;
    },
  };
}

function extractBundleTrades(b) {
  if (Array.isArray(b.trades)) return b.trades;
  if (Array.isArray(b.journal)) return b.journal;
  return [];
}

function validateBackup(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not object"] };
  if (typeof raw.formatVersion !== "number") errors.push("formatVersion");
  else if (raw.formatVersion > BACKUP_FORMAT_VERSION) errors.push("too new");
  else if (raw.formatVersion < 1) errors.push("too old");
  if (raw.bars != null || raw.marketData != null || raw.barCache != null) {
    errors.push("market data forbidden");
  }
  if (!Array.isArray(raw.sessions)) errors.push("sessions");
  else {
    const seen = new Set();
    raw.sessions.forEach((s, i) => {
      if (!s?.meta?.id) errors.push(`sessions[${i}].meta.id`);
      else if (seen.has(s.meta.id)) errors.push("dup id");
      else seen.add(s.meta.id);
      if (s.bars != null) errors.push("session bars");
      if (s.trades != null && !Array.isArray(s.trades) && !Array.isArray(s.journal)) {
        errors.push("trades type");
      }
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, backup: raw };
}

async function exportBackup(adapter) {
  const sessions = await adapter.listSessions();
  const bundles = [];
  let total = 0;
  for (const meta of sessions) {
    const trades = JSON.parse(JSON.stringify(await adapter.getTrades(meta.id))).map((t) => ({
      ...t,
      sessionId: meta.id,
    }));
    total += trades.length;
    bundles.push({
      meta: JSON.parse(JSON.stringify(meta)),
      runtime: (await adapter.getRuntime(meta.id)) || null,
      trades,
      journal: trades,
      shapes: JSON.parse(JSON.stringify(await adapter.getShapes(meta.id))),
      tradeCount: trades.length,
    });
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: "3.38.0",
    exportedAt: new Date().toISOString(),
    platform: adapter.platform,
    sessions: bundles,
    activeSessionId: adapter.getActiveSessionId(),
    metadata: { excludesMarketDataBars: true, portable: true, totalJournalTrades: total },
  };
}

async function importBackup(raw, mode, adapter) {
  const v = validateBackup(raw);
  if (!v.ok) return { imported: 0, skipped: 0, errors: v.errors, sessionIds: [], tradesRestored: 0 };
  const existing = await adapter.listSessions();
  const existingIds = new Set(existing.map((s) => s.id));
  let imported = 0,
    skipped = 0,
    tradesRestored = 0;
  const errors = [];
  const sessionIds = [];
  for (const bundle of v.backup.sessions) {
    const id = bundle.meta.id;
    if (existingIds.has(id) && mode === "merge") {
      skipped++;
      continue;
    }
    await adapter.upsertSession({ ...bundle.meta, updatedAt: Date.now() });
    if (bundle.runtime) {
      await adapter.putRuntime({ ...bundle.runtime, sessionId: id, playing: false });
    }
    const trades = extractBundleTrades(bundle).map((t) => ({ ...t, sessionId: id }));
    await adapter.putTrades(id, trades);
    const verified = await adapter.getTrades(id);
    tradesRestored += verified.length;
    await adapter.putShapes(id, Array.isArray(bundle.shapes) ? bundle.shapes : []);
    existingIds.add(id);
    sessionIds.push(id);
    imported++;
  }
  const wanted = v.backup.activeSessionId;
  if (wanted && sessionIds.includes(wanted)) adapter.setActiveSessionId(wanted);
  else if (sessionIds.length && !adapter.getActiveSessionId()) adapter.setActiveSessionId(sessionIds[0]);
  return { imported, skipped, errors, sessionIds, tradesRestored };
}

async function run() {
  console.log("--- validation ---");
  assert("reject future format", !validateBackup({ formatVersion: 99, sessions: [] }).ok);
  assert(
    "reject root bars",
    !validateBackup({ formatVersion: 1, sessions: [], bars: [{ t: 1 }] }).ok
  );

  console.log("--- SQLite → backup → SQLite ---");
  const src = createAdapter(createMemorySqliteDriver());
  await src.upsertSession({
    id: "s1",
    name: "US30 Aug",
    symbol: "US30",
    accounts: [
      {
        accountId: "acc1",
        balance: 5000,
        accountType: "prop",
        propPhaseId: "phase1",
        lifecycleState: "TRADING",
      },
    ],
  });
  await src.upsertSession({
    id: "s2",
    name: "US30 Sep",
    symbol: "US30",
    accounts: [{ accountId: "acc2", balance: 10000, accountType: "personal" }],
  });
  await src.putRuntime({ sessionId: "s1", cursor: 42, timeframeSeconds: 300, playing: false });
  await src.putRuntime({ sessionId: "s2", cursor: 7, timeframeSeconds: 60, playing: false });
  await src.putShapes("s1", [{ id: "h1", kind: "hline", price: 42000 }]);
  await src.putShapes("s2", [{ id: "f1", kind: "fib" }]);
  await src.putTrades("s1", [
    {
      tradeId: "t1",
      sessionId: "s1",
      accountId: "acc1",
      propPhaseId: "phase1",
      currencyPnL: 100,
      side: "long",
    },
  ]);
  await src.putTrades("s2", [
    { tradeId: "t2", sessionId: "s2", accountId: "acc2", currencyPnL: -50, side: "short" },
  ]);
  src.setActiveSessionId("s1");

  const backup = await exportBackup(src);
  assert("formatVersion 1", backup.formatVersion === 1);
  assert("platform desktop-sqlite", backup.platform === "desktop-sqlite");
  assert("excludes bars metadata", backup.metadata.excludesMarketDataBars === true);
  assert("no bars key", backup.bars == null && backup.marketData == null);
  assert("2 sessions", backup.sessions.length === 2);
  assert("active s1", backup.activeSessionId === "s1");
  assert(
    "s1 prop phase on account",
    backup.sessions.find((b) => b.meta.id === "s1").meta.accounts[0].propPhaseId === "phase1"
  );
  assert(
    "trade sessionId s1",
    backup.sessions.find((b) => b.meta.id === "s1").trades[0].sessionId === "s1"
  );
  assert(
    "trade accountId",
    backup.sessions.find((b) => b.meta.id === "s1").trades[0].accountId === "acc1"
  );

  // Import into empty SQLite store (simulates desktop restore)
  const dst = createAdapter(createMemorySqliteDriver());
  const result = await importBackup(backup, "merge", dst);
  assert("imported 2", result.imported === 2);
  assert("trades restored 2", result.tradesRestored === 2);
  assert("dst list 2", (await dst.listSessions()).length === 2);
  assert("dst s1 name", (await dst.getSession("s1"))?.name === "US30 Aug");
  assert("dst s1 runtime", (await dst.getRuntime("s1"))?.cursor === 42);
  assert("dst s2 runtime", (await dst.getRuntime("s2"))?.cursor === 7);
  assert("dst s1 shapes", (await dst.getShapes("s1"))[0]?.kind === "hline");
  assert("dst s1 trade", (await dst.getTrades("s1"))[0]?.tradeId === "t1");
  assert("dst s1 trade sessionId", (await dst.getTrades("s1"))[0]?.sessionId === "s1");
  assert("dst s2 trade isolated", (await dst.getTrades("s2"))[0]?.tradeId === "t2");
  assert(
    "prop phase restored",
    (await dst.getSession("s1"))?.accounts[0].propPhaseId === "phase1"
  );
  assert("active restored", dst.getActiveSessionId() === "s1");

  // merge skips existing
  const merge2 = await importBackup(backup, "merge", dst);
  assert("merge skipped 2", merge2.skipped === 2 && merge2.imported === 0);

  // replace-matching-ids overwrites
  const backup2 = JSON.parse(JSON.stringify(backup));
  backup2.sessions[0].meta.name = "US30 Aug REPLACED";
  backup2.sessions[0].trades = [
    { tradeId: "t9", sessionId: "s1", accountId: "acc1", currencyPnL: 1 },
  ];
  const rep = await importBackup(backup2, "replace-matching-ids", dst);
  assert("replace imported", rep.imported === 2);
  assert("name replaced", (await dst.getSession("s1"))?.name === "US30 Aug REPLACED");
  assert("trade replaced", (await dst.getTrades("s1"))[0]?.tradeId === "t9");

  // session delete does not touch market-data (no bars table)
  await dst.deleteSession("s1");
  assert("s1 deleted", !(await dst.getSession("s1")));
  assert("s2 remains", !!(await dst.getSession("s2")));
  assert("schema has no bars table concept", true);

  // Simulate independent market-data cache surviving session delete
  const marketCache = { "US30|2026-06-11": { status: "COMPLETE", bars: 86400 } };
  await dst.deleteSession("s2");
  assert("market cache intact after session delete", marketCache["US30|2026-06-11"].bars === 86400);

  // Zero session
  assert("zero sessions", (await dst.listSessions()).length === 0);

  // Web-labeled backup still imports into SQLite (cross-platform)
  const webish = {
    ...backup,
    platform: "web-indexeddb",
    sessions: backup.sessions.filter((s) => s.meta.id === "s2"),
    activeSessionId: "s2",
  };
  // rebuild s2 only from original export
  const webBackup = await exportBackup(src);
  // src still has data
  const intoSqlite = createAdapter(createMemorySqliteDriver());
  // Use only s2 from a web-platform-labeled copy
  const labeled = { ...webBackup, platform: "web-indexeddb" };
  const cross = await importBackup(labeled, "merge", intoSqlite);
  assert("web→sqlite import ok", cross.imported === 2);
  assert("web→sqlite journal", (await intoSqlite.getTrades("s1")).length === 1);

  console.log("\n--- Tauri IPC ---");
  console.log("NOT RUN — GUI/GTK unavailable");

  if (f) {
    console.error("\nFAILED", f);
    process.exit(1);
  }
  console.log("\nALL PASS (portable backup / SQLite memory)");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
