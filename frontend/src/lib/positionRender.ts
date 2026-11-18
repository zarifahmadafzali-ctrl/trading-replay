/**
 * Position tool — canvas painter (TradingView Long/Short Position appearance).
 * Pure drawing only. Execution / SL-TP math lives in positionEngine; do not change it here.
 *
 * Visual language (TradingView public position tool):
 * - Profit zone always green, stop zone always red (long and short).
 * - Solid TP/SL lines; entry solid when filled, dashed when draft/pending.
 * - Centered pills: Target / Stop / Qty·R·Open P&L.
 * - Compact price tags on the right edge of each level.
 * - Selection handles: white fill + level color stroke (square on TP/SL, circle on entry).
 */
import type { Box, PositionLike, PositionStyle, PositionTexts } from "./positionModel";
import { hexToRgba } from "./positionModel";

export type DrawPositionOpts = {
  box: Box;
  w: number;
  h: number;
  style: PositionStyle;
  texts: PositionTexts;
  compactCenter?: string;
  selected: boolean;
  warning?: string | null;
  stopTriggerY?: number | null;
  limitY?: number | null;
  priceDecimals: number;
  forScreenshot?: boolean;
};

const FONT =
  '12px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** TradingView-style label chip (rounded, optional border). */
function chip(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  bg: string,
  fg: string,
  fontSize: number,
  bounds: { w: number; h: number },
  align: "center" | "left" = "center"
) {
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
  const padX = 7;
  const hgt = fontSize + 7;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  let x =
    align === "center" ? cx - bw / 2 : cx;
  x = Math.max(2, Math.min(bounds.w - bw - 2, x));
  const yy = Math.max(2, Math.min(bounds.h - hgt - 2, y));
  roundRect(ctx, x, yy, bw, hgt, 3);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, x + padX, yy + hgt / 2 + 0.5);
  return { x, y: yy, w: bw, h: hgt };
}

function hline(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  color: string,
  width: number,
  dash: number[]
) {
  // Half-pixel for crisp 1px strokes (TV toolkit style).
  const yy = Math.round(y) + (width % 2 === 1 ? 0.5 : 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, yy);
  ctx.lineTo(x1, yy);
  ctx.stroke();
  ctx.setLineDash([]);
}

function handleSquare(ctx: CanvasRenderingContext2D, x: number, y: number, stroke: string) {
  const s = 4.5;
  const xx = Math.round(x) + 0.5;
  const yy = Math.round(y) + 0.5;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.fillRect(xx - s, yy - s, s * 2, s * 2);
  ctx.strokeRect(xx - s, yy - s, s * 2, s * 2);
}

