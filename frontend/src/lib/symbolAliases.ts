/**
 * Canonical symbol lookup for market-data keys (Tick + bars day IDs).
 * Read-only fallback: does not migrate or rewrite stored IndexedDB rows.
 */

const CANONICAL_BY_ALIAS: Record<string, string> = {
  US30: "US30",
  USA30IDXUSD: "US30",
  US30IDXUSD: "US30",
  "US30.CASH": "US30",
  DJI: "US30",
  DOW: "US30",
  EURUSD: "EURUSD",
  XAUUSD: "XAUUSD",
  GOLD: "XAUUSD",
  BTCUSD: "BTCUSD",
  BTCUSDT: "BTCUSD",
};

/** Map any known provider/UI alias to a stable canonical symbol. */
export function canonicalSymbol(symbol: string): string {
  const u = String(symbol || "").trim().toUpperCase();
  if (!u) return u;
  return CANONICAL_BY_ALIAS[u] || u;
}

/**
 * Ordered candidates for IndexedDB lookup: canonical first, then known aliases.
 * Deduplicated.
 */
export function symbolLookupCandidates(symbol: string): string[] {
  const c = canonicalSymbol(symbol);
  const out: string[] = [c];
  for (const [alias, canon] of Object.entries(CANONICAL_BY_ALIAS)) {
    if (canon === c && alias !== c) out.push(alias);
  }
  // Always try the raw uppercased input last if different
  const raw = String(symbol || "").trim().toUpperCase();
  if (raw && !out.includes(raw)) out.push(raw);
  return out;
}
