// Compiles the REAL src/lib/*.ts (including riskModel) with tsc — no mirrors — and runs test files.
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = mkdtempSync(join(tmpdir(), "pos-tests-"));
const tscCandidates = [
  join(root, "node_modules", "typescript", "lib", "tsc.js"),
  join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"),
];
const tscJs = tscCandidates.find((c) => existsSync(c));
const files = ["positionModel", "positionEngine", "positionRender", "positionSizing", "riskModel"].map(
  (f) => join(root, "src", "lib", `${f}.ts`)
);
for (const f of files) {
  if (!existsSync(f)) throw new Error("missing " + f);
}
if (tscJs && tscJs.endsWith("tsc.js")) {
  execFileSync(process.execPath, [tscJs, "--outDir", out, "--module", "commonjs", "--target", "es2020", "--lib", "es2020,dom", "--skipLibCheck", "--strict", ...files], {
    stdio: "inherit",
  });
} else {
  const tsc = tscJs || "tsc";
  execFileSync(tsc, ["--outDir", out, "--module", "commonjs", "--target", "es2020", "--lib", "es2020,dom", "--skipLibCheck", "--strict", ...files], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "commonjs" }));
process.env.POSITION_TEST_LIB = out;
await import(join(here, "test-position.mjs"));
await import(join(here, "test-position-sizing.mjs"));
await import(join(here, "test-position-ticket.mjs"));
