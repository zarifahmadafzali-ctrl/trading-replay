/** Pure check: closer handle wins over body-style large distance. */
function assert(c, m) { if (!c) throw new Error(m); }

function pickBest(hits) {
  let best = null;
  for (const h of hits) {
    if (!best || h.distance < best.distance - 0.25) best = h;
  }
  return best;
}

const hits = [
  { id: "far-box", part: "body", distance: 40 },
  { id: "near-line", part: "body", distance: 3 },
  { id: "handle", part: "a", distance: 2 },
];
const w = pickBest(hits);
assert(w.id === "handle" && w.part === "a", "nearest handle wins");

const onlyBody = pickBest([
  { id: "a", part: "body", distance: 10 },
  { id: "b", part: "body", distance: 10.1 },
]);
assert(onlyBody.id === "a", "stable when nearly equal");

console.log("test-drawing-hit-distance: PASS");
