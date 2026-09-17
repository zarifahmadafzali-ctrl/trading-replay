/**
 * v3.21.0 — Storage architecture invariants (static + logical).
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

const adapter = readFileSync(join(root, "src/lib/storageAdapter.ts"), "utf8");
const journal = readFileSync(join(root, "src/lib/journal.ts"), "utf8");
const backup = readFileSync(join(root, "src/lib/backup.ts"), "utf8");
const sessionView = readFileSync(join(root, "src/views/SessionView.tsx"), "utf8");
const store = readFileSync(join(root, "src/lib/sessionStore.ts"), "utf8");
const versions = readFileSync(join(root, "src/lib/storageVersions.ts"), "utf8");

assert("adapter exports getSessionStorageAdapter", adapter.includes("getSessionStorageAdapter"));
assert("adapter does not import barCache", !/import.*barCache/.test(adapter));
assert("adapter documents market data exclusion", adapter.includes("Market-data") || adapter.includes("market-data"));
assert("journal uses storage adapter", journal.includes("getSessionStorageAdapter"));
assert("journal does not call getSessionTrades directly", !journal.includes("getSessionTrades"));
assert("journal does not call putSessionTrades directly", !journal.includes("putSessionTrades"));
assert("backup uses adapter", backup.includes("getSessionStorageAdapter"));
assert("backup uses journal load/save", backup.includes("loadJournalForSession") && backup.includes("saveJournalForSession"));
assert("SessionView uses adapter", sessionView.includes("getSessionStorageAdapter"));
assert("SessionView delete via adapter", sessionView.includes(".deleteSession("));
assert("sessionStore is implementation backend", store.includes("IndexedDB") || store.includes("indexedDB") || store.includes("idb"));
assert("APP_VERSION present", versions.includes("APP_VERSION"));
assert("STORAGE_SCHEMA independent", versions.includes("STORAGE_SCHEMA_VERSION"));
assert("BACKUP_FORMAT independent", versions.includes("BACKUP_FORMAT_VERSION"));
assert("MARKET_DATA_CACHE independent", versions.includes("MARKET_DATA_CACHE_VERSION"));
assert("docs STORAGE.md exists", existsSync(join(root, "docs/STORAGE.md")));

// Logical: session delete must not touch bar cache keys
assert("deleteSessionAll does not open bar cache DB", !/trading-replay-bars|barCache|cachePutBars/.test(
  store.slice(store.indexOf("deleteSessionAll"), store.indexOf("deleteSessionAll") + 800)
));

// Zero-session invariant preserved in ReplayView
const replay = readFileSync(join(root, "src/views/ReplayView.tsx"), "utf8");
assert("ReplayView no-session ready path", replay.includes("No active session") && replay.includes("setSessionReady(true)"));

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
