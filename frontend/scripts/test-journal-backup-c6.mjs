/**
 * C6 journal backup structural checks (source contracts; not executed in C6 phase).
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "../src/lib/journalBackup.ts"), "utf8");
const zip = readFileSync(join(dir, "../src/lib/zipStore.ts"), "utf8");

function ok(n, c) {
  if (!c) throw new Error("FAIL " + n);
  console.log("ok -", n);
}

ok("format version", /JOURNAL_BACKUP_FORMAT_VERSION = 1/.test(src));
ok("buildJournalBackupZip", /export function buildJournalBackupZip/.test(src));
ok("parseJournalBackupZip", /export function parseJournalBackupZip/.test(src));
ok("merge replace", /ImportMode = "merge" \| "replace"/.test(src));
ok("writeZipStored", /export function writeZipStored/.test(zip));
ok("attachments path", /attachments\/trade_/.test(src));
console.log("C6 contract checks listed (run later).");
