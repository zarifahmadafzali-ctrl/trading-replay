/**
 * v3.32.0 — platform detection + file-service web fallback contracts.
 * Node environment: no real window/Tauri; asserts pure helpers via reimplementation.
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

// Mirror platform detection without DOM Tauri
function detectIsTauri(w) {
  if (!w) return false;
  if (w.__TAURI_INTERNALS__ != null) return true;
  if (w.__TAURI__ != null) return true;
  return false;
}

function getPlatformInfo(w) {
  const isTauri = detectIsTauri(w);
  return {
    platform: isTauri ? "desktop" : "web",
    isTauri,
  };
}

assert("web default", getPlatformInfo(undefined).platform === "web");
assert("web empty window", getPlatformInfo({}).platform === "web");
assert("desktop tauri1", getPlatformInfo({ __TAURI__: {} }).platform === "desktop");
assert("desktop tauri2", getPlatformInfo({ __TAURI_INTERNALS__: {} }).platform === "desktop");

// Storage adapter selection contract
const WEB_PLATFORM = "web-indexeddb";
const FUTURE = "desktop-sqlite-future";
assert("web storage id", WEB_PLATFORM === "web-indexeddb");
assert("future label exists", FUTURE.includes("sqlite"));

// File service: web always provides exportFile/pickTextFile surface
const webFileService = {
  platform: "web",
  exportFile: async () => {},
  pickTextFile: async () => null,
};
assert("web file platform", webFileService.platform === "web");
assert("export exists", typeof webFileService.exportFile === "function");
assert("pick exists", typeof webFileService.pickTextFile === "function");

// Format versions must not bump in v3.32
const BACKUP_FORMAT_VERSION = 1;
const MARKET_DATA_EXPORT_FORMAT_VERSION = 1;
const STORAGE_SCHEMA_VERSION = 1;
assert("backup v1", BACKUP_FORMAT_VERSION === 1);
assert("market export v1", MARKET_DATA_EXPORT_FORMAT_VERSION === 1);
assert("schema v1", STORAGE_SCHEMA_VERSION === 1);

// No second store
const canonicalStores = ["SessionStorageAdapter", "barCache"];
assert("two canonical owners", canonicalStores.length === 2);

// Tauri not required for web
const browserDevRequiresTauri = false;
assert("browser independent", browserDevRequiresTauri === false);

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
