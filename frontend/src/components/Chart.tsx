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

export type Shape = TrendlineShape | RectangleShape | PositionShape;

type DragTarget = { id: string; field: "stop" | "takeProfit" | "entry" };

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
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const shapesRef = useRef(shapes);
  const drawToolRef = useRef(drawTool);
  const orderTypeRef = useRef(orderType);
  const marketRef = useRef({ price: marketPrice, time: marketTime });
  const followRef = useRef(followPrice);
  const crosshairRef = useRef<ChartPoint | null>(null);
  const stepsRef = useRef<ChartPoint[]>([]);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<DragTarget | null>(null);
  const onShapesChangeRef = useRef(onShapesChange);
  onShapesChangeRef.current = onShapesChange;

  const [ohlc, setOhlc] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);
  const [hint, setHint] = useState("");

  shapesRef.current = shapes;
  drawToolRef.current = drawTool;
  orderTypeRef.current = orderType;
  marketRef.current = { price: marketPrice, time: marketTime };
  followRef.current = followPrice;

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

  // When user picks Long/Short tool → drop draft on chart
  useEffect(() => {
    if (drawTool === "long" || drawTool === "short") {
      spawnDraft(drawTool);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawTool, orderType]);

  function redrawOverlay() {
    const canvas = overlayRef.current;
    const handles = handlesRef.current;
    if (!canvas || !handles) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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

    const ts = handles.chart.timeScale();
    const series = handles.candles;
    const toXY = (p: ChartPoint) => {
      const x = ts.timeToCoordinate(p.time as UTCTimestamp);
      const y = series.priceToCoordinate(p.price);
      if (x == null || y == null) return null;
      return { x, y };
    };

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
        if (sel) {
          ctx.fillStyle = "#fbbf24";
          ctx.beginPath(); ctx.arc(A.x, A.y, 5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(B.x, B.y, 5, 0, Math.PI * 2); ctx.fill();
        }
      } else if (s.kind === "rectangle") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const x = Math.min(A.x, B.x);
        const y = Math.min(A.y, B.y);
        ctx.fillStyle = "rgba(96, 165, 250, 0.12)";
        ctx.strokeStyle = "#60a5fa";
        ctx.fillRect(x, y, Math.abs(B.x - A.x), Math.abs(B.y - A.y));
        ctx.strokeRect(x, y, Math.abs(B.x - A.x), Math.abs(B.y - A.y));
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
  }

  function placePoint(point: ChartPoint) {
    const tool = drawToolRef.current;
    if (tool !== "trendline" && tool !== "rectangle") return;
    const steps = stepsRef.current;
    if (steps.length === 0) {
      stepsRef.current = [point];
      setHint("Double-click 2nd point");
      scheduleRedraw();
      return;
    }
    const a = steps[0];
    const b = point;
    stepsRef.current = [];
    setShapes([
      ...shapesRef.current,
      tool === "trendline"
        ? { id: uid(), kind: "trendline", a, b }
        : { id: uid(), kind: "rectangle", a, b },
    ]);
    setHint("Done");
  }

  function hitTestDrag(y: number): DragTarget | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    const series = handles.candles;
    const threshold = 12;
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
        const price = candles.coordinateToPrice(param.point.y);
        if (price != null) {
          const d = dragRef.current;
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
    const onPointerDown = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const hit = hitTestDrag(y);
      if (hit) {
        dragRef.current = hit;
        el.setPointerCapture(ev.pointerId);
        setHint("Dragging level…");
        ev.preventDefault();
      }
    };
    const onPointerUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setHint("Level updated · Confirm when ready");
        scheduleRedraw();
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
      if (tool !== "trendline" && tool !== "rectangle") return;
      const pt = crosshairRef.current;
      if (!pt) return;
      placePoint(pt);
    };
    el.addEventListener("dblclick", onDblClick);

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
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      handlesRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    handles.chart.applyOptions({
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { visible: drawTool !== "none" },
        horzLine: { visible: drawTool !== "none" },
      },
    });
    stepsRef.current = [];
    if (drawTool === "trendline") setHint("Double-click two points");
    else if (drawTool === "rectangle") setHint("Double-click two corners");
    else if (drawTool === "long" || drawTool === "short") {
      /* hint set in spawnDraft */
    } else setHint("");
    scheduleRedraw();
  }, [drawTool]);

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
    <div className="chart-wrap">
      <div ref={containerRef} className="chart" />
      <canvas ref={overlayRef} className="chart-overlay" />
      {ohlc && (
        <div className="ohlc-box">
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
      {hint && <div className="draw-hint">{hint}</div>}
    </div>
  );
}
