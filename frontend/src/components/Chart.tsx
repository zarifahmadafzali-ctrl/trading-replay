import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type MouseEventParams,
} from "lightweight-charts";
import type { Bar } from "../lib/types";
import Toolbar from "./Toolbar";

type ChartHandles = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
};

export type DrawTool =
  | "none"
  | "crosshair"
  | "trendline"
  | "rectangle"
  | "measure"
  | "hline"
  | "vline"
  | "fib"
  | "long"
  | "short";

export type OrderType =
  | "market"
  | "buy_limit"
  | "sell_limit"
  | "buy_stop"
  | "sell_stop"
  | "buy_stop_limit"
  | "sell_stop_limit";

export type ChartPoint = { time: number; price: number };

export type TrendlineShape = {
  id: string;
  kind: "trendline";
  a: ChartPoint;
  b: ChartPoint;
};

export type RectangleShape = {
  id: string;
  kind: "rectangle";
  a: ChartPoint;
  b: ChartPoint;
};

export type MeasureShape = {
  id: string;
  kind: "measure";
  a: ChartPoint;
  b: ChartPoint;
};

export type HLineShape = {
  id: string;
  kind: "hline";
  price: number;
};

export type VLineShape = {
  id: string;
  kind: "vline";
  time: number;
};

export type FibShape = {
  id: string;
  kind: "fib";
  a: ChartPoint;
  b: ChartPoint;
};

export type PositionShape = {
  id: string;
  kind: "position";
  side: "long" | "short";
  orderType: OrderType;
  /** draft = lines on chart, user still editing; open = confirmed */
  status: "draft" | "open";
  entry: ChartPoint;
  stop: ChartPoint;
  takeProfit: ChartPoint;
};

export type Shape =
  | TrendlineShape
  | RectangleShape
  | MeasureShape
  | HLineShape
  | VLineShape
  | FibShape
  | PositionShape;

type DragTarget = {
  id: string;
  field: "stop" | "takeProfit" | "entry" | "a" | "b" | "price" | "time";
};

function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.slice(0, 2).join(" ");
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function riskReward(entry: number, stop: number, tp: number): number | null {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (risk < 1e-12) return null;
  return reward / risk;
}

/** Default SL/TP offsets from entry (~0.4% risk, ~0.8% reward → ~1:2) */
function defaultsFor(
  side: "long" | "short",
  orderType: OrderType,
  price: number,
  time: number
): Pick<PositionShape, "entry" | "stop" | "takeProfit"> {
  const riskPct = 0.004;
  const rewardPct = 0.008;
  const entry = { time, price };
  if (side === "long") {
    return {
      entry,
      stop: { time, price: price * (1 - riskPct) },
      takeProfit: { time, price: price * (1 + rewardPct) },
    };
  }
  return {
    entry,
    stop: { time, price: price * (1 + riskPct) },
    takeProfit: { time, price: price * (1 - rewardPct) },
  };
}

