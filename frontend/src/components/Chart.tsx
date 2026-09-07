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
  entry: ChartPoint;
  stop?: ChartPoint;
};

export type Shape = TrendlineShape | RectangleShape | PositionShape;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function Chart({
  bars,
  cursor,
  drawTool = "crosshair",
  shapes,
  onShapesChange,
}: {
  bars: Bar[];
  cursor: number;
  drawTool?: DrawTool;
  shapes: Shape[];
  onShapesChange: (next: Shape[]) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const barsRef = useRef(bars);
  const shapesRef = useRef(shapes);
  const drawToolRef = useRef(drawTool);
  const pendingRef = useRef<ChartPoint | null>(null);
  const [ohlc, setOhlc] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);

  barsRef.current = bars;
  shapesRef.current = shapes;
  drawToolRef.current = drawTool;

  function redrawOverlay() {
    const canvas = overlayRef.current;
    const handles = handlesRef.current;
    if (!canvas || !handles) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
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
        if (!E) continue;
        const color = s.side === "long" ? "#26a69a" : "#ef5350";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, E.y);
        ctx.lineTo(w, E.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = "11px system-ui";
        ctx.fillText(
          `${s.side.toUpperCase()} @ ${s.entry.price.toFixed(2)}`,
          8,
          Math.max(12, E.y - 6)
        );
        if (s.stop) {
          const S = toXY(s.stop);
          if (S) {
            ctx.strokeStyle = "#f59e0b";
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(0, S.y);
            ctx.lineTo(w, S.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = "#f59e0b";
            ctx.fillText(`SL ${s.stop.price.toFixed(2)}`, 8, Math.max(12, S.y - 6));
          }
        }
      }
    }

    // pending first click marker
    const pend = pendingRef.current;
    if (pend) {
      const P = toXY(pend);
      if (P) {
        ctx.fillStyle = "#fbbf24";
        ctx.beginPath();
        ctx.arc(P.x, P.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Create chart once
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
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
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

    const onClick = (param: MouseEventParams) => {
      const tool = drawToolRef.current;
      if (!param.point || param.time == null) return;
      const price = candles.coordinateToPrice(param.point.y);
      if (price == null) return;
      const time =
        typeof param.time === "number"
          ? param.time
          : (param.time as { timestamp?: number }).timestamp ?? 0;
      const point: ChartPoint = { time, price };

      if (tool === "trendline" || tool === "rectangle") {
        if (!pendingRef.current) {
          pendingRef.current = point;
          redrawOverlay();
          return;
        }
        const a = pendingRef.current;
        const b = point;
        pendingRef.current = null;
        if (tool === "trendline") {
          onShapesChange([
            ...shapesRef.current,
            { id: uid(), kind: "trendline", a, b },
          ]);
        } else {
          onShapesChange([
            ...shapesRef.current,
            { id: uid(), kind: "rectangle", a, b },
          ]);
        }
        return;
      }

      if (tool === "long" || tool === "short") {
        if (!pendingRef.current) {
          // first click = entry
          pendingRef.current = point;
          redrawOverlay();
          return;
        }
        // second click = stop loss (optional complete)
        const entry = pendingRef.current;
        const stop = point;
        pendingRef.current = null;
        onShapesChange([
          ...shapesRef.current,
          {
            id: uid(),
            kind: "position",
            side: tool,
            entry,
            stop,
          },
        ]);
      }
    };
    chart.subscribeClick(onClick);

    const onVisible = () => redrawOverlay();
    chart.timeScale().subscribeVisibleTimeRangeChange(onVisible);
    chart.subscribeCrosshairMove(() => redrawOverlay());

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      redrawOverlay();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
      chart.remove();
      handlesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // cancel pending when switching tool
    pendingRef.current = null;
    redrawOverlay();
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
    redrawOverlay();
  }, [bars, cursor]);

  useEffect(() => {
    redrawOverlay();
  }, [shapes]);

  return (
    <div className="chart-wrap" ref={wrapRef}>
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
            <span className={ohlc.close >= ohlc.open ? "up" : "down"}>
              {ohlc.close.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
