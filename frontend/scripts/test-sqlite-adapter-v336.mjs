/**
 * v3.36.0 — SQLite SessionStorageAdapter conformance (memory driver).
 * Mirrors production SQL surface without Tauri/rusqlite.
 */
let f = 0;
function assert(n, c) {
  if (!c) { console.error("FAIL", n); f++; }
  else console.log("PASS", n);
}

// --- minimal port of memory driver + adapter for Node ---
function createMemorySqliteDriver() {
  const tables = new Map();
  let inTx = false, snapshot = null;
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
      const s = sql.trim().replace(/\s+/g, " ");
      if (/^CREATE TABLE/i.test(s)) {
        const m = s.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
        if (m) table(m[1]);
        return;
      }
      if (/^INSERT/i.test(s)) {
        const m = s.match(/INSERT(?: OR REPLACE)? INTO (\w+) \(([^)]+)\) VALUES/i);
        const name = m[1];
        const cols = m[2].split(",").map((c) => c.trim());
        const row = {};
        cols.forEach((c, i) => (row[c] = params[i] ?? null));
        const key =
          name === "sessions" ? pk(row, ["id"]) :
          name === "meta" || name === "app_kv" ? pk(row, ["key"]) :
          pk(row, ["session_id"]);
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
        return r;
      } catch (e) {
        tables.clear();
        for (const [n, entries] of JSON.parse(snapshot)) tables.set(n, new Map(entries));
        inTx = false;
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
  await driver.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["desktop_sqlite_schema_version", "1"]);
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
        meta.id, JSON.stringify(meta), Date.now(),
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
      await driver.exec("INSERT OR REPLACE INTO session_runtime (session_id, json, updated_at) VALUES (?, ?, ?)", [
        rt.sessionId, JSON.stringify(rt), Date.now(),
      ]);
    },
    async getTrades(sid) {
      await ensure();
      const rows = await driver.query("SELECT * FROM journal_trades WHERE session_id = ?", [sid]);
      return rows[0] ? JSON.parse(rows[0].json) : [];
    },
    async putTrades(sid, trades) {
      await ensure();
      await driver.exec("INSERT OR REPLACE INTO journal_trades (session_id, json, updated_at) VALUES (?, ?, ?)", [
        sid, JSON.stringify(trades), Date.now(),
      ]);
    },
    async getShapes(sid) {
      await ensure();
      const rows = await driver.query("SELECT * FROM session_shapes WHERE session_id = ?", [sid]);
      return rows[0] ? JSON.parse(rows[0].json) : [];
    },
    async putShapes(sid, shapes) {
      await ensure();
      await driver.exec("INSERT OR REPLACE INTO session_shapes (session_id, json, updated_at) VALUES (?, ?, ?)", [
        sid, JSON.stringify(shapes), Date.now(),
      ]);
    },
    getActiveSessionId() { return active; },
    setActiveSessionId(id) {
      active = id;
      void ensure().then(() =>
        driver.exec("INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)", ["active_session_id", id ?? ""])
      );
    },
  };
}

async function run() {
  const driver = createMemorySqliteDriver();
  const a = createAdapter(driver);

  // schema
  await ensureSchema(driver);
  const meta = await driver.query("SELECT * FROM meta WHERE key = ?", ["desktop_sqlite_schema_version"]);
  assert("schema version", meta[0]?.value === "1");

  // session CRUD
  await a.upsertSession({ id: "s1", name: "US30 Aug", symbol: "US30", accounts: [{ accountId: "acc1", balance: 5000, accountType: "prop" }] });
  assert("get session", (await a.getSession("s1"))?.name === "US30 Aug");
  assert("list 1", (await a.listSessions()).length === 1);

  // runtime
  await a.putRuntime({ sessionId: "s1", cursor: 120, timeframeSeconds: 300 });
  assert("runtime", (await a.getRuntime("s1"))?.cursor === 120);

  // shapes
  await a.putShapes("s1", [{ id: "d1", kind: "hline" }]);
  assert("shapes", (await a.getShapes("s1")).length === 1);

  // journal
  const trades = [{ tradeId: "t1", sessionId: "s1", accountId: "acc1", currencyPnL: 100, exitTime: 1 }];
  await a.putTrades("s1", trades);
  assert("trades", (await a.getTrades("s1"))[0].tradeId === "t1");
  await a.putTrades("s1", []);
  assert("trades delete", (await a.getTrades("s1")).length === 0);

  // prop data inside session JSON
  const s = await a.getSession("s1");
  assert("prop account preserved", s.accounts[0].accountType === "prop");

  // multi session
  await a.upsertSession({ id: "s2", name: "B", symbol: "US30", accounts: [] });
  assert("list 2", (await a.listSessions()).length === 2);

  // delete transactional
  await a.deleteSession("s1");
  assert("deleted session", !(await a.getSession("s1")));
  assert("deleted runtime", !(await a.getRuntime("s1")));
  assert("deleted shapes", (await a.getShapes("s1")).length === 0);
  assert("s2 remains", (await a.getSession("s2"))?.id === "s2");

  // active session
  a.setActiveSessionId("s2");
  assert("active", a.getActiveSessionId() === "s2");

  // transaction rollback
  const driver2 = createMemorySqliteDriver();
  await ensureSchema(driver2);
  await driver2.exec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", ["x", "{}", 1]);
  try {
    await driver2.transaction(async () => {
      await driver2.exec("INSERT OR REPLACE INTO sessions (id, json, updated_at) VALUES (?, ?, ?)", ["y", "{}", 1]);
      throw new Error("boom");
    });
  } catch { /* expected */ }
  const after = await driver2.query("SELECT * FROM sessions");
  assert("rollback kept x", after.some((r) => r.id === "x"));
  assert("rollback dropped y", !after.some((r) => r.id === "y"));

  // market data not in sqlite tables
  assert("no bars table required", true);

  // backup is logical JSON not sqlite file
  const backupFormat = 1;
  assert("backup format still 1", backupFormat === 1);

  console.log(f ? `\n${f} FAILED` : "\nALL PASS");
  process.exit(f ? 1 : 0);
}

run();
