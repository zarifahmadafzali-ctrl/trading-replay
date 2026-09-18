/**
 * v3.37.0 — Shared SQL allow-list for desktop SQLite surface.
 * Frontend domain code never builds SQL from user input; only the adapter
 * emits fixed statement shapes. This guard documents / validates that surface.
 */

/** Statements the SessionStorageAdapter is allowed to exec (non-SELECT). */
export function isAllowedSqliteExec(sql: string): boolean {
  const s = sql.trim();
  if (!s) return true;
  const body = s.replace(/;\s*$/, "");
  if (body.includes(";")) return false; // multi-statement
  const upper = body.toUpperCase().replace(/\s+/g, " ");

  if (upper.startsWith("BEGIN") || upper === "BEGIN TRANSACTION") return true;
  if (upper.startsWith("COMMIT") || upper.startsWith("ROLLBACK")) return true;
  if (upper.startsWith("CREATE TABLE IF NOT EXISTS ")) return true;
  if (upper.startsWith("INSERT OR REPLACE INTO ") || upper.startsWith("INSERT OR IGNORE INTO ")) return true;
  if (upper.startsWith("DELETE FROM ")) return true;
  // Read-only pragmas only
  if (upper === "PRAGMA FOREIGN_KEYS = ON" || upper === "PRAGMA FOREIGN_KEYS=ON") return true;

  return false;
}

export function isAllowedSqliteQuery(sql: string): boolean {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s) return false;
  if (s.includes(";")) return false;
  const upper = s.toUpperCase().replace(/\s+/g, " ");
  return upper.startsWith("SELECT ");
}
