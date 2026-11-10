/** Pure tests for cache-first Load 1s decision (desktop vs remote). */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Inline the pure logic (mjs cannot import TS without build) — mirror cacheFirstLoad.ts
function decideCacheFirstLoad(opts) {
  const hasLocal = opts.localBarCount > 0;
  const missing = opts.missingDayCount > 0;
  const online = opts.backendOnline === true;
  if (hasLocal && !missing) return { paintLocal: true, fetchRemote: false, doneAfterLocal: true };
  if (hasLocal && missing && !online) return { paintLocal: true, fetchRemote: false, doneAfterLocal: true };
  if (hasLocal && missing && online) return { paintLocal: true, fetchRemote: true, doneAfterLocal: false };
  if (!hasLocal && !online) return { paintLocal: false, fetchRemote: false, doneAfterLocal: true };
  return { paintLocal: false, fetchRemote: true, doneAfterLocal: false };
}
function messageAfterNetworkFailure(localBarsApplied, errMsg) {
  if (localBarsApplied > 0) return `Network failed · showing ${localBarsApplied.toLocaleString()} local bars`;
  return errMsg || "Load failed";
}

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.error("FAIL", name); }
}

const fullLocal = decideCacheFirstLoad({ localBarCount: 5000, missingDayCount: 0, backendOnline: true });
assert(fullLocal.paintLocal && !fullLocal.fetchRemote && fullLocal.doneAfterLocal, "full local online → paint only");

const partialOffline = decideCacheFirstLoad({ localBarCount: 1000, missingDayCount: 2, backendOnline: false });
assert(partialOffline.paintLocal && !partialOffline.fetchRemote, "partial offline → paint local, no fetch");

const partialOnline = decideCacheFirstLoad({ localBarCount: 1000, missingDayCount: 2, backendOnline: true });
assert(partialOnline.paintLocal && partialOnline.fetchRemote && !partialOnline.doneAfterLocal, "partial online → paint then fetch");

const noneOnline = decideCacheFirstLoad({ localBarCount: 0, missingDayCount: 3, backendOnline: true });
assert(!noneOnline.paintLocal && noneOnline.fetchRemote, "empty online → fetch");

const noneOffline = decideCacheFirstLoad({ localBarCount: 0, missingDayCount: 3, backendOnline: false });
assert(!noneOffline.paintLocal && !noneOffline.fetchRemote, "empty offline → stop");

const nullBackend = decideCacheFirstLoad({ localBarCount: 100, missingDayCount: 1, backendOnline: null });
assert(nullBackend.paintLocal && !nullBackend.fetchRemote, "backend null treated as offline for fetch");

assert(
  messageAfterNetworkFailure(1234, "boom").includes("local bars") && messageAfterNetworkFailure(1234, "boom").includes("local bars"),
  "network fail keeps local message"
);
assert(messageAfterNetworkFailure(0, "timeout") === "timeout", "network fail with no local shows error");

// Regression: OLD behavior would not paint local when online+partial before fetch — NEW must paint
assert(partialOnline.paintLocal === true, "REGRESSION: online partial must paint local first");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
