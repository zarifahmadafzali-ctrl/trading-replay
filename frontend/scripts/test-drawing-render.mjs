// Renders with the REAL compiled drawingRender.ts into a recording canvas mock.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const R = require(process.env.DRAWING_BUILD_RENDER || "../.build/lib/drawingRender.js");

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  ", name); }
  catch (e) { console.error("  FAIL", name, "\n      ", e.message); process.exitCode = 1; }
}

function mockCtx() {
  const calls = [];
  const props = { strokeStyle: [], fillStyle: [], lineWidth: [], dashes: [] };
  const target = {
    measureText: (s) => ({ width: String(s).length * 7 }),
    setLineDash: (d) => { props.dashes.push(d); calls.push(["setLineDash", d]); },
  };
  const ctx = new Proxy(target, {
    get(o, k) {
      if (k in o) return o[k];
      if (k === "__calls") return calls;
      if (k === "__props") return props;
      return (...a) => { calls.push([k, ...a]); };
    },
    set(o, k, v) { if (k in props) props[k].push(v); calls.push(["set:" + String(k), v]); o[k] = v; return true; },
  });
  return ctx;
}
const count = (ctx, name) => ctx.__calls.filter((c) => c[0] === name).length;
const W = { w: 400, h: 200 };
const project = (p) => ({ x: p.time, y: 200 - p.price });
const env = (o = {}) => ({ project, bounds: W, selected: false, priceDecimals: 2, barSec: 60, ...o });
const P = (time, price) => ({ time, price });
const draw = (shape, e) => { const c = mockCtx(); const r = R.drawShape(c, shape, e || env()); return { c, r }; };

const shapes = {
  trendline: { id: "1", kind: "trendline", a: P(50, 50), b: P(150, 100) },
  ray: { id: "2", kind: "ray", a: P(50, 50), b: P(150, 100) },
  extended: { id: "3", kind: "extended", a: P(50, 50), b: P(150, 100) },
  rectangle: { id: "4", kind: "rectangle", a: P(100, 150), b: P(200, 100) },
  measure: { id: "5", kind: "measure", a: P(100, 100), b: P(200, 150) },
  fib: { id: "6", kind: "fib", a: P(100, 180), b: P(200, 100) },
  channel: { id: "7", kind: "channel", a: P(100, 50), b: P(200, 60), c: P(150, 90) },
  text: { id: "8", kind: "text", a: P(100, 100), text: "Hello" },
};

