import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type MouseEventParams,
} from "lightweight-charts";
import type { Bar } from "../lib/types";
import { ema, sma, vwap } from "../lib/indicators";
import {
  type DrawingShape,
  type TrendlineShape,
  type RectangleShape,
  type MeasureShape,
  type FibShape,
  type HLineShape,
  type VLineShape,
  type ChannelShape,
  type TextShape,
  type Pt,
  type HitPart,
  normalizeShape,
  hitTestShape,
  applyDrag as applyDrawingDrag,
  createShape,
  cloneShape,
  bringToFront,
  sendToBack,
  loadToolDefaults,
  saveToolDefaults,
  constrainAnglePx,
  constrainSquarePx,
} from "../lib/drawingModel";
import { drawShape } from "../lib/drawingRender";
import { DrawingSettingsBar } from "./DrawingSettingsBar";
import { PositionSettingsBar } from "./PositionSettingsBar";
import { APP_VERSION } from "../lib/storageVersions";
import {
  normalizePosition,
  draftBoxExtras,
  validatePosition,
  hasErrors,
  prepareConfirm,
  resolveStyle,
  loadPositionDefaults,
  savePositionDefaults,
  buildPositionTexts,
  compactCenter,
  positionBox,
  hitTestPosition,
  applyPositionDrag,
  applyEdit,
  syncDraft,
  type RRLock,
  type PositionRiskInput,
  type PositionStyle,
  type PositionPart,
} from "../lib/positionModel";
import { runPositionBars, manualClose as engineManualClose } from "../lib/positionEngine";
import { runPositionTicks, type TickLike } from "../lib/positionEngineTick";
import { drawPosition } from "../lib/positionRender";
import {
  freezeSizing,
  lotOverrideRisk,
  checkFillLot,
  tickAndDecimals,
  sizingInfo,
  type PositionSizing,
  type SnapLike,
} from "../lib/positionSizing";
import {
  CHART_FUTURE_LOGICAL_BARS,
  CHART_FUTURE_MIN_BARS,
  followVisibleLogicalRange,
  shouldAutoFollowScroll,
  buildFutureWhitespaceTimes,
  futureWhitespaceCount,
} from "../lib/chartTimeScale";

export type IndicatorKind = "sma" | "ema" | "vwap" | "rsi";
export type IndicatorSpec = { id: string; kind: IndicatorKind; period?: number; color: string };

type ChartHandles = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  /** Tick-mode Bid/Ask guides (removed when values unavailable). */
  bidLine: ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null;
  askLine: ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]> | null;
};

export type DrawTool =
  | "none"
  | "crosshair"
  | "trendline"
  | "ray"
  | "extended"
  | "hline"
  | "vline"
  | "rectangle"
  | "fib"
  | "measure"
  | "channel"
  | "text"
  | "long"
  | "short";

/** Re-export drawing geometry types from the shared model (single source of truth). */
export type { TrendlineShape, RectangleShape, MeasureShape, FibShape, HLineShape, VLineShape, ChannelShape, TextShape };
export type ChartPoint = Pt;

export type MagnetMode = "off" | "weak" | "strong";

export type OrderType =
  | "market"
  | "buy_limit"
  | "sell_limit"
  | "buy_stop"
  | "sell_stop"
  | "buy_stop_limit"
  | "sell_stop_limit";

export type PositionShape = {
  id: string;
  kind: "position";
  side: "long" | "short";
  orderType: OrderType;
  /**
   * draft   = user still editing lines
   * pending = confirmed, waiting for entry (or stop-limit stages)
   * open    = filled / live position — only then SL/TP runs
   * closed  = SL/TP/manual done — stays on chart until user deletes the shape
   */
  status: "draft" | "pending" | "open" | "closed";
  /** Set when status becomes closed (execution price). */
  exitPrice?: number;
  exitTime?: number;
  closeReason?: "sl" | "tp" | "manual";
  /** Fill price once open; for simple pending = stop/limit trigger price */
  entry: ChartPoint;
  stop: ChartPoint;
  takeProfit: ChartPoint;
  /** Stop-Limit only: stop trigger level (not the protective SL). */
  stopPrice?: number;
  /** Stop-Limit only: limit price after stop is armed. */
  limitPrice?: number;
  /** Stop-Limit only: true after stop trigger, waiting for limit fill. */
  stopTriggered?: boolean;
  /** Owning account at draft/confirm (v3.17.4) — frozen; not rewritten on switch. */
  accountId?: string;
  /** Frozen at actual fill (v3.16.1). */
  riskSnapshot?: Record<string, unknown>;
  /** Chart PNG at the moment the position became open (entry/confirm). */
  entryScreenshot?: string;
  /** v3.47 TradingView-style box right edge (unix sec). Absent = legacy full-width lines. */
  rightTime?: number;
  anchorTime?: number;
  /** Per-position style overrides (colors, fonts, flags). */
  style?: Partial<PositionStyle>;
  /** Risk inputs frozen on this order at draft time (panel edits later must not change them). */
  risk?: PositionRiskInput;
  /** When true, only selection is allowed — no drag. */
  locked?: boolean;
  /** Brief 01: lot frozen at Confirm (all order types). Moving SL/TP later changes risk$, never this lot. */
  sizing?: PositionSizing;
  /** Brief 02: false = order type chosen by hand (never auto-detected). */
  orderTypeAuto?: boolean;
  /** Brief 02: fixed reward:risk — target follows entry/stop. */
  rrLock?: RRLock;
  /** C5.1: Ask−Bid in price points at entry when both sides known. */
  spreadAtEntry?: number;
  /** Unit label for spreadAtEntry (always price points). */
  spreadUnit?: "price_points";
};


export type ClosedPosition = {
  id: string;
  side: "long" | "short";
  orderType: OrderType;
  entry: ChartPoint;
  stop: ChartPoint;
  takeProfit: ChartPoint;
  exitPrice: number;
  exitTime: number;
  reason: "sl" | "tp" | "manual";
  pnlPoints: number;
  riskSnapshot?: Record<string, unknown>;
  /** PNG data URL captured only on SL/TP/manual close (v3.16.1). */
  screenshot?: string;
  /** Chart PNG captured when the position opened (entry/confirm). */
  entryScreenshot?: string;
  /** C5.1: Ask−Bid at entry when known (price points). */
  spreadAtEntry?: number;
  /** C5.1: Ask−Bid at exit when known (price points). */
  spreadAtExit?: number;
  /** Always "price_points" when spread fields are set. */
  spreadUnit?: "price_points";
};

export type Shape = DrawingShape | PositionShape;

