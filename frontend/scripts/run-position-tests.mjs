// Compiles the REAL lib/*.ts with tsc (no mirrors) into a temp dir and runs the tests against it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "pos-tests-"));
const localTsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const tsc = existsSync(localTsc) ? localTsc : "tsc";
execFileSync(
  tsc,
  ["--outDir", out, "--module", "commonjs", "--target", "es2020", "--lib", "es2020,dom", "--skipLibCheck", "--strict",
   join(root, "src/lib/positionModel.ts"), join(root, "src/lib/positionEngine.ts"), join(root, "src/lib/positionRender.ts")],
  { stdio: "inherit", shell: process.platform === "win32" }
);
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "commonjs" }));
process.env.POSITION_TEST_LIB = out;
await import(join(here, "test-position.mjs"));
