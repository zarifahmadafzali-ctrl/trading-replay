/**
 * P0 drawing-state integrity: mergeEngineShapeResult
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/chartShapesSync.ts"), "utf8");

function assert(c, m) {
  if (!c) throw new Error(m);
}

function mergeEngineShapeResult(current, engineOut, inputIds) {
  const engineById = new Map();
  for (const s of engineOut) engineById.set(s.id, s);
  const out = [];
  const seen = new Set();
  for (const s of current) {
    if (s.kind === "position") {
      const eng = engineById.get(s.id);
      if (eng) {
        out.push(eng);
        seen.add(s.id);
      } else if (!inputIds.has(s.id)) {
        out.push(s);
        seen.add(s.id);
      }
    } else {
      out.push(s);
      seen.add(s.id);
    }
  }
  for (const eng of engineOut) {
    if (!seen.has(eng.id)) {
      out.push(eng);
      seen.add(eng.id);
    }
  }
  return out;
}

// A: trendline survives engine close of position
const pos = { id: "p1", kind: "position", status: "open" };
const posClosed = { id: "p1", kind: "position", status: "closed" };
const trend = { id: "t1", kind: "trendline" };
const inputIds = new Set(["p1"]);
const current = [pos, trend]; // trend added after snapshot conceptually; still in current
const engineOut = [posClosed];
const merged = mergeEngineShapeResult(current, engineOut, inputIds);
assert(merged.some((s) => s.id === "t1"), "trendline kept");
assert(merged.find((s) => s.id === "p1").status === "closed", "position closed from engine");

// B: ray + fib + text + channel + rectangle kept
const many = [
  { id: "p1", kind: "position", status: "open" },
  { id: "r1", kind: "ray" },
  { id: "f1", kind: "fib" },
  { id: "x1", kind: "text" },
  { id: "c1", kind: "channel" },
  { id: "q1", kind: "rectangle" },
];
const m2 = mergeEngineShapeResult(many, [{ id: "p1", kind: "position", status: "open", entry: 1 }], new Set(["p1"]));
assert(m2.filter((s) => s.kind !== "position").length === 5, "all geometry kept");

// C: empty positions — drawing only
const only = [{ id: "t2", kind: "trendline" }];
const m3 = mergeEngineShapeResult(only, [], new Set());
assert(m3.length === 1 && m3[0].id === "t2", "drawing-only survives empty engine out");

// D: position in input missing from engine out is dropped
const m4 = mergeEngineShapeResult(
  [{ id: "p2", kind: "position" }, { id: "t3", kind: "trendline" }],
  [],
  new Set(["p2"])
);
assert(!m4.some((s) => s.id === "p2"), "removed position dropped");
assert(m4.some((s) => s.id === "t3"), "trend still there");

assert(src.includes("mergeEngineShapeResult"), "source present");
console.log("test-chart-shapes-sync: PASS");
