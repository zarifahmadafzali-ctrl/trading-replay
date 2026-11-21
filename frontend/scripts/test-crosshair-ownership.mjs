import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = join(here, "../src/lib/crosshairOwnership.ts");
const r = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "-e",
    `
import { crosshairMode, lwcMayWriteCrosshair, pointerMayWriteCrosshair } from ${JSON.stringify(mod)};
function assert(c,m){ if(!c) throw new Error(m); }

assert(crosshairMode({ dragActive: false, placementSteps: 0 }) === "lwc-hover", "idle hover");
assert(crosshairMode({ dragActive: false, placementSteps: 1 }) === "pointer-draw", "placing");
assert(crosshairMode({ dragActive: true, placementSteps: 0 }) === "pointer-draw", "drag");
assert(lwcMayWriteCrosshair("lwc-hover") && !lwcMayWriteCrosshair("pointer-draw"), "lwc write rules");
assert(pointerMayWriteCrosshair("pointer-draw") && !pointerMayWriteCrosshair("lwc-hover"), "pointer write rules");
console.log("test-crosshair-ownership: PASS");
`,
  ],
  { stdio: "inherit" }
);
process.exit(r.status ?? 1);
