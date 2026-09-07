import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar } from "../lib/types";

type ChartHandles = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
};

export type DrawTool = "none" | "crosshair" | "trendline" | "rectangle";

export function Chart({
  bars,
  cursor,
  drawTool = "crosshair",
}: {
  bars: Bar[];
  cursor: number;
  drawTool?: DrawTool;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  const drawToolRef = useRef(drawTool);
  drawToolRef.current = drawTool;

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#080b0f" }, textColor: "#b7c1cf" },
      grid: {
        vertLines: { color: "#17202a" },
        horzLines: { color: "#17202a" },
      },
      timeScale: { timeVisible: true, secondsVisible: true },
      // Free-float crosshair (TradingView-like). Magnet snaps to candle OHLC.
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

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      handlesRef.current = null;
    };
  }, []);

  // When tool changes, keep crosshair free (not magnet).
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
  }, [drawTool]);

  // Update visible data whenever bars or the replay cursor change.
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
  }, [bars, cursor]);

  return <div ref={containerRef} className="chart" />;
}
