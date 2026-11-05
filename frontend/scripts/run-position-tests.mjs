// Compiles the REAL src/lib/*.ts with tsc — no mirrors — and runs both test files.
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "pos-tests-"));
const tscJs = join(root, "node_modules", "typescript", "lib", "tsc.js");
const files = ["positionModel", "positionEngine", "positionRender", "positionSizing", "riskModel"].map((f) => join(root, "lib", `${f}.ts`));
if (!existsSync(tscJs)) throw new Error("typescript not installed at " + tscJs);
for (const f of files) if (!existsSync(f)) throw new Error("missing " + f);
execFileSync(process.execPath, [tscJs, "--outDir", out, "--module", "commonjs", "--target", "es2020", "--lib", "es2020,dom", "--skipLibCheck", "--strict", ...files], { stdio: "inherit" });
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "commonjs" }));
process.env.POSITION_TEST_LIB = out;
await import(join(here, "test-position.mjs"));
await import(join(here, "test-position-sizing.mjs"));
