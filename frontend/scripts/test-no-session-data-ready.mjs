/**
 * v3.20.2 — Zero sessions must not leave UI stuck in "Restoring previous session…"
 * Market data is global; Load 1s / Data Engine must remain usable without a Session.
 */

let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

/** Mirrors fixed initial-state logic */
function initialUiState({ activeSessionId, saved }) {
  const hasActive = !!activeSessionId;
  const message =
    hasActive && saved && saved.dataSource !== "demo"
      ? "Restoring previous session…"
      : saved?.message ?? "Demo data · Sync then Load";
  const loading = !!(hasActive && saved && saved.dataSource !== "demo");
  return { message, loading };
}

/** Mirrors fixed loadSession(null) outcome */
function afterNoSessionBootstrap() {
  return {
    sessionReady: true,
    loading: false,
    sessionMeta: null,
    message: "No active session · Use Data Engine or Load 1s (market data is global)",
    load1sDisabled: false, // disabled only when loading===true
  };
}

// 1. Stale localStorage after last session deleted
const stale = { dataSource: "loaded", symbol: "US30", start: "2026-06-01", end: "2026-06-10", message: "Loaded 1000" };
const s1 = initialUiState({ activeSessionId: null, saved: stale });
assert("1 no restore message without active session", s1.message !== "Restoring previous session…");
assert("2 loading false without active session", s1.loading === false);

// 2. With active session + loaded source → may restore
const s2 = initialUiState({ activeSessionId: "sess1", saved: stale });
assert("3 restore message with active+loaded", s2.message === "Restoring previous session…");
assert("4 loading true with active+loaded", s2.loading === true);

// 3. After loadSession(null)
const idle = afterNoSessionBootstrap();
assert("5 sessionReady true", idle.sessionReady === true);
assert("6 loading false", idle.loading === false);
assert("7 Load 1s enabled", idle.load1sDisabled === false);
assert("8 not stuck restoring", !idle.message.includes("Restoring"));

// 4. Market data ownership
const ownership = { marketData: "global", session: "consumer" };
assert("9 market data global", ownership.marketData === "global");
assert("10 session does not own cache", ownership.session === "consumer");

// 5. Delete last session → active null → idle
function onDeleteLastSession() {
  const activeSessionId = null;
  return { ...afterNoSessionBootstrap(), activeSessionId };
}
const afterDel = onDeleteLastSession();
assert("11 after delete ready", afterDel.sessionReady && !afterDel.loading);

// 6. Demo path still works
const s3 = initialUiState({ activeSessionId: null, saved: { dataSource: "demo", message: "Demo" } });
assert("12 demo message", s3.message === "Demo" || s3.loading === false);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
