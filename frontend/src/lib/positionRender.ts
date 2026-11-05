/**
 * Position tool v2 — canvas painter (TradingView-like long/short position box).
 * Pure drawing: no React, no chart library. Called from Chart.tsx redrawOverlay for kind === "position".
 *
 * Colour semantics (TradingView): the PROFIT zone is always profitColor and the STOP zone always
 * stopColor, for Long AND Short. (The old code tinted a Short's profit zone red.)
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
  /** Blocking validation message to show on the box (draft/pending/open). */
  warning?: string | null;
  /** Stop-Limit extra levels (y coordinates). */
  stopTriggerY?: number | null;
  limitY?: number | null;
  priceDecimals: number;
  /** Hide selection chrome (journal screenshots). */
  forScreenshot?: boolean;
};

function pill(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  bg: string,
  fg: string,
  fontSize: number,
  bounds: { w: number; h: number }
) {
  ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const padX = 6;
  const hgt = fontSize + 8;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  let x = cx - bw / 2;
  x = Math.max(2, Math.min(bounds.w - bw - 2, x));
  const yy = Math.max(2, Math.min(bounds.h - hgt - 2, y));
  const r = 3;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(x + r, yy);
  ctx.lineTo(x + bw - r, yy);
  ctx.arcTo(x + bw, yy, x + bw, yy + r, r);
  ctx.lineTo(x + bw, yy + hgt - r);
  ctx.arcTo(x + bw, yy + hgt, x + bw - r, yy + hgt, r);
  ctx.lineTo(x + r, yy + hgt);
  ctx.arcTo(x, yy + hgt, x, yy + hgt - r, r);
  ctx.lineTo(x, yy + r);
  ctx.arcTo(x, yy, x + r, yy, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, x + padX, yy + hgt / 2 + 0.5);
}

function hline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, width: number, dash: number[]) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function handleSquare(ctx: CanvasRenderingContext2D, x: number, y: number, stroke: string) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.fillRect(x - 5, y - 5, 10, 10);
  ctx.strokeRect(x - 5, y - 5, 10, 10);
}

