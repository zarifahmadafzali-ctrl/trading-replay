/**
 * v3.42.0 — Static checks for Windows auto-update configuration.
 * Does not perform a live update (requires Windows EXE + GitHub Release).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "..");

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    failed++;
  } else console.log("PASS", name);
}

const confPath = path.join(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
assert("version 3.42.0", conf.version === "3.42.0");
assert("createUpdaterArtifacts true", conf.bundle?.createUpdaterArtifacts === true);
assert("updater plugin present", !!conf.plugins?.updater);
assert("pubkey non-empty", typeof conf.plugins.updater.pubkey === "string" && conf.plugins.updater.pubkey.length > 20);
assert("HTTPS endpoint", Array.isArray(conf.plugins.updater.endpoints) && conf.plugins.updater.endpoints.every((u) => u.startsWith("https://")));
assert(
  "GitHub latest.json endpoint",
  conf.plugins.updater.endpoints.some((u) => u.includes("github.com") && u.includes("latest.json"))
);
assert("windows installMode passive", conf.plugins.updater.windows?.installMode === "passive");
assert("no private key in tauri.conf", !JSON.stringify(conf).includes("PRIVATE KEY"));

const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
assert("tauri-plugin-updater dep", cargo.includes("tauri-plugin-updater"));
assert("tauri-plugin-process dep", cargo.includes("tauri-plugin-process"));

const libRs = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
assert("updater plugin registered", libRs.includes("tauri_plugin_updater"));
assert("process plugin registered", libRs.includes("tauri_plugin_process"));

const caps = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/capabilities/default.json"), "utf8"));
assert("updater:default permission", caps.permissions.includes("updater:default"));
assert("process:default permission", caps.permissions.includes("process:default"));

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert("npm plugin-updater", !!pkg.dependencies["@tauri-apps/plugin-updater"]);
assert("npm plugin-process", !!pkg.dependencies["@tauri-apps/plugin-process"]);
assert("package version 3.42.0", pkg.version === "3.42.0");

const wf = fs.readFileSync(path.join(repo, ".github/workflows/windows-build.yml"), "utf8");
assert("workflow uses TAURI_SIGNING_PRIVATE_KEY", wf.includes("TAURI_SIGNING_PRIVATE_KEY"));
assert("workflow generates latest.json", wf.includes("latest.json"));
assert("workflow can publish release", wf.includes("publish_release"));
assert("no private key literal in workflow", !wf.includes("BEGIN") && !/untrusted comment:.*private/i.test(wf));

// Ensure private key file is not in the tree
function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "target" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
const files = walk(repo);
const keyFiles = files.filter((f) => /\.key$/i.test(f) && !f.includes("icons"));
assert("no .key files tracked in workspace", keyFiles.length === 0);

const updaterTs = fs.readFileSync(path.join(root, "src/lib/desktopUpdater.ts"), "utf8");
assert("desktop updater module exists", updaterTs.includes("checkForDesktopUpdate"));
assert("data-safety comment present", /binaries only|SQLite|not cleared|stay intact/i.test(updaterTs));

const panel = fs.readFileSync(path.join(root, "src/components/UpdatePanel.tsx"), "utf8");
assert("UpdatePanel desktop-only", panel.includes("isDesktopPlatform"));
assert("manual check action", panel.includes("Check for Updates"));

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll v3.42.0 updater config checks PASS");
process.exit(0);
