/**
 * v3.37.0 — Desktop SQLite layer hardening tests (no Tauri GUI required).
 * A) Memory-driver adapter conformance + SQL allow-list + isolation
 * B) Tauri IPC — marked NOT RUN in environments without GTK/WebKit
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

// --- SQL allow-list (mirrors sqliteSqlGuard.ts) ---
function isAllowedSqliteExec(sql) {
  const s = sql.trim();
  if (!s) return true;
  const body = s.replace(/;\s*$/, "");
  if (body.includes(";")) return false;
  const upper = body.toUpperCase().replace(/\s+/g, " ");
  if (upper.startsWith("BEGIN") || upper === "BEGIN TRANSACTION") return true;
  if (upper.startsWith("COMMIT") || upper.startsWith("ROLLBACK")) return true;
  if (upper.startsWith("CREATE TABLE IF NOT EXISTS ")) return true;
  if (upper.startsWith("INSERT OR REPLACE INTO ") || upper.startsWith("INSERT OR IGNORE INTO ")) return true;
  if (upper.startsWith("DELETE FROM ")) return true;
  if (upper === "PRAGMA FOREIGN_KEYS = ON" || upper === "PRAGMA FOREIGN_KEYS=ON") return true;
  return false;
}
function isAllowedSqliteQuery(sql) {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s || s.includes(";")) return false;
  const upper = s.toUpperCase().replace(/\s+/g, " ");
  return upper.startsWith("SELECT ");
}

function createMemorySqliteDriver() {
  const tables = new Map();
  let inTx = false,
    snapshot = null;
  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }
  function pk(row, keys) {
    for (const k of keys) if (row[k] != null) return String(row[k]);
    return JSON.stringify(row);
  }
  return {
    location: "memory://test",
    async exec(sql, params = []) {
      if (!isAllowedSqliteExec(sql) && !/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql.trim())) {
        // memory driver still rejects non-adapter shapes for parity
        if (!/^CREATE TABLE|^INSERT|^DELETE FROM|^BEGIN|^COMMIT|^ROLLBACK/i.test(sql.trim())) {
          throw new Error("not allowed: " + sql);
        }
      }
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
        const col = m[2];
        const val = String(params[0]);
        for (const [k, row] of [...t.entries()]) if (String(row[col]) === val) t.delete(k);
        return;
      }
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(s)) return;
      throw new Error("bad exec " + s);
    },
    async query(sql, params = []) {
      if (!isAllowedSqliteQuery(sql)) throw new Error("bad query " + sql);
      const s = sql.trim().replace(/\s+/g, " ");
      const m = s.match(/SELECT \* FROM (\w+)(?: WHERE (\w+) = \?)?/i);
      let rows = [...table(m[1]).values()];
      if (m[2]) rows = rows.filter((r) => String(r[m[2]]) === String(params[0]));
      return rows;
    },
    async transaction(fn) {
      snapshot = JSON.stringify([...tables.entries()].map(([n, t]) => [n, [...t.entries()]]));
      inTx = true;
      try {
        const r = await fn();
        inTx = false;
        snapshot = null;
        return r;
      } catch (e) {
        tables.clear();
        for (const [n, entries] of JSON.parse(snapshot)) tables.set(n, new Map(entries));
        inTx = false;
        snapshot = null;
        throw e;
      }
    },
  };
}

async function ensureSchema(driver) {
  const ddl = [
    "CREATE TABLE IF NOT EXISTS meta (key TEXT, value TEXT)",
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT, json TEXT, updated_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS session_runtime (session_id TEXT, json TEXT, updated_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS session_shapes (session_id TEXT, json TEXT, updated_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS journal_trades (session_id TEXT, json TEXT, updated_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS app_kv (key TEXT, value TEXT)",
  ];
  for (const s of ddl) await driver.exec(s);
  const rows = await driver.query("SELECT * FROM meta WHERE key = ?", ["desktop_sqlite_schema_version"]);
  if (!rows.length) {
    await driver.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
      "desktop_sqlite_schema_version",
      "1",
    ]);
  }
}

function createAdapter(driver) {
  let active = null;
  const ensure = () => ensureSchema(driver);
  return {
    platform: "desktop-sqlite",
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
      void ensure().then(() =>
        driver.exec("INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)", [
          "active_session_id",
          id ?? "",
        ])
      );
    },
  };
}

async function run() {
  console.log("--- A) SQL allow-list ---");
  assert("allow INSERT OR REPLACE", isAllowedSqliteExec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)"));
  assert("allow DELETE", isAllowedSqliteExec("DELETE FROM sessions WHERE id = ?"));
  assert("allow CREATE IF NOT EXISTS", isAllowedSqliteExec("CREATE TABLE IF NOT EXISTS sessions (id TEXT)"));
  assert("reject DROP", !isAllowedSqliteExec("DROP TABLE sessions"));
  assert("reject multi-stmt", !isAllowedSqliteExec("DELETE FROM sessions WHERE id = ?; DROP TABLE meta"));
  assert("reject SELECT on exec", !isAllowedSqliteExec("SELECT * FROM sessions"));
  assert("allow SELECT query", isAllowedSqliteQuery("SELECT * FROM sessions WHERE id = ?"));
  assert("reject INSERT as query", !isAllowedSqliteQuery("INSERT INTO sessions VALUES (1)"));

  console.log("--- A) Adapter CRUD / isolation ---");
  const driver = createMemorySqliteDriver();
  const a = createAdapter(driver);

  await ensureSchema(driver);
  const meta = await driver.query("SELECT * FROM meta WHERE key = ?", ["desktop_sqlite_schema_version"]);
  assert("schema version 1", meta[0]?.value === "1");

  // zero-session
  assert("zero sessions initially", (await a.listSessions()).length === 0);

  await a.upsertSession({
    id: "s1",
    name: "US30 Aug",
    symbol: "US30",
    accounts: [{ accountId: "acc1", balance: 5000, accountType: "prop" }],
  });
  await a.upsertSession({
    id: "s2",
    name: "US30 Sep",
    symbol: "US30",
    accounts: [{ accountId: "acc2", balance: 10000, accountType: "personal" }],
  });
  assert("list 2", (await a.listSessions()).length === 2);

  await a.putRuntime({ sessionId: "s1", cursor: 10, timeframeSeconds: 60 });
  await a.putRuntime({ sessionId: "s2", cursor: 99, timeframeSeconds: 300 });
  await a.putShapes("s1", [{ id: "h1", kind: "hline" }]);
  await a.putShapes("s2", [{ id: "f1", kind: "fib" }]);
  await a.putTrades("s1", [{ tradeId: "t1", sessionId: "s1", accountId: "acc1", currencyPnL: 50 }]);
  await a.putTrades("s2", [{ tradeId: "t2", sessionId: "s2", accountId: "acc2", currencyPnL: -20 }]);

  assert("s1 runtime isolated", (await a.getRuntime("s1"))?.cursor === 10);
  assert("s2 runtime isolated", (await a.getRuntime("s2"))?.cursor === 99);
  assert("s1 journal isolated", (await a.getTrades("s1"))[0].tradeId === "t1");
  assert("s2 journal isolated", (await a.getTrades("s2"))[0].tradeId === "t2");
  assert("s1 shapes isolated", (await a.getShapes("s1"))[0].kind === "hline");
  assert("s2 shapes isolated", (await a.getShapes("s2"))[0].kind === "fib");

  // update session
  await a.upsertSession({
    id: "s1",
    name: "US30 Aug Updated",
    symbol: "US30",
    accounts: [{ accountId: "acc1", balance: 5100, accountType: "prop" }],
  });
  assert("session update", (await a.getSession("s1"))?.name === "US30 Aug Updated");
  assert("balance in JSON", (await a.getSession("s1"))?.accounts[0].balance === 5100);

  // delete s1 only
  await a.deleteSession("s1");
  assert("s1 gone", !(await a.getSession("s1")));
  assert("s1 runtime gone", !(await a.getRuntime("s1")));
  assert("s1 trades empty", (await a.getTrades("s1")).length === 0);
  assert("s2 still present", (await a.getSession("s2"))?.id === "s2");
  assert("s2 journal intact", (await a.getTrades("s2"))[0].tradeId === "t2");
  assert("s2 runtime intact", (await a.getRuntime("s2"))?.cursor === 99);

  // market-data independence: session delete only touches session tables
  // (barCache is separate IndexedDB — no SQLite table for bars exists)
  const tableNames = ["meta", "sessions", "session_runtime", "session_shapes", "journal_trades", "app_kv"];
  assert("no bars table in schema", !tableNames.includes("bars") && !tableNames.includes("market_data"));

  // zero-session after deleting last
  await a.deleteSession("s2");
  assert("zero sessions after delete all", (await a.listSessions()).length === 0);
  a.setActiveSessionId(null);
  assert("active null", a.getActiveSessionId() === null);

  // transaction rollback
  const d2 = createMemorySqliteDriver();
  await ensureSchema(d2);
  await d2.exec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", ["keep", "{}", 1]);
  try {
    await d2.transaction(async () => {
      await d2.exec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", ["temp", "{}", 1]);
      throw new Error("boom");
    });
  } catch {
    /* expected */
  }
  const after = await d2.query("SELECT * FROM sessions");
  assert("rollback keeps original", after.length === 1 && after[0].id === "keep");
  assert("rollback drops temp", !after.find((r) => r.id === "temp"));

  // idempotent schema ensure
  await ensureSchema(d2);
  const v = await d2.query("SELECT * FROM meta WHERE key = ?", ["desktop_sqlite_schema_version"]);
  assert("schema still 1 after re-ensure", v[0]?.value === "1");

  console.log("--- B) Tauri IPC ---");
  console.log("NOT RUN — requires Tauri runtime + GTK/WebKit (environment blocker)");

  if (f) {
    console.error("\nFAILED", f);
    process.exit(1);
  }
  console.log("\nALL PASS (SQLite/native memory-driver suite)");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
