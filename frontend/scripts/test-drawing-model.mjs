// Tests the REAL lib/drawingModel.ts (compiled with tsc), not a mirror.
// Run:  npm run test:drawing   (see GROK_PATCH_drawing-tools.md for the script)
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const M = require(process.env.DRAWING_BUILD || "../.build/lib/drawingModel.js");

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  ", name); }
  catch (e) { console.error("  FAIL", name, "\n      ", e.message); process.exitCode = 1; }
}
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const W = { w: 400, h: 200 };
const project = (p) => ({ x: p.time, y: 200 - p.price });
const O = (sel = true) => ({ handleTol: 10, lineTol: 6, bounds: W, selected: sel });
const P = (time, price) => ({ time, price });

console.log("geometry");
t("clip: no extension keeps segment", () => {
  const r = M.clipLineToRect({ x: 10, y: 50 }, { x: 20, y: 50 }, W, false, false);
  assert.deepEqual(r, [{ x: 10, y: 50 }, { x: 20, y: 50 }]);
});
t("clip: extend right reaches canvas edge", () => {
  const r = M.clipLineToRect({ x: 10, y: 50 }, { x: 20, y: 50 }, W, false, true);
  close(r[0].x, 10); close(r[1].x, 400);
});
t("clip: extend both sides spans canvas", () => {
  const r = M.clipLineToRect({ x: 10, y: 50 }, { x: 20, y: 50 }, W, true, true);
  close(r[0].x, 0); close(r[1].x, 400);
});
t("clip: diagonal extended stays inside canvas", () => {
  const r = M.clipLineToRect({ x: 100, y: 100 }, { x: 150, y: 120 }, W, true, true);
  for (const p of r) { assert.ok(p.x >= -1e-6 && p.x <= 400 + 1e-6 && p.y >= -1e-6 && p.y <= 200 + 1e-6); }
});
t("clip: line fully outside -> null", () => {
  assert.equal(M.clipLineToRect({ x: -50, y: -50 }, { x: -10, y: -10 }, W, false, false), null);
});
t("clip: vertical line extended hits top/bottom", () => {
  const r = M.clipLineToRect({ x: 50, y: 60 }, { x: 50, y: 80 }, W, true, true);
  close(r[0].y, 0); close(r[1].y, 200);
});
t("distPointToSegment", () => {
  close(M.distPointToSegment(5, 5, 0, 0, 10, 0), 5);
  close(M.distPointToSegment(15, 0, 0, 0, 10, 0), 5);
  close(M.distPointToSegment(3, 4, 0, 0, 0, 0), 5);
});

