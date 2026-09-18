/**
 * v3.36.0 — Deterministic in-memory driver for adapter conformance tests.
 * Not used in production browser builds.
 */

import type { SqliteDriver, SqlParam, SqlRow } from "./sqliteDriver";

type Table = Map<string, Record<string, unknown>>;

/**
 * Minimal SQL subset used by sqliteSessionAdapter:
 * - CREATE TABLE IF NOT EXISTS (ignored after first)
 * - INSERT OR REPLACE INTO t (cols) VALUES (...)
 * - SELECT * FROM t [WHERE col = ?]
 * - DELETE FROM t WHERE col = ?
 * - UPDATE meta ...
 */
export function createMemorySqliteDriver(): SqliteDriver {
  const tables = new Map<string, Table>();
  let inTx = false;
  let snapshot: string | null = null;

  function table(name: string): Table {
    let t = tables.get(name);
    if (!t) {
      t = new Map();
      tables.set(name, t);
    }
    return t;
  }

  function primaryKey(row: Record<string, unknown>, preferred: string[]): string {
    for (const k of preferred) {
      if (row[k] != null) return String(row[k]);
    }
    return JSON.stringify(row);
  }

  async function exec(sql: string, params: SqlParam[] = []): Promise<void> {
    const s = sql.trim().replace(/\s+/g, " ");
    if (/^CREATE TABLE/i.test(s)) {
      const m = s.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (m) table(m[1]);
      return;
    }
    if (/^INSERT OR REPLACE INTO/i.test(s) || /^INSERT INTO/i.test(s)) {
      const m = s.match(/INSERT(?: OR REPLACE)? INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/i);
      if (!m) throw new Error("unsupported INSERT: " + s);
      const name = m[1];
      const cols = m[2].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = params[i] ?? null;
      });
      const pk =
        name === "sessions"
          ? primaryKey(row, ["id"])
          : name === "session_runtime" || name === "session_shapes" || name === "journal_trades"
            ? primaryKey(row, ["session_id"])
            : name === "meta" || name === "app_kv"
              ? primaryKey(row, ["key"])
              : primaryKey(row, ["id", "key", "session_id"]);
      table(name).set(pk, row);
      return;
    }
    if (/^DELETE FROM/i.test(s)) {
      const m = s.match(/DELETE FROM (\w+) WHERE (\w+) = \?/i);
      if (!m) throw new Error("unsupported DELETE: " + s);
      const name = m[1];
      const col = m[2];
      const val = String(params[0]);
      const t = table(name);
      for (const [k, row] of [...t.entries()]) {
        if (String(row[col]) === val) t.delete(k);
      }
      return;
    }
    throw new Error("unsupported exec SQL: " + s.slice(0, 120));
  }

  async function query(sql: string, params: SqlParam[] = []): Promise<SqlRow[]> {
    const s = sql.trim().replace(/\s+/g, " ");
    const m = s.match(/SELECT \* FROM (\w+)(?: WHERE (\w+) = \?)?/i);
    if (!m) throw new Error("unsupported query: " + s);
    const name = m[1];
    const col = m[2];
    const t = table(name);
    let rows = [...t.values()] as SqlRow[];
    if (col) {
      const val = String(params[0]);
      rows = rows.filter((r) => String(r[col]) === val);
    }
    return rows;
  }

  return {
    location: "memory://sqlite-test",
    exec,
    query,
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (inTx) return fn();
      snapshot = JSON.stringify([...tables.entries()].map(([n, t]) => [n, [...t.entries()]]));
      inTx = true;
      try {
        const result = await fn();
        inTx = false;
        snapshot = null;
        return result;
      } catch (e) {
        // rollback
        tables.clear();
        if (snapshot) {
          const data = JSON.parse(snapshot) as [string, [string, Record<string, unknown>][]][];
          for (const [n, entries] of data) {
            tables.set(n, new Map(entries));
          }
        }
        inTx = false;
        snapshot = null;
        throw e;
      }
    },
  };
}
