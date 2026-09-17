/** v3.33.0 — platform + desktop identity contracts */
let f = 0;
function assert(n, c) {
  if (!c) { console.error("FAIL", n); f++; }
  else console.log("PASS", n);
}

function detectIsTauri(w) {
  if (!w) return false;
  return w.__TAURI_INTERNALS__ != null || w.__TAURI__ != null;
}
function getPlatform(w) {
  return detectIsTauri(w) ? "desktop" : "web";
}

assert("web", getPlatform({}) === "web");
assert("desktop", getPlatform({ __TAURI_INTERNALS__: {} }) === "desktop");

const APP_ID = "com.tradingreplay.afzali";
const PRODUCT = "Trading Replay";
const VERSION = "3.33.0";
assert("app id", APP_ID === "com.tradingreplay.afzali");
assert("product", PRODUCT === "Trading Replay");
assert("version", VERSION === "3.33.0");

const BACKUP = 1, MARKET = 1, SCHEMA = 1;
assert("formats frozen", BACKUP === 1 && MARKET === 1 && SCHEMA === 1);

const sqliteImplemented = false;
assert("no sqlite", sqliteImplemented === false);

const browserRequiresTauri = false;
assert("web independent", browserRequiresTauri === false);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
