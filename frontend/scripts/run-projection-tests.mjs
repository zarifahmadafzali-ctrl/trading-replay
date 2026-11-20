/**
 * Compile-free runner: Node strip-types loads the real chartProjection.ts.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, "test-chart-projection.mjs");
const r = spawnSync(
  process.execPath,
  ["--experimental-strip-types", testFile],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PROJ_TEST_LIB: "strip-types",
      PROJ_TEST_MODULE: join(here, "../src/lib/chartProjection.ts"),
    },
  }
);
process.exit(r.status ?? 1);