type DragTarget = {
  id: string;
  field:
    | "stop"
    | "takeProfit"
    | "entry"
    | "stopTrigger"
    | "a"
    | "b"
    | "c"
    | "price"
    | "time"
    | "body"
    | "tl"
    | "tr"
    | "bl"
    | "br"
    | "top"
    | "bottom"
    | "left"
    | "right";
  /** Logical anchor at drag start for body moves (time/price deltas). */
  originPoint?: ChartPoint;
  originShape?: Shape;
};

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS: Record<number, string> = {
  0: "#8a97a8",
  0.236: "#2dd4bf",
  0.382: "#60a5fa",
  0.5: "#fbbf24",
  0.618: "#f97316",
  0.786: "#f472b6",
  1: "#8a97a8",
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

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return `rgba(96, 165, 250, ${alpha})`;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function dashForStyle(style?: "solid" | "dashed" | "dotted"): number[] {
  if (style === "dashed") return [8, 6];
  if (style === "dotted") return [2, 4];
  return [];
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
  _orderType: OrderType,
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

/** True when a 1s bar touches a pending entry (simple stop/limit, not stop-limit). */
function pendingEntryTouched(orderType: OrderType, entryPrice: number, hi: number, lo: number): boolean {
  switch (orderType) {
    case "buy_limit":
      return lo <= entryPrice;
    case "sell_limit":
      return hi >= entryPrice;
    case "buy_stop":
      return hi >= entryPrice;
    case "sell_stop":
      return lo <= entryPrice;
    default:
      return false;
  }
}

export function Chart({
  bars,
  cursor,
  drawTool = "crosshair",
  orderType = "market",
  marketPrice = null,
  marketTime = null,
  marketBid = null,
  marketAsk = null,
  replayBar = null,
  /** Ordered 1s bars from previous cursor → current (inclusive of new bar).
   *  When Replay Step > 1s, this may contain many bars; each is evaluated for SL/TP. */
  execBars = null,
  execTicks = null,
  followPrice = false,
  shapes,
  onShapesChange,
  selectedShapeId = null,
  onSelectedShapeId,
  onDrawToolChange,
  onPositionClosed,
  canFillPosition,
  getDraftRisk,
  onRequestConfirm,
  barSeconds = 60,
  tickSize = 0.01,
  captureRiskSnapshot,
  activeAccountId,
  indicators = [],
  magnetMode = "off" as MagnetMode,
}: {
  bars: Bar[];
  cursor: number;
  drawTool?: DrawTool;
  orderType?: OrderType;
  marketPrice?: number | null;
  marketTime?: number | null;
  marketBid?: number | null;
  marketAsk?: number | null;
  /** Exact 1-second bar at the replay cursor. Execution uses this, never the displayed/aggregated timeframe bar. */
  replayBar?: Bar | null;
  /** 1s bars to evaluate for SL/TP this tick (step jumps). Falls back to [replayBar]. */
  execBars?: Bar[] | null;
  /** C2: tick Bid/Ask stream for this step; null keeps 1s bar engine. */
  execTicks?: TickLike[] | null;
  /** If true, keep latest bar near the right edge while playing */
  followPrice?: boolean;
  shapes: Shape[];
  onShapesChange: (next: Shape[]) => void;
  selectedShapeId?: string | null;
  onSelectedShapeId?: (id: string | null) => void;
  /** Parent can reset the active tool (e.g. back to crosshair after placing a line). */
  onDrawToolChange?: (tool: DrawTool) => void;
  onPositionClosed?: (closed: ClosedPosition) => void;
  /** Return false to cancel a pending fill (e.g. prop account blocked). */
  canFillPosition?: (pos: PositionShape, bar: { time: number }) => boolean;
  /** Copy order-panel risk into a new draft so later panel edits do not affect it. */
  getDraftRisk?: () => PositionRiskInput | undefined;
  /** Confirm from the position bar / Enter: parent runs its gate (prop lifecycle) then fires tr-confirm-position. */
  onRequestConfirm?: () => void;
  /** Display timeframe seconds — used for default box width. */
  barSeconds?: number;
  /** Instrument tick size (price step). Drives drag snapping, decimals and tick counts. */
  tickSize?: number;
  /** Build immutable risk snapshot at fill time (v3.16.1). */
  captureRiskSnapshot?: (pos: PositionShape) => Record<string, unknown> | null;
  /** Active account when drafting (stamped onto position; not changed by later switches). */
  activeAccountId?: string | null;
  indicators?: IndicatorSpec[];
  magnetMode?: MagnetMode;
}) {
  const inst = tickAndDecimals(tickSize);
  const instRef = useRef(inst);
  instRef.current = inst;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  /** Track last setData fingerprint for incremental candle updates (v3.23.0). */
  const chartDataMetaRef = useRef<{ len: number; firstTime: number; lastTime: number }>({
    len: 0,
    firstTime: 0,
    lastTime: 0,
  });
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const shapesRef = useRef(shapes);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const drawToolRef = useRef(drawTool);
  const magnetModeRef = useRef(magnetMode);
  magnetModeRef.current = magnetMode;
  const orderTypeRef = useRef(orderType);
  const marketRef = useRef({ price: marketPrice, time: marketTime, bid: marketBid, ask: marketAsk });
  const replayBarRef = useRef<Bar | null>(replayBar);
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
  const onDrawToolChangeRef = useRef(onDrawToolChange);
  onDrawToolChangeRef.current = onDrawToolChange;
  const onPositionClosedRef = useRef(onPositionClosed);
  onPositionClosedRef.current = onPositionClosed;
  const canFillRef = useRef<((s: PositionShape, bar: { time: number }) => boolean) | null>(null);
  canFillRef.current = canFillPosition ?? null;
  const captureRiskSnapshotRef = useRef(captureRiskSnapshot);
  captureRiskSnapshotRef.current = captureRiskSnapshot;
  const activeAccountIdRef = useRef(activeAccountId);
  activeAccountIdRef.current = activeAccountId;
  const getDraftRiskRef = useRef(getDraftRisk);
  getDraftRiskRef.current = getDraftRisk;
  const onRequestConfirmRef = useRef(onRequestConfirm);
  onRequestConfirmRef.current = onRequestConfirm;
  // Screen-space hit area for the on-canvas "×" delete button drawn next to
  // whichever trendline/rectangle/measure shape is currently selected.
  const capturingRef = useRef(false);
  const downRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const doubleTapRef = useRef<{ x: number; y: number; time: number } | null>(null);

  /** P0: OHLC UI via ref + rAF DOM update — avoid React re-render on every crosshair move. */
  type OhlcUi = { time: string; open: number; high: number; low: number; close: number };
  const ohlcLatestRef = useRef<OhlcUi | null>(null);
  const ohlcBoxRef = useRef<HTMLDivElement | null>(null);
  const ohlcTimeRef = useRef<HTMLDivElement | null>(null);
  const ohlcOpenRef = useRef<HTMLSpanElement | null>(null);
  const ohlcHighRef = useRef<HTMLSpanElement | null>(null);
  const ohlcLowRef = useRef<HTMLSpanElement | null>(null);
  const ohlcCloseRef = useRef<HTMLSpanElement | null>(null);
  const ohlcRafRef = useRef<number | null>(null);
  const ohlcPaintKeyRef = useRef<string>("");

  function paintOhlcBox(data: OhlcUi | null) {
    const box = ohlcBoxRef.current;
    if (!box) return;
    if (!data) {
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    if (ohlcTimeRef.current) ohlcTimeRef.current.textContent = data.time;
    if (ohlcOpenRef.current) ohlcOpenRef.current.textContent = data.open.toFixed(2);
    if (ohlcHighRef.current) ohlcHighRef.current.textContent = data.high.toFixed(2);
    if (ohlcLowRef.current) ohlcLowRef.current.textContent = data.low.toFixed(2);
    if (ohlcCloseRef.current) {
      ohlcCloseRef.current.textContent = data.close.toFixed(2);
      ohlcCloseRef.current.className = data.close >= data.open ? "up" : "down";
    }
  }

  function scheduleOhlcUi(data: OhlcUi | null) {
    ohlcLatestRef.current = data;
    if (ohlcRafRef.current != null) return;
    ohlcRafRef.current = requestAnimationFrame(() => {
      ohlcRafRef.current = null;
      const v = ohlcLatestRef.current;
      const key = v
        ? `${v.time}|${v.open}|${v.high}|${v.low}|${v.close}`
        : "";
      if (key === ohlcPaintKeyRef.current) return;
      ohlcPaintKeyRef.current = key;
      paintOhlcBox(v);
    });
  }

  const [hint, setHint] = useState("");

  shapesRef.current = shapes.map((s) =>
    s.kind === "position"
      ? (normalizePosition(s as PositionShape, { barSec: Math.max(1, barsRef.current.length >= 2 ? Math.abs((barsRef.current[1]?.time ?? 0) - (barsRef.current[0]?.time ?? 0)) || 60 : 60) }) as Shape)
      : (normalizeShape(s as DrawingShape) as Shape)
  );
  drawToolRef.current = drawTool;
  orderTypeRef.current = orderType;
  marketRef.current = { price: marketPrice, time: marketTime, bid: marketBid, ask: marketAsk };
  replayBarRef.current = replayBar;
  followRef.current = followPrice;
  selectedShapeIdRef.current = selectedShapeId;

  function scheduleRedraw() {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      redrawOverlay();
    });
  }

  /** P1: coalesce hover hit-testing to one evaluation per animation frame. */
  const hoverHitRafRef = useRef<number | null>(null);
  const hoverPtrRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverCursorRef = useRef<string>("");

  function setShapes(next: Shape[]) {
    onShapesChangeRef.current(next);
  }

  function updatePosition(id: string, patch: Partial<PositionShape>) {
    // Every edit (bar, dialog, order-type chip) goes through applyEdit: R:R lock + draft/market sync.
    const ctx = { market: marketRef.current.price, tick: instRef.current.tick };
    setShapes(
      shapesRef.current.map((s) =>
        s.kind === "position" && s.id === id ? (applyEdit(s as never, patch as never, ctx) as unknown as Shape) : s
      ) as Shape[]
    );
  }

  /** Drop a draft position on the chart immediately (Market or pending). */
  function spawnDraft(side: "long" | "short", at?: { time: number; price: number }) {
    const mPrice = marketRef.current.price;
    const mTime = marketRef.current.time;
    if (mPrice == null || mTime == null) {
      setHint("Load replay data first");
      return;
    }
    // Free placement: click point when provided; otherwise market (legacy fallback).
    const price = at && Number.isFinite(at.price) ? at.price : mPrice;
    const time = at && Number.isFinite(at.time) ? Math.round(at.time) : mTime;

    const panelType = orderTypeRef.current;
    // Honor the order-type chip (limit/stop/stop-limit), not only market / stop-limit.
    const ot: OrderType = (() => {
      const p = panelType;
      if (p === "market") return "market";
      if (side === "long") {
        if (p === "buy_limit" || p === "buy_stop" || p === "buy_stop_limit") return p;
        if (p === "sell_limit") return "buy_limit";
        if (p === "sell_stop") return "buy_stop";
        if (p === "sell_stop_limit") return "buy_stop_limit";
        return "buy_limit";
      }
      if (p === "sell_limit" || p === "sell_stop" || p === "sell_stop_limit") return p;
      if (p === "buy_limit") return "sell_limit";
      if (p === "buy_stop") return "sell_stop";
      if (p === "buy_stop_limit") return "sell_stop_limit";
      return "sell_limit";
    })();
    const manualStopLimit = ot === "buy_stop_limit" || ot === "sell_stop_limit";

    const kept = shapesRef.current.filter((s) => !(s.kind === "position" && s.status === "draft"));
    const levels = defaultsFor(side, ot, price, time);

    // Anchor SL/TP around the click price (not only market), so the box sits where the user clicked.
    const risk = 0.004;
    const reward = 0.008;
    levels.entry = { time, price };
    levels.stop = {
      time,
      price: side === "long" ? price * (1 - risk) : price * (1 + risk),
    };
    levels.takeProfit = {
      time,
      price: side === "long" ? price * (1 + reward) : price * (1 - reward),
    };

    let stopPrice: number | undefined;
    let limitPrice: number | undefined;
    if (ot === "buy_stop_limit") {
      stopPrice = price * 1.003;
      limitPrice = price * 1.001;
      levels.entry = { time, price: limitPrice };
    } else if (ot === "sell_stop_limit") {
      stopPrice = price * 0.997;
      limitPrice = price * 0.999;
      levels.entry = { time, price: limitPrice };
    }

    const barSec = Math.max(
      1,
      barsRef.current.length >= 2
        ? Math.abs((barsRef.current[1]?.time ?? 0) - (barsRef.current[0]?.time ?? 0)) || 60
        : 60
    );
    // Visible finite box: a few bars left of click is not needed — entry at click, extend ~18 bars right.
    const widthBars = 18;

    const draftRisk = (() => {
      const r = getDraftRiskRef.current?.();
      if (!r) return undefined;
      const o: PositionRiskInput = {};
      if (r.mode) o.mode = r.mode;
      if (typeof r.percent === "number" && r.percent > 0) o.percent = r.percent;
      if (typeof r.amount === "number" && r.amount > 0) o.amount = r.amount;
      if (typeof r.lot === "number" && r.lot > 0) o.lot = r.lot;
      return Object.keys(o).length ? o : undefined;
    })();

    const draft: PositionShape = {
      id: uid(),
      kind: "position",
      side,
      orderType: ot,
      status: "draft",
      ...levels,
      anchorTime: levels.entry.time,
      rightTime: levels.entry.time + barSec * widthBars,
      orderTypeAuto: !manualStopLimit,
      ...(draftRisk ? { risk: draftRisk } : {}),
      ...(stopPrice != null ? { stopPrice, limitPrice, stopTriggered: false } : {}),
      ...(activeAccountIdRef.current ? { accountId: activeAccountIdRef.current } : {}),
    };
    setShapes([...kept, draft]);
    onSelectedShapeIdRef.current?.(draft.id);
    // Return to crosshair so pan/zoom works while editing SL/TP on the draft.
    onDrawToolChangeRef.current?.("crosshair");
    setHint(
      ot === "market"
        ? "Box placed · Market entry follows price · drag handles for SL/TP/width · Confirm in bar"
        : `Box placed · ${ot.replace(/_/g, " ")} · drag handles for entry/SL/TP · Confirm in bar`
    );
  }


  /**
   * Capture Entry/SL/TP + candles + drawing overlay as one image.
   * lightweight-charts takeScreenshot() only returns the chart canvas;
   * user drawings live on a separate overlay canvas, so we composite both.
   */
  function capturePositionScreenshot(pos: PositionShape, exitPrice?: number): string | undefined {
    try {
      const handles = handlesRef.current;
      if (!handles?.chart || !handles.candles) return undefined;
      const prices = [pos.entry.price, pos.stop.price, pos.takeProfit.price, exitPrice]
        .filter((x): x is number => x != null && Number.isFinite(x));
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const span = maxP - minP || Math.max(Math.abs(maxP) * 0.002, 1);
      const pad = span * 0.25;
      const ps = handles.candles.priceScale();
      let prevRange: { from: number; to: number } | null = null;
      try {
        prevRange =
          (ps as { getVisibleRange?: () => { from: number; to: number } | null }).getVisibleRange?.() ??
          null;
        (ps as { applyOptions?: (o: object) => void }).applyOptions?.({ autoScale: false });
        (ps as { setVisibleRange?: (r: { from: number; to: number }) => void }).setVisibleRange?.({
          from: minP - pad,
          to: maxP + pad,
        });
      } catch {
        /* scale optional */
      }
      // Synchronous overlay redraw so drawings are painted before capture
      try {
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
      if (ohlcRafRef.current != null) cancelAnimationFrame(ohlcRafRef.current);
      if (hoverHitRafRef.current != null) cancelAnimationFrame(hoverHitRafRef.current);
          rafRef.current = null;
        }
        redrawOverlay();
      } catch {
        /* */
      }
      const shot = handles.chart.takeScreenshot?.() as HTMLCanvasElement | undefined;
      if (!shot || typeof shot.toDataURL !== "function") {
        try {
          if (prevRange) {
            (ps as { setVisibleRange?: (r: { from: number; to: number }) => void }).setVisibleRange?.(
              prevRange
            );
          } else {
            (ps as { applyOptions?: (o: object) => void }).applyOptions?.({ autoScale: true });
          }
        } catch {
          /* */
        }
        return undefined;
      }
      // Composite chart canvas + drawing overlay into one PNG
      const out = document.createElement("canvas");
      out.width = shot.width;
      out.height = shot.height;
      const octx = out.getContext("2d");
      if (!octx) {
        try {
          if (prevRange) {
            (ps as { setVisibleRange?: (r: { from: number; to: number }) => void }).setVisibleRange?.(
              prevRange
            );
          } else {
            (ps as { applyOptions?: (o: object) => void }).applyOptions?.({ autoScale: true });
          }
        } catch {
          /* */
        }
        return shot.toDataURL("image/png");
      }
      octx.drawImage(shot, 0, 0);
      const overlay = overlayRef.current;
      if (overlay && overlay.width > 0 && overlay.height > 0) {
        octx.drawImage(overlay, 0, 0, out.width, out.height);
      }
      const dataUrl = out.toDataURL("image/png");
      try {
        if (prevRange) {
          (ps as { setVisibleRange?: (r: { from: number; to: number }) => void }).setVisibleRange?.(
            prevRange
          );
        } else {
          (ps as { applyOptions?: (o: object) => void }).applyOptions?.({ autoScale: true });
        }
      } catch {
        /* */
      }
      return dataUrl;
    } catch {
      return undefined;
    } finally {
      capturingRef.current = false;
    }
  }

  function confirmDrafts() {
    let n = 0;
    const events: string[] = [];
    const blocked: string[] = [];
    const dec = instRef.current.decimals;
    const market = {
      price: marketRef.current.price,
      time: marketRef.current.time,
      bid: marketRef.current.bid,
      ask: marketRef.current.ask,
    };
    const entrySpread = (() => {
      const b = market.bid;
      const a = market.ask;
      if (b == null || a == null || !Number.isFinite(b) || !Number.isFinite(a) || a < b) return undefined;
      return a - b;
    })();
    const next = shapesRef.current.map((s) => {
      if (s.kind !== "position" || s.status !== "draft") return s;
      // 1) MARKET orders are refreshed to the CURRENT replay price/time (they used to fill at the stale
      //    draft price). Every order is validated (SL/TP side, pending side vs market); invalid = not confirmed.
      const pc = prepareConfirm(s as never, market) as unknown as {
        ok: boolean;
        pos: PositionShape;
        issues: { message: string }[];
      };
      if (!pc.ok) {
        blocked.push(pc.issues[0]?.message || "Invalid order levels");
        return s;
      }
      // Market fills immediately; all pending types wait for entry on 1s bars.
      const nextStatus: PositionShape["status"] = pc.pos.orderType === "market" ? "open" : "pending";
      const ownerId = pc.pos.accountId || activeAccountIdRef.current || undefined;
      const sized: PositionShape = { ...pc.pos, status: nextStatus, ...(ownerId ? { accountId: ownerId } : {}) };
      // 2) Size the order NOW: the lot is frozen at Confirm for every order type (like a live broker).
      const snap = (captureRiskSnapshotRef.current?.(sized) ?? null) as SnapLike | null;
      const fz = freezeSizing(snap, market.time ?? sized.entry.time, (snap?.riskMode as string | undefined) ?? sized.risk?.mode);
      if (fz.blocked) {
        blocked.push(fz.reason || "No valid lot");
        return s;
      }
      n++;
      const entryShot = nextStatus === "open" ? capturePositionScreenshot(sized) : undefined;
      if (nextStatus === "open") {
        events.push(`Filled · ${sized.side.toUpperCase()} market @ ${sized.entry.price.toFixed(dec)}`);
        try {
          window.dispatchEvent(
            new CustomEvent("tr-entry-memo-request", {
              detail: {
                positionId: sized.id,
                side: sized.side,
                orderType: sized.orderType,
                entryPrice: sized.entry.price,
                entryTime: sized.entry.time,
              },
            })
          );
        } catch {
          /* */
        }
      } else {
        events.push(
          `Pending · ${(sized.orderType || "").replace(/_/g, " ")} · ${sized.side.toUpperCase()} @ ${sized.entry.price.toFixed(dec)}`
        );
      }
      return {
        ...sized,
        ...(fz.sizing ? { sizing: fz.sizing } : {}),
        ...(nextStatus === "open" && snap
          ? { riskSnapshot: { ...snap, ...(fz.sizing ? { lotFrozenAtConfirm: true } : {}) } }
          : {}),
        ...(entryShot ? { entryScreenshot: entryShot } : {}),
        ...(nextStatus === "open" && entrySpread != null
          ? { spreadAtEntry: entrySpread, spreadUnit: "price_points" as const }
          : entrySpread != null
            ? { spreadAtEntry: entrySpread, spreadUnit: "price_points" as const }
            : {}),
      } as Shape;
    });
    setShapes(next);
    for (const text of events) {
      window.dispatchEvent(new CustomEvent("tr-workspace-event", { detail: { text } }));
    }
    if (blocked.length) {
      const msg = `Not confirmed · ${blocked[0]}`;
      window.dispatchEvent(new CustomEvent("tr-workspace-event", { detail: { text: msg } }));
      setHint(n ? `Order confirmed (${n}) · ${msg}` : msg);
    } else {
      setHint(n ? `Order confirmed (${n}) · drag right handle to extend width` : "No draft to confirm");
      if (n > 0) onDrawToolChangeRef.current?.("crosshair");
    }
  }

  /** Bar / Enter -> same gate as the old Orders panel (prop lifecycle) when the parent provides it. */
  function requestConfirm() {
    if (onRequestConfirmRef.current) onRequestConfirmRef.current();
    else confirmDrafts();
  }

  /** Manual close at current replay market price — Journal via onPositionClosed. */
  function manualCloseById(id: string) {
    const s = shapesRef.current.find((x) => x.kind === "position" && x.id === id) as
      | PositionShape
      | undefined;
    if (!s || s.status !== "open") return;
    // C3: manual close uses Bid/Ask when available (long → Bid, short → Ask).
    const m = marketRef.current;
    let exitPrice = m.price;
    if (s.side === "long" && m.bid != null && Number.isFinite(m.bid)) exitPrice = m.bid;
    else if (s.side === "short" && m.ask != null && Number.isFinite(m.ask)) exitPrice = m.ask;
    const exitTime = m.time;
    if (exitPrice == null || exitTime == null) {
      setHint("No market price for manual close");
      return;
    }
    const pnlPoints =
      s.side === "long" ? exitPrice - s.entry.price : s.entry.price - exitPrice;
    const screenshot = capturePositionScreenshot(s, exitPrice);
    const exitSpread = (() => {
      const b = m.bid;
      const a = m.ask;
      if (b == null || a == null || !Number.isFinite(b) || !Number.isFinite(a) || a < b) return undefined;
      return a - b;
    })();
    const closed: ClosedPosition = {
      id: s.id,
      side: s.side,
      orderType: s.orderType,
      entry: s.entry,
      stop: s.stop,
      takeProfit: s.takeProfit,
      exitPrice,
      exitTime,
      reason: "manual",
      pnlPoints,
      riskSnapshot: s.riskSnapshot,
      screenshot,
      entryScreenshot: s.entryScreenshot,
      ...(s.spreadAtEntry != null ? { spreadAtEntry: s.spreadAtEntry } : {}),
      ...(exitSpread != null ? { spreadAtExit: exitSpread, spreadUnit: "price_points" as const } : {}),
    };
    const kept: PositionShape = {
      ...s,
      status: "closed",
      exitPrice,
      exitTime,
      closeReason: "manual",
      locked: true,
    };
    const next = shapesRef.current.map((x) => (x.id === id ? kept : x));
    shapesRef.current = next;
    setShapes(next);
    onPositionClosedRef.current?.(closed);
    scheduleRedraw();
    window.dispatchEvent(
      new CustomEvent("tr-workspace-event", {
        detail: {
          text: `Manual close · ${s.side.toUpperCase()} @ ${exitPrice.toFixed(2)} · ${pnlPoints >= 0 ? "+" : ""}${pnlPoints.toFixed(1)} pts`,
        },
      })
    );
    setHint(`Manual close @ ${exitPrice.toFixed(2)}`);
  }

  function cancelDrafts() {
    setShapes(shapesRef.current.filter((s) => !(s.kind === "position" && s.status === "draft")));
    setHint("Draft cancelled");
  }

  // Expose confirm via custom events from parent buttons
  // Brief 02: drafts follow the market. A market draft's entry tracks the replay price (SL/TP keep their
  // absolute prices, R:R lock recomputes TP); auto drafts re-detect Limit/Stop as the market moves.
  useEffect(() => {
    if (marketPrice == null) return;
    const cur = shapesRef.current;
    let changed = false;
    const next = cur.map((s) => {
      if (s.kind !== "position" || s.status !== "draft") return s;
      const n = syncDraft(s as never, { market: marketPrice, tick: instRef.current.tick }) as unknown as PositionShape;
      if (n !== (s as unknown as PositionShape)) changed = true;
      return n as Shape;
    });
    if (changed) onShapesChangeRef.current(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketPrice, marketTime]);

  useEffect(() => {
    const onConfirm = () => confirmDrafts();
    const onCancel = () => cancelDrafts();
    const onManual = (ev: Event) => {
      const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
      if (id) manualCloseById(id);
    };
    window.addEventListener("tr-confirm-position", onConfirm);
    window.addEventListener("tr-cancel-draft", onCancel);
    window.addEventListener("tr-manual-close", onManual);
    return () => {
      window.removeEventListener("tr-confirm-position", onConfirm);
      window.removeEventListener("tr-cancel-draft", onCancel);
      window.removeEventListener("tr-manual-close", onManual);
    };
  }, []);

  // Long/Short: do NOT auto-place. User clicks the chart to drop the box (tool-like).
  useEffect(() => {
    if (drawTool === "long" || drawTool === "short") {
      setHint(
        drawTool === "long"
          ? "Long tool · click anywhere on the chart to place the box · then set SL/TP · Confirm"
          : "Short tool · click anywhere on the chart to place the box · then set SL/TP · Confirm"
      );
    }
  }, [drawTool]);

  /** Chart-space point → screen (canvas) pixel coordinates. */
  /**
   * Logical continuous mapping (v3.16.2).
   * Price is continuous via series.coordinateToPrice — any Y on the scale.
   * Time is continuous via coordinateToLogical + interpolation between bars,
   * so drawings are NOT limited to candle OHLC times.
   */
  function timeToLogicalIndex(time: number): number | null {
    const data = barsRef.current;
    if (!data.length) return null;
    if (time <= data[0].time) {
      const dt = data.length > 1 ? data[1].time - data[0].time : 1;
      return (time - data[0].time) / Math.max(1, dt);
    }
    if (time >= data[data.length - 1].time) {
      const n = data.length - 1;
      const dt = n > 0 ? data[n].time - data[n - 1].time : 1;
      return n + (time - data[n].time) / Math.max(1, dt);
    }
    // binary search
    let lo = 0, hi = data.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid].time <= time) lo = mid;
      else hi = mid;
    }
    const t0 = data[lo].time;
    const t1 = data[hi].time;
    const frac = t1 === t0 ? 0 : (time - t0) / (t1 - t0);
    return lo + frac;
  }

  function logicalIndexToTime(logical: number): number | null {
    const data = barsRef.current;
    if (!data.length) return null;
    if (logical <= 0) {
      const dt = data.length > 1 ? data[1].time - data[0].time : 1;
      return data[0].time + logical * Math.max(1, dt);
    }
    if (logical >= data.length - 1) {
      const n = data.length - 1;
      const dt = n > 0 ? data[n].time - data[n - 1].time : 1;
      return data[n].time + (logical - n) * Math.max(1, dt);
    }
    const i0 = Math.floor(logical);
    const i1 = Math.min(data.length - 1, i0 + 1);
    const frac = logical - i0;
    return data[i0].time + (data[i1].time - data[i0].time) * frac;
  }

  function toXY(p: ChartPoint): { x: number; y: number } | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    let x = handles.chart.timeScale().timeToCoordinate(p.time as UTCTimestamp);
    // Fallback: continuous logical → coordinate when time is between/outside bars
    if (x == null) {
      const logical = timeToLogicalIndex(p.time);
      if (logical != null) {
        x = handles.chart.timeScale().logicalToCoordinate(logical as any);
      }
    }
    const y = handles.candles.priceToCoordinate(p.price);
    if (x == null || y == null) return null;
    return { x, y };
  }

  /** Time → canvas X with logical extrapolation past the last bar (needed for position rightTime in the future). */
  function timeToX(time: number): number | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    let x = handles.chart.timeScale().timeToCoordinate(time as UTCTimestamp);
    if (x == null || !Number.isFinite(x)) {
      const logical = timeToLogicalIndex(time);
      if (logical != null) {
        x = handles.chart.timeScale().logicalToCoordinate(logical as any);
      }
    }
    if (x == null || !Number.isFinite(x)) return null;
    return x;
  }

  /** Screen pixel → continuous { time, price }. Never requires a candle at that price. */
  function fromXY(x: number, y: number): ChartPoint | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    const price = handles.candles.coordinateToPrice(y);
    if (price == null) return null;

    // Continuous time via logical index (works for any visible X, not only bar centers)
    const logical = handles.chart.timeScale().coordinateToLogical(x);
    let time: number | null = null;
    if (logical != null && Number.isFinite(logical as number)) {
      time = logicalIndexToTime(logical as number);
    }
    if (time == null) {
      const t = handles.chart.timeScale().coordinateToTime(x);
      if (t != null) time = Number(t);
    }
    if (time == null) return null;
    return { time, price: Number(price) };
  }

  function applyMagnet(point: ChartPoint, mode: MagnetMode): ChartPoint {
    if (mode === "off") return point;
    const data = barsRef.current;
    if (!data.length) return point;
    // Find nearest bar by time
    let best = data[0];
    let bestDt = Math.abs(data[0].time - point.time);
    for (let i = 1; i < data.length; i++) {
      const dt = Math.abs(data[i].time - point.time);
      if (dt < bestDt) {
        bestDt = dt;
        best = data[i];
      }
    }
    const ohlc = [best.open, best.high, best.low, best.close];
    let nearestPrice = ohlc[0];
    let bestDp = Math.abs(ohlc[0] - point.price);
    for (const v of ohlc) {
      const dp = Math.abs(v - point.price);
      if (dp < bestDp) {
        bestDp = dp;
        nearestPrice = v;
      }
    }
    const thresh = mode === "strong" ? 1e12 : Math.abs(best.high - best.low) * 0.35 + 1e-9;
    // weak: only snap if close; strong: always snap to nearest OHLC
    if (mode === "strong" || bestDp <= thresh) {
      return { time: best.time, price: nearestPrice };
    }
    return point;
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
      if ("visible" in s && s.visible === false) continue;
      ctx.setLineDash([]);
      // Professional drawing engine (trend/rect/measure/fib/channel/text)
      if (s.kind !== "position" && s.kind !== "hline" && s.kind !== "vline") {
        const barSec =
          barsRef.current.length >= 2
            ? Math.max(1, (barsRef.current[1]?.time ?? 0) - (barsRef.current[0]?.time ?? 0))
            : 60;
        if (
          drawShape(ctx, s as DrawingShape, {
            project: toXY,
            bounds: { w, h },
            selected: selectedShapeIdRef.current === s.id,
            priceDecimals: instRef.current.decimals,
            barSec,
          })
        ) {
          continue;
        }
      }
      if (s.kind === "trendline" || s.kind === "ray" || s.kind === "extended") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : (s.color || "#60a5fa");
        ctx.lineWidth = sel ? 2.5 : (s.lineWidth || 1.5);
        ctx.setLineDash(dashForStyle(s.lineStyle));
        // Extend ray/extended beyond anchors in screen space
        let x0 = A.x, y0 = A.y, x1 = B.x, y1 = B.y;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const BIG = 5000;
        if (s.kind === "ray") {
          x1 = x0 + ux * BIG;
          y1 = y0 + uy * BIG;
        } else if (s.kind === "extended") {
          x0 = A.x - ux * BIG;
          y0 = A.y - uy * BIG;
          x1 = A.x + ux * BIG;
          y1 = A.y + uy * BIG;
        }
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : (s.color || "#60a5fa");
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
        if (sel) {
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
        const base = s.color || "#60a5fa";
        const fo = typeof s.fillOpacity === "number" ? s.fillOpacity : 0.12;
        ctx.fillStyle = sel ? "rgba(251, 191, 36, 0.14)" : hexToRgba(base, fo);
        ctx.strokeStyle = sel ? "#fbbf24" : base;
        ctx.lineWidth = sel ? 2 : (s.lineWidth || 1.5);
        ctx.setLineDash(dashForStyle(s.lineStyle));
        ctx.fillRect(x, y, rw, rh);
        ctx.strokeRect(x, y, rw, rh);
        ctx.setLineDash([]);
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : base;
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
        if (sel) {
        }
      } else if (s.kind === "measure") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        const base = s.color || "#c084fc";
        ctx.strokeStyle = sel ? "#fbbf24" : base;
        ctx.lineWidth = sel ? 2.5 : (s.lineWidth || 1.5);
        ctx.setLineDash(s.lineStyle ? dashForStyle(s.lineStyle) : [6, 4]);
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : base;
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
        drawMeasureLabel(ctx, s.a, s.b, A, B, sel ? "#fbbf24" : base);
        if (sel) {
        }
      } else if (s.kind === "hline") {
        const yy = handlesRef.current!.candles.priceToCoordinate(s.price);
        if (yy == null) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : (s.color || "#34d399");
        ctx.lineWidth = sel ? 2.5 : (s.lineWidth || 1.5);
        ctx.setLineDash(s.lineStyle ? dashForStyle(s.lineStyle) : [2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        drawLabel(ctx, 6, yy - 6, s.price.toFixed(2), sel ? "#fbbf24" : "#34d399");
      } else if (s.kind === "vline") {
        const xx = handlesRef.current!.chart.timeScale().timeToCoordinate(s.time as UTCTimestamp);
        if (xx == null) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        ctx.strokeStyle = sel ? "#fbbf24" : "#a78bfa";
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, h);
        ctx.stroke();
        ctx.setLineDash([]);
        drawLabel(ctx, xx + 6, 16, new Date(s.time * 1000).toLocaleTimeString(), sel ? "#fbbf24" : "#a78bfa");
      } else if (s.kind === "fib") {
        const A = toXY(s.a);
        const B = toXY(s.b);
        if (!A || !B) continue;
        const sel = selectedShapeIdRef?.current === s.id;
        const minX = Math.min(A.x, B.x);
        const maxX = Math.max(A.x, B.x);
        const priceAt = (level: number) => s.b.price + (s.a.price - s.b.price) * level;
        for (let i = 0; i < FIB_LEVELS.length - 1; i++) {
          const l0 = FIB_LEVELS[i];
          const l1 = FIB_LEVELS[i + 1];
          const y0 = handlesRef.current!.candles.priceToCoordinate(priceAt(l0));
          const y1 = handlesRef.current!.candles.priceToCoordinate(priceAt(l1));
          if (y0 == null || y1 == null) continue;
          ctx.fillStyle = FIB_COLORS[l0] + "18";
          ctx.fillRect(minX, Math.min(y0, y1), maxX - minX, Math.abs(y1 - y0));
        }
        for (const level of FIB_LEVELS) {
          const y = handlesRef.current!.candles.priceToCoordinate(priceAt(level));
          if (y == null) continue;
          const color = sel ? "#fbbf24" : FIB_COLORS[level];
          ctx.strokeStyle = color;
          ctx.lineWidth = level === 0 || level === 1 ? 1.5 : 1;
          ctx.beginPath();
          ctx.moveTo(minX, y);
          ctx.lineTo(maxX, y);
          ctx.stroke();
          drawLabel(ctx, maxX + 6, y, `${(level * 100).toFixed(1)}% · ${priceAt(level).toFixed(2)}`, color);
        }
        const r = sel ? 6 : 4;
        ctx.fillStyle = sel ? "#fbbf24" : "#60a5fa";
        ctx.beginPath(); ctx.arc(A.x, A.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(B.x, B.y, r, 0, Math.PI * 2); ctx.fill();
      } else if (s.kind === "position") {
        // v3.47 — single painter (positionRender). Old full-width line branch removed.
        const handles = handlesRef.current;
        if (!handles) continue;
        const toY = (price: number) => {
          const y = handles.candles.priceToCoordinate(price);
          return y == null || !Number.isFinite(y) ? null : y;
        };
        const box = positionBox(s as never, {
          xOf: (tm: number) => timeToX(tm),
          yOf: (pr: number) => toY(pr),
          w,
        });
        if (!box) continue;
        // One source of truth for the numbers (draft = live; pending/open = confirmed lot, risk from current SL/TP).
        const si = sizingInfo(
          s as PositionShape,
          captureRiskSnapshotRef.current?.(s as PositionShape) as never,
          marketRef.current.price
        );
        let openPnL: number | null = si.openPnL;
        if (openPnL == null && s.status === "open" && marketRef.current.price != null) {
          const px = marketRef.current.price;
          openPnL = s.side === "long" ? px - s.entry.price : s.entry.price - px; // legacy position without a known lot: points
        }
        const priceDecimals = instRef.current.decimals;
        const ctxT = {
          priceDecimals,
          tick: instRef.current.tick,
          lot: si.lot,
          riskAmount: si.riskAmount,
          rewardAmount: si.rewardAmount,
          openPnL,
        };
        const issues = validatePosition(s as never, marketRef.current.price);
        const isStopLimit =
          s.orderType === "buy_stop_limit" || s.orderType === "sell_stop_limit";
        drawPosition(ctx, s as never, {
          box,
          w,
          h,
          style: resolveStyle(s as never, loadPositionDefaults()),
          texts: buildPositionTexts(s as never, ctxT),
          compactCenter: compactCenter(s as never, ctxT),
          selected: selectedShapeIdRef.current === s.id,
          warning: hasErrors(issues) ? issues[0].message : null,
          stopTriggerY:
            isStopLimit && s.status !== "open" && s.stopPrice != null
              ? toY(s.stopPrice)
              : null,
          limitY:
            isStopLimit && s.status !== "open" && s.limitPrice != null
              ? toY(s.limitPrice)
              : null,
          priceDecimals,
          forScreenshot: capturingRef.current,
        });
      }
    }
    // Live placement preview: same engine as finished drawings (TradingView-style).
    if (stepsRef.current.length === 1 && crosshairRef.current) {
      const tool = drawToolRef.current;
      const a = stepsRef.current[0]!;
      const b = crosshairRef.current;
      const barSec =
        barsRef.current.length >= 2
          ? Math.max(1, (barsRef.current[1]?.time ?? 0) - (barsRef.current[0]?.time ?? 0))
          : 60;
      const previewEnv = {
        project: toXY,
        bounds: { w, h },
        selected: true,
        priceDecimals: instRef.current.decimals,
        barSec,
      };
      if (tool === "measure") {
        drawShape(ctx, { id: "__preview__", kind: "measure", a, b } as DrawingShape, previewEnv);
      } else if (tool === "rectangle") {
        drawShape(ctx, { id: "__preview__", kind: "rectangle", a, b } as DrawingShape, previewEnv);
      } else if (tool === "trendline" || tool === "ray" || tool === "extended") {
        drawShape(
          ctx,
          {
            id: "__preview__",
            kind: tool,
            a,
            b,
            extendRight: tool === "ray" || tool === "extended",
            extendLeft: tool === "extended",
          } as DrawingShape,
          previewEnv
        );
      } else if (tool === "fib") {
        drawShape(ctx, { id: "__preview__", kind: "fib", a, b } as DrawingShape, previewEnv);
      } else if (tool === "channel") {
        // 2-point preview: third point offset until final click
        const c = { time: a.time, price: a.price + (b.price - a.price) * 0.25 };
        drawShape(ctx, { id: "__preview__", kind: "channel", a, b, c } as DrawingShape, previewEnv);
      }
    } else if (stepsRef.current.length >= 1) {
      const P = toXY(stepsRef.current[0]!);
      if (P) {
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#2962FF";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(P.x, P.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
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

  function placePoint(raw: ChartPoint) {
    const tool = drawToolRef.current;
    if (
      tool !== "trendline" &&
      tool !== "ray" &&
      tool !== "extended" &&
      tool !== "rectangle" &&
      tool !== "measure" &&
      tool !== "fib" &&
      tool !== "channel" &&
      tool !== "text" &&
      tool !== "long" &&
      tool !== "short"
    )
      return;
    const point = applyMagnet(raw, magnetModeRef.current);
    const steps = stepsRef.current;

    // Long/Short position box: single click places a draft at the free chart coordinate.
    if (tool === "long" || tool === "short") {
      spawnDraft(tool, point);
      return;
    }

    // Text: single click
    if (tool === "text") {
      const defaults = loadToolDefaults("text");
      // Always place a visible box; empty saved defaults must not hide the shape.
      const initialText =
        typeof (defaults as { text?: string }).text === "string" &&
        (defaults as { text?: string }).text!.trim()
          ? (defaults as { text: string }).text.trim()
          : "Text";
      const shape = createShape("text", { a: point }, uid(), {
        ...defaults,
        text: initialText,
        fillOpacity:
          typeof (defaults as { fillOpacity?: number }).fillOpacity === "number"
            ? Math.max(0.45, (defaults as { fillOpacity: number }).fillOpacity)
            : 0.85,
      }) as Shape;
      setShapes([...shapesRef.current, shape]);
      onSelectedShapeIdRef.current?.(shape.id);
      onDrawToolChangeRef.current?.("crosshair");
      setHint("Text placed · edit text in the settings bar");
      return;
    }

    // Channel needs 3 points
    if (tool === "channel") {
      if (steps.length === 0) {
        stepsRef.current = [point];
        setHint("Channel: point A set · click B on baseline");
        scheduleRedraw();
        return;
      }
      if (steps.length === 1) {
        stepsRef.current = [steps[0], point];
        setHint("Channel: baseline set · click C for width");
        scheduleRedraw();
        return;
      }
      const a = steps[0], b = steps[1], c = point;
      stepsRef.current = [];
      const defaults = loadToolDefaults("channel");
      const shape = createShape("channel", { a, b, c }, uid(), defaults) as Shape;
      setShapes([...shapesRef.current, shape]);
      onSelectedShapeIdRef.current?.(shape.id);
      onDrawToolChangeRef.current?.("crosshair");
      setHint("Channel placed");
      return;
    }

    if (steps.length === 0) {
      stepsRef.current = [point];
      setHint(
        tool === "measure"
          ? "Move cursor, then click 2nd point"
          : "Point A set · move cursor for live preview · click Point B"
      );
      scheduleRedraw();
      return;
    }
    const a = steps[0];
    const b = point;
    stepsRef.current = [];
    const kind =
      tool === "ray" || tool === "extended" || tool === "trendline"
        ? tool
        : tool === "rectangle"
        ? "rectangle"
        : tool === "fib"
        ? "fib"
        : "measure";
    const defaults = loadToolDefaults(kind as "trendline" | "ray" | "extended" | "rectangle" | "fib" | "measure");
    const extra =
      tool === "ray"
        ? { extendRight: true, extendLeft: false }
        : tool === "extended"
        ? { extendRight: true, extendLeft: true }
        : {};
    const shape = createShape(kind as "trendline", { a, b }, uid(), { ...defaults, ...extra }) as Shape;
    // keep ray/extended kind for compatibility when tool was ray/extended
    if (tool === "ray" || tool === "extended") {
      (shape as TrendlineShape).kind = tool;
    }
    setShapes([...shapesRef.current, shape]);
    onSelectedShapeIdRef.current?.(shape.id);
    onDrawToolChangeRef.current?.("crosshair");
    setHint("Done · select to move · Delete key or settings bar to remove");
  }

  function resizeCursorForPart(part: string | undefined): string {
    switch (part) {
      case "tl":
      case "br":
        return "nwse-resize";
      case "tr":
      case "bl":
        return "nesw-resize";
      case "top":
      case "bottom":
        return "ns-resize";
      case "left":
      case "right":
        return "ew-resize";
      case "a":
      case "b":
      case "c":
        return "move";
      case "body":
        return "move";
      default:
        return "";
    }
  }

    function hitTestDrag(x: number, y: number, touch: boolean): DragTarget | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    const series = handles.candles;
    // Horizontal SL/TP/hline need a taller Y band; touch needs even more.
    const pointThreshold = touch ? 22 : 14;
    const lineThreshold = touch ? 24 : 16;
    const w = elWidth();

    const canEdit = (s: Shape) => {
      if ("visible" in s && s.visible === false) return false;
      if ("locked" in s && s.locked) return false;
      return true;
    };

    // Professional drawings: top-most first; unselected → body only; locked → select only (caller skips drag).
    {
      const wBox = elWidth();
      const hBox = containerRef.current?.clientHeight ?? 0;
      const list = [...shapesRef.current].reverse();
      for (const s of list) {
        if (s.kind === "position" || s.kind === "hline" || s.kind === "vline") continue;
        if ("visible" in s && s.visible === false) continue;
        const hit = hitTestShape(s as DrawingShape, toXY, x, y, {
          handleTol: pointThreshold,
          lineTol: lineThreshold,
          bounds: { w: wBox, h: hBox },
          selected: selectedShapeIdRef.current === s.id,
        });
        if (!hit) continue;
        const originPoint = fromXY(x, y) || undefined;
        return {
          id: s.id,
          field: hit.part as DragTarget["field"],
          originPoint,
          originShape: JSON.parse(JSON.stringify(s)) as Shape,
        };
      }
    }

    for (const s of shapesRef.current) {
      if (!canEdit(s)) continue;
      if (s.kind === "hline") {
        const yy = series.priceToCoordinate(s.price);
        if (yy != null && Math.abs(yy - y) <= lineThreshold) return { id: s.id, field: "price" };
      } else if (s.kind === "vline") {
        const xx = handles.chart.timeScale().timeToCoordinate(s.time as UTCTimestamp);
        if (xx != null && Math.abs(xx - x) <= lineThreshold) return { id: s.id, field: "time" };
      }
    }

    // Positions: box-local hit test (TradingView-style finite width).
    for (const s of shapesRef.current) {
      if (s.kind !== "position") continue;
      const barSec =
        barsRef.current.length >= 2
          ? Math.abs((barsRef.current[1]?.time ?? 0) - (barsRef.current[0]?.time ?? 0)) || 60
          : 60;
      const pos = normalizePosition(s as PositionShape, { barSec });
      const box = positionBox(pos as never, {
        xOf: (tm: number) => timeToX(tm),
        yOf: (pr: number) => {
          const yy = series.priceToCoordinate(pr);
          return yy == null || !Number.isFinite(yy) ? null : yy;
        },
        w,
      });
      if (!box) continue;

      // Stop-Limit trigger line (stopPrice)
      const isStopLimit =
        s.orderType === "buy_stop_limit" || s.orderType === "sell_stop_limit";
      if (
        isStopLimit &&
        (s.status === "draft" || s.status === "pending") &&
        s.stopPrice != null
      ) {
        const sty = series.priceToCoordinate(s.stopPrice);
        if (
          sty != null &&
          x >= box.x0 - lineThreshold &&
          x <= box.x1 + lineThreshold &&
          Math.abs(sty - y) <= lineThreshold + 4
        ) {
          return { id: s.id, field: "stopTrigger" };
        }
      }

      const part = hitTestPosition(pos as never, box, x, y, {
        tol: Math.max(12, lineThreshold + 4),
        selected: selectedShapeIdRef.current === s.id || s.status === "draft",
      });
      if (!part) continue;
      // CRITICAL: originPoint + originShape must be captured at pointer-down.
      // Body/entry drag uses deltas from origin; without them the box never moves.
      const originPoint = fromXY(x, y) || undefined;
      const originShape = JSON.parse(JSON.stringify(pos)) as Shape;
      const drag = (field: DragTarget["field"]): DragTarget => ({
        id: s.id,
        field,
        originPoint,
        originShape,
      });
      // Map 9-handle parts directly into drag fields
      if (part === "stop" || part === "takeProfit" || part === "tl" || part === "tr" || part === "bl" || part === "br") {
        if (s.status === "draft" || s.status === "open" || s.status === "pending") {
          return drag(part);
        }
        continue;
      }
      if (part === "entry" || part === "left" || part === "right" || part === "body") {
        if (s.status === "draft" || s.status === "pending") {
          return drag(part === "entry" ? "entry" : part);
        }
        // Open: body still moves SL/TP vertically; right still resizes width.
        if (s.status === "open" && (part === "body" || part === "right" || part === "entry")) {
          return drag(part === "entry" ? "body" : part);
        }
      }
    }
    return null;
  }

  function elWidth(): number {
    return containerRef.current?.clientWidth ?? 0;
  }

  /** Apply an in-progress drag from client-relative chart coordinates. */
  function applyDragAt(x: number, y: number) {
    const d = dragRef.current;
    const handles = handlesRef.current;
    if (!d || !handles) return;
    const { candles } = handles;

    // Drawing-engine drag (body / endpoints / rectangle handles / channel C)
    const drawingParts = new Set([
      "body", "a", "b", "c", "tl", "tr", "bl", "br", "top", "bottom", "left", "right",
    ]);
    if (drawingParts.has(d.field) && d.originShape && d.originShape.kind !== "position" && d.originShape.kind !== "hline" && d.originShape.kind !== "vline") {
      let cur = fromXY(x, y);
      if (!cur) return;
      // Shift-constrain for lines/rects when originPoint exists
      if (d.originPoint && (d.field === "b" || d.field === "a")) {
        const A = toXY(
          d.field === "b"
            ? (d.originShape as { a: ChartPoint }).a
            : (d.originShape as { b: ChartPoint }).b
        );
        const P = toXY(cur);
        if (A && P && typeof window !== "undefined") {
          // shift key tracked via drag - optional: skip if no shift state
        }
      }
      const origin = {
        point: d.originPoint || cur,
        shape: d.originShape as DrawingShape,
      };
      const next = applyDrawingDrag(
        d.originShape as DrawingShape,
        d.field as HitPart,
        cur,
        origin
      );
      setShapes(shapesRef.current.map((s) => (s.id === d.id ? (next as Shape) : s)));
      return;
    }
    if (d.field === "price") {
      const price = candles.coordinateToPrice(y);
      if (price == null) return;
      setShapes(
        shapesRef.current.map((s) => (s.id === d.id && s.kind === "hline" ? { ...s, price } : s))
      );
      return;
    }
    if (d.field === "time") {
      const newPoint = fromXY(x, y);
      if (!newPoint) return;
      setShapes(
        shapesRef.current.map((s) =>
          s.id === d.id && s.kind === "vline" ? { ...s, time: newPoint.time } : s
        )
      );
      return;
    }
    const s = shapesRef.current.find((x) => x.kind === "position" && x.id === d.id) as
      | PositionShape
      | undefined;
    if (!s) return;
    if (s.locked) return;
    const pt = fromXY(x, y);
    if (!pt) {
      const price = candles.coordinateToPrice(y);
      if (price == null) return;
      // Fallback price-only drag for legacy fields
      if (d.field === "stop") updatePosition(d.id, { stop: { ...s.stop, price } });
      else if (d.field === "takeProfit") updatePosition(d.id, { takeProfit: { ...s.takeProfit, price } });
      else if (d.field === "stopTrigger") updatePosition(d.id, { stopPrice: price });
      else if (d.field === "entry") {
        const patch: Partial<PositionShape> = { entry: { ...s.entry, price } };
        if (s.orderType === "buy_stop_limit" || s.orderType === "sell_stop_limit") patch.limitPrice = price;
        updatePosition(d.id, patch);
      }
      return;
    }
    const part = d.field as PositionPart;
    const origin = {
      pt: d.originPoint || pt,
      pos: (d.originShape as PositionShape) || s,
    };
    const next = applyPositionDrag(s as never, part, pt, origin as never, {
      tick: instRef.current.tick,
      market: marketRef.current.price,
      barSec: Math.max(1, barSeconds || 60),
    });
    // After a hand drag of the entry/box the order type is re-detected (market <-> limit/stop).
    const synced = syncDraft(next as never, {
      market: marketRef.current.price,
      tick: instRef.current.tick,
      userMovedEntry: part === "entry" || part === "body" || part === "left" || part === "tl" || part === "bl",
    });
    setShapes(shapesRef.current.map((x) => (x.id === d.id ? (synced as unknown as Shape) : x)));
  }

  function setChartInteraction(enabled: boolean) {
    const chart = handlesRef.current?.chart;
    if (!chart) return;
    chart.applyOptions({
      handleScroll: enabled
        ? { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true }
        : { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
      handleScale: enabled
        ? { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
        : { axisPressedMouseMove: false, mouseWheel: false, pinch: false },
    });
  }

  /** Selection hit-test — deliberately excludes positions (order/SL/TP levels
   *  stay managed only via the Confirm/Cancel draft flow, never keyboard-deleted). */
  function hitTestSelect(x: number, y: number, threshold: number): string | null {
    const handles = handlesRef.current;
    if (!handles) return null;
    for (const s of shapesRef.current) {
      if (s.kind === "trendline" || s.kind === "ray" || s.kind === "extended" || s.kind === "measure" || s.kind === "fib") {
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
        const yy = handles.candles.priceToCoordinate(s.price);
        if (yy != null && Math.abs(yy - y) <= threshold) return s.id;
      } else if (s.kind === "vline") {
        const xx = handles.chart.timeScale().timeToCoordinate(s.time as UTCTimestamp);
        if (xx != null && Math.abs(xx - x) <= threshold) return s.id;
      } else if (s.kind === "position") {
        // Select position by clicking entry/SL/TP band so PositionSettingsBar can open.
        const sy = handles.candles.priceToCoordinate(s.stop.price);
        const ty = handles.candles.priceToCoordinate(s.takeProfit.price);
        const ey = handles.candles.priceToCoordinate(s.entry.price);
        if (ey == null || sy == null || ty == null) continue;
        const top = Math.min(ey, sy, ty) - threshold;
        const bottom = Math.max(ey, sy, ty) + threshold;
        if (y >= top && y <= bottom) return s.id;
      }
    }
    return null;
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      // v3.46: size is driven by forceChartResize (single owner) — avoids autoSize + applyOptions fight
      autoSize: false,
      layout: { background: { color: "#080b0f" }, textColor: "#b7c1cf" },
      grid: {
        vertLines: { color: "#17202a" },
        horzLines: { color: "#17202a" },
      },
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: "#202a35",
        scaleMargins: { top: 0.06, bottom: 0.08 },
      },
      leftPriceScale: { visible: false },
      timeScale: {
        // Time labels only — no tall navigator/scrub strip.
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: false,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: CHART_FUTURE_LOGICAL_BARS,
        borderVisible: true,
        borderColor: "#202a35",
        ticksVisible: true,
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
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.88, bottom: 0 }, visible: false });
    handlesRef.current = { chart, candles, volume, bidLine: null, askLine: null };
    // Do NOT force tiny heights on LWC internal table rows — that hides price/time axes.


    const onMove = (param: MouseEventParams) => {
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

      // Drag updates are handled in pointermove (setPointerCapture). Crosshair
      // alone is not reliable while the pointer is captured on desktop.

      // P0-2: overlay only needs a frame while placing a tool or dragging handles.
      // Native LWC crosshair paints independently — do not full-redraw drawings on hover.
      if (stepsRef.current.length >= 1 || dragRef.current) {
        scheduleRedraw();
      }

      if (!param.time || !param.seriesData) {
        scheduleOhlcUi(null);
        return;
      }
      const raw = param.seriesData.get(candles) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (!raw) {
        scheduleOhlcUi(null);
        return;
      }
      const tt = typeof param.time === "number" ? param.time : 0;
      scheduleOhlcUi({
        time: new Date(tt * 1000).toLocaleString(),
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
      // Only primary button / touch / pen
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      downRef.current = { x, y, time: Date.now() };

      // Drawing geometry tools own the pointer so mobile page scroll does not
      // fight rubber-band placement. Order tools (long/short) must NOT capture
      // or disable pan/zoom — only handle drags do (below). Chart stays free
      // while configuring SL/TP on a draft/open position.
      const toolNow = drawToolRef.current;
      const isGeometryDrawTool =
        toolNow === "trendline" ||
        toolNow === "ray" ||
        toolNow === "extended" ||
        toolNow === "rectangle" ||
        toolNow === "measure" ||
        toolNow === "fib" ||
        toolNow === "channel" ||
        toolNow === "text" ||
        toolNow === "hline" ||
        toolNow === "vline";
      if (isGeometryDrawTool) {
        setChartInteraction(false);
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        ev.preventDefault();
        // do not return — continue into hit-test / place flow
      }

      const hit = hitTestDrag(x, y, ev.pointerType === "touch");
      if (hit) {
        const shape = shapesRef.current.find((s) => s.id === hit.id);
        // v3.15.2.3: drawings (not positions) use select-first.
        // Unselected line + pointerdown → select only; selected + pointerdown → drag.
        // Positions keep immediate SL/TP drag without requiring prior selection.
        const isDrawing =
          shape &&
          shape.kind !== "position" &&
          (shape.kind === "hline" ||
            shape.kind === "vline" ||
            shape.kind === "trendline" ||
            shape.kind === "ray" ||
            shape.kind === "extended" ||
            shape.kind === "rectangle" ||
            shape.kind === "measure" ||
            shape.kind === "fib" ||
            shape.kind === "channel" ||
            shape.kind === "text");
        const alreadySelected = selectedShapeIdRef.current === hit.id;
        if (isDrawing && shape && "locked" in shape && shape.locked) {
          onSelectedShapeIdRef.current?.(hit.id);
          setHint("Locked · unlock from settings bar to move");
          ev.preventDefault();
          return;
        }
        if (isDrawing && !alreadySelected) {
          onSelectedShapeIdRef.current?.(hit.id);
          setHint("Selected · drag to move, Delete key or settings bar to remove");
          scheduleRedraw();
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        // Positions: select on interaction so PositionSettingsBar mounts.
        if (shape && shape.kind === "position") {
          onSelectedShapeIdRef.current?.(hit.id);
        }
        dragRef.current = hit;
        setChartInteraction(false);
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        setHint("Dragging…");
        ev.preventDefault();
        ev.stopPropagation();
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (dragRef.current) {
        applyDragAt(x, y);
        const cur = resizeCursorForPart(dragRef.current.field);
        if (cur) el.style.cursor = cur;
        scheduleRedraw();
        ev.preventDefault();
        return;
      }
      // Keep crosshair in sync while placing multi-point tools so live preview
      // follows mouse/finger even when chart crosshair events are sparse (touch).
      const tool = drawToolRef.current;
      const placing =
        stepsRef.current.length === 1 &&
        (tool === "trendline" ||
          tool === "ray" ||
          tool === "extended" ||
          tool === "rectangle" ||
          tool === "measure" ||
          tool === "fib" ||
          tool === "channel");
      if (placing) {
        const pt = fromXY(x, y);
        if (pt) crosshairRef.current = applyMagnet(pt, magnetModeRef.current);
        el.style.cursor = "crosshair";
        // Block page scroll while rubber-band preview is active on touch.
        if (ev.pointerType === "touch") ev.preventDefault();
      } else if (
        ev.pointerType === "touch" &&
        (tool === "trendline" ||
          tool === "ray" ||
          tool === "extended" ||
          tool === "rectangle" ||
          tool === "measure" ||
          tool === "fib" ||
          tool === "channel" ||
          tool === "text" ||
          tool === "hline" ||
          tool === "vline" ||
          tool === "long" ||
          tool === "short")
      ) {
        // Drawing tool selected: finger move must not scroll the document.
        ev.preventDefault();
      } else if (tool === "crosshair" || tool === "none") {
        // P1: hover hit-test at most once per frame; skip when no editable shapes.
        hoverPtrRef.current = { x, y };
        if (hoverHitRafRef.current == null) {
          hoverHitRafRef.current = requestAnimationFrame(() => {
            hoverHitRafRef.current = null;
            const pt = hoverPtrRef.current;
            if (!pt) return;
            let interactive = !!selectedShapeIdRef.current;
            if (!interactive) {
              for (const s of shapesRef.current) {
                if ("visible" in s && s.visible === false) continue;
                if ("locked" in s && s.locked) continue;
                interactive = true;
                break;
              }
            }
            if (!interactive) {
              if (lastHoverCursorRef.current !== "default") {
                el.style.cursor = "default";
                lastHoverCursorRef.current = "default";
              }
              return;
            }
            const hit = hitTestDrag(pt.x, pt.y, false);
            const next = (hit ? resizeCursorForPart(hit.field) : "") || "default";
            if (next !== lastHoverCursorRef.current) {
              el.style.cursor = next;
              lastHoverCursorRef.current = next;
            }
          });
        }
        // Hover-only: no overlay visual change (LWC owns crosshair).
        return;
      }
      // Placement preview, drawing tools, or other active overlay interactions.
      if (placing || stepsRef.current.length >= 1 || dragRef.current) {
        scheduleRedraw();
      }
    };

    const endDrag = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setChartInteraction(true);
      const shape = shapesRef.current.find((s) => s.id === d.id);
      if (shape && shape.kind === "position") {
        if (d.field === "stop") {
          window.dispatchEvent(
            new CustomEvent("tr-workspace-event", {
              detail: { text: `SL modified · ${shape.stop.price.toFixed(2)}` },
            })
          );
        } else if (d.field === "takeProfit") {
          window.dispatchEvent(
            new CustomEvent("tr-workspace-event", {
              detail: { text: `TP modified · ${shape.takeProfit.price.toFixed(2)}` },
            })
          );
        } else if (d.field === "entry" && shape.status === "pending") {
          window.dispatchEvent(
            new CustomEvent("tr-workspace-event", {
              detail: { text: `Pending entry modified · ${shape.entry.price.toFixed(2)}` },
            })
          );
        } else if (d.field === "stopTrigger" && shape.stopPrice != null) {
          window.dispatchEvent(
            new CustomEvent("tr-workspace-event", {
              detail: { text: `Stop trigger modified · ${shape.stopPrice.toFixed(2)}` },
            })
          );
        }
      }
      setHint("Updated · Confirm when ready");
      scheduleRedraw();
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (dragRef.current) {
        endDrag();
        downRef.current = null;
        try {
          if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
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
      const isTap = dt < 500 && dist < 10;

      if (isTap) {
        const tool = drawToolRef.current;
        const threshold = ev.pointerType === "touch" ? 18 : 12;
        if (tool === "hline" || tool === "vline") {
          // Prefer selecting an existing line over stacking a new one on the same spot.
          const existingId = hitTestSelect(x, y, threshold);
          if (existingId) {
            onSelectedShapeIdRef.current?.(existingId);
            setHint("Selected · drag to move, Delete key or settings bar to remove");
          } else {
            // Free continuous coordinate — not restricted to candle OHLC (v3.16.2)
            const raw = fromXY(x, y);
            const pt = raw ? applyMagnet(raw, magnetModeRef.current) : null;
            if (pt) {
              const shape: Shape =
                tool === "hline"
                  ? { id: uid(), kind: "hline", price: pt.price }
                  : { id: uid(), kind: "vline", time: pt.time };
              setShapes([...shapesRef.current, shape]);
              onSelectedShapeIdRef.current?.(shape.id);
              // Auto-return to cursor so the next tap selects/drags instead of placing again.
              onDrawToolChangeRef.current?.("crosshair");
              setHint("Done · drag to move, Delete key or settings bar to remove");
            }
          }
        } else if (
          tool === "trendline" ||
          tool === "ray" ||
          tool === "extended" ||
          tool === "rectangle" ||
          tool === "measure" ||
          tool === "fib"
        ) {
          // v3.16.2: single-click place for multi-point tools (TradingView-like).
          // Prefer selecting an existing drawing if the tap hits one.
          const existingId = hitTestSelect(x, y, threshold);
          if (existingId && stepsRef.current.length === 0) {
            onSelectedShapeIdRef.current?.(existingId);
            setHint("Selected · drag to move, Delete key or settings bar to remove");
          } else {
            const pt = fromXY(x, y);
            if (pt) placePoint(pt);
          }
        } else if (tool === "long" || tool === "short") {
          // Prefer selecting/dragging an existing position over placing a new box on top.
          const existingId = hitTestSelect(x, y, threshold);
          if (existingId) {
            onSelectedShapeIdRef.current?.(existingId);
            setHint("Selected · drag handles · Confirm in bar");
          } else {
            const pt = fromXY(x, y);
            if (pt) placePoint(pt);
          }
        } else {
          const hitId = hitTestSelect(x, y, threshold);
          onSelectedShapeIdRef.current?.(hitId);
        }
        scheduleRedraw();
      }

      // Manual double-tap: mobile often skips native dblclick.
      if (ev.pointerType === "touch" && isTap) {
        const now = Date.now();
        const prevTap = doubleTapRef.current;
        if (prevTap && now - prevTap.time < 400 && Math.hypot(x - prevTap.x, y - prevTap.y) < 30) {
          doubleTapRef.current = null;
          const tool = drawToolRef.current;
          if (tool === "trendline" || tool === "ray" || tool === "extended" || tool === "rectangle" || tool === "measure" || tool === "fib") {
            const pt = fromXY(x, y);
            if (pt) placePoint(pt);
          }
        } else {
          doubleTapRef.current = { x, y, time: now };
        }
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("lostpointercapture", endDrag);
    el.addEventListener("wheel", () => scheduleRedraw(), { passive: true });

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
      if (ev.key === "Enter") {
        const t = ev.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "BUTTON" || t.isContentEditable)) return;
        const sid = selectedShapeIdRef.current;
        const sh = sid ? shapesRef.current.find((s) => s.id === sid) : null;
        if (sh && sh.kind === "position" && sh.status === "draft") {
          ev.preventDefault();
          requestConfirm();
        }
        return;
      }
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

    // v3.46 — ONE owner of chart size. Layout (CSS) decides the box; this only reads it.
    // No inline width/height/minHeight is ever written to .chartbox/.chart-wrap/.chart
    // (the old code wrote them, which re-triggered the ResizeObserver and locked a
    // half-height box that could never shrink or grow again).
    let lastW = 0;
    let lastH = 0;
    let retries = 0;
    const debugOn = (() => {
      try {
        return (
          new URLSearchParams(window.location.search).get("fsdebug") === "1" ||
          window.localStorage.getItem("trFsDebug") === "1"
        );
      } catch {
        return false;
      }
    })();
    const forceChartResize = () => {
      const elc = containerRef.current;
      const handles = handlesRef.current;
      if (!elc || !handles) return;
      const w = Math.floor(elc.clientWidth);
      const h = Math.floor(elc.clientHeight);
      if (debugOn && elc.parentElement) {
        const vv = window.visualViewport;
        const boxEl = elc.parentElement.parentElement as HTMLElement | null;
        elc.parentElement.setAttribute(
          "data-fsdebug",
          `chart ${w}x${h} | box ${boxEl?.clientWidth ?? 0}x${boxEl?.clientHeight ?? 0} | inner ${window.innerWidth}x${window.innerHeight} | vv ${Math.round(vv?.width ?? 0)}x${Math.round(vv?.height ?? 0)} | fs ${document.documentElement.classList.contains("tr-fullscreen") ? "on" : "off"} | v${APP_VERSION}`
        );
      }
      if (w < 2 || h < 2) {
        // Layout not settled (fullscreen transition, hidden tab). Retry a few frames only.
        if (retries < 30) {
          retries += 1;
          requestAnimationFrame(forceChartResize);
        }
        return;
      }
      retries = 0;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      try {
        chart.resize(w, h, true);
        const ov = overlayRef.current;
        if (ov) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          ov.width = Math.floor(w * dpr);
          ov.height = Math.floor(h * dpr);
          ov.style.width = `${w}px`;
          ov.style.height = `${h}px`;
          const octx = ov.getContext("2d");
          if (octx) octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        scheduleRedraw();
      } catch {
        /* chart may be disposing */
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      retries = 0;
      forceChartResize();
    });
    // Observe ONLY the chart element — never parents (writing parent size caused feedback loops).
    resizeObserver.observe(containerRef.current);
    // Immediate size after mount (mobile FS may already be active)
    forceChartResize();
    requestAnimationFrame(() => forceChartResize());
    // Fullscreen / orientation: LWC needs several retries while flex settles.
    const onFsOrOrient = () => {
      const delays = [0, 16, 50, 100, 200, 400, 800];
      for (const ms of delays) {
        window.setTimeout(() => {
          requestAnimationFrame(() => forceChartResize());
        }, ms);
      }
    };
    document.addEventListener("fullscreenchange", onFsOrOrient);
    document.addEventListener("webkitfullscreenchange", onFsOrOrient as EventListener);
    window.addEventListener("orientationchange", onFsOrOrient);
    window.addEventListener("resize", onFsOrOrient);

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener("fullscreenchange", onFsOrOrient);
      document.removeEventListener("webkitfullscreenchange", onFsOrOrient as EventListener);
      window.removeEventListener("orientationchange", onFsOrOrient);
      window.removeEventListener("resize", onFsOrOrient);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("lostpointercapture", endDrag);
      el.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("keydown", onKeyDown);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      handlesRef.current = null;
      indicatorSeriesRef.current.clear();
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
    // Geometry tools disable pan while active; order tools (long/short) keep
    // pan/zoom so SL/TP can be adjusted without freezing the chart.
    const geometryDrawing =
      drawTool === "trendline" ||
      drawTool === "ray" ||
      drawTool === "extended" ||
      drawTool === "rectangle" ||
      drawTool === "measure" ||
      drawTool === "fib" ||
      drawTool === "channel" ||
      drawTool === "text" ||
      drawTool === "hline" ||
      drawTool === "vline";
    // Geometry tools disable pan while placing; Long/Short keep pan so SL/TP stays usable.
    setChartInteraction(!geometryDrawing);
    if (drawTool === "trendline" || drawTool === "ray" || drawTool === "extended") {
      setHint("Click Point A · move for live preview · click Point B");
    } else if (drawTool === "rectangle") {
      setHint("Click first corner · move for live preview · click opposite corner");
    } else if (drawTool === "fib") {
      setHint("Click swing low · move · click swing high");
    } else if (drawTool === "hline") setHint("Click a price level to draw the line");
    else if (drawTool === "vline") setHint("Click a moment in time to draw the line");
    else if (drawTool === "measure") setHint("Click a point, move for live preview, then click again");
    else if (drawTool === "channel") setHint("Click A · move · click B (channel width follows third control after place)");
    else if (drawTool === "text") setHint("Click to place a text note");
    else if (drawTool === "long" || drawTool === "short") {
      setHint(
        drawTool === "long"
          ? "Long tool · click chart to place box"
          : "Short tool · click chart to place box"
      );
    } else setHint("");
    scheduleRedraw();
  }, [drawTool]);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    // ReplayView already passes windowed/aggregated bars; cursor is typically bars.length.
    const end = Math.min(bars.length, Math.max(0, cursor));
    const played = bars.slice(0, end);
    // Unplayed bars stay on the time scale as whitespace (no OHLC) so the axis
    // spans the full loaded session — same idea as a full-range timeline — without
    // revealing future prices. Fixes drawings that mapped off a truncated scale.
    const unplayed = bars.slice(end);
    const firstTime = bars[0]?.time ?? played[0]?.time ?? 0;
    const lastPlayed = played[played.length - 1];
    const lastSession = bars[bars.length - 1];
    const lastTime = lastPlayed?.time ?? 0;

    // C1.4-A: display-only WhitespaceData after last real bar (time only, no OHLC/volume).
    // Never fed to execution, journal, or caches — Chart series only.
    const stepSec = Math.max(1, Math.floor(barSeconds) || 1);
    // Size future labels to the current viewport so times reach the right edge of the chart.
    const ts0 = handles.chart.timeScale();
    const cur0 = ts0.getVisibleLogicalRange();
    const viewWidth =
      cur0 && Number.isFinite(cur0.to - cur0.from)
        ? Math.max(10, cur0.to - cur0.from)
        : Math.min(160, Math.max(CHART_FUTURE_MIN_BARS, Math.max(played.length, 1) * 0.3));
    const futureCount = futureWhitespaceCount(viewWidth);
    // Synthetic padding after the *session* end (not only the playhead).
    const padAnchor = lastSession?.time ?? lastPlayed?.time;
    const futureTimes =
      padAnchor != null ? buildFutureWhitespaceTimes(padAnchor, stepSec, futureCount) : [];
    const unplayedPts = unplayed.map((b) => ({ time: b.time as UTCTimestamp }));
    const padPts = futureTimes.map((t) => ({ time: t as UTCTimestamp }));
    const whitespacePts = [...unplayedPts, ...padPts];

    // Full setData keeps candle + whitespace times aligned. Real OHLC only for played bars.
    handles.candles.setData([
      ...played.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
      ...whitespacePts,
    ]);
    handles.volume.setData([
      ...played.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume ?? 0,
        color: b.close >= b.open ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)",
      })),
      // Matching times only — no value → LWC treats as whitespace (no histogram bar).
      ...whitespacePts,
    ]);
    chartDataMetaRef.current = {
      len: played.length,
      firstTime,
      lastTime,
    };
    // Follow: keep last *played* candle in view; unplayed + pad whitespace fill to the right.
    if (shouldAutoFollowScroll(followRef.current, played.length)) {
      const ts = handles.chart.timeScale();
      ts.applyOptions({ rightOffset: 2 });
      const cur = ts.getVisibleLogicalRange();
      const width =
        cur && Number.isFinite(cur.to - cur.from)
          ? Math.max(10, cur.to - cur.from)
          : viewWidth;
      const tail = unplayed.length + futureCount;
      const next = followVisibleLogicalRange(played.length, width, tail);
      if (next) {
        try {
          ts.setVisibleLogicalRange(next);
        } catch {
          ts.scrollToRealTime();
        }
      }
    }
    scheduleRedraw();
  }, [bars, cursor, followPrice, barSeconds]);

  // Create/destroy one Line series per indicator spec as the list changes.
  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    const existing = indicatorSeriesRef.current;
    const wantIds = new Set(indicators.map((s) => s.id));

    for (const [id, series] of existing) {
      if (!wantIds.has(id)) {
        handles.chart.removeSeries(series);
        existing.delete(id);
      }
    }
    for (const spec of indicators) {
      if (!existing.has(spec.id)) {
        const series = handles.chart.addSeries(LineSeries, {
          color: spec.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        existing.set(spec.id, series);
      }
    }
    return () => {
      // Full cleanup happens in the chart-teardown effect below; this effect
      // only reconciles the set of series while the chart itself is alive.
    };
  }, [indicators]);

  // Recompute indicator values whenever the visible bars or indicator list change.
  useEffect(() => {
    const visible = bars.slice(0, cursor);
    for (const spec of indicators) {
      const series = indicatorSeriesRef.current.get(spec.id);
      if (!series) continue;
      const points =
        spec.kind === "sma"
          ? sma(visible, spec.period ?? 20)
          : spec.kind === "ema"
          ? ema(visible, spec.period ?? 20)
          : vwap(visible);
      series.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
  }, [bars, cursor, indicators]);

  // Execution engine: exact 1-second bars only — never aggregated TF.
  // Order: (1) pending entry / stop-limit stages → (2) SL/TP on open only.
  // Engine: 1s OHLC (positionEngine) or C2 tick Bid/Ask (positionEngineTick).
  useEffect(() => {
    const hasWork = shapesRef.current.some(
      (s) =>
        s.kind === "position" && (s.status === "open" || s.status === "pending")
    );
    if (!hasWork) return;

    const tickSeq =
      execTicks && execTicks.length
        ? execTicks.filter(
            (x) =>
              Number.isFinite(x.time) &&
              Number.isFinite(x.bid) &&
              Number.isFinite(x.ask) &&
              x.bid <= x.ask
          )
        : null;

    if (tickSeq && tickSeq.length) {
      const res = runPositionTicks(
        shapesRef.current,
        tickSeq,
        {
          onFill: (f) => {
            const filled = f as PositionShape;
            const fz = filled.sizing;
            const forSnap = fz ? ({ ...filled, risk: lotOverrideRisk(fz) } as PositionShape) : filled;
            const snap = captureRiskSnapshotRef.current?.(forSnap) ?? undefined;
            return {
              riskSnapshot: snap
                ? {
                    ...snap,
                    ...(fz
                      ? {
                          riskMode: fz.mode ?? (snap as { riskMode?: unknown }).riskMode,
                          lotFrozenAtConfirm: true,
                          lotFrozenAt: fz.atTime,
                          riskAmountAtConfirm: fz.riskAmountAtConfirm ?? null,
                        }
                      : {}),
                  }
                : undefined,
              entryScreenshot: capturePositionScreenshot(filled) ?? undefined,
            };
          },
          onClose: (s, px) => ({
            screenshot: capturePositionScreenshot(s as PositionShape, px) ?? undefined,
          }),
          canFill: (s, bar) => {
            const fn = canFillRef.current;
            if (fn && !fn(s as PositionShape, bar)) return false;
            const sz = (s as PositionShape).sizing;
            if (sz && captureRiskSnapshotRef.current) {
              const chk = captureRiskSnapshotRef.current({ ...(s as PositionShape), risk: lotOverrideRisk(sz) });
              const verdict = checkFillLot(sz.lot, (chk as { finalLot?: number | null } | null)?.finalLot);
              if (!verdict.ok) return { ok: false as const, reason: verdict.reason || "Cancelled · insufficient margin" };
            }
            return true;
          },
        },
        { gapFill: true }
      );
      if (!res.mutated) return;
      shapesRef.current = res.shapes as Shape[];
      onShapesChangeRef.current(res.shapes as Shape[]);
      for (const c of res.closed) {
        onPositionClosedRef.current?.(c as unknown as ClosedPosition);
      }
      for (const e of res.events) {
        window.dispatchEvent(new CustomEvent("tr-workspace-event", { detail: { text: e.text } }));
      }
      scheduleRedraw();
      if (res.closed.length) {
        setHint(
          res.closed
            .map((c) => `${String(c.side).toUpperCase()} ${String(c.reason).toUpperCase()} @ ${Number(c.exitPrice).toFixed(2)}`)
            .join(" · ")
        );
      }
      return;
    }

    // Tick mode with empty slice (e.g. step back): do not fall through to 1s OHLC engine.
    if (execTicks !== null && execTicks !== undefined) return;

    const sequence: Bar[] =
      execBars && execBars.length
        ? execBars
        : replayBar
          ? [replayBar]
          : [];
    if (!sequence.length) return;

    const res = runPositionBars(
      shapesRef.current,
      sequence,
      {
        onFill: (f) => {
          const filled = f as PositionShape;
          const fz = filled.sizing;
          // Lot frozen at Confirm: recalculate the snapshot with that exact lot (the SL may have moved since).
          const forSnap = fz ? ({ ...filled, risk: lotOverrideRisk(fz) } as PositionShape) : filled;
          const snap = captureRiskSnapshotRef.current?.(forSnap) ?? undefined;
          return {
            riskSnapshot: snap
              ? {
                  ...snap,
                  ...(fz
                    ? {
                        // keep the trader's ORIGINAL sizing mode; the lot itself is the frozen one
                        riskMode: fz.mode ?? (snap as { riskMode?: unknown }).riskMode,
                        lotFrozenAtConfirm: true,
                        lotFrozenAt: fz.atTime,
                        riskAmountAtConfirm: fz.riskAmountAtConfirm ?? null,
                      }
                    : {}),
                }
              : undefined,
            entryScreenshot: capturePositionScreenshot(filled) ?? undefined,
            ...( (() => {
              const b = marketRef.current.bid;
              const a = marketRef.current.ask;
              if (b == null || a == null || !Number.isFinite(b) || !Number.isFinite(a) || a < b) return {};
              return { spreadAtEntry: a - b, spreadUnit: "price_points" as const };
            })() ),
          };
        },
        onClose: (s, px) => {
          const b = marketRef.current.bid;
          const a = marketRef.current.ask;
          const exitSpread =
            b != null && a != null && Number.isFinite(b) && Number.isFinite(a) && a >= b ? a - b : undefined;
          const pos = s as PositionShape;
          return {
            screenshot: capturePositionScreenshot(pos, px) ?? undefined,
            ...(pos.spreadAtEntry != null ? { spreadAtEntry: pos.spreadAtEntry } : {}),
            ...(exitSpread != null ? { spreadAtExit: exitSpread, spreadUnit: "price_points" as const } : {}),
          };
        },
        canFill: (s, bar) => {
          const fn = canFillRef.current;
          if (fn && !fn(s as PositionShape, bar)) return false;
          // Confirmed lot must still be affordable at fill; otherwise cancel (never silently resize).
          const sz = (s as PositionShape).sizing;
          if (sz && captureRiskSnapshotRef.current) {
            const chk = captureRiskSnapshotRef.current({ ...(s as PositionShape), risk: lotOverrideRisk(sz) });
            const verdict = checkFillLot(sz.lot, (chk as { finalLot?: number | null } | null)?.finalLot);
            if (!verdict.ok) return { ok: false as const, reason: verdict.reason || "Cancelled · insufficient margin" };
          }
          return true;
        },
      },
      { gapFill: false }
    );
    if (!res.mutated) return;
    // v3.46.1: sync ref before parent re-render so fast ticks cannot ghost-draw closed positions
    shapesRef.current = res.shapes as Shape[];
    onShapesChangeRef.current(res.shapes as Shape[]);
    for (const c of res.closed) {
      onPositionClosedRef.current?.(c as unknown as ClosedPosition);
    }
    for (const e of res.events) {
      window.dispatchEvent(new CustomEvent("tr-workspace-event", { detail: { text: e.text } }));
      if (e.type === "filled") {
        try {
          window.dispatchEvent(
            new CustomEvent("tr-entry-memo-request", {
              detail: { positionId: e.id },
            })
          );
        } catch {
          /* */
        }
      }
    }
    scheduleRedraw();
    if (res.closed.length) {
      setHint(
        res.closed
          .map((c) => `${String(c.side).toUpperCase()} ${String(c.reason).toUpperCase()} @ ${Number(c.exitPrice).toFixed(2)}`)
          .join(" · ")
      );
    }
  }, [marketPrice, marketTime, replayBar, execBars, execTicks]);

  useEffect(() => {
    scheduleRedraw();
  }, [shapes, marketPrice]);

  // C2 UI: show Bid/Ask price lines when tick execution quotes are available.
  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    const { candles } = handles;
    const b = marketBid;
    const a = marketAsk;
    const valid =
      b != null &&
      a != null &&
      Number.isFinite(b) &&
      Number.isFinite(a) &&
      a >= b &&
      b > 0;

    if (!valid) {
      if (handles.bidLine) {
        try {
          candles.removePriceLine(handles.bidLine);
        } catch {
          /* */
        }
        handles.bidLine = null;
      }
      if (handles.askLine) {
        try {
          candles.removePriceLine(handles.askLine);
        } catch {
          /* */
        }
        handles.askLine = null;
      }
      return;
    }

    if (!handles.bidLine) {
      handles.bidLine = candles.createPriceLine({
        price: b,
        color: "#42a5f5",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "Bid",
      });
    } else {
      handles.bidLine.applyOptions({ price: b });
    }
    if (!handles.askLine) {
      handles.askLine = candles.createPriceLine({
        price: a,
        color: "#ff7043",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "Ask",
      });
    } else {
      handles.askLine.applyOptions({ price: a });
    }
  }, [marketBid, marketAsk]);

  return (
    <div className="chart-wrap" style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} className="chart" style={{ width: "100%", height: "100%" }} />
      {/* Purely visual — all pointer/touch handling is attached to the chart
          div above, so the overlay must never intercept events. */}
      <canvas
        ref={overlayRef}
        className="chart-overlay"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", touchAction: "none" }}
      />
      {(() => {
        const sel = shapes.find((s) => s.id === selectedShapeId);
        if (!sel) return null;
        const handles = handlesRef.current;
        if (sel.kind === "position") {
          const wBox = containerRef.current?.clientWidth ?? 640;
          const hBox = containerRef.current?.clientHeight ?? 360;
          const issues = validatePosition(sel as never, marketPrice);
          return (
            <>
              <PositionSettingsBar
                position={sel as never}
                container={{ w: wBox, h: hBox }}
                priceDecimals={inst.decimals}
                tick={inst.tick}
                barSec={Math.max(1, barSeconds || 60)}
                issues={issues}
                info={sizingInfo(
                  sel as PositionShape,
                  captureRiskSnapshotRef.current?.(sel as PositionShape) as never,
                  marketPrice
                )}
                marketPrice={marketPrice}
                onConfirm={() => requestConfirm()}
                savedDefaults={loadPositionDefaults()}
                onChange={(patch) => updatePosition(sel.id, patch as Partial<PositionShape>)}
                onClosePosition={() => manualCloseById(sel.id)}
                onCancelOrder={() => {
                  setShapes(shapesRef.current.filter((x) => x.id !== sel.id));
                  onSelectedShapeIdRef.current?.(null as never);
                }}
                onSaveStyleAsDefault={(st) => savePositionDefaults(st)}
              />
              {typeof window !== "undefined" &&
                new URLSearchParams(window.location.search).has("posdebug") &&
                (() => {
                  const barSec =
                    barsRef.current.length >= 2
                      ? Math.abs((barsRef.current[1]?.time ?? 0) - (barsRef.current[0]?.time ?? 0)) || 60
                      : 60;
                  const pos = normalizePosition(sel as PositionShape, { barSec });
                  const hnd = handlesRef.current;
                  const ww = containerRef.current?.clientWidth ?? 0;
                  const rawEntryX = hnd
                    ? hnd.chart.timeScale().timeToCoordinate(pos.entry.time as UTCTimestamp)
                    : null;
                  const rawRightX =
                    pos.rightTime != null && hnd
                      ? hnd.chart.timeScale().timeToCoordinate(pos.rightTime as UTCTimestamp)
                      : null;
                  const x0v = timeToX(pos.entry.time);
                  const x1v = pos.rightTime != null ? timeToX(pos.rightTime) : null;
                  const box = positionBox(pos as never, {
                    xOf: (tm: number) => timeToX(tm),
                    yOf: (pr: number) => {
                      const y = hnd?.candles.priceToCoordinate(pr);
                      return y == null || !Number.isFinite(y) ? null : y;
                    },
                    w: ww,
                  });
                  const line =
                    "v=" +
                    APP_VERSION +
                    " · rt=" +
                    String(pos.rightTime ?? "null") +
                    " · et=" +
                    String(pos.entry.time) +
                    " · rawE=" +
                    (rawEntryX == null ? "null" : String(Math.round(rawEntryX))) +
                    " · rawR=" +
                    (rawRightX == null ? "null" : String(Math.round(rawRightX))) +
                    " · x0=" +
                    (x0v == null ? "null" : String(Math.round(x0v))) +
                    " · x1=" +
                    (x1v == null ? "null" : String(Math.round(x1v))) +
                    " · box=" +
                    (box
                      ? String(Math.round(box.x0)) +
                        ".." +
                        String(Math.round(box.x1)) +
                        " w=" +
                        String(Math.round(box.x1 - box.x0))
                      : "null");
                  return (
                    <div
                      style={{
                        position: "absolute",
                        left: 8,
                        bottom: 8,
                        zIndex: 40,
                        maxWidth: "96%",
                        padding: "4px 8px",
                        borderRadius: 6,
                        background: "rgba(0,0,0,0.75)",
                        color: "#fde68a",
                        fontSize: 11,
                        fontFamily: "ui-monospace, monospace",
                        pointerEvents: "none",
                      }}
                    >
                      {"posdebug "}
                      {line}
                    </div>
                  );
                })()}
            </>
          );
        }
        // Floating settings bar is fixed near top-center — NOT glued to the shape bounds.
        const w = overlayRef.current?.clientWidth ?? 0;
        const h = overlayRef.current?.clientHeight ?? 0;
        return (
          <DrawingSettingsBar
            shape={sel as DrawingShape}
            anchor={null}
            container={{ w, h }}
            onChange={(patch: Partial<DrawingShape>) => {
              setShapes(
                shapesRef.current.map((s) =>
                  s.id === sel.id ? ({ ...s, ...patch } as Shape) : s
                )
              );
            }}
            onClone={() => {
              const barSec =
                barsRef.current.length >= 2
                  ? Math.max(1, barsRef.current[1].time - barsRef.current[0].time)
                  : 60;
              const prices = barsRef.current.map((b) => b.high);
              const range = prices.length ? Math.max(...prices) - Math.min(...prices) : 1;
              const c = cloneShape(sel as DrawingShape, uid(), 5 * barSec, range * 0.01);
              setShapes([...shapesRef.current, c as Shape]);
              onSelectedShapeIdRef.current?.(c.id);
            }}
            onDelete={() => {
              setShapes(shapesRef.current.filter((s) => s.id !== sel.id));
              onSelectedShapeIdRef.current?.(null);
            }}
            onBringToFront={() => {
              setShapes(bringToFront(shapesRef.current as DrawingShape[], sel.id) as Shape[]);
            }}
            onSendToBack={() => {
              setShapes(sendToBack(shapesRef.current as DrawingShape[], sel.id) as Shape[]);
            }}
            onSaveAsDefault={() => {
              // DrawingSettingsBar is only mounted for non-position drawing shapes.
              saveToolDefaults(sel.kind as DrawingShape["kind"], sel as DrawingShape);
            }}
          />
        );
      })()}
      <div
        ref={ohlcBoxRef}
        className="ohlc-box"
        style={{
          display: "none",
          fontSize: "clamp(10px, 2.6vw, 12px)",
          padding: "clamp(4px, 1.2vw, 8px) clamp(6px, 1.6vw, 10px)",
        }}
      >
        <div className="ohlc-time" ref={ohlcTimeRef} />
        <div>
          <span className="k">O</span> <span ref={ohlcOpenRef} />
        </div>
        <div>
          <span className="k">H</span> <span ref={ohlcHighRef} />
        </div>
        <div>
          <span className="k">L</span> <span ref={ohlcLowRef} />
        </div>
        <div>
          <span className="k">C</span> <span ref={ohlcCloseRef} />
        </div>
      </div>
      {hint && (
        <div className="draw-hint" style={{ fontSize: "clamp(10px, 2.8vw, 13px)", textAlign: "center" }}>
          {hint}
        </div>
      )}
    </div>
  );
}