console.log("model");
t("normalizeShape: ray -> trendline extendRight", () => {
  const n = M.normalizeShape({ id: "r", kind: "ray", a: P(1, 1), b: P(2, 2) });
  assert.equal(n.kind, "trendline"); assert.equal(n.extendRight, true); assert.equal(n.extendLeft, false);
});
t("normalizeShape: extended -> both, idempotent, explicit flags win", () => {
  const n = M.normalizeShape({ id: "e", kind: "extended", a: P(1, 1), b: P(2, 2) });
  assert.equal(n.extendLeft && n.extendRight, true);
  assert.deepEqual(M.normalizeShape(n), n);
  const k = M.normalizeShape({ id: "x", kind: "ray", a: P(1, 1), b: P(2, 2), extendRight: false });
  assert.equal(k.extendRight, false);
});
t("normalizeShape leaves other kinds untouched", () => {
  const r = { id: "q", kind: "rectangle", a: P(1, 2), b: P(3, 4) };
  assert.equal(M.normalizeShape(r), r);
});
t("old persisted shape (no new fields) resolves defaults", () => {
  const st = M.resolveStyle({ id: "o", kind: "rectangle" });
  assert.equal(st.color, "#2962FF"); assert.equal(st.lineWidth, 1); close(st.fillOpacity, 0.2);
});
t("resolveStyle: overrides + clamping", () => {
  const st = M.resolveStyle({ id: "o", kind: "trendline", color: "#ff0000", lineWidth: 99, fillOpacity: 5, lineStyle: "dashed" });
  assert.equal(st.color, "#ff0000"); assert.equal(st.lineWidth, 8); assert.equal(st.fillOpacity, 1); assert.equal(st.lineStyle, "dashed");
});
t("withAlpha", () => {
  assert.equal(M.withAlpha("#ff0000", 0.5), "rgba(255, 0, 0, 0.5)");
  assert.equal(M.withAlpha("#f00", 1), "rgba(255, 0, 0, 1)");
  assert.equal(M.withAlpha("red", 0.5), "red");
});
t("measureStats up/down/bars", () => {
  const s = M.measureStats(P(0, 100), P(3600, 110), { barSec: 900 });
  close(s.dPrice, 10); close(s.pct, 10); assert.equal(s.bars, 4); assert.equal(s.up, true);
  const d = M.measureStats(P(0, 100), P(900, 90), { barSec: 900 });
  close(d.pct, -10); assert.equal(d.up, false); assert.equal(d.bars, 1);
  assert.equal(M.measureStats(P(0, 100), P(900, 90)).bars, null);
});
t("fib convention: level 0 at b, level 1 at a (matches existing app)", () => {
  const a = P(0, 200), b = P(10, 100);
  close(M.fibPrice(a, b, 0), 100); close(M.fibPrice(a, b, 1), 200); close(M.fibPrice(a, b, 0.5), 150);
  close(M.fibPrice(a, b, 0, true), 200); close(M.fibPrice(a, b, 1, true), 100);
});
t("enabledFibLevels: defaults = 7 levels, sorted; custom respected", () => {
  assert.equal(M.enabledFibLevels({}).length, 7);
  const lv = M.enabledFibLevels({ levels: [{ value: 1, color: "#fff", enabled: true }, { value: 0.5, color: "#fff", enabled: true }, { value: 2, color: "#fff", enabled: false }] });
  assert.deepEqual(lv.map((l) => l.value), [0.5, 1]);
});
t("channel offset + parallel line", () => {
  const ch = { a: P(0, 100), b: P(10, 110), c: P(5, 120) };
  close(M.priceOnLineAt(ch.a, ch.b, 5), 105); close(M.channelOffset(ch), 15);
  const [a2, b2] = M.channelParallel(ch);
  close(a2.price, 115); close(b2.price, 125);
});
t("formatDuration", () => { assert.equal(M.formatDuration(3725), "1h 2m"); assert.equal(M.formatDuration(0), "0s"); });
t("constrainAnglePx snaps to 45deg steps", () => {
  const r = M.constrainAnglePx({ x: 0, y: 0 }, { x: 100, y: 10 });
  close(r.y, 0, 1e-6); assert.ok(r.x > 99);
  const d = M.constrainAnglePx({ x: 0, y: 0 }, { x: 100, y: 90 });
  close(Math.abs(d.x), Math.abs(d.y), 1e-6);
});
t("constrainSquarePx keeps axis signs", () => {
  const r = M.constrainSquarePx({ x: 10, y: 10 }, { x: -30, y: 15 });
  close(r.x, -30); close(r.y, 50);
});

