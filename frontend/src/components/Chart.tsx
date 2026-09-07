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
  entry: ChartPoint;
  stop: ChartPoint;
  takeProfit: ChartPoint;
};

export type Shape = TrendlineShape | RectangleShape | PositionShape;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function riskReward(side: "long" | "short", entry: number, stop: number, tp: number): number | null {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (risk < 1e-12) return null;
  return reward / risk;
}

export function Chart({
  bars,
  cursor,
  drawTool = "crosshair",
  orderType = "market",
  shapes,
  onShapesChange,
}: {
  bars: Bar[];
  cursor: number;
  drawTool?: DrawTool;
  orderType?: OrderType;
  shapes: Shape[];
  onShapesChange: (next: Shape[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const shapesRef = useRef(shapes);
  const drawToolRef = useRef(drawTool);
  const orderTypeRef = useRef(orderType);
  const crosshairRef = useRef<ChartPoint | null>(null);
  const stepsRef = useRef<ChartPoint[]>([]);
  const rafRef = useRef<number | null>(null);
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

  function scheduleRedraw() {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      redrawOverlay();
    });
  }

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
        ctx.strokeStyle = "#60a5fa";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      } else if (s.kind === "rectangle") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const x = Math.min(A.x, B.x);
        const y = Math.min(A.y, B.y);
        const rw = Math.abs(B.x - A.x);
        const rh = Math.abs(B.y - A.y);
        ctx.fillStyle = "rgba(96, 165, 250, 0.12)";
        ctx.strokeStyle = "#60a5fa";
        ctx.lineWidth = 1.2;
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x, y, rw, rh);
      } else if (s.kind === "position") {
        const E = toXY(s.entry);
        const S = toXY(s.stop);
        const T = toXY(s.takeProfit);
        if (!E) continue;
        const long = s.side === "long";
        const entryColor = long ? "#26a69a" : "#ef5350";

        if (S && T) {
          const top = Math.min(E.y, T.y);
          const bot = Math.max(E.y, T.y);
          ctx.fillStyle = long ? "rgba(38,166,154,0.08)" : "rgba(239,83,80,0.08)";
          ctx.fillRect(0, top, w, bot - top);
          const rTop = Math.min(E.y, S.y);
          const rBot = Math.max(E.y, S.y);
          ctx.fillStyle = "rgba(245,158,11,0.10)";
          ctx.fillRect(0, rTop, w, rBot - rTop);
        }

        const drawHLine = (y: number, color: string, dash: number[]) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.setLineDash(dash);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          ctx.setLineDash([]);
        };

        drawHLine(E.y, entryColor, [6, 4]);
        if (S) drawHLine(S.y, "#f59e0b", [4, 4]);
        if (T) drawHLine(T.y, "#38bdf8", [4, 4]);

        ctx.font = "11px system-ui, sans-serif";
        ctx.fillStyle = entryColor;
        const rr = riskReward(s.side, s.entry.price, s.stop.price, s.takeProfit.price);
        const rrText = rr != null ? ` · R:R 1:${rr.toFixed(2)}` : "";
        ctx.fillText(
          `${s.side.toUpperCase()} ${s.orderType} @ ${s.entry.price.toFixed(2)}${rrText}`,
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
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function placePoint(point: ChartPoint) {
    const tool = drawToolRef.current;
    if (tool === "none" || tool === "crosshair") return;
    const steps = stepsRef.current;

    if (tool === "trendline" || tool === "rectangle") {
      if (steps.length === 0) {
        stepsRef.current = [point];
        setHint(tool === "trendline" ? "Double-click 2nd point of trendline" : "Double-click opposite corner");
        scheduleRedraw();
        return;
      }
      const a = steps[0];
      const b = point;
      stepsRef.current = [];
      if (tool === "trendline") {
        onShapesChangeRef.current([...shapesRef.current, { id: uid(), kind: "trendline", a, b }]);
      } else {
        onShapesChangeRef.current([...shapesRef.current, { id: uid(), kind: "rectangle", a, b }]);
      }
      setHint("Done — pick Crosshair to deselect tool, or draw again");
      return;
    }

    if (tool === "long" || tool === "short") {
      if (steps.length === 0) {
        stepsRef.current = [point];
        setHint("Double-click Stop Loss");
        scheduleRedraw();
        return;
      }
      if (steps.length === 1) {
        stepsRef.current = [steps[0], point];
        setHint("Double-click Take Profit");
        scheduleRedraw();
        return;
      }
      const entry = steps[0];
      const stop = steps[1];
      const takeProfit = point;
      stepsRef.current = [];
      onShapesChangeRef.current([
        ...shapesRef.current,
        {
          id: uid(),
          kind: "position",
          side: tool,
          orderType: orderTypeRef.current,
          entry,
          stop,
          takeProfit,
        },
      ]);
      setHint("Position placed — R:R on entry line");
    }
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#080b0f" }, textColor: "#b7c1cf" },
      grid: {
        vertLines: { color: "#17202a" },
        horzLines: { color: "#17202a" },
      },
      timeScale: { timeVisible: true, secondsVisible: true },
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
    const onPointer = () => scheduleRedraw();
    el.addEventListener("pointermove", onPointer);
    el.addEventListener("wheel", onPointer, { passive: true });
    el.addEventListener("touchmove", onPointer, { passive: true });

    const onDblClick = (ev: MouseEvent) => {
      ev.preventDefault();
      const tool = drawToolRef.current;
      if (tool === "none" || tool === "crosshair") return;
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
    if (drawTool === "trendline") setHint("Move crosshair → double-click 1st point");
    else if (drawTool === "rectangle") setHint("Move crosshair → double-click 1st corner");
    else if (drawTool === "long" || drawTool === "short")
      setHint("Move crosshair → double-click ENTRY → SL → TP");
    else setHint("");
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
    if (visible.length) {
      handles.chart.timeScale().scrollToRealTime();
    }
    scheduleRedraw();
  }, [bars, cursor]);

  useEffect(() => {
    scheduleRedraw();
  }, [shapes]);

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
