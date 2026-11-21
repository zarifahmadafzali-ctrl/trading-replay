/** Unit tests for shouldApplyParentShapes (drawing commit race). */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, "../src/lib/shapesPropSync.ts");
const r = spawnSync(process.execPath, ["--experimental-strip-types", "-e", `
import { shouldApplyParentShapes } from ${JSON.stringify(modPath)};
function assert(c, m) { if (!c) throw new Error(m); }

// A: intermediate stale parent while awaiting — do not apply
{
  const d = shouldApplyParentShapes({
    awaitingParent: true,
    isGeneralDrawingDrag: false,
    liveIds: ["a", "new"],
    parentIds: ["a"],
  });
  assert(!d.apply && !d.clearAwaiting, "stale parent blocked");
}

// B: parent caught up with new id — apply and clear awaiting
{
  const d = shouldApplyParentShapes({
    awaitingParent: true,
    isGeneralDrawingDrag: false,
    liveIds: ["a", "new"],
    parentIds: ["a", "new"],
  });
  assert(d.apply && d.clearAwaiting, "parent caught up");
}

// C: not awaiting — always apply
{
  const d = shouldApplyParentShapes({
    awaitingParent: false,
    isGeneralDrawingDrag: false,
    liveIds: ["a"],
    parentIds: [],
  });
  assert(d.apply && !d.clearAwaiting, "normal parent apply");
}

// D: general drag — never apply
{
  const d = shouldApplyParentShapes({
    awaitingParent: false,
    isGeneralDrawingDrag: true,
    liveIds: ["a"],
    parentIds: ["b"],
  });
  assert(!d.apply, "drag blocks parent");
}

// E: fingerprint invalidation model — valid flag
{
  let cache = { valid: false, prop: null, fp: "" };
  const shapesProp = null;
  // null===null must NOT hit cache when valid=false
  const hit = cache.valid && cache.prop === shapesProp;
  assert(!hit, "invalid cache not used when prop null");
  cache = { valid: true, prop: shapesProp, fp: "0" };
  assert(cache.valid && cache.prop === shapesProp, "valid empty list cache ok");
}

console.log("test-shapes-prop-sync: PASS");
`], { stdio: "inherit" });
process.exit(r.status ?? 1);
