// `npm run test:drawing` — compiles the REAL TS (no mirrors) and runs both drawing test files.
// Works from the app root (src/lib/...) or from this package folder (lib/...).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const libDir = process.env.DRAWING_LIB_DIR || (existsSync("src/lib/drawingModel.ts") ? "src/lib" : "lib");
const out = resolve(root, ".build-drawing");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
try {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsc", `${libDir}/drawingModel.ts`, `${libDir}/drawingRender.ts`, "--outDir", out, "--rootDir", ".",
     "--module", "commonjs", "--target", "es2020", "--lib", "es2020,dom", "--skipLibCheck", "--strict"],
    { stdio: "inherit", cwd: root }
  );
  writeFileSync(resolve(out, "package.json"), '{"type":"commonjs"}');
  const env = {
    ...process.env,
    DRAWING_BUILD: resolve(out, libDir, "drawingModel.js"),
    DRAWING_BUILD_RENDER: resolve(out, libDir, "drawingRender.js"),
  };
  let failed = false;
  for (const f of ["test-drawing-model.mjs", "test-drawing-render.mjs"]) {
    const r = spawnSync(process.execPath, [resolve(root, "scripts", f)], { stdio: "inherit", env });
    if (r.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(out, { recursive: true, force: true });
}
