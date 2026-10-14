/**
 * Ensure product version is identical across:
 * package.json, Cargo.toml, tauri.conf.json, storageVersions APP_VERSION
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const sv = readFileSync(join(root, "src/lib/storageVersions.ts"), "utf8");

const cargoVer = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
const appVer = (sv.match(/export const APP_VERSION = "([^"]+)"/) || [])[1];
const tauriVer = tauri.version || tauri.package?.version;

const versions = {
  "package.json": pkg.version,
  "Cargo.toml": cargoVer,
  "tauri.conf.json": tauriVer,
  "APP_VERSION": appVer,
};

console.log("Versions:", versions);

const set = new Set(Object.values(versions));
if (set.has(undefined) || set.has(null) || set.has("")) {
  fail("One or more version fields missing: " + JSON.stringify(versions));
}
if (set.size !== 1) {
  fail("Version mismatch across sources: " + JSON.stringify(versions));
}

// Updater endpoint must stay on releases/latest/download/latest.json
const plugins = tauri.plugins || {};
const updater = plugins.updater || {};
const endpoints = updater.endpoints || [];
const okEndpoint = endpoints.some((e) =>
  String(e).includes("/releases/latest/download/latest.json")
);
if (!okEndpoint) {
  fail("tauri.conf.json updater.endpoints must include releases/latest/download/latest.json");
}
if (!updater.pubkey || String(updater.pubkey).length < 32) {
  fail("tauri.conf.json updater.pubkey missing");
}

console.log("PASS version sync + updater endpoint/pubkey present");