console.log("drag / move");
const rect = { id: "r1", kind: "rectangle", a: P(100, 150), b: P(200, 100) };
const org = (s, p) => ({ point: p, shape: s });
t("rect corner br resizes", () => {
  const r = M.applyDrag(rect, "br", P(250, 80), org(rect, P(200, 100)));
  assert.deepEqual([r.a, r.b], [P(100, 150), P(250, 80)]);
});
t("rect drag past opposite edge flips without losing size", () => {
  const r = M.applyDrag(rect, "right", P(50, 0), org(rect, P(200, 125)));
  assert.equal(r.a.time, 50); assert.equal(r.b.time, 100);
});
t("rect edge top only changes price", () => {
  const r = M.applyDrag(rect, "top", P(999, 180), org(rect, P(150, 150)));
  assert.equal(r.a.price, 180); assert.equal(r.a.time, 100); assert.equal(r.b.time, 200); assert.equal(r.b.price, 100);
});
t("drag result is stable (computed from origin, not from current)", () => {
  const first = M.applyDrag(rect, "tl", P(60, 170), org(rect, P(100, 150)));
  const second = M.applyDrag(first, "tl", P(60, 170), org(rect, P(100, 150)));
  assert.deepEqual(first, second);
});
t("body drag moves all anchors by the same delta", () => {
  const ch = { id: "c", kind: "channel", a: P(0, 100), b: P(10, 110), c: P(5, 120) };
  const r = M.applyDrag(ch, "body", P(30, 50), org(ch, P(10, 40)));
  assert.deepEqual([r.a, r.b, r.c], [P(20, 110), P(30, 120), P(25, 130)]);
});
t("point drag a/b/c", () => {
  const ch = { id: "c", kind: "channel", a: P(0, 100), b: P(10, 110), c: P(5, 120) };
  assert.deepEqual(M.applyDrag(ch, "c", P(7, 130), org(ch, P(5, 120))).c, P(7, 130));
  const tl = { id: "t", kind: "trendline", a: P(0, 1), b: P(1, 2) };
  assert.equal(M.applyDrag(tl, "c", P(1, 1), org(tl, P(0, 0))), tl);
});
t("moveShape hline/vline/text", () => {
  assert.equal(M.moveShape({ id: "h", kind: "hline", price: 10 }, 5, 3).price, 13);
  assert.equal(M.moveShape({ id: "v", kind: "vline", time: 10 }, 5, 3).time, 15);
  assert.deepEqual(M.moveShape({ id: "x", kind: "text", a: P(1, 1), text: "hi" }, 1, 1).a, P(2, 2));
});
t("cloneShape: new id, unlocked, offset", () => {
  const c = M.cloneShape({ id: "a", kind: "rectangle", a: P(0, 0), b: P(1, 1), locked: true }, "b", 5, 5);
  assert.equal(c.id, "b"); assert.equal(c.locked, false); assert.deepEqual(c.a, P(5, 5));
});
t("z-order helpers", () => {
  const s = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.deepEqual(M.bringToFront(s, "1").map((x) => x.id), ["2", "3", "1"]);
  assert.deepEqual(M.sendToBack(s, "3").map((x) => x.id), ["3", "1", "2"]);
  assert.equal(M.bringToFront(s, "zzz"), s);
});