function handleCircle(ctx: CanvasRenderingContext2D, x: number, y: number, stroke: string) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawPosition(ctx: CanvasRenderingContext2D, p: PositionLike, o: DrawPositionOpts): void {
  const { box: b, style: st } = o;
  const long = p.side === "long";
  const live = p.status === "open";
  const zoneScale = live ? 1 : 0.75;
  const top = Math.min(b.entryY, b.tpY);
  const profitH = Math.abs(b.tpY - b.entryY);
  const stopTop = Math.min(b.entryY, b.stopY);
  const stopH = Math.abs(b.stopY - b.entryY);
  const width = b.x1 - b.x0;

  ctx.save();
  ctx.setLineDash([]);

  // zones
  ctx.fillStyle = hexToRgba(st.profitColor, st.profitOpacity * zoneScale);
  ctx.fillRect(b.x0, top, width, profitH);
  ctx.fillStyle = hexToRgba(st.stopColor, st.stopOpacity * zoneScale);
  ctx.fillRect(b.x0, stopTop, width, stopH);

  // lines
  hline(ctx, b.x0, b.x1, b.tpY, st.profitColor, st.lineWidth, []);
  hline(ctx, b.x0, b.x1, b.stopY, st.stopColor, st.lineWidth, []);
  hline(ctx, b.x0, b.x1, b.entryY, st.lineColor, Math.max(1, st.lineWidth), live ? [] : [6, 4]);

  // stop-limit helper levels
  if (o.stopTriggerY != null) hline(ctx, b.x0, b.x1, o.stopTriggerY, "#f97316", 1.5, [2, 3]);
  if (o.limitY != null) hline(ctx, b.x0, b.x1, o.limitY, st.lineColor, 1.5, [6, 4]);

  // labels
  const fs = st.fontSize;
  const cx = (b.x0 + b.x1) / 2;
  const showStats = !!o.forScreenshot || st.alwaysShowStats || o.selected || p.status !== "open";
  if (showStats) {
    const pillH = fs + 8;
    const tpAbove = b.tpY < b.entryY; // target drawn above entry (screen y smaller)
    pill(ctx, o.texts.target, cx, tpAbove ? b.tpY - pillH - 2 : b.tpY + 2, st.profitColor, st.textColor, fs, o);
    const slAbove = b.stopY < b.entryY;
    pill(ctx, o.texts.stop, cx, slAbove ? b.stopY - pillH - 2 : b.stopY + 2, st.stopColor, st.textColor, fs, o);
    const centerText = st.compactStats ? o.compactCenter || o.texts.center : o.texts.center;
    if (centerText) {
      const pnlNeg = live && /Open P&L: -/.test(o.texts.center);
      pill(ctx, centerText, cx, b.entryY - pillH / 2, pnlNeg ? st.stopColor : "rgba(30,34,45,0.92)", st.textColor, fs, o);
    }
  }

  // price tags at the right end
  if (st.showPriceLabels) {
    const d = o.priceDecimals;
    const tag = (price: number, y: number, bg: string) => {
      const text = price.toFixed(d);
      ctx.font = `${fs - 1}px system-ui, sans-serif`;
      const tw = ctx.measureText(text).width + 8;
      const x = Math.min(o.w - tw - 1, b.x1 + 2);
      ctx.fillStyle = bg;
      ctx.fillRect(x, y - (fs + 4) / 2, tw, fs + 4);
      ctx.fillStyle = st.textColor;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(text, x + 4, y + 0.5);
    };
    tag(p.takeProfit.price, b.tpY, st.profitColor);
    tag(p.stop.price, b.stopY, st.stopColor);
    tag(p.entry.price, b.entryY, "#363a45");
  }

  // Outer box border (bounded rectangle — never full-width chrome)
  {
    const top = Math.min(b.tpY, b.stopY, b.entryY);
    const bot = Math.max(b.tpY, b.stopY, b.entryY);
    ctx.strokeStyle = hexToRgba(st.lineColor, live ? 0.55 : 0.4);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(b.x0 + 0.5, top + 0.5, Math.max(1, width - 1), Math.max(1, bot - top - 1));
  }

  // 9 handles only when selected (or draft) and not screenshot
  if (!o.forScreenshot && (o.selected || p.status === "draft") && !p.locked) {
    const draftOrPending = p.status !== "open";
    const mx = (b.x0 + b.x1) / 2;
    // Top row: TL, TC (TP), TR
    if (draftOrPending) handleSquare(ctx, b.x0, b.tpY, st.profitColor);
    handleSquare(ctx, mx, b.tpY, st.profitColor);
    handleSquare(ctx, b.x1, b.tpY, st.profitColor);
    // Middle row: ML, MC (entry/body), MR
    if (draftOrPending) handleCircle(ctx, b.x0, b.entryY, st.lineColor);
    handleCircle(ctx, mx, b.entryY, st.lineColor);
    handleCircle(ctx, b.x1, b.entryY, st.lineColor);
    // Bottom row: BL, BC (SL), BR
    if (draftOrPending) handleSquare(ctx, b.x0, b.stopY, st.stopColor);
    handleSquare(ctx, mx, b.stopY, st.stopColor);
    handleSquare(ctx, b.x1, b.stopY, st.stopColor);
  }

  if (o.warning) {
    pill(ctx, `⚠ ${o.warning}`, cx, Math.max(2, Math.min(b.tpY, b.stopY, b.entryY) - (fs + 8) * 2 - 6), "#b91c1c", "#ffffff", fs, o);
  }
  if (p.locked && !o.forScreenshot) {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = `${fs}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("🔒", b.x0 + 4, b.entryY - 10);
  }
  ctx.restore();
}
