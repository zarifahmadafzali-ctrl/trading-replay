/**
 * v3.36.0 — Low-level SQLite driver boundary.
 * Frontend never passes arbitrary SQL from UI code — only typed adapter methods use the driver.
 */

export type SqlParam = string | number | null;

export type SqlRow = Record<string, unknown>;

export interface SqliteDriver {
  /** Run DDL/DML; no result rows required. */
  exec(sql: string, params?: SqlParam[]): Promise<void>;
  /** SELECT returning row objects. */
  query(sql: string, params?: SqlParam[]): Promise<SqlRow[]>;
  /** Run fn inside a single transaction (commit/rollback). */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Optional path for diagnostics */
  readonly location?: string;
}