for (const [k, s] of Object.entries(shapes)) {
  t(`${k}: handled, draws something, balanced save/restore`, () => {
    const { c, r } = draw(s);
    assert.equal(r, true);
    assert.ok(count(c, "stroke") + count(c, "fill") + count(c, "fillRect") + count(c, "strokeRect") + count(c, "fillText") > 0);
    assert.equal(count(c, "save"), count(c, "restore"));
  });
  t(`${k}: null projection draws nothing and does not throw`, () => {
    const { c, r } = draw(s, env({ project: () => null }));
    assert.equal(r, true);
    assert.equal(count(c, "stroke") + count(c, "fill") + count(c, "fillRect") + count(c, "strokeRect"), 0);
  });
}
t("hline/vline are not owned by the renderer (Chart keeps legacy branch)", () => {
  assert.equal(draw({ id: "h", kind: "hline", price: 5 }).r, false);
  assert.equal(draw({ id: "v", kind: "vline", time: 5 }).r, false);
});
t("selection adds handles, never recolors the shape", () => {
  const s = { ...shapes.trendline, color: "#ff0000" };
  const off = draw(s).c, on = draw(s, env({ selected: true })).c;
  assert.equal(count(off, "arc"), 0);
  assert.equal(count(on, "arc"), 2);
  assert.ok(on.__props.strokeStyle.includes("#ff0000"));
  assert.ok(!on.__props.strokeStyle.includes("#fbbf24"), "must not switch to yellow when selected");
});
t("rectangle selected: 8 handles; fill uses fillColor+fillOpacity", () => {
  const c = draw({ ...shapes.rectangle, color: "#ff0000", fillOpacity: 0.5 }, env({ selected: true })).c;
  assert.equal(count(c, "arc"), 8);
  assert.ok(c.__props.fillStyle.includes("rgba(255, 0, 0, 0.5)"));
});
t("rectangle fillOpacity 0 -> no fillRect with color", () => {
  const c = draw({ ...shapes.rectangle, fillOpacity: 0 }).c;
  assert.equal(count(c, "fillRect"), 0);
  assert.equal(count(c, "strokeRect"), 1);
});
t("rectangle extendRight reaches canvas edge", () => {
  const c = draw({ ...shapes.rectangle, extendRight: true }).c;
  const sr = c.__calls.find((x) => x[0] === "strokeRect");
  assert.equal(sr[1] + sr[3], 400);
});
t("trendline: no extension = one segment ending at B; extendRight reaches edge", () => {
  const plain = draw(shapes.trendline).c.__calls.filter((x) => x[0] === "lineTo");
  assert.equal(plain.length, 1); assert.equal(plain[0][1], 150);
  // shallow slope so the extension hits the RIGHT edge (a steep one correctly stops at the top edge)
  const shallow = { ...shapes.trendline, b: P(150, 60) };
  const ext = draw({ ...shallow, extendRight: true }).c.__calls.filter((x) => x[0] === "lineTo");
  assert.ok(ext[0][1] >= 399.9);
  const steep = draw({ ...shapes.trendline, extendRight: true }).c.__calls.filter((x) => x[0] === "lineTo");
  assert.ok(steep[0][1] < 400 && steep[0][2] >= -1e-6, "steep line must stop at the canvas edge, not overshoot");
});
t("legacy ray renders like extendRight", () => {
  const ray = draw({ ...shapes.ray, b: P(150, 60) }).c.__calls.filter((x) => x[0] === "lineTo")[0][1];
  assert.ok(ray >= 399.9);
});
t("trendline stats/angle/text labels appear only when enabled", () => {
  assert.equal(count(draw(shapes.trendline).c, "fillText"), 0);
  const c = draw({ ...shapes.trendline, showStats: true, showAngle: true, text: "T" }).c;
  assert.ok(count(c, "fillText") >= 4);
  const texts = c.__calls.filter((x) => x[0] === "fillText").map((x) => x[1]);
  assert.ok(texts.some((x) => x.includes("°")));
  assert.ok(texts.some((x) => x.includes("bars")));
});
t("trendline arrows draw closed polygons", () => {
  assert.equal(count(draw({ ...shapes.trendline, arrowEnd: true, arrowStart: true }).c, "closePath"), 2);
});
t("measure: up = blue, down = red, custom color wins", () => {
  const up = draw(shapes.measure).c.__props.strokeStyle;
  assert.ok(up.includes("#2962FF"));
  const down = draw({ ...shapes.measure, a: P(100, 150), b: P(200, 100) }).c.__props.strokeStyle;
  assert.ok(down.includes("#F23645"));
  assert.ok(draw({ ...shapes.measure, color: "#00ff00" }).c.__props.strokeStyle.includes("#00ff00"));
});
t("measure label shows price delta, percent and bars", () => {
  const texts = draw(shapes.measure, env({ barSec: 50 })).c.__calls.filter((x) => x[0] === "fillText").map((x) => x[1]);
  assert.ok(texts.some((x) => x.startsWith("+50.00 (+50.00%)")), texts.join("|"));
  assert.ok(texts.some((x) => x.includes("2 bars")), texts.join("|"));
});
t("fib: one line per enabled level (7 default) + diagonal; toggling levels changes count", () => {
  const lines = (s) => draw(s).c.__calls.filter((x) => x[0] === "lineTo").length;
  assert.equal(lines(shapes.fib), 7 + 1);
  assert.equal(lines({ ...shapes.fib, trendLine: false }), 7);
  const lv = [{ value: 0, color: "#fff", enabled: true }, { value: 1, color: "#fff", enabled: true }, { value: 2, color: "#fff", enabled: true }];
  assert.equal(lines({ ...shapes.fib, levels: lv, trendLine: false }), 3);
});
t("fib labels: percents/prices can be hidden", () => {
  const texts = (s) => draw(s).c.__calls.filter((x) => x[0] === "fillText").map((x) => x[1]);
  assert.ok(texts({ ...shapes.fib }).some((x) => /0\.618 \(/.test(x)));
  assert.equal(texts({ ...shapes.fib, showPercents: false, showPrices: false }).length, 0);
});
t("channel: two lines, 3 handles when selected, fill only with opacity", () => {
  const c = draw(shapes.channel, env({ selected: true })).c;
  assert.equal(count(c, "arc"), 3);
  assert.equal(draw({ ...shapes.channel, fillOpacity: 0 }).c.__calls.filter((x) => x[0] === "fill").length, 0);
  assert.ok(draw(shapes.channel).c.__calls.filter((x) => x[0] === "fill").length >= 1);
  const mid = (s) => draw(s).c.__calls.filter((x) => x[0] === "stroke").length;
  assert.equal(mid({ ...shapes.channel, showMiddle: true }), mid(shapes.channel) + 1);
});
t("text: draws box + text; custom text color", () => {
  const c = draw({ ...shapes.text, textColor: "#00ff00" }).c;
  assert.ok(c.__props.fillStyle.includes("#00ff00"));
  assert.equal(count(c, "fillText"), 1);
});
t("line style maps to dash arrays", () => {
  const dashed = draw({ ...shapes.trendline, lineStyle: "dashed" }).c.__props.dashes.some((d) => d.length === 2);
  const solid = draw({ ...shapes.trendline, lineStyle: "solid" }).c.__props.dashes.every((d) => d.length === 0);
  assert.ok(dashed && solid);
});

console.log(`\n${process.exitCode ? "SOME TESTS FAILED" : "all passed"} (${pass} ok)`);
