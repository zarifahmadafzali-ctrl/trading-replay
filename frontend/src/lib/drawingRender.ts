/**
 * Canvas painters for the drawing tools. No React, no lightweight-charts.
 * Chart.tsx calls drawShape() per shape inside redrawOverlay() with its own toXY as `project`.
 * Returns false for kinds it does not own (hline / vline / position) so Chart keeps its legacy branch.
 * Selection never recolors the shape (TradingView style): it only adds white handles.
 */
import {
  Bounds, DrawingShape, Pt, Px, TrendlineShape,
  channelParallel, clipLineToRect, dashFor, enabledFibLevels, fibPrice, formatDuration,
  measureStats, normalizeShape, resolveStyle, withAlpha,
} from "./drawingModel";

export type RenderEnv = {
  project: (p: Pt) => Px | null;
  bounds: Bounds;
  selected: boolean;
  priceDecimals?: number;
  /** seconds per bar of the displayed timeframe (for "N bars") */
  barSec?: number;
};

const UP = "#2962FF";
const DOWN = "#F23645";
const FONT = "12px -apple-system, Segoe UI, Roboto, sans-serif";

function fmt(v: number, dec = 2) {
  return v.toFixed(dec);
}
function signed(v: number, dec: number) {
  return (v >= 0 ? "+" : "") + v.toFixed(dec);
}

function applyLine(ctx: CanvasRenderingContext2D, color: string, width: number, style: "solid" | "dashed" | "dotted") {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashFor(style, width));
  ctx.lineCap = style === "dotted" ? "round" : "butt";
}

function seg(ctx: CanvasRenderingContext2D, a: Px, b: Px) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function handle(ctx: CanvasRenderingContext2D, p: Px, color: string) {
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function arrowHead(ctx: CanvasRenderingContext2D, tip: Px, from: Px, color: string, size: number) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(ang - Math.PI / 7), tip.y - size * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(tip.x - size * Math.cos(ang + Math.PI / 7), tip.y - size * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

/** Rounded label box. (x,y) is the anchor; `align` decides how the box sits relative to it. */
function labelBox(
  ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number,
  bg: string, fg: string, bounds: Bounds, align: "center" | "left" | "right" = "center"
) {
  ctx.setLineDash([]);
  ctx.font = FONT;
  const padX = 8, lineH = 16, padY = 5;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * lineH + padY * 2 - 4;
  let bx = align === "center" ? x - w / 2 : align === "left" ? x : x - w;
  let by = y;
  bx = Math.min(Math.max(bx, 2), Math.max(2, bounds.w - w - 2));
  by = Math.min(Math.max(by, 2), Math.max(2, bounds.h - h - 2));
  ctx.fillStyle = bg;
  ctx.beginPath();
  const r = 4;
  ctx.moveTo(bx + r, by);
  ctx.lineTo(bx + w - r, by);
  ctx.quadraticCurveTo(bx + w, by, bx + w, by + r);
  ctx.lineTo(bx + w, by + h - r);
  ctx.quadraticCurveTo(bx + w, by + h, bx + w - r, by + h);
  ctx.lineTo(bx + r, by + h);
  ctx.quadraticCurveTo(bx, by + h, bx, by + h - r);
  ctx.lineTo(bx, by + r);
  ctx.quadraticCurveTo(bx, by, bx + r, by);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY - 1 + i * lineH));
}