function handleCircle(ctx: CanvasRenderingContext2D, x: number, y: number, stroke: string) {
  const xx = Math.round(x) + 0.5;
  const yy = Math.round(y) + 0.5;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(xx, yy, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Right-edge price tag (TradingView level label). */
function priceTag(
  ctx: CanvasRenderingContext2D,
  price: number,
  y: number,
  bg: string,
  fg: string,
  decimals: number,
  boxRight: number,
  canvasW: number,
  fontSize: number
) {
  const text = price.toFixed(decimals);
  ctx.font = `600 ${fontSize - 1}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
  const padX = 5;
  const hgt = fontSize + 5;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  let x = boxRight + 3;
  if (x + bw > canvasW - 2) x = canvasW - bw - 2;
  const yy = Math.round(y) - hgt / 2;
  roundRect(ctx, x, yy, bw, hgt, 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, x + padX, yy + hgt / 2 + 0.5);
}

export function drawPosition(ctx: CanvasRenderingContext2D, p: PositionLike, o: DrawPositionOpts): void {
  const { box: b, style: st } = o;
  const live = p.status === "open";
  const pending = p.status === "pending" || p.status === "draft";
  const zoneScale = live ? 1 : pending ? 0.72 : 0.55;
  const profitTop = Math.min(b.entryY, b.tpY);
  const profitH = Math.abs(b.tpY - b.entryY);
  const stopTop = Math.min(b.entryY, b.stopY);
  const stopH = Math.abs(b.stopY - b.entryY);
  const width = Math.max(1, b.x1 - b.x0);
  const fs = st.fontSize || 12;
  const cx = (b.x0 + b.x1) / 2;

  ctx.save();
  ctx.setLineDash([]);

  // ── zones (TV: always profit=green, stop=red regardless of side) ──
  ctx.fillStyle = hexToRgba(st.profitColor, st.profitOpacity * zoneScale);
  ctx.fillRect(b.x0, profitTop, width, Math.max(0, profitH));
  ctx.fillStyle = hexToRgba(st.stopColor, st.stopOpacity * zoneScale);
  ctx.fillRect(b.x0, stopTop, width, Math.max(0, stopH));

  // Subtle vertical edge lines (TV bounded box, not full-bleed)
  ctx.strokeStyle = hexToRgba(st.lineColor, live ? 0.35 : 0.25);
  ctx.lineWidth = 1;
  const edgeTop = Math.min(b.tpY, b.stopY, b.entryY);
  const edgeBot = Math.max(b.tpY, b.stopY, b.entryY);
  ctx.beginPath();
  ctx.moveTo(Math.round(b.x0) + 0.5, edgeTop);
  ctx.lineTo(Math.round(b.x0) + 0.5, edgeBot);
  ctx.moveTo(Math.round(b.x1) + 0.5, edgeTop);
  ctx.lineTo(Math.round(b.x1) + 0.5, edgeBot);
  ctx.stroke();

  // ── level lines ──
  hline(ctx, b.x0, b.x1, b.tpY, st.profitColor, Math.max(1, st.lineWidth), []);
  hline(ctx, b.x0, b.x1, b.stopY, st.stopColor, Math.max(1, st.lineWidth), []);
  hline(
    ctx,
    b.x0,
    b.x1,
    b.entryY,
    st.lineColor,
    Math.max(1, st.lineWidth),
    live ? [] : [5, 4]
  );

  // Stop-limit helpers
  if (o.stopTriggerY != null) {
    hline(ctx, b.x0, b.x1, o.stopTriggerY, "#f59e0b", 1.25, [3, 3]);
  }
  if (o.limitY != null) {
    hline(ctx, b.x0, b.x1, o.limitY, st.lineColor, 1.25, [5, 4]);
  }

  // ── labels (TV-style chips) ──
  const showStats =
    !!o.forScreenshot || st.alwaysShowStats || o.selected || p.status !== "open";
  if (showStats) {
    const pillH = fs + 7;
    const tpAbove = b.tpY < b.entryY;
    chip(
      ctx,
      o.texts.target,
      cx,
      tpAbove ? b.tpY - pillH - 2 : b.tpY + 3,
      st.profitColor,
      st.textColor || "#ffffff",
      fs,
      o
    );
    const slAbove = b.stopY < b.entryY;
    chip(
      ctx,
      o.texts.stop,
      cx,
      slAbove ? b.stopY - pillH - 2 : b.stopY + 3,
      st.stopColor,
      st.textColor || "#ffffff",
      fs,
      o
    );
    const centerText = st.compactStats ? o.compactCenter || o.texts.center : o.texts.center;
    if (centerText) {
      chip(
        ctx,
        centerText,
        cx,
        b.entryY - pillH / 2,
        "rgba(19, 23, 34, 0.92)",
        st.textColor || "#ffffff",
        fs,
        o
      );
    }
  } else if (p.status === "open") {
    // Live open: compact center only (less clutter while replaying)
    const centerText = o.compactCenter || o.texts.center;
    if (centerText) {
      const pnlNeg = (o.compactCenter || "").trim().startsWith("-");
      chip(
        ctx,
        centerText,
        cx,
        b.entryY - (fs + 7) / 2,
        pnlNeg ? st.stopColor : "rgba(19, 23, 34, 0.92)",
        st.textColor || "#ffffff",
        fs,
        o
      );
    }
  }

  // Side / status badge at left of entry (TV-like “Long” / “Short”)
  if (!o.forScreenshot) {
    const sideLabel =
      p.status === "draft"
        ? p.side === "long"
          ? "Long draft"
          : "Short draft"
        : p.status === "pending"
          ? p.side === "long"
            ? "Long pending"
            : "Short pending"
          : p.status === "closed"
            ? p.side === "long"
              ? "Long closed"
              : "Short closed"
            : p.side === "long"
              ? "Long"
              : "Short";
    chip(
      ctx,
      sideLabel,
      b.x0 + 4,
      b.entryY - (fs + 7) - 2,
      p.side === "long" ? hexToRgba(st.profitColor, 0.95) : hexToRgba(st.stopColor, 0.95),
      "#ffffff",
      Math.max(10, fs - 1),
      o,
      "left"
    );
  }

  // Right price tags
  if (st.showPriceLabels) {
    const d = o.priceDecimals;
    priceTag(ctx, p.takeProfit.price, b.tpY, st.profitColor, st.textColor || "#fff", d, b.x1, o.w, fs);
    priceTag(ctx, p.stop.price, b.stopY, st.stopColor, st.textColor || "#fff", d, b.x1, o.w, fs);
    priceTag(ctx, p.entry.price, b.entryY, "#363a45", st.textColor || "#fff", d, b.x1, o.w, fs);
  }

  // Selection handles (TV-like, not oversized)
  if (!o.forScreenshot && (o.selected || p.status === "draft") && !p.locked) {
    const draftOrPending = p.status !== "open" && p.status !== "closed";
    const mx = (b.x0 + b.x1) / 2;
    if (draftOrPending) handleSquare(ctx, b.x0, b.tpY, st.profitColor);
    handleSquare(ctx, mx, b.tpY, st.profitColor);
    handleSquare(ctx, b.x1, b.tpY, st.profitColor);
    if (draftOrPending) handleCircle(ctx, b.x0, b.entryY, st.lineColor);
    handleCircle(ctx, mx, b.entryY, st.lineColor);
    handleCircle(ctx, b.x1, b.entryY, st.lineColor);
    if (draftOrPending) handleSquare(ctx, b.x0, b.stopY, st.stopColor);
    handleSquare(ctx, mx, b.stopY, st.stopColor);
    handleSquare(ctx, b.x1, b.stopY, st.stopColor);
  }

  if (o.warning) {
    chip(
      ctx,
      `⚠ ${o.warning}`,
      cx,
      Math.max(2, Math.min(b.tpY, b.stopY, b.entryY) - (fs + 8) * 2 - 6),
      "#b91c1c",
      "#ffffff",
      fs,
      o
    );
  }
  if (p.locked && !o.forScreenshot) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("🔒", b.x0 + 4, b.entryY + 12);
  }

  ctx.restore();
}