export function Chart({
  bars,
  cursor,
  drawTool = "crosshair",
  orderType = "market",
  marketPrice = null,
  marketTime = null,
  followPrice = false,
  shapes,
  onShapesChange,
  selectedShapeId = null,
  onSelectedShapeId,
  onDrawToolChange,
}: {
  bars: Bar[];
  cursor: number;
  drawTool?: DrawTool;
  orderType?: OrderType;
  marketPrice?: number | null;
  marketTime?: number | null;
  /** If true, keep latest bar near the right edge while playing */
  followPrice?: boolean;
  shapes: Shape[];
  onShapesChange: (next: Shape[]) => void;
  selectedShapeId?: string | null;
  onSelectedShapeId?: (id: string | null) => void;
  /** Optional callback used by the built-in TradingView-style toolbar. */
  onDrawToolChange?: (tool: DrawTool) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const shapesRef = useRef(shapes);
  const drawToolRef = useRef(drawTool);
  const orderTypeRef = useRef(orderType);
  const marketRef = useRef({ price: marketPrice, time: marketTime });
  const followRef = useRef(followPrice);
  const selectedShapeIdRef = useRef(selectedShapeId);
  const crosshairRef = useRef<ChartPoint | null>(null);
  const stepsRef = useRef<ChartPoint[]>([]);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<DragTarget | null>(null);
  const onShapesChangeRef = useRef(onShapesChange);
  onShapesChangeRef.current = onShapesChange;
  const onSelectedShapeIdRef = useRef(onSelectedShapeId);
  onSelectedShapeIdRef.current = onSelectedShapeId;
  // Screen-space hit area for the on-canvas "×" delete button drawn next to
  // whichever trendline/rectangle/measure shape is currently selected.
  const deleteButtonRef = useRef<{ id: string; x: number; y: number; r: number } | null>(null);
  const downRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const doubleTapRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const [ohlc, setOhlc] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);
  const [hint, setHint] = useState("");
  // The built-in toolbar can operate even when the parent does not pass a
  // controlled onDrawToolChange callback. This is important for the chart
  // toolbar itself, especially on mobile.
  const [localDrawTool, setLocalDrawTool] = useState<DrawTool>(drawTool);
  const activeDrawTool = localDrawTool;

  shapesRef.current = shapes;
  drawToolRef.current = activeDrawTool;
  orderTypeRef.current = orderType;
  marketRef.current = { price: marketPrice, time: marketTime };
  followRef.current = followPrice;
  selectedShapeIdRef.current = selectedShapeId;

  function scheduleRedraw() {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      redrawOverlay();
    });
  }

  function setShapes(next: Shape[]) {
    onShapesChangeRef.current(next);
  }

  function updatePosition(id: string, patch: Partial<PositionShape>) {
    setShapes(
      shapesRef.current.map((s) =>
        s.kind === "position" && s.id === id ? { ...s, ...patch } : s
      ) as Shape[]
    );
  }

  /** Drop a draft position on the chart immediately (Market or pending). */
  function spawnDraft(side: "long" | "short") {
    const price = marketRef.current.price;
    const time = marketRef.current.time;
    if (price == null || time == null) {
      setHint("Load replay data first");
      return;
    }
    const ot = orderTypeRef.current;
    // remove previous unfinished draft of same side
    const kept = shapesRef.current.filter(
      (s) => !(s.kind === "position" && s.status === "draft")
    );
    const levels = defaultsFor(side, ot, price, time);
    // pending: entry slightly off market so user sees a separate entry line
    if (ot !== "market") {
      const off = side === "long" ? 0.998 : 1.002;
      if (ot.includes("limit")) {
        levels.entry = { time, price: price * (side === "long" ? 0.997 : 1.003) };
      } else if (ot.includes("stop")) {
        levels.entry = { time, price: price * (side === "long" ? 1.003 : 0.997) };
      } else {
        levels.entry = { time, price: price * off };
      }
      levels.stop = {
        time,
        price:
          side === "long"
            ? levels.entry.price * 0.996
            : levels.entry.price * 1.004,
      };
      levels.takeProfit = {
        time,
        price:
          side === "long"
            ? levels.entry.price * 1.008
            : levels.entry.price * 0.992,
      };
    }
    const draft: PositionShape = {
      id: uid(),
      kind: "position",
      side,
      orderType: ot,
      status: "draft",
      ...levels,
    };
    setShapes([...kept, draft]);
    if (ot === "market") {
      setHint("MARKET draft · drag SL (orange) & TP (blue) · then Confirm");
    } else {
      setHint(`${ot} draft · drag Entry / SL / TP · then Confirm`);
    }
  }

  function confirmDrafts() {
    let n = 0;
    const next = shapesRef.current.map((s) => {
      if (s.kind === "position" && s.status === "draft") {
        n++;
        return { ...s, status: "open" as const };
      }
      return s;
    });
    setShapes(next);
    setHint(n ? `Position confirmed (${n})` : "No draft to confirm");
  }

  function cancelDrafts() {
    setShapes(shapesRef.current.filter((s) => !(s.kind === "position" && s.status === "draft")));
    setHint("Draft cancelled");
  }

  // Expose confirm via custom events from parent buttons
  useEffect(() => {
    const onConfirm = () => confirmDrafts();
    const onCancel = () => cancelDrafts();
    window.addEventListener("tr-confirm-position", onConfirm);
    window.addEventListener("tr-cancel-draft", onCancel);
    return () => {
      window.removeEventListener("tr-confirm-position", onConfirm);
      window.removeEventListener("tr-cancel-draft", onCancel);
    };
  }, []);

  // Long/Short are placed by tapping the chart. This works even when the
  // parent does not provide marketPrice/marketTime, which is common during
  // mobile replay startup.
  useEffect(() => {
    if (activeDrawTool === "long" || activeDrawTool === "short") {
      setHint(`Tap the chart to place ${activeDrawTool === "long" ? "Long" : "Short"} position`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawTool, orderType]);

  /** Chart-space point → screen (canvas) pixel coordinates. */
  function toXY(p: ChartPoint): { x: number; y: number } | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    const x = handles.chart.timeScale().timeToCoordinate(p.time as UTCTimestamp);
    const y = handles.candles.priceToCoordinate(p.price);
    if (x == null || y == null) return null;
    return { x, y };
  }

  /** Screen pixel coordinates → chart-space point (time + price). */
  function fromXY(x: number, y: number): ChartPoint | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    const time = handles.chart.timeScale().coordinateToTime(x);
    const price = handles.candles.coordinateToPrice(y);
    if (time == null || price == null) return null;
    return { time: Number(time), price };
  }

  function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
    ctx.font = "11px system-ui, sans-serif";
    const padX = 6;
    const padY = 4;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(8, 11, 15, 0.85)";
    ctx.fillRect(x - padX, y - 11 - padY, w + padX * 2, 15 + padY);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - padX, y - 11 - padY, w + padX * 2, 15 + padY);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function redrawOverlay() {
    const canvas = overlayRef.current;
    const handles = handlesRef.current;
    if (!canvas || !handles) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    deleteButtonRef.current = null;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const needW = Math.floor(w * dpr);
    const needH = Math.floor(h * dpr);
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    for (const s of shapesRef.current) {
      if (s.kind === "trendline") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : "#60a5fa";
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
        // Endpoint handles are always visible (small) so it's obvious the
        // line can be grabbed and dragged; they grow when selected.
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : "#60a5fa";
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
        if (sel) {
          const bx = B.x + 14;
          const by = B.y - 14;
          drawDeleteButton(ctx, s.id, bx, by);
        }
      } else if (s.kind === "rectangle") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        const x = Math.min(A.x, B.x);
        const y = Math.min(A.y, B.y);
        const rw = Math.abs(B.x - A.x);
        const rh = Math.abs(B.y - A.y);
        ctx.fillStyle = sel ? "rgba(251, 191, 36, 0.14)" : "rgba(96, 165, 250, 0.12)";
        ctx.strokeStyle = sel ? "#fbbf24" : "#60a5fa";
        ctx.lineWidth = sel ? 2 : 1.5;
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x, y, rw, rh);
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : "#60a5fa";
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
        if (sel) {
          drawDeleteButton(ctx, s.id, x + rw + 14, y - 14);
        }
      } else if (s.kind === "measure") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : "#c084fc";
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : "#c084fc";
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
        drawMeasureLabel(ctx, s.a, s.b, A, B, sel ? "#fbbf24" : "#c084fc");
        if (sel) {
          drawDeleteButton(ctx, s.id, B.x + 14, B.y - 14);
        }
      } else if (s.kind === "hline") {
        const y = handles.candles.priceToCoordinate(s.price);
        if (y == null) continue;
        const sel = selectedShapeIdRef.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : "#f59e0b";
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = sel ? "#fbbf24" : "#f59e0b";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(`H ${s.price.toFixed(2)}`, 8, Math.max(14, y - 7));
        if (sel) drawDeleteButton(ctx, s.id, w - 14, y - 14);
      } else if (s.kind === "vline") {
        const x = handles.chart.timeScale().timeToCoordinate(s.time as UTCTimestamp);
        if (x == null) continue;
        const sel = selectedShapeIdRef.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : "#a78bfa";
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        if (sel) {
          ctx.fillStyle = "#fbbf24";
          ctx.beginPath();
          ctx.arc(x, 14, 5, 0, Math.PI * 2);
          ctx.fill();
          drawDeleteButton(ctx, s.id, x + 14, 28);
        }
      } else if (s.kind === "fib") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef.current === s.id;
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
        const priceDelta = s.b.price - s.a.price;
        ctx.lineWidth = sel ? 1.5 : 1;
        for (const level of levels) {
          const price = s.a.price + priceDelta * level;
          const y = handles.candles.priceToCoordinate(price);
          if (y == null) continue;
          ctx.strokeStyle = sel ? "#fbbf24" : "rgba(167,139,250,0.9)";
          ctx.setLineDash(level === 0 || level === 1 ? [] : [5, 4]);
          ctx.beginPath();
          ctx.moveTo(Math.min(A.x, B.x), y);
          ctx.lineTo(Math.max(A.x, B.x), y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = sel ? "#fbbf24" : "#c4b5fd";
          ctx.font = "10px system-ui, sans-serif";
          ctx.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(2)}`, Math.min(A.x, B.x) + 6, Math.max(12, y - 4));
        }
        if (sel) {
          const r = 6;
          ctx.fillStyle = "#fbbf24";
          ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
          drawDeleteButton(ctx, s.id, B.x + 14, B.y - 14);
        }
      } else if (s.kind === "position") {
        const E = toXY(s.entry);
        const S = toXY(s.stop);
        const T = toXY(s.takeProfit);
        if (!E) continue;
        const long = s.side === "long";
        const entryColor = long ? "#26a69a" : "#ef5350";
        const draft = s.status === "draft";

        if (S && T) {
          ctx.fillStyle = long ? "rgba(38,166,154,0.10)" : "rgba(239,83,80,0.10)";
          ctx.fillRect(0, Math.min(E.y, T.y), w, Math.abs(T.y - E.y));
          ctx.fillStyle = "rgba(245,158,11,0.12)";
          ctx.fillRect(0, Math.min(E.y, S.y), w, Math.abs(S.y - E.y));
        }

        const hLine = (y: number, color: string, dash: number[]) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = draft ? 2 : 1.5;
          ctx.setLineDash(dash);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          ctx.setLineDash([]);
        };

        // Entry: solid for market open, dashed for pending/draft entry
        const entryDash =
          s.orderType === "market" && s.status === "open" ? [] : [6, 4];
        hLine(E.y, entryColor, entryDash);
        if (S) {
          hLine(S.y, "#f59e0b", [4, 4]);
          ctx.fillStyle = "#f59e0b";
          ctx.fillRect(w - 20, S.y - 7, 14, 14);
        }
        if (T) {
          hLine(T.y, "#38bdf8", [4, 4]);
          ctx.fillStyle = "#38bdf8";
          ctx.fillRect(w - 20, T.y - 7, 14, 14);
        }
        // entry handle only for pending drafts (entry editable)
        if (draft && s.orderType !== "market") {
          ctx.fillStyle = entryColor;
          ctx.fillRect(w - 20, E.y - 7, 14, 14);
        }

        ctx.font = "11px system-ui, sans-serif";
        const rr = riskReward(s.entry.price, s.stop.price, s.takeProfit.price);
        const rrText = rr != null ? ` · R:R 1:${rr.toFixed(2)}` : "";
        const st = draft ? "DRAFT" : "OPEN";
        ctx.fillStyle = entryColor;
        ctx.fillText(
          `${st} ${s.side.toUpperCase()} ${s.orderType} @ ${s.entry.price.toFixed(2)}${rrText}`,
          8,
          Math.max(14, E.y - 8)
        );
        if (S) {
          ctx.fillStyle = "#f59e0b";
          ctx.fillText(`SL ${s.stop.price.toFixed(2)}`, 8, Math.max(14, S.y - 8));
        }
        if (T) {
          ctx.fillStyle = "#38bdf8";
          ctx.fillText(`TP ${s.takeProfit.price.toFixed(2)}`, 8, Math.max(14, T.y - 8));
        }
      }
    }

    for (const p of stepsRef.current) {
      const P = toXY(p);
      if (!P) continue;
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.arc(P.x, P.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Live preview while the measure tool's first point is placed but the
    // second hasn't been clicked yet — shows the running delta as you move.
    if (drawToolRef.current === "measure" && stepsRef.current.length === 1 && crosshairRef.current) {
      const a = stepsRef.current[0];
      const b = crosshairRef.current;
      const A = toXY(a);
      const B = toXY(b);
      if (A && B) {
        ctx.strokeStyle = "#c084fc";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
        ctx.setLineDash([]);
        drawMeasureLabel(ctx, a, b, A, B, "#c084fc");
      }
    }
  }

  function drawDeleteButton(ctx: CanvasRenderingContext2D, id: string, x: number, y: number) {
    const r = 10;
    ctx.fillStyle = "rgba(239, 83, 80, 0.9)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 4);
    ctx.lineTo(x + 4, y + 4);
    ctx.moveTo(x + 4, y - 4);
    ctx.lineTo(x - 4, y + 4);
    ctx.stroke();
    deleteButtonRef.current = { id, x, y, r: r + 6 }; // generous tap padding
  }

  /** Δprice, Δ%, candle count, and elapsed time between two chart points. */
  function drawMeasureLabel(
    ctx: CanvasRenderingContext2D,
    a: ChartPoint,
    b: ChartPoint,
    A: { x: number; y: number },
    B: { x: number; y: number },
    color: string
  ) {
    const priceDelta = b.price - a.price;
    const pctDelta = a.price !== 0 ? (priceDelta / a.price) * 100 : 0;
    const timeDelta = b.time - a.time;
    const lo = Math.min(a.time, b.time);
    const hi = Math.max(a.time, b.time);
    const barCount = bars.filter((bar) => bar.time >= lo && bar.time <= hi).length;
    const sign = priceDelta >= 0 ? "+" : "";
    const text = `${sign}${priceDelta.toFixed(2)} (${sign}${pctDelta.toFixed(2)}%) · ${barCount} bars · ${formatDuration(timeDelta)}`;
    const midX = (A.x + B.x) / 2;
    const midY = Math.min(A.y, B.y) - 12;
    drawLabel(ctx, midX - ctx.measureText(text).width / 2, Math.max(16, midY), text, color);
  }

  function placePoint(point: ChartPoint) {
    const tool = drawToolRef.current;
    if (tool !== "trendline" && tool !== "rectangle" && tool !== "measure" && tool !== "fib") return;
    const steps = stepsRef.current;
    if (steps.length === 0) {
      stepsRef.current = [point];
      setHint(tool === "measure" ? "Move, then click 2nd point" : "Double-click 2nd point");
      scheduleRedraw();
      return;
    }
    const a = steps[0];
    const b = point;
    stepsRef.current = [];
    const shape: Shape =
      tool === "trendline"
        ? { id: uid(), kind: "trendline", a, b }
        : tool === "rectangle"
        ? { id: uid(), kind: "rectangle", a, b }
        : tool === "measure"
        ? { id: uid(), kind: "measure", a, b }
        : { id: uid(), kind: "fib", a, b };
    setShapes([...shapesRef.current, shape]);
    onSelectedShapeIdRef.current?.(shape.id);
    setHint("Done · tap it to select, Delete or × to remove");
  }

  function hitTestDrag(x: number, y: number, touch: boolean): DragTarget | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    const series = handles.candles;
    const threshold = touch ? 20 : 12;

    // Two-point drawings: grab either endpoint.
    for (const s of shapesRef.current) {
      if (s.kind !== "trendline" && s.kind !== "rectangle" && s.kind !== "measure" && s.kind !== "fib") continue;
      const A = toXY(s.a);
      const B = toXY(s.b);
      if (A && Math.hypot(A.x - x, A.y - y) <= threshold) return { id: s.id, field: "a" };
      if (B && Math.hypot(B.x - x, B.y - y) <= threshold) return { id: s.id, field: "b" };
    }

    for (const s of shapesRef.current) {
      if (s.kind === "hline") {
        const lineY = series.priceToCoordinate(s.price);
        if (lineY != null && Math.abs(lineY - y) <= threshold) return { id: s.id, field: "price" };
      } else if (s.kind === "vline") {
        const xCoord = handles.chart.timeScale().timeToCoordinate(s.time as UTCTimestamp);
        if (xCoord != null && Math.abs(xCoord - x) <= threshold) return { id: s.id, field: "time" };
      }
    }

    for (const s of shapesRef.current) {
      if (s.kind !== "position") continue;
      // only draft fully editable; open still allows SL/TP tweak
      const sy = series.priceToCoordinate(s.stop.price);
      const ty = series.priceToCoordinate(s.takeProfit.price);
      const ey = series.priceToCoordinate(s.entry.price);
      if (sy != null && Math.abs(sy - y) <= threshold) return { id: s.id, field: "stop" };
      if (ty != null && Math.abs(ty - y) <= threshold) return { id: s.id, field: "takeProfit" };
      if (
        s.status === "draft" &&
        s.orderType !== "market" &&
        ey != null &&
        Math.abs(ey - y) <= threshold
      ) {
        return { id: s.id, field: "entry" };
      }
    }
    return null;
  }

  /** Selection hit-test — deliberately excludes positions (order/SL/TP levels
   *  stay managed only via the Confirm/Cancel draft flow, never keyboard-deleted). */
  function hitTestSelect(x: number, y: number, threshold: number): string | null {
    for (const s of shapesRef.current) {
      if (s.kind === "trendline" || s.kind === "measure") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        if (distToSegment(x, y, A.x, A.y, B.x, B.y) <= threshold) return s.id;
      } else if (s.kind === "rectangle") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const minX = Math.min(A.x, B.x) - threshold;
        const maxX = Math.max(A.x, B.x) + threshold;
        const minY = Math.min(A.y, B.y) - threshold;
        const maxY = Math.max(A.y, B.y) + threshold;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) return s.id;
      } else if (s.kind === "hline") {
        const lineY = handlesRef.current?.candles.priceToCoordinate(s.price);
        if (lineY != null && Math.abs(lineY - y) <= threshold) return s.id;
      } else if (s.kind === "vline") {
        const lineX = handlesRef.current?.chart.timeScale().timeToCoordinate(s.time as UTCTimestamp);
        if (lineX != null && Math.abs(lineX - x) <= threshold) return s.id;
      } else if (s.kind === "fib") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const minX = Math.min(A.x, B.x) - threshold;
        const maxX = Math.max(A.x, B.x) + threshold;
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
        for (const level of levels) {
          const price = s.a.price + (s.b.price - s.a.price) * level;
          const levelY = handlesRef.current?.candles.priceToCoordinate(price);
          if (levelY != null && x >= minX && x <= maxX && Math.abs(levelY - y) <= threshold) return s.id;
        }
      }
    }
    return null;
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#080b0f" }, textColor: "#b7c1cf" },
      grid: {
        vertLines: { color: "#17202a" },
        horzLines: { color: "#17202a" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 16,
        borderVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(180, 200, 220, 0.55)",
          width: 1,
          style: 2,
          labelBackgroundColor: "#1e293b",
        },
        horzLine: {
          color: "rgba(180, 200, 220, 0.55)",
          width: 1,
          style: 2,
          labelBackgroundColor: "#1e293b",
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    handlesRef.current = { chart, candles, volume };

    const onMove = (param: MouseEventParams) => {
      scheduleRedraw();
      if (param.point && param.time != null) {
        const price = candles.coordinateToPrice(param.point.y);
        if (price != null) {
          const time =
            typeof param.time === "number"
              ? param.time
              : Number((param.time as { timestamp?: number }).timestamp) || 0;
          crosshairRef.current = { time, price };
        }
      }

      if (dragRef.current && param.point) {
        const d = dragRef.current;
        if (d.field === "a" || d.field === "b") {
          const newPoint = fromXY(param.point.x, param.point.y);
          if (newPoint) {
            setShapes(
              shapesRef.current.map((s) =>
                s.id === d.id &&
                (s.kind === "trendline" || s.kind === "rectangle" || s.kind === "measure" || s.kind === "fib")
                  ? ({ ...s, [d.field]: newPoint } as Shape)
                  : s
              )
            );
          }
        } else if (d.field === "price") {
          const price = candles.coordinateToPrice(param.point.y);
          if (price != null) {
            setShapes(shapesRef.current.map((s) =>
              s.id === d.id && s.kind === "hline" ? { ...s, price } : s
            ));
          }
        } else if (d.field === "time") {
          const time = chart.timeScale().coordinateToTime(param.point.x);
          if (time != null) {
            setShapes(shapesRef.current.map((s) =>
              s.id === d.id && s.kind === "vline" ? { ...s, time: Number(time) } : s
            ));
          }
        } else {
          const price = candles.coordinateToPrice(param.point.y);
          if (price != null) {
            const s = shapesRef.current.find((x) => x.kind === "position" && x.id === d.id) as
              | PositionShape
              | undefined;
            if (s) {
              if (d.field === "stop") updatePosition(d.id, { stop: { ...s.stop, price } });
              else if (d.field === "takeProfit")
                updatePosition(d.id, { takeProfit: { ...s.takeProfit, price } });
              else if (d.field === "entry")
                updatePosition(d.id, { entry: { ...s.entry, price } });
            }
          }
        }
      }

      if (!param.time || !param.seriesData) {
        setOhlc(null);
        return;
      }
      const raw = param.seriesData.get(candles) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (!raw) {
        setOhlc(null);
        return;
      }
      const t = typeof param.time === "number" ? param.time : 0;
      setOhlc({
        time: new Date(t * 1000).toLocaleString(),
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
      });
    };
    chart.subscribeCrosshairMove(onMove);

    const onRange = () => scheduleRedraw();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);

    const el = containerRef.current;

    function deleteShape(id: string) {
      setShapes(shapesRef.current.filter((s) => s.id !== id));
      if (selectedShapeIdRef.current === id) onSelectedShapeIdRef.current?.(null);
      setHint("Deleted");
      scheduleRedraw();
    }

    const onPointerDown = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      downRef.current = { x, y, time: Date.now() };

      // Tapping the on-canvas "×" next to a selected shape deletes it immediately.
      const btn = deleteButtonRef.current;
      if (btn && Math.hypot(btn.x - x, btn.y - y) <= btn.r) {
        deleteShape(btn.id);
        ev.preventDefault();
        return;
      }

      const hit = hitTestDrag(x, y, ev.pointerType === "touch");
      if (hit) {
        dragRef.current = hit;
        el.setPointerCapture(ev.pointerId);
        setHint("Dragging…");
        ev.preventDefault();
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (dragRef.current) {
        dragRef.current = null;
        setHint("Updated · Confirm when ready");
        scheduleRedraw();
        downRef.current = null;
        return;
      }

      const down = downRef.current;
      downRef.current = null;
      if (!down) return;

      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const dt = Date.now() - down.time;
      const dist = Math.hypot(x - down.x, y - down.y);
      const isTap = dt < 500 && dist < 8;

      const tool = drawToolRef.current;

      // Long/Short are single-tap placement tools. Do not depend on
      // marketPrice/marketTime being supplied by the parent.
      if (isTap && (tool === "long" || tool === "short")) {
        const pt = fromXY(x, y);
        if (pt) {
          const side = tool as "long" | "short";
          const levels = defaultsFor(side, orderTypeRef.current, pt.price, pt.time);
          const draft: PositionShape = {
            id: uid(),
            kind: "position",
            side,
            orderType: orderTypeRef.current,
            status: "draft",
            ...levels,
          };
          const kept = shapesRef.current.filter(
            (s) => !(s.kind === "position" && s.status === "draft")
          );
          setShapes([...kept, draft]);
          onSelectedShapeIdRef.current?.(draft.id);
          setHint(`DRAFT ${side.toUpperCase()} · drag SL/TP · then Confirm`);
          scheduleRedraw();
        }
        return;
      }

      // H/V lines are single-click tools.
      if (isTap && (tool === "hline" || tool === "vline")) {
        const pt = fromXY(x, y);
        if (pt) {
          const shape: Shape =
            tool === "hline"
              ? { id: uid(), kind: "hline", price: pt.price }
              : { id: uid(), kind: "vline", time: pt.time };
          setShapes([...shapesRef.current, shape]);
          onSelectedShapeIdRef.current?.(shape.id);
          setHint(tool === "hline" ? "Horizontal line placed" : "Vertical line placed");
          scheduleRedraw();
        }
        return;
      }

      if (isTap) {
        const threshold = ev.pointerType === "touch" ? 18 : 10;
        const hitId = hitTestSelect(x, y, threshold);
        onSelectedShapeIdRef.current?.(hitId);
        scheduleRedraw();
      }

      // Manual double-tap detection: mobile browsers don't fire 'dblclick'
      // reliably from touch, so two-point tools need their own tap-tap gesture.
      if (ev.pointerType === "touch" && isTap) {
        const now = Date.now();
        const prevTap = doubleTapRef.current;
        if (prevTap && now - prevTap.time < 400 && Math.hypot(x - prevTap.x, y - prevTap.y) < 30) {
          doubleTapRef.current = null;
          const tool = drawToolRef.current;
          if (tool === "trendline" || tool === "rectangle" || tool === "measure" || tool === "fib") {
            const pt = fromXY(x, y);
            if (pt) placePoint(pt);
          }
        } else {
          doubleTapRef.current = { x, y, time: now };
        }
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    const onPointer = () => scheduleRedraw();
    el.addEventListener("pointermove", onPointer);
    el.addEventListener("wheel", onPointer, { passive: true });
    el.addEventListener("touchmove", onPointer, { passive: true });

    const onDblClick = (ev: MouseEvent) => {
      ev.preventDefault();
      if (dragRef.current) return;
      const tool = drawToolRef.current;
      if (tool !== "trendline" && tool !== "rectangle" && tool !== "measure" && tool !== "fib") return;
      const pt = crosshairRef.current;
      if (!pt) return;
      placePoint(pt);
    };
    el.addEventListener("dblclick", onDblClick);

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const id = selectedShapeIdRef.current;
      if (!id) return;
      // Positions are only ever removed via the Confirm/Cancel draft flow,
      // never by an accidental keypress — safety-critical, so excluded here.
      const shape = shapesRef.current.find((s) => s.id === id);
      if (!shape || shape.kind === "position") return;
      ev.preventDefault();
      deleteShape(id);
    };
    window.addEventListener("keydown", onKeyDown);

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      scheduleRedraw();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("pointermove", onPointer);
      el.removeEventListener("wheel", onPointer);
      el.removeEventListener("touchmove", onPointer);
      el.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("keydown", onKeyDown);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      handlesRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    // Keep the local tool in sync with a parent-controlled prop, while still
    // allowing the built-in toolbar to change the tool immediately.
    setLocalDrawTool(drawTool);
  }, [drawTool]);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    handles.chart.applyOptions({
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { visible: activeDrawTool !== "none" },
        horzLine: { visible: activeDrawTool !== "none" },
      },
    });
    stepsRef.current = [];
    if (activeDrawTool === "trendline") setHint("Double-click two points (or tap-tap on phone)");
    else if (activeDrawTool === "rectangle") setHint("Double-click two corners (or tap-tap on phone)");
    else if (activeDrawTool === "measure") setHint("Click a point, move, then click again to measure");
    else if (activeDrawTool === "fib") setHint("Double-click two points (or tap-tap on phone)");
    else if (activeDrawTool === "hline") setHint("Click to place horizontal line");
    else if (activeDrawTool === "vline") setHint("Click to place vertical line");
    else if (activeDrawTool === "long" || activeDrawTool === "short") {
      /* hint set in spawnDraft */
    } else setHint("");
    scheduleRedraw();
  }, [activeDrawTool]);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    const visible = bars.slice(0, cursor).map((b) => ({
      ...b,
      time: b.time as UTCTimestamp,
    }));
    handles.candles.setData(visible);
    handles.volume.setData(
      visible.map((b) => ({
        time: b.time,
        value: b.volume ?? 0,
        color: b.close >= b.open ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)",
      }))
    );
    // Do NOT glue candles to the right every tick (TradingView-like free pan).
    // Only follow when user enables Follow mode.
    if (visible.length && followRef.current) {
      handles.chart.timeScale().scrollToRealTime();
    }
    scheduleRedraw();
  }, [bars, cursor, followPrice]);

  useEffect(() => {
    scheduleRedraw();
  }, [shapes, marketPrice]);

  return (
    <div className="chart-wrap" style={{ position: "relative", width: "100%", height: "100%" }}>
      <Toolbar
        tool={drawTool}
        onToolChange={(tool) => {
          // Update locally first so the in-chart toolbar always works, even
          // if the parent callback is delayed or absent.
          setLocalDrawTool(tool);
          onDrawToolChange?.(tool);
        }}
      />
      <div ref={containerRef} className="chart" style={{ width: "100%", height: "100%" }} />
      {/* Purely visual — all pointer/touch handling is attached to the chart
          div above, so the overlay must never intercept events. */}
      <canvas
        ref={overlayRef}
        className="chart-overlay"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", touchAction: "none" }}
      />
      {ohlc && (
        <div
          className="ohlc-box"
          style={{ fontSize: "clamp(10px, 2.6vw, 12px)", padding: "clamp(4px, 1.2vw, 8px) clamp(6px, 1.6vw, 10px)" }}
        >
          <div className="ohlc-time">{ohlc.time}</div>
          <div>
            <span className="k">O</span> {ohlc.open.toFixed(2)}
          </div>
          <div>
            <span className="k">H</span> {ohlc.high.toFixed(2)}
          </div>
          <div>
            <span className="k">L</span> {ohlc.low.toFixed(2)}
          </div>
          <div>
            <span className="k">C</span>{" "}
            <span className={ohlc.close >= ohlc.open ? "up" : "down"}>{ohlc.close.toFixed(2)}</span>
          </div>
        </div>
      )}
      {hint && (
        <div className="draw-hint" style={{ fontSize: "clamp(10px, 2.8vw, 13px)", textAlign: "center" }}>
          {hint}
        </div>
      )}
    </div>
  );
}