function yAtX(P: Px, Q: Px, x: number): number | null {
  if (Q.x === P.x) return null;
  return P.y + ((Q.y - P.y) * (x - P.x)) / (Q.x - P.x);
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: DrawingShape, env: RenderEnv): boolean {
  const { project, bounds, selected } = env;
  const dec = env.priceDecimals ?? 2;
  ctx.save();
  try {
    const s = normalizeShape(shape);
    if (s.kind === "trendline" || s.kind === "ray" || s.kind === "extended") {
      drawTrend(ctx, s as TrendlineShape, env, dec);
      return true;
    }
    if (s.kind === "rectangle") {
      const A = project(s.a), B = project(s.b);
      if (!A || !B) return true;
      const st = resolveStyle(s);
      const x0 = Math.min(A.x, B.x), y0 = Math.min(A.y, B.y);
      const x1 = s.extendRight ? Math.max(bounds.w, Math.max(A.x, B.x)) : Math.max(A.x, B.x);
      const y1 = Math.max(A.y, B.y);
      if (st.fillOpacity > 0) {
        ctx.fillStyle = withAlpha(st.fillColor, st.fillOpacity);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      applyLine(ctx, st.color, st.lineWidth, st.lineStyle);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (s.text) {
        ctx.font = FONT; ctx.fillStyle = s.textColor || st.color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(s.text, (x0 + Math.max(A.x, B.x)) / 2, (y0 + y1) / 2);
      }
      if (s.showStats) {
        const hi = Math.max(s.a.price, s.b.price), lo = Math.min(s.a.price, s.b.price);
        const pct = lo !== 0 ? ((hi - lo) / Math.abs(lo)) * 100 : 0;
        labelBox(ctx, [`${fmt(hi - lo, dec)} (${fmt(pct, 2)}%)`], (x0 + x1) / 2, y1 + 6, withAlpha(st.color, 0.9), "#ffffff", bounds);
      }
      if (selected) {
        const mx = (x0 + Math.max(A.x, B.x)) / 2, my = (y0 + y1) / 2, xr = Math.max(A.x, B.x);
        for (const p of [
          { x: x0, y: y0 }, { x: xr, y: y0 }, { x: x0, y: y1 }, { x: xr, y: y1 },
          { x: mx, y: y0 }, { x: mx, y: y1 }, { x: x0, y: my }, { x: xr, y: my },
        ]) handle(ctx, p, st.color);
      }
      return true;
    }
    if (s.kind === "measure") {
      const A = project(s.a), B = project(s.b);
      if (!A || !B) return true;
      const ms = measureStats(s.a, s.b, { barSec: env.barSec });
      const base = s.color || (ms.up ? UP : DOWN);
      const st = resolveStyle({ ...s, color: base });
      const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x), y0 = Math.min(A.y, B.y), y1 = Math.max(A.y, B.y);
      if (st.fillOpacity > 0) {
        ctx.fillStyle = withAlpha(s.fillColor || base, st.fillOpacity);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      applyLine(ctx, base, st.lineWidth, "solid");
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      seg(ctx, { x: A.x, y: my }, { x: B.x, y: my });
      seg(ctx, { x: mx, y: A.y }, { x: mx, y: B.y });
      if (Math.abs(B.x - A.x) > 8) arrowHead(ctx, { x: B.x, y: my }, { x: A.x, y: my }, base, 8);
      if (Math.abs(B.y - A.y) > 8) arrowHead(ctx, { x: mx, y: B.y }, { x: mx, y: A.y }, base, 8);
      const l1 = `${signed(ms.dPrice, dec)} (${signed(ms.pct, 2)}%)`;
      const l2 = `${ms.bars != null ? `${ms.bars >= 0 ? "" : "-"}${Math.abs(ms.bars)} bars, ` : ""}${ms.durationSec < 0 ? "-" : ""}${formatDuration(ms.durationSec)}`;
      const above = ms.up;
      labelBox(ctx, [l1, l2], mx, above ? y0 - 44 : y1 + 8, withAlpha(base, 0.95), "#ffffff", bounds);
      if (selected) { handle(ctx, A, base); handle(ctx, B, base); }
      return true;
    }
    if (s.kind === "fib") {
      const A = project(s.a), B = project(s.b);
      if (!A || !B) return true;
      const st = resolveStyle(s);
      const xl = s.extendLeft ? 0 : Math.min(A.x, B.x);
      const xr = s.extendRight ? bounds.w : Math.max(A.x, B.x);
      const rows: { y: number; color: string; value: number; price: number }[] = [];
      for (const l of enabledFibLevels(s)) {
        const price = fibPrice(s.a, s.b, l.value, !!s.reverse);
        const p = project({ time: s.a.time, price });
        if (p) rows.push({ y: p.y, color: l.color, value: l.value, price });
      }
      for (let i = 0; i < rows.length - 1; i++) {
        if (st.fillOpacity <= 0) break;
        ctx.fillStyle = withAlpha(rows[i].color, st.fillOpacity);
        ctx.fillRect(xl, Math.min(rows[i].y, rows[i + 1].y), xr - xl, Math.abs(rows[i + 1].y - rows[i].y));
      }
      ctx.font = FONT; ctx.textBaseline = "middle";
      for (const r of rows) {
        applyLine(ctx, r.color, st.lineWidth, st.lineStyle === "dotted" ? "dotted" : st.lineStyle);
        seg(ctx, { x: xl, y: r.y }, { x: xr, y: r.y });
        const parts: string[] = [];
        if (s.showPercents !== false) parts.push(String(r.value));
        if (s.showPrices !== false) parts.push(parts.length ? `(${fmt(r.price, dec)})` : fmt(r.price, dec));
        if (parts.length) {
          ctx.fillStyle = r.color;
          const inside = xl < 80;
          ctx.textAlign = inside ? "left" : "right";
          ctx.fillText(parts.join(" "), inside ? xl + 4 : xl - 6, r.y - 8);
        }
      }
      if (s.trendLine !== false) {
        applyLine(ctx, "#787B86", 1, "dashed");
        seg(ctx, A, B);
      }
      if (selected) { handle(ctx, A, "#787B86"); handle(ctx, B, "#787B86"); }
      return true;
    }
    if (s.kind === "channel") {
      const A = project(s.a), B = project(s.b), C = project(s.c);
      const [a2, b2] = channelParallel(s);
      const A2 = project(a2), B2 = project(b2);
      if (!A || !B || !C || !A2 || !B2) return true;
      const st = resolveStyle(s);
      const eL = !!s.extendLeft, eR = !!s.extendRight;
      const base = clipLineToRect(A, B, bounds, eL, eR);
      const par = clipLineToRect(A2, B2, bounds, eL, eR);
      if (st.fillOpacity > 0 && base && par) {
        const xs = [base[0].x, base[1].x, par[0].x, par[1].x];
        const xa = Math.min(...xs), xb = Math.max(...xs);
        const y1a = yAtX(A, B, xa), y1b = yAtX(A, B, xb), y2a = yAtX(A2, B2, xa), y2b = yAtX(A2, B2, xb);
        if (y1a != null && y1b != null && y2a != null && y2b != null) {
          ctx.fillStyle = withAlpha(st.fillColor, st.fillOpacity);
          ctx.beginPath();
          ctx.moveTo(xa, y1a); ctx.lineTo(xb, y1b); ctx.lineTo(xb, y2b); ctx.lineTo(xa, y2a);
          ctx.closePath(); ctx.fill();
        }
      }
      applyLine(ctx, st.color, st.lineWidth, st.lineStyle);
      if (base) seg(ctx, base[0], base[1]);
      if (par) seg(ctx, par[0], par[1]);
      if (s.showMiddle) {
        const M1 = { x: (A.x + A2.x) / 2, y: (A.y + A2.y) / 2 }, M2 = { x: (B.x + B2.x) / 2, y: (B.y + B2.y) / 2 };
        const mid = clipLineToRect(M1, M2, bounds, eL, eR);
        applyLine(ctx, st.color, 1, "dashed");
        if (mid) seg(ctx, mid[0], mid[1]);
      }
      if (selected) { handle(ctx, A, st.color); handle(ctx, B, st.color); handle(ctx, C, st.color); }
      return true;
    }
    if (s.kind === "text") {
      const A = project(s.a);
      if (!A) return true;
      const st = resolveStyle(s);
      const fs = s.fontSize || 13;
      ctx.font = `${fs}px -apple-system, Segoe UI, Roboto, sans-serif`;
      const w = ctx.measureText(s.text || "").width + 12;
      const h = fs + 10;
      ctx.fillStyle = withAlpha(s.fillColor || "#131722", st.fillOpacity);
      ctx.fillRect(A.x, A.y - h, w, h);
      applyLine(ctx, st.color, 1, "solid");
      ctx.strokeRect(A.x, A.y - h, w, h);
      ctx.fillStyle = s.textColor || st.color;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(s.text || "", A.x + 6, A.y - h / 2);
      if (selected) handle(ctx, A, st.color);
      return true;
    }
    return false;
  } finally {
    ctx.restore();
  }
}

function drawTrend(ctx: CanvasRenderingContext2D, s: TrendlineShape, env: RenderEnv, dec: number) {
  const A = env.project(s.a), B = env.project(s.b);
  if (!A || !B) return;
  const st = resolveStyle(s);
  applyLine(ctx, st.color, st.lineWidth, st.lineStyle);
  const sg = clipLineToRect(A, B, env.bounds, !!s.extendLeft, !!s.extendRight);
  if (sg) seg(ctx, sg[0], sg[1]);
  if (s.arrowEnd) arrowHead(ctx, B, A, st.color, 6 + st.lineWidth * 2);
  if (s.arrowStart) arrowHead(ctx, A, B, st.color, 6 + st.lineWidth * 2);
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  if (s.text) {
    ctx.font = FONT; ctx.fillStyle = s.textColor || st.color; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(s.text, mid.x, mid.y - 6);
  }
  if (s.showStats || s.showAngle) {
    const ms = measureStats(s.a, s.b, { barSec: env.barSec });
    const lines: string[] = [];
    if (s.showStats) {
      lines.push(`${signed(ms.dPrice, dec)} (${signed(ms.pct, 2)}%)`);
      lines.push(`${ms.bars != null ? `${Math.abs(ms.bars)} bars, ` : ""}${formatDuration(ms.durationSec)}`);
    }
    if (s.showAngle) {
      const deg = (Math.atan2(-(B.y - A.y), B.x - A.x) * 180) / Math.PI;
      lines.push(`${deg.toFixed(1)}°`);
    }
    labelBox(ctx, lines, B.x + 8, B.y + (B.y >= A.y ? 6 : -lines.length * 16 - 8), withAlpha(st.color, 0.9), "#ffffff", env.bounds, "left");
  }
  if (env.selected) {
    handle(ctx, A, st.color);
    handle(ctx, B, st.color);
    if (s.showMidpoint) handle(ctx, mid, st.color);
  } else if (s.showMidpoint) {
    ctx.fillStyle = st.color;
    ctx.beginPath(); ctx.arc(mid.x, mid.y, 3, 0, Math.PI * 2); ctx.fill();
  }
}
