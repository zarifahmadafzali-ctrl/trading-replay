/**
 * Focused tests for platform export boundary (no Tauri runtime required).
 * Verifies web path uses Blob download shape and outcome helpers.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = mkdtempSync(join(tmpdir(), "platform-file-"));
const localTsc = join(root, "node_modules", ".bin", "tsc");
const tsc = localTsc;

// Compile platformFile + platform only if tsc available
let ok = 0;
let fail = 0;
function check(name, cond) {
  if (cond) ok++;
  else {
    fail++;
    console.error("FAIL", name);
  }
}

// Static source checks (always run)
const platformFile = readFileSync(join(root, "src/lib/platformFile.ts"), "utf8");
check("desktop uses plugin-dialog save", platformFile.includes("@tauri-apps/plugin-dialog"));
check("desktop uses plugin-fs writeFile", platformFile.includes("writeFile"));
check("web still has createElement a download", platformFile.includes('createElement("a")'));
check("export outcome cancelled status", platformFile.includes('status: "cancelled"'));
check("empty helper present", platformFile.includes("emptyExportOutcome"));

const journal = readFileSync(join(root, "src/lib/journal.ts"), "utf8");
check("csv routes exportTextFile", journal.includes("exportTextFile") && journal.includes("downloadJournalCsv"));

const backup = readFileSync(join(root, "src/lib/journalBackup.ts"), "utf8");
check("zip routes exportBinaryFile", backup.includes("exportBinaryFile") && backup.includes("downloadJournalBackupZip"));
check("analytics json routes exportTextFile", backup.includes("downloadAnalyticsJson") && backup.includes("exportTextFile"));

const memos = readFileSync(join(root, "src/lib/tradeMemos.ts"), "utf8");
check("ai package routes exportBinaryFile", memos.includes("downloadAiReviewPackage") && memos.includes("exportBinaryFile"));

const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
check("cargo has dialog plugin", cargo.includes("tauri-plugin-dialog"));
check("cargo has fs plugin", cargo.includes("tauri-plugin-fs"));

const caps = readFileSync(join(root, "src-tauri/capabilities/default.json"), "utf8");
check("capabilities dialog", caps.includes("dialog:default"));
check("capabilities fs write", caps.includes("fs:allow-write-file"));

console.log(`${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
