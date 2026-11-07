// Read-only consistency check for the Tauri JS <-> Rust dependency set. No network, no dependencies.
//   node scripts/check-tauri-deps.mjs
// Fails (exit 1) when: npm lock does not satisfy the plugins' @tauri-apps/api range, a nested/duplicate
// @tauri-apps/api copy exists, Cargo.lock lacks the plugin crates, or JS/Rust minors differ.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const problems = [];
const info = [];
const fail = (m) => problems.push(m);
const mm = (v) => String(v).split(".").slice(0, 2).join(".");
const parse = (v) => String(v).split(".").map((n) => parseInt(n, 10));
function satisfiesCaret(version, range) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!m) return null; // unknown range style
  const [a, b, c] = parse(version);
  const [A, B, C] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a !== A) return false;
  return b > B || (b === B && c >= C);
}

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const P = lock.packages || {};
const apiPin = pkg.dependencies["@tauri-apps/api"];
const lockApi = P["node_modules/@tauri-apps/api"]?.version;
info.push(`package.json  @tauri-apps/api = ${apiPin}`);
info.push(`package-lock  @tauri-apps/api = ${lockApi ?? "MISSING"}`);
if (lockApi !== apiPin) fail(`package-lock @tauri-apps/api (${lockApi}) != package.json pin (${apiPin}). Regenerate the lock.`);
const nested = Object.keys(P).filter((k) => k.endsWith("/@tauri-apps/api") && k !== "node_modules/@tauri-apps/api");
if (nested.length) fail(`nested @tauri-apps/api copies in lock: ${nested.join(", ")}`);

const npmPlugins = {};
for (const name of ["plugin-updater", "plugin-process"]) {
  const e = P[`node_modules/@tauri-apps/${name}`];
  if (!e) { fail(`@tauri-apps/${name} missing from package-lock`); continue; }
  npmPlugins[name] = e.version;
  const range = e.dependencies?.["@tauri-apps/api"];
  const ok = range && lockApi ? satisfiesCaret(lockApi, range) : null;
  info.push(`@tauri-apps/${name} ${e.version} requires @tauri-apps/api ${range ?? "(none)"} -> locked api ${lockApi} ${ok === true ? "OK" : ok === false ? "NOT SATISFIED" : "?"}`);
  if (ok === false) fail(`@tauri-apps/${name}@${e.version} needs @tauri-apps/api ${range} but the lock has ${lockApi}`);
  if (pkg.dependencies[`@tauri-apps/${name}`] !== e.version) fail(`package.json pin for ${name} (${pkg.dependencies[`@tauri-apps/${name}`]}) != lock (${e.version})`);
}

const cl = read("src-tauri/Cargo.lock");
const crate = (n) => {
  const m = new RegExp(`\\[\\[package\\]\\]\\nname = "${n}"\\nversion = "([^"]+)"`).exec(cl);
  return m ? m[1] : null;
};
const tauriCrate = crate("tauri");
info.push(`Cargo.lock    tauri = ${tauriCrate ?? "MISSING"}`);
if (!tauriCrate) fail("Cargo.lock has no tauri crate");
else if (lockApi && mm(tauriCrate) !== mm(lockApi)) fail(`tauri crate ${tauriCrate} and @tauri-apps/api ${lockApi} differ in major.minor (Tauri CLI >= 2.8 aborts \`tauri build\`)`);
for (const [name, crateName] of [["plugin-updater", "tauri-plugin-updater"], ["plugin-process", "tauri-plugin-process"]]) {
  const v = crate(crateName);
  info.push(`Cargo.lock    ${crateName} = ${v ?? "MISSING"}`);
  if (!v) fail(`Cargo.lock lacks ${crateName} (stale lock: \`cargo build --locked\` would fail)`);
  else if (npmPlugins[name] && mm(v) !== mm(npmPlugins[name])) fail(`${crateName} ${v} vs @tauri-apps/${name} ${npmPlugins[name]} differ in major.minor`);
}

console.log(info.join("\n"));
if (problems.length) {
  console.log("\nFAIL:");
  for (const p of problems) console.log(" - " + p);
  process.exit(1);
}
console.log("\nOK: JS and Rust Tauri packages are consistent.");
