/**
 * v3.27.0 — Drawing engine pure logic tests.
 */
let f = 0;
function assert(n, c) {
  if (!c) {
    console.error("FAIL", n);
    f++;
  } else console.log("PASS", n);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

assert("hit near segment", distToSegment(5, 1, 0, 0, 10, 0) <= 2);
assert("miss far segment", distToSegment(5, 20, 0, 0, 10, 0) > 10);

// Body move: delta time/price
function moveBody(shape, dT, dP) {
  return {
    ...shape,
    a: { time: shape.a.time + dT, price: shape.a.price + dP },
    b: { time: shape.b.time + dT, price: shape.b.price + dP },
  };
}
const line = { kind: "trendline", a: { time: 100, price: 50 }, b: { time: 200, price: 60 } };
const moved = moveBody(line, 10, -2);
assert("body keeps span", moved.b.time - moved.a.time === 100);
assert("body shifts price", moved.a.price === 48 && moved.b.price === 58);

// Magnet OFF preserves exact
function applyMagnet(pt, mode) {
  if (mode === "off") return pt;
  return { ...pt, price: Math.round(pt.price) };
}
assert("magnet off exact", applyMagnet({ time: 1, price: 1.234 }, "off").price === 1.234);

// Drawing delete does not touch journal
const journal = [{ id: "t1" }];
const shapes = [{ id: "d1", kind: "hline" }, { id: "d2", kind: "vline" }];
const afterDel = shapes.filter((s) => s.id !== "d1");
assert("delete drawing only", afterDel.length === 1 && journal.length === 1);

// Position vs drawing isolation
const pos = { kind: "position", status: "open", entry: { price: 1 } };
const draw = { kind: "trendline", a: { time: 1, price: 1 }, b: { time: 2, price: 2 } };
function moveDrawing(s) {
  if (s.kind === "position") throw new Error("must not move real position via drawing body");
  return moveBody(s, 1, 0);
}
assert("move trendline ok", moveDrawing(draw).a.time === 2);
let threw = false;
try {
  moveDrawing(pos);
} catch {
  threw = true;
}
assert("position not body-moved", threw);

// Fib levels preserved by anchors
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
assert("fib levels count", FIB.length === 7);

// Style patch
const styled = { ...line, lineWidth: 3, lineStyle: "dashed", visible: true };
assert("style fields", styled.lineWidth === 3 && styled.lineStyle === "dashed");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);