console.log("hit-test");
const tl = { id: "t", kind: "trendline", a: P(100, 100), b: P(200, 100) };
t("trendline: unselected -> body only (first tap selects)", () => {
  assert.deepEqual(M.hitTestShape(tl, project, 100, 100, O(false)), { part: "body" });
});
t("trendline: selected endpoints", () => {
  assert.deepEqual(M.hitTestShape(tl, project, 101, 101, O()), { part: "a" });
  assert.deepEqual(M.hitTestShape(tl, project, 200, 100, O()), { part: "b" });
});
t("trendline: body near line, miss far away", () => {
  assert.deepEqual(M.hitTestShape(tl, project, 150, 103, O()), { part: "body" });
  assert.equal(M.hitTestShape(tl, project, 150, 130, O()), null);
});
t("trendline: beyond B only hits when extendRight", () => {
  assert.equal(M.hitTestShape(tl, project, 300, 100, O()), null);
  assert.deepEqual(M.hitTestShape({ ...tl, extendRight: true }, project, 300, 100, O()), { part: "body" });
});
t("ray (legacy kind) behaves as extendRight", () => {
  assert.deepEqual(M.hitTestShape({ id: "r", kind: "ray", a: P(100, 100), b: P(200, 100) }, project, 300, 100, O()), { part: "body" });
});
t("locked shape exposes no handles", () => {
  assert.deepEqual(M.hitTestShape({ ...tl, locked: true }, project, 100, 100, O()), { part: "body" });
});
// rect on screen: x 100..200, y (200-150)=50 .. (200-100)=100
t("rect: 4 corners + 4 edge handles when selected", () => {
  const h = (x, y) => M.hitTestShape(rect, project, x, y, O())?.part;
  assert.equal(h(100, 50), "tl"); assert.equal(h(200, 50), "tr");
  assert.equal(h(100, 100), "bl"); assert.equal(h(200, 100), "br");
  assert.equal(h(150, 50), "top"); assert.equal(h(150, 100), "bottom");
  assert.equal(h(100, 75), "left"); assert.equal(h(200, 75), "right");
});
t("rect: inside is body, unselected has no handles", () => {
  assert.equal(M.hitTestShape(rect, project, 150, 75, O())?.part, "body");
  assert.equal(M.hitTestShape(rect, project, 100, 50, O(false))?.part, "body");
  assert.equal(M.hitTestShape(rect, project, 300, 75, O()), null);
});
t("measure: handles + inside", () => {
  const m = { id: "m", kind: "measure", a: P(100, 100), b: P(200, 150) };
  assert.equal(M.hitTestShape(m, project, 100, 100, O())?.part, "a");
  assert.equal(M.hitTestShape(m, project, 150, 75, O())?.part, "body");
});
t("fib: hit near a level line, miss far outside", () => {
  const f = { id: "f", kind: "fib", a: P(100, 200), b: P(200, 100) };
  // screen: level 1 (price 200) at y=0, level 0 (price 100) at y=100, x 100..200
  assert.equal(M.hitTestShape(f, project, 150, 50, O())?.part, "body");
  assert.equal(M.hitTestShape(f, project, 150, 150, O()), null);
  assert.equal(M.hitTestShape(f, project, 350, 50, O()), null);
  assert.equal(M.hitTestShape({ ...f, extendRight: true }, project, 350, 50, O())?.part, "body");
});
t("channel: handles a/b/c, parallel line and band", () => {
  const ch = { id: "c", kind: "channel", a: P(100, 50), b: P(200, 50), c: P(150, 90) };
  assert.equal(M.hitTestShape(ch, project, 100, 150, O())?.part, "a");
  assert.equal(M.hitTestShape(ch, project, 150, 110, O())?.part, "c");
  assert.equal(M.hitTestShape(ch, project, 120, 110, O())?.part, "body");
  assert.equal(M.hitTestShape(ch, project, 120, 130, O())?.part, "body");
  assert.equal(M.hitTestShape(ch, project, 120, 20, O()), null);
});
t("text: bbox hit", () => {
  const tx = { id: "x", kind: "text", a: P(100, 100), text: "Hello" };
  assert.equal(M.hitTestShape(tx, project, 110, 95, O())?.part, "body");
  assert.equal(M.hitTestShape(tx, project, 110, 150, O()), null);
});
t("hline/vline handled by Chart (returns null)", () => {
  assert.equal(M.hitTestShape({ id: "h", kind: "hline", price: 5 }, project, 0, 0, O()), null);
});
t("null projection never throws", () => {
  assert.equal(M.hitTestShape(tl, () => null, 1, 1, O()), null);
});
t("shapeBoundsPx", () => {
  const b = M.shapeBoundsPx(rect, project, W);
  assert.deepEqual(b, { x0: 100, x1: 200, y0: 50, y1: 100 });
  assert.deepEqual(M.shapeBoundsPx({ id: "h", kind: "hline", price: 20 }, project, W), { x0: 0, x1: 400, y0: 180, y1: 180 });
});

console.log("creation / defaults");
t("createShape merges defaults and normalizes legacy kinds", () => {
  const s = M.createShape("ray", { a: P(1, 1), b: P(2, 2) }, "n1", { color: "#00ff00", lineWidth: 3 });
  assert.equal(s.kind, "trendline"); assert.equal(s.color, "#00ff00"); assert.equal(s.extendRight, true); assert.equal(s.id, "n1");
});
t("tool defaults: load/save without storage never throws", () => {
  assert.deepEqual(M.loadToolDefaults("rectangle"), {});
  M.saveToolDefaults("rectangle", rect);
});
t("tool defaults round-trip drops geometry", () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  M.saveToolDefaults("rectangle", { ...rect, color: "#abcdef", fillOpacity: 0.4 });
  const d = M.loadToolDefaults("rectangle");
  assert.equal(d.color, "#abcdef"); assert.equal(d.fillOpacity, 0.4); assert.equal(d.a, undefined); assert.equal(d.id, undefined);
  delete globalThis.localStorage;
});

console.log(`\n${process.exitCode ? "SOME TESTS FAILED" : "all passed"} (${pass} ok)`);
