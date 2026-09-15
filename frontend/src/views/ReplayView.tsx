import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chart, type ClosedPosition, type DrawTool, type IndicatorSpec, type MagnetMode, type OrderType, type Shape } from "../components/Chart";
import { Toolbar } from "../components/Toolbar";
import {
  GROUP_LABELS,
  IMPLEMENTED_TOOLS,
  loadFavorites,
  saveFavorites,
  type ToolGroup,
} from "../lib/drawingTools";
import { fetchBars, addTrade } from "../lib/api";
import { appendTradeAsync, rMultiple } from "../lib/journal";
import { cacheGetRange, cachePutBars } from "../lib/barCache";
import { generateDemoBars, readCsvFile } from "../lib/demoData";
import { aggregateVisible } from "../lib/replay";
import { useReplayHotkeys } from "../lib/useReplayHotkeys";
import { loadReplaySession, saveReplaySession, type ReplayDataSource } from "../lib/replaySession";
import {
  getActiveSessionId,
  getRuntime,
  getSession,
  getSessionShapes,
  migrateLegacyToSessionIfNeeded,
  putRuntime,
  putSessionShapes,
  SESSION_CHANGED_EVENT,
  setActiveSessionId,
  upsertSession,
  defaultRuntime,
  ensureSessionAccounts,
  getActiveAccount,
  type SessionMeta,
} from "../lib/sessionStore";
import {
  applyRealizedPnL,
  calculateRisk,
  currencyPnLFromTradeFields,
  defaultInstrument,
  normalizeAccount,
  type RiskCalcResult,
} from "../lib/riskModel";
import { SYMBOLS, TIMEFRAMES, formatTf } from "../lib/types";
import type { Bar } from "../lib/types";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function toLocalInputValue(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DEFAULT_TFS = TIMEFRAMES.map((t) => t.seconds);

const INDICATOR_DEFS: { id: string; label: string; kind: IndicatorSpec["kind"]; period?: number; color: string }[] = [
  { id: "sma20", label: "SMA 20", kind: "sma", period: 20, color: "#60a5fa" },
  { id: "sma50", label: "SMA 50", kind: "sma", period: 50, color: "#f97316" },
  { id: "ema20", label: "EMA 20", kind: "ema", period: 20, color: "#34d399" },
  { id: "ema50", label: "EMA 50", kind: "ema", period: 50, color: "#c084fc" },
  { id: "vwap", label: "VWAP", kind: "vwap", color: "#fbbf24" },
];

function loadShapesFor(symbol: string): Shape[] {
  try {
    const raw = localStorage.getItem(`tr-shapes-${symbol}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Shape[];
    // One-time v3.15.2.4 migration: pre-fix non-market shapes were saved as
    // "open" on Confirm without a real fill. Convert those to "pending" once.
    // After this flag is set, genuine fills (status open) are left alone.
    const flagKey = "tr-pending-migrate-v324";
    if (localStorage.getItem(flagKey)) return parsed;
    const migrated = parsed.map((s) => {
      if (s.kind === "position" && s.orderType !== "market" && s.status === "open") {
        return { ...s, status: "pending" as const };
      }
      return s;
    });
    localStorage.setItem(flagKey, "1");
    try {
      localStorage.setItem(`tr-shapes-${symbol}`, JSON.stringify(migrated));
    } catch {
      /* ignore quota */
    }
    return migrated;
  } catch {
    return [];
  }
}

export function ReplayView({ backendOnline }: { backendOnline: boolean | null }) {
  const saved = useMemo(() => loadReplaySession(), []);
  const [baseBars, setBaseBars] = useState<Bar[]>(() =>
    saved && saved.dataSource !== "demo" ? [] : generateDemoBars()
  );
  const [cursor, setCursor] = useState(() => (saved ? Math.max(1, saved.cursor) : 800));
  const [speed, setSpeed] = useState(() => saved?.speed ?? 1);
  const [playing, setPlaying] = useState(false); // always start PAUSED after refresh
  const [symbol, setSymbol] = useState(() => saved?.symbol ?? SYMBOLS[0]);
  const [timeframeSeconds, setTimeframeSeconds] = useState(() => saved?.timeframeSeconds ?? 300);
  /** Cursor advance per Next/Prev/Play tick (1s bars). Execution still scans every intermediate 1s bar. */
  const [replayStepSeconds, setReplayStepSeconds] = useState(() =>
    Math.max(1, saved?.replayStepSeconds ?? 1)
  );
  const [stepOpen, setStepOpen] = useState(false);
  const [customStepInput, setCustomStepInput] = useState("");
  const prevCursorRef = useRef(saved ? Math.max(1, saved.cursor) : 800);
  const stepPanelRef = useRef<HTMLDivElement | null>(null);
  const [customTfs, setCustomTfs] = useState<number[]>(() => {
    if (saved?.customTfs?.length) return saved.customTfs;
    try {
      const raw = localStorage.getItem("tr-custom-tfs");
      if (raw) return JSON.parse(raw) as number[];
    } catch { /* */ }
    return [];
  });
  const [tfOpen, setTfOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [customTfInput, setCustomTfInput] = useState("");
  const [start, setStart] = useState(() => saved?.start ?? isoDaysAgo(3));
  const [end, setEnd] = useState(() => saved?.end ?? isoDaysAgo(0));
  const [dataSource, setDataSource] = useState<ReplayDataSource>(() => saved?.dataSource ?? "demo");
  const [message, setMessage] = useState(() =>
    saved && saved.dataSource !== "demo"
      ? "Restoring previous session…"
      : (saved?.message ?? "Demo data · Sync then Load")
  );
  const [loading, setLoading] = useState(() => !!(saved && saved.dataSource !== "demo"));
  const [drawTool, setDrawTool] = useState<DrawTool>(() => (saved?.drawTool as DrawTool) || "crosshair");
  const [magnetMode, setMagnetMode] = useState<MagnetMode>("off");
  const [drawMenuOpen, setDrawMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState<DrawTool[]>(() => loadFavorites());
  const [floatPos, setFloatPos] = useState(() => {
    try {
      const raw = localStorage.getItem("tr-float-toolbar-pos");
      if (raw) return JSON.parse(raw) as { x: number; y: number };
    } catch { /* */ }
    return { x: 56, y: 12 };
  });
  const floatDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const shapesUndoRef = useRef<Shape[][]>([]);
  const shapesRedoRef = useRef<Shape[][]>([]);
  const [goToValue, setGoToValue] = useState("");
  const [shapes, setShapes] = useState<Shape[]>(() => loadShapesFor(saved?.symbol ?? SYMBOLS[0]));
  const shapesRefForUndo = useRef(shapes);
  shapesRefForUndo.current = shapes;
  function pushShapes(next: Shape[]) {
    shapesUndoRef.current = [...shapesUndoRef.current.slice(-40), shapesRefForUndo.current];
    shapesRedoRef.current = [];
    shapesRefForUndo.current = next;
    setShapes(next);
  }
  function undoShapes() {
    const prev = shapesUndoRef.current.pop();
    if (!prev) return;
    shapesRedoRef.current.push(shapesRefForUndo.current);
    shapesRefForUndo.current = prev;
    setShapes(prev);
  }
  function redoShapes() {
    const next = shapesRedoRef.current.pop();
    if (!next) return;
    shapesUndoRef.current.push(shapesRefForUndo.current);
    shapesRefForUndo.current = next;
    setShapes(next);
  }
  const [orderType, setOrderType] = useState<OrderType>(() => (saved?.orderType as OrderType) || "market");
  const [riskPercent, setRiskPercent] = useState(2);
  const [riskPercentInput, setRiskPercentInput] = useState("2");
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const lastRiskSnapshotRef = useRef<RiskCalcResult | null>(null);
  const [followPrice, setFollowPrice] = useState(() => saved?.followPrice ?? false);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [activeIndicatorIds, setActiveIndicatorIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("tr-indicators");
      if (raw) return JSON.parse(raw) as string[];
    } catch { /* */ }
    return [];
  });
  const [indOpen, setIndOpen] = useState(false);
  const [sessionReady, setSessionReady] = useState(false); // v3.16: true only after session bootstrap
  const restoredCursorRef = useRef<number>(saved?.cursor ?? 800);
  const tfPanelRef = useRef<HTMLDivElement | null>(null);
  const ordersPanelRef = useRef<HTMLDivElement | null>(null);
  const indPanelRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(getActiveSessionId());
  const loadedSessionRef = useRef<string | null>(null);
  const [sessionLabel, setSessionLabel] = useState<string>("");

  const allTfs = useMemo(() => {
    const set = new Set<number>([...DEFAULT_TFS, ...customTfs, timeframeSeconds]);
    return Array.from(set).sort((a, b) => a - b);
  }, [customTfs, timeframeSeconds]);

  useEffect(() => {
    try {
      localStorage.setItem("tr-custom-tfs", JSON.stringify(customTfs));
    } catch { /* */ }
  }, [customTfs]);

  useEffect(() => {
    saveFavorites(favorites);
  }, [favorites]);

  useEffect(() => {
    try {
      localStorage.setItem("tr-float-toolbar-pos", JSON.stringify(floatPos));
    } catch { /* */ }
  }, [floatPos]);

  // Drawings + indicators: session-scoped in IndexedDB (v3.16)
  useEffect(() => {
    const sid = sessionIdRef.current;
    // Only persist once bootstrap has fully applied this session's shapes
    if (!sid || !sessionReady || loadedSessionRef.current !== sid) return;
    void putSessionShapes(sid, shapes);
    try {
      localStorage.setItem(`tr-shapes-${symbol}`, JSON.stringify(shapes));
    } catch { /* */ }
  }, [shapes, symbol, sessionReady]);

  useEffect(() => {
    try {
      localStorage.setItem("tr-indicators", JSON.stringify(activeIndicatorIds));
    } catch { /* */ }
  }, [activeIndicatorIds]);

  // Bootstrap / switch Backtest Session from IndexedDB
  useEffect(() => {
    let cancelled = false;
    async function loadSession(id: string | null) {
      if (!id) {
        id = await migrateLegacyToSessionIfNeeded();
      }
      if (!id || cancelled) return;
      sessionIdRef.current = id;
      setActiveSessionId(id);
      const meta = await getSession(id);
      const rt = (await getRuntime(id)) || defaultRuntime(id);
      const sh = (await getSessionShapes(id)) as Shape[];
      if (cancelled) return;
      if (meta) {
        const full = ensureSessionAccounts(meta);
        if (JSON.stringify(full) !== JSON.stringify(meta)) {
          void upsertSession(full);
        }
        setSessionMeta(full);
        setSymbol(full.symbol);
        setStart(full.start);
        setEnd(full.end);
        setDataSource(full.dataSource);
        setSessionLabel(full.name);
      }
      setTimeframeSeconds(rt.timeframeSeconds);
      setCustomTfs(rt.customTfs || []);
      setReplayStepSeconds(Math.max(1, rt.replayStepSeconds || 1));
      setCursor(Math.max(1, rt.cursor || 1));
      restoredCursorRef.current = Math.max(1, rt.cursor || 1);
      setSpeed(rt.speed || 1);
      setFollowPrice(!!rt.followPrice);
      setOrderType((rt.orderType as OrderType) || "market");
      setDrawTool((rt.drawTool as DrawTool) || "crosshair");
      setActiveIndicatorIds(rt.activeIndicatorIds || []);
      setShapes(Array.isArray(sh) ? sh : []);
      setPlaying(false);
      setMessage(rt.message || (meta ? meta.name : "Session loaded"));
      loadedSessionRef.current = id;
      setSessionReady(true);
      if (meta && meta.dataSource !== "demo") {
        setLoading(true);
        try {
          const local = await cacheGetRange(meta.symbol, meta.start, meta.end);
          if (!cancelled && local.bars.length) {
            setBaseBars(local.bars);
            const c = Math.min(Math.max(1, rt.cursor || 1), local.bars.length);
            setCursor(c);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
    }
    void loadSession(getActiveSessionId());
    const onChange = (ev: Event) => {
      const sid = (ev as CustomEvent).detail?.sessionId as string | null;
      void loadSession(sid);
    };
    window.addEventListener(SESSION_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_CHANGED_EVENT, onChange);
    };
  }, []);

  // v3.16: bar restore is owned by the Session bootstrap effect above.
  // Legacy localStorage-only restore is skipped to avoid racing session load.
  const restoreAttemptedRef = useRef(true);

  // Persist lightweight meta (localStorage) + session runtime (IndexedDB).
  useEffect(() => {
    if (!sessionReady) return;
    saveReplaySession({
      symbol,
      start,
      end,
      dataSource,
      timeframeSeconds,
      customTfs,
      replayStepSeconds,
      cursor,
      speed,
      followPrice,
      orderType,
      drawTool,
      message,
    });
    const sid = sessionIdRef.current;
    if (sid) {
      void putRuntime({
        sessionId: sid,
        timeframeSeconds,
        customTfs,
        replayStepSeconds,
        cursor,
        speed,
        followPrice,
        orderType,
        drawTool,
        activeIndicatorIds,
        message,
        playing: false,
        updatedAt: Date.now(),
      });
      void getSession(sid).then((meta) => {
        if (!meta) return;
        void upsertSession({
          ...meta,
          symbol,
          start,
          end,
          dataSource,
          updatedAt: Date.now(),
        });
      });
    }
  }, [
    sessionReady,
    symbol,
    start,
    end,
    dataSource,
    timeframeSeconds,
    customTfs,
    replayStepSeconds,
    cursor,
    speed,
    followPrice,
    orderType,
    drawTool,
    message,
    activeIndicatorIds,
  ]);

  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, replayStepSeconds);
    const id = window.setInterval(() => {
      setCursor((c) => {
        if (c >= baseBars.length) {
          setPlaying(false);
          return c;
        }
        return Math.min(baseBars.length, c + step);
      });
    }, Math.max(15, 250 / speed));
    return () => window.clearInterval(id);
  }, [playing, speed, baseBars.length, replayStepSeconds]);

  useEffect(() => {
    const b = baseBars[Math.max(0, cursor - 1)];
    if (b) setGoToValue(toLocalInputValue(b.time));
  }, [cursor, baseBars]);

  // close panels on outside tap
  // v3.15.2.2: pointerdown (not mousedown) unifies mouse/touch/pen into one
  // consistent event so a tap on a just-rendered preset button inside an
  // open panel is never mistaken for an outside click ahead of the
  // button's own onClick handler.
  useEffect(() => {
    function onDoc(e: PointerEvent) {
      const t = e.target as Node;
      if (tfOpen && tfPanelRef.current && !tfPanelRef.current.contains(t)) setTfOpen(false);
      if (drawMenuOpen && !(t as HTMLElement).closest?.(".draw-menu-wrap")) setDrawMenuOpen(false);
      if (ordersOpen && ordersPanelRef.current && !ordersPanelRef.current.contains(t)) setOrdersOpen(false);
      if (indOpen && indPanelRef.current && !indPanelRef.current.contains(t)) setIndOpen(false);
      if (stepOpen && stepPanelRef.current && !stepPanelRef.current.contains(t)) setStepOpen(false);
    }
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [tfOpen, ordersOpen, indOpen, stepOpen, drawMenuOpen]);

  // Space = play/pause, ArrowRight/ArrowLeft = step one second. Ignored
  // while typing in an input (symbol search, custom TF box, etc).
  useReplayHotkeys({
    onTogglePlay: () => setPlaying((p) => (p ? false : cursor < baseBars.length ? true : p)),
    onStepForward: () => {
      setPlaying(false);
      setCursor((c) => Math.min(baseBars.length, c + Math.max(1, replayStepSeconds)));
    },
    onStepBack: () => {
      setPlaying(false);
      setCursor((c) => Math.max(1, c - Math.max(1, replayStepSeconds)));
    },
  });

  async function loadRange() {
    setLoading(true);
    setPlaying(false);
    try {
      const local = await cacheGetRange(symbol, start, end);
      if (local.missingDays.length === 0 && local.bars.length) {
        setBaseBars(local.bars);
        setCursor(Math.min(800, local.bars.length));
        setDataSource("loaded");
        setMessage(
          `From device · ${local.bars.length.toLocaleString()} bars · ${local.fromCacheDays.length} day(s) · ${start} → ${end}`
        );
        return;
      }
      if (local.bars.length && local.missingDays.length) {
        setMessage(
          `Partial cache: ${local.fromCacheDays.length} day(s) on device, missing ${local.missingDays.length}…`
        );
      }
      if (!backendOnline) {
        if (local.bars.length) {
          setBaseBars(local.bars);
          setCursor(Math.min(800, local.bars.length));
          setDataSource("loaded");
          setMessage(`Offline · ${local.fromCacheDays.length} cached day(s)`);
        } else setMessage("No cache · backend offline");
        return;
      }
      const res = await fetchBars(symbol, 1, start, end);
      if (!res.bars.length && !local.bars.length) {
        setMessage(`No data · Sync in Data Engine first`);
        return;
      }
      const byT = new Map<number, Bar>();
      for (const b of local.bars) byT.set(b.time, b);
      for (const b of res.bars) byT.set(b.time, b);
      const merged = Array.from(byT.values()).sort((a, b) => a.time - b.time);
      setBaseBars(merged);
      setCursor(Math.min(800, merged.length));
      setDataSource("loaded");
      const daysSaved = await cachePutBars(symbol, merged);
      setMessage(`Loaded ${merged.length.toLocaleString()} · saved ${daysSaved} day(s) on device`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleImport(file: File) {
    try {
      const parsed = await readCsvFile(file);
      if (parsed.length) {
        setBaseBars(parsed);
        setCursor(Math.min(800, parsed.length));
        setDataSource("csv");
        // Seed day cache so refresh can restore without keeping the full series in localStorage.
        try {
          await cachePutBars(symbol, parsed);
        } catch { /* */ }
        setMessage(`Imported ${parsed.length.toLocaleString()} bars`);
      } else setMessage("No valid OHLC rows");
    } catch {
      setMessage("Could not read file");
    }
  }

  function handleGoTo() {
    if (!goToValue || !baseBars.length) return;
    setPlaying(false);
    const target = Math.floor(new Date(goToValue).getTime() / 1000);
    if (!Number.isFinite(target)) return;
    let lo = 0;
    let hi = baseBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (baseBars[mid].time < target) lo = mid + 1;
      else hi = mid;
    }
    setCursor(Math.min(baseBars.length, Math.max(1, lo + 1)));
  }

  function jumpSession(kind: "tokyo" | "london" | "ny") {
    if (!baseBars.length) return;
    setPlaying(false);
    const cur = baseBars[Math.max(0, cursor - 1)] ?? baseBars[0];
    const d = new Date(cur.time * 1000);
    const hours: Record<string, number> = { tokyo: 0, london: 7, ny: 13 };
    d.setUTCHours(hours[kind], kind === "ny" ? 30 : 0, 0, 0);
    const target = Math.floor(d.getTime() / 1000);
    let lo = 0;
    let hi = baseBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (baseBars[mid].time < target) lo = mid + 1;
      else hi = mid;
    }
    setCursor(Math.min(baseBars.length, Math.max(1, lo + 1)));
  }

  function addCustomTf() {
    const raw = customTfInput.trim().toLowerCase();
    if (!raw) return;
    let sec = 0;
    const m = raw.match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/i);
    if (m) {
      const n = parseFloat(m[1]);
      const u = (m[2] || "m").toLowerCase();
      if (u === "s") sec = Math.round(n);
      else if (u === "m") sec = Math.round(n * 60);
      else if (u === "h") sec = Math.round(n * 3600);
      else if (u === "d") sec = Math.round(n * 86400);
    } else {
      sec = parseInt(raw, 10);
    }
    if (!Number.isFinite(sec) || sec < 1) {
      setMessage("Custom TF invalid · examples: 3m, 90s, 2h");
      return;
    }
    const alreadyExisted = DEFAULT_TFS.includes(sec) || customTfs.includes(sec);
    setCustomTfs((prev) => (prev.includes(sec) ? prev : [...prev, sec].sort((a, b) => a - b)));
    setTimeframeSeconds(sec);
    setCustomTfInput("");
    setTfOpen(false);
    setMessage(
      alreadyExisted
        ? `Timeframe ${formatTf(sec)} selected`
        : `Timeframe ${formatTf(sec)} added`
    );
  }

  function handleSymbolChange(next: string) {
    setSymbol(next);
    setPlaying(false);
    setShapes(loadShapesFor(next));
    setSelectedShapeId(null);
  }

  function toggleIndicator(id: string) {
    setActiveIndicatorIds((prev) => {
      const adding = !prev.includes(id);
      const next = adding ? [...prev, id] : prev.filter((x) => x !== id);
      if (adding) setIndOpen(false);
      return next;
    });
  }

  function parseStepInput(raw: string): number | null {
    const t = raw.trim().toLowerCase();
    if (!t) return null;
    const m = t.match(/^(\d+(?:\.\d+)?)\s*([smh])?$/i);
    if (!m) {
      const n = parseInt(t, 10);
      return Number.isFinite(n) && n >= 1 ? n : null;
    }
    const n = parseFloat(m[1]);
    const u = (m[2] || "s").toLowerCase();
    let sec = 0;
    if (u === "s") sec = Math.round(n);
    else if (u === "m") sec = Math.round(n * 60);
    else if (u === "h") sec = Math.round(n * 3600);
    return sec >= 1 ? sec : null;
  }

  function applyCustomStep() {
    const sec = parseStepInput(customStepInput);
    if (sec == null) {
      setMessage("Replay step invalid · examples: 1s, 90s, 7m");
      return;
    }
    setReplayStepSeconds(sec);
    setCustomStepInput("");
    setStepOpen(false);
    setMessage(`Replay step ${formatTf(sec)}`);
  }

  
  async function handlePositionClosed(closed: ClosedPosition) {
    const note = `auto-${closed.reason} · ${closed.pnlPoints >= 0 ? "+" : ""}${closed.pnlPoints.toFixed(2)} pts`;
    const snap = (closed.riskSnapshot || lastRiskSnapshotRef.current) as Record<string, unknown> | null;
    const meta = sessionMeta ? ensureSessionAccounts(sessionMeta) : null;
    const acc = meta ? getActiveAccount(meta) : null;
    const num = (k: string) => {
      const v = snap?.[k];
      return typeof v === "number" ? v : undefined;
    };
    const localTrade = {
      id: `replay-${closed.id}-${closed.exitTime}`,
      symbol,
      side: closed.side,
      orderType: closed.orderType,
      entryPrice: closed.entry.price,
      exitPrice: closed.exitPrice,
      stopPrice: closed.stop.price,
      takeProfitPrice: closed.takeProfit.price,
      entryTime: closed.entry.time,
      exitTime: closed.exitTime,
      reason: closed.reason,
      pnlPoints: closed.pnlPoints,
      rMultiple: rMultiple(closed.side, closed.entry.price, closed.stop.price, closed.exitPrice),
      note,
      accountId: (snap?.accountId as string) || acc?.accountId,
      balanceBefore: num("balance") ?? num("balanceBefore"),
      equityBefore: num("equity") ?? num("equityBefore"),
      freeMarginBefore: num("freeMargin") ?? num("freeMarginBefore"),
      leverage: num("leverage") ?? acc?.leverage,
      riskPercent: num("riskPercent") ?? riskPercent,
      riskAmount: num("riskAmount"),
      riskBasedLot: num("riskBasedLot") ?? null,
      marginMaxLot: num("marginMaxLot") ?? null,
      finalLot: num("finalLot") ?? null,
      actualRiskAmount: num("actualRiskAmount") ?? null,
      actualRiskPercent: num("actualRiskPercent") ?? null,
      slDistance: num("slDistance") ?? Math.abs(closed.entry.price - closed.stop.price),
      tpDistance: num("tpDistance") ?? Math.abs(closed.takeProfit.price - closed.entry.price),
      durationSeconds: Math.max(0, closed.exitTime - closed.entry.time),
      snapshot: snap as any,
      closeScreenshot: closed.screenshot,
    };
    // Local storage is the immediate source of truth, so an auto-closed replay
    // trade is never lost just because the backend is sleeping/offline.
    void appendTradeAsync({ ...localTrade, sessionId: sessionIdRef.current || undefined });

    // Realized currency PnL → owning account.balance (initialBalance stays immutable)
    try {
      const rMult = localTrade.rMultiple;
      const ccy = currencyPnLFromTradeFields({
        rMultiple: rMult,
        actualRiskAmount: localTrade.actualRiskAmount,
        riskAmount: localTrade.riskAmount,
        pnlPoints: localTrade.pnlPoints,
        finalLot: localTrade.finalLot,
        riskBasedLot: localTrade.riskBasedLot,
        pointValue: num("pointValue") ?? 1,
      });
      const ownerId = localTrade.accountId;
      if (sessionMeta && ownerId && Number.isFinite(ccy) && ccy !== 0) {
        const full = ensureSessionAccounts(sessionMeta);
        const nextAccounts = (full.accounts || []).map((a) =>
          a.accountId === ownerId ? applyRealizedPnL(a, ccy) : a
        );
        const nextMeta = { ...full, accounts: nextAccounts, updatedAt: Date.now() };
        setSessionMeta(nextMeta);
        void upsertSession(nextMeta);
      }
    } catch {
      /* non-fatal */
    }

    setMessage(
      `Closed ${closed.side.toUpperCase()} on ${closed.reason.toUpperCase()} @ ${closed.exitPrice.toFixed(2)} (${closed.pnlPoints >= 0 ? "+" : ""}${closed.pnlPoints.toFixed(2)}) · Journal saved`
    );
    try {
      await addTrade({
        symbol,
        direction: closed.side,
        entry_price: closed.entry.price,
        exit_price: closed.exitPrice,
        size: 1,
        stop_price: closed.stop.price,
        take_profit_price: closed.takeProfit.price,
        opened_at: closed.entry.time,
        closed_at: closed.exitTime,
        notes: note,
      });
    } catch {
      // Local journal already contains the trade. Backend sync can fail safely.
    }
  }

  function pickTool(t: DrawTool) {
    setDrawTool(t);
    if (t === "long" || t === "short") setOrdersOpen(true);
  }

  function confirmOrder() {
    window.dispatchEvent(new Event("tr-confirm-position"));
    setOrdersOpen(false);
    setDrawTool("crosshair");
  }

  function deleteSelectedShape() {
    if (!selectedShapeId) return;
    // Positions are never removed via toolbar trash — only drawings.
    setShapes((prev) =>
      prev.filter((s) => {
        if (s.id !== selectedShapeId) return true;
        if (s.kind === "position") return true;
        return false;
      })
    );
    setSelectedShapeId(null);
  }

  const visibleBars = useMemo(
    () => aggregateVisible(baseBars, cursor, timeframeSeconds),
    [baseBars, cursor, timeframeSeconds]
  );
  const indicators: IndicatorSpec[] = useMemo(
    () =>
      INDICATOR_DEFS.filter((d) => activeIndicatorIds.includes(d.id)).map((d) => ({
        id: d.id,
        kind: d.kind,
        period: d.period,
        color: d.color,
      })),
    [activeIndicatorIds]
  );
  const currentBase = baseBars[Math.max(0, cursor - 1)];
  const max = Math.max(1, baseBars.length);
  const atEnd = cursor >= baseBars.length;

  // 1s bars from previous cursor → current for SL/TP (covers Replay Step jumps).
  const execBars = useMemo(() => {
    const prev = prevCursorRef.current;
    const lo = Math.min(prev, cursor);
    const hi = Math.max(prev, cursor);
    if (hi <= lo) {
      return currentBase ? [currentBase] : [];
    }
    // baseBars is 0-indexed; cursor is 1-based count of seconds revealed
    return baseBars.slice(lo, hi);
  }, [cursor, baseBars, currentBase]);

  useEffect(() => {
    prevCursorRef.current = cursor;
  }, [cursor]);

  const STEP_PRESETS = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];



  useEffect(() => {
    const onAcc = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as SessionMeta | undefined;
      if (detail && detail.id === (sessionMeta?.id || getActiveSessionId())) {
        setSessionMeta(ensureSessionAccounts(detail));
      }
    };
    window.addEventListener("tr-session-accounts-updated", onAcc as EventListener);
    return () => window.removeEventListener("tr-session-accounts-updated", onAcc as EventListener);
  }, [sessionMeta?.id]);

  // v3.16.1 live risk calculator from draft/selected position + order risk %
  const captureRiskSnapshot = useCallback(
    (pos: import("../components/Chart").PositionShape) => {
      if (!sessionMeta) return null;
      const full = ensureSessionAccounts(sessionMeta);
      // Prefer ownership stamped on the position (pending fill keeps original account)
      const account =
        (pos.accountId
          ? full.accounts?.find((a) => a.accountId === pos.accountId)
          : null) || getActiveAccount(full);
      if (!account) return null;
      const instrument = full.instrument || defaultInstrument(symbol);
      const result = calculateRisk({
        account,
        instrument,
        riskPercent,
        entryPrice: pos.entry.price,
        stopPrice: pos.stop.price,
        takeProfitPrice: pos.takeProfit.price,
        side: pos.side,
      });
      return {
        accountId: account.accountId,
        initialBalance: account.initialBalance,
        balance: result.balance,
        balanceBefore: result.balance,
        equity: result.equity,
        equityBefore: result.equity,
        freeMargin: result.freeMargin,
        freeMarginBefore: result.freeMargin,
        leverage: result.leverage,
        riskPercent: result.riskPercent,
        riskAmount: result.riskAmount,
        entryPrice: pos.entry.price,
        stopLoss: pos.stop.price,
        takeProfit: pos.takeProfit.price,
        slDistance: result.slDistance,
        tpDistance: result.tpDistance,
        pointValue: result.pointValue,
        contractSize: instrument.contractSize,
        accountMinLot: result.accountMinLot,
        accountMaxLot: result.accountMaxLot,
        instrumentMaxLot: result.instrumentMaxLot,
        lotStep: account.lotStep ?? instrument.lotStep,
        riskBasedLot: result.riskBasedLot,
        marginMaxLot: result.marginMaxLot,
        finalLot: result.finalLot,
        marginRequired: result.marginRequired,
        actualRiskAmount: result.actualRiskAmount,
        actualRiskPercent: result.actualRiskPercent,
        entryTime: pos.entry.time,
      };
    },
    [sessionMeta, riskPercent, symbol]
  );

  const liveRisk = useMemo((): RiskCalcResult | null => {
    if (!sessionMeta) return null;
    const full = ensureSessionAccounts(sessionMeta);
    const rawAcc = getActiveAccount(full);
    if (!rawAcc) return null;
    const instrument = full.instrument || defaultInstrument(symbol);
    const account = normalizeAccount(rawAcc, instrument);
    const pos = shapes.find((s) => s.kind === "position" && (s.status === "draft" || s.id === selectedShapeId)) as
      | import("../components/Chart").PositionShape
      | undefined;
    const draft = shapes.find((s) => s.kind === "position" && s.status === "draft") as
      | import("../components/Chart").PositionShape
      | undefined;
    const p = draft || pos;
    if (!p || p.kind !== "position") return null;
    const result = calculateRisk({
      account,
      instrument,
      riskPercent,
      entryPrice: p.entry.price,
      stopPrice: p.stop.price,
      takeProfitPrice: p.takeProfit.price,
      side: p.side,
    });
    lastRiskSnapshotRef.current = result;
    return result;
  }, [sessionMeta, shapes, selectedShapeId, riskPercent, symbol]);

  return (
    <section className="replay-view">
      {/* Compact top: symbol + TF dropdown + Orders + data */}
      <div className="bar replay-topbar mobile-scroll">
        {sessionLabel ? <span className="session-chip" title="Active backtest session">{sessionLabel}</span> : null}
        <select value={symbol} onChange={(e) => handleSymbolChange(e.target.value)}>
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="draw-menu-wrap">
          <button type="button" className={drawMenuOpen ? "on" : ""} onClick={() => setDrawMenuOpen((v) => !v)}>
            Drawing Tools ▾
          </button>
          {drawMenuOpen && (
            <div className="draw-menu panel-top">
              {(Object.keys(GROUP_LABELS) as ToolGroup[]).map((g) => {
                const items = IMPLEMENTED_TOOLS.filter((x) => x.group === g);
                if (!items.length) return null;
                return (
                  <div className="draw-menu-group" key={g}>
                    <b>{GROUP_LABELS[g]}</b>
                    {items.map((tool) => (
                      <button
                        key={tool.id}
                        type="button"
                        className={`${drawTool === tool.id ? "on" : ""}${favorites.includes(tool.id) ? " fav" : ""}`}
                        onClick={() => {
                          pickTool(tool.id);
                          setDrawMenuOpen(false);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFavorites((prev) =>
                            prev.includes(tool.id) ? prev.filter((x) => x !== tool.id) : [...prev, tool.id]
                          );
                        }}
                        title="Click to select · right-click toggle favorite"
                      >
                        {tool.label}
                      </button>
                    ))}
                  </div>
                );
              })}
              <p className="tools-note">Right-click a tool to add/remove Favorites.</p>
            </div>
          )}
        </div>

        <label className="magnet-row" title="Snap to OHLC">
          Magnet
          <select value={magnetMode} onChange={(e) => setMagnetMode(e.target.value as MagnetMode)}>
            <option value="off">OFF</option>
            <option value="weak">Weak</option>
            <option value="strong">Strong</option>
          </select>
        </label>
        <span className="draw-actions">
          <button type="button" onClick={undoShapes} title="Undo drawing">Undo</button>
          <button type="button" onClick={redoShapes} title="Redo drawing">Redo</button>
        </span>

        <div className="tf-wrap" ref={tfPanelRef}>
          <button type="button" className="tf-current on" onClick={() => setTfOpen((v) => !v)}>
            TF {formatTf(timeframeSeconds)} ▾
          </button>
          {tfOpen && (
            <div className="tf-panel panel-top">
              <div className="tf-list">
                {allTfs.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className={sec === timeframeSeconds ? "on" : ""}
                    onClick={() => {
                      setTimeframeSeconds(sec);
                      setTfOpen(false);
                    }}
                  >
                    {formatTf(sec)}
                  </button>
                ))}
              </div>
              <div className="tf-custom">
                <input
                  type="text"
                  placeholder="Custom: 3m, 90s, 2h"
                  value={customTfInput}
                  onChange={(e) => setCustomTfInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCustomTf()}
                />
                <button type="button" className="on" onClick={addCustomTf}>Add</button>
              </div>
            </div>
          )}
        </div>

        <div className="tools-wrap" ref={indPanelRef}>
          <button type="button" className={indOpen ? "on" : ""} onClick={() => setIndOpen((v) => !v)}>
            Ind ▾
          </button>
          {indOpen && (
            <div className="tools-panel panel-top">
              {INDICATOR_DEFS.map((d) => (
                <label key={d.id} className="ind-row">
                  <input
                    type="checkbox"
                    checked={activeIndicatorIds.includes(d.id)}
                    onChange={() => toggleIndicator(d.id)}
                  />
                  <span className="ind-swatch" style={{ background: d.color }} />
                  {d.label}
                </label>
              ))}
              <p className="tools-note">Overlays recompute live as you replay.</p>
            </div>
          )}
        </div>

        <div className="tools-wrap" ref={ordersPanelRef}>
          <button type="button" className={ordersOpen ? "on" : ""} onClick={() => setOrdersOpen((v) => !v)}>
            Orders ▾
          </button>
          {ordersOpen && (
            <div className="tools-panel panel-top risk-panel">
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
                <option value="market">Market</option>
                <option value="buy_limit">Buy Limit</option>
                <option value="sell_limit">Sell Limit</option>
                <option value="buy_stop">Buy Stop</option>
                <option value="sell_stop">Sell Stop</option>
                <option value="buy_stop_limit">Buy Stop Limit</option>
                <option value="sell_stop_limit">Sell Stop Limit</option>
              </select>
              {sessionMeta && ensureSessionAccounts(sessionMeta).accounts && (
                <div className="active-account-block">
                  <div className="active-account-label">ACTIVE ACCOUNT</div>
                  <select
                    value={sessionMeta.activeAccountId || ""}
                    onChange={(e) => {
                      const full = ensureSessionAccounts(sessionMeta);
                      const id = e.target.value;
                      if (!full.accounts?.some((a) => a.accountId === id && a.enabled !== false)) return;
                      const next = { ...full, activeAccountId: id, updatedAt: Date.now() };
                      setSessionMeta(next);
                      void upsertSession(next);
                    }}
                    title="Active account for new trades"
                  >
                    {ensureSessionAccounts(sessionMeta)
                      .accounts!.filter((a) => a.enabled !== false)
                      .map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.accountId === sessionMeta.activeAccountId ? "● " : ""}
                        {a.name} · {a.currency} {(a.balance ?? a.initialBalance).toLocaleString()} · 1:{a.leverage}
                      </option>
                    ))}
                  </select>
                  <ul className="account-switch-list">
                    {ensureSessionAccounts(sessionMeta).accounts!.map((a) => (
                      <li
                        key={a.accountId}
                        className={
                          a.accountId === sessionMeta.activeAccountId
                            ? "acc-active"
                            : a.enabled === false
                              ? "acc-disabled"
                              : ""
                        }
                      >
                        <button
                          type="button"
                          disabled={a.enabled === false}
                          onClick={() => {
                            if (a.enabled === false) return;
                            const full = ensureSessionAccounts(sessionMeta);
                            const next = { ...full, activeAccountId: a.accountId, updatedAt: Date.now() };
                            setSessionMeta(next);
                            void upsertSession(next);
                          }}
                        >
                          {a.accountId === sessionMeta.activeAccountId ? "🟢" : a.enabled === false ? "⛔" : "⚪"}{" "}
                          {a.name}
                          <span className="muted">
                            {" "}
                            {(a.balance ?? a.initialBalance).toLocaleString()} · 1:{a.leverage}
                            {a.accountId === sessionMeta.activeAccountId ? " · Active" : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className="risk-label">
                Risk %
                <input
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={riskPercentInput}
                  onChange={(e) => setRiskPercentInput(e.target.value)}
                  onBlur={() => {
                    const n = Number(riskPercentInput);
                    if (!Number.isFinite(n) || n < 0.01 || n > 100) {
                      setRiskPercentInput(String(riskPercent));
                      return;
                    }
                    const v = Math.round(n * 100) / 100;
                    setRiskPercent(v);
                    setRiskPercentInput(String(v));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </label>
              <div className="risk-presets">
                {[1, 2, 3].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={riskPercent === p ? "on" : ""}
                    onClick={() => {
                      setRiskPercent(p);
                      setRiskPercentInput(String(p));
                    }}
                  >
                    {p}%
                  </button>
                ))}
              </div>
              <button type="button" className="on" onClick={confirmOrder}>Confirm</button>
              <button type="button" onClick={() => window.dispatchEvent(new Event("tr-cancel-draft"))}>Cancel draft</button>
              <button type="button" onClick={() => { setShapes([]); setSelectedShapeId(null); }}>Clear drawings</button>
              {liveRisk && (
                <div className="risk-calc">
                  {liveRisk.missingSpec ? (
                    <p className="tools-note warn-text">Instrument specification required: {liveRisk.missingSpec}</p>
                  ) : (
                    <>
                      <p className="tools-note">
                        Eq {liveRisk.equity.toFixed(0)} · Lev 1:{liveRisk.leverage} · SL {liveRisk.slDistance.toFixed(2)} pts
                      </p>
                      <p className="tools-note">
                        Risk ${liveRisk.riskAmount.toFixed(2)} ({liveRisk.riskPercent.toFixed(2)}%) · RiskLot {liveRisk.riskBasedLot ?? "—"} · MaxMarg {liveRisk.marginMaxLot ?? "—"} · <b>Lot {liveRisk.finalLot ?? "—"}</b>
                      </p>
                      <p className="tools-note">
                        Actual risk {liveRisk.actualRiskPercent != null ? liveRisk.actualRiskPercent.toFixed(2) + "%" : "—"}
                        {liveRisk.rr != null ? ` · R:R 1:${liveRisk.rr.toFixed(2)}` : ""}
                        {liveRisk.potentialProfit != null ? ` · TP $${liveRisk.potentialProfit.toFixed(2)}` : ""}
                      </p>
                    </>
                  )}
                </div>
              )}
              <p className="tools-note">Pick Long/Short on the chart toolbar, set Risk % and order type, then Confirm.</p>
            </div>
          )}
        </div>

        <button type="button" onClick={() => jumpSession("tokyo")}>Tokyo</button>
        <button type="button" onClick={() => jumpSession("london")}>London</button>
        <button type="button" onClick={() => jumpSession("ny")}>NY</button>
        <label className="goto-label">
          Go To
          <input type="datetime-local" step="1" value={goToValue} onChange={(e) => setGoToValue(e.target.value)} />
        </label>
        <button type="button" className="on" onClick={handleGoTo}>Jump</button>
        <label className="import-btn">CSV<input type="file" accept=".csv,.txt" onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])} /></label>
      </div>

      <div className="bar replay-range mobile-scroll">
        <span>Data</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span>→</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button onClick={loadRange} disabled={loading}>{loading ? "…" : "Load 1s"}</button>
        <span className="status-message">{message}</span>
      </div>

      <div className="chartbox">


        <Toolbar
          activeTool={drawTool}
          onToolChange={pickTool}
          hasSelection={!!selectedShapeId}
          onDeleteSelected={deleteSelectedShape}
          favorites={favorites}
          position={floatPos}
          onPositionChange={setFloatPos}
        />
        <Chart
          bars={visibleBars}
          cursor={visibleBars.length}
          drawTool={drawTool}
          orderType={orderType}
          marketPrice={currentBase?.close ?? null}
          marketTime={currentBase?.time ?? null}
          replayBar={currentBase ?? null}
          execBars={execBars}
          followPrice={followPrice}
          shapes={shapes}
          onShapesChange={pushShapes}
          magnetMode={magnetMode}
          selectedShapeId={selectedShapeId}
          onSelectedShapeId={setSelectedShapeId}
          onDrawToolChange={pickTool}
          onPositionClosed={handlePositionClosed}
          captureRiskSnapshot={captureRiskSnapshot}
          activeAccountId={sessionMeta?.activeAccountId ?? null}
          indicators={indicators}
        />
      </div>

      <div className="replay mobile-scroll">
        <button
          type="button"
          className="on"
          onClick={() => setPlaying((p) => !p)}
          disabled={!playing && atEnd}
          title="Space"
        >
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button type="button" className={followPrice ? "on" : ""} onClick={() => setFollowPrice((v) => !v)}>
          {followPrice ? "Follow ON" : "Follow OFF"}
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            setCursor((c) => Math.max(1, c - Math.max(1, replayStepSeconds)));
          }}
          title="←"
        >
          Prev
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            setCursor((c) => Math.min(baseBars.length, c + Math.max(1, replayStepSeconds)));
          }}
          title="→"
        >
          Next
        </button>
        <div className="tools-wrap" ref={stepPanelRef}>
          <button type="button" className={stepOpen ? "on" : ""} onClick={() => setStepOpen((v) => !v)}>
            Step {formatTf(replayStepSeconds)} ▾
          </button>
          {stepOpen && (
            <div className="tools-panel panel-bottom">
              {STEP_PRESETS.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className={sec === replayStepSeconds ? "on" : ""}
                  onClick={() => {
                    setReplayStepSeconds(sec);
                    setStepOpen(false);
                  }}
                >
                  {formatTf(sec)}
                </button>
              ))}
              <div className="tf-custom">
                <input
                  type="text"
                  placeholder="Custom: 37s, 90s, 7m"
                  value={customStepInput}
                  onChange={(e) => setCustomStepInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyCustomStep()}
                />
                <button type="button" className="on" onClick={applyCustomStep}>
                  Add
                </button>
              </div>
              <p className="tools-note">Step moves the cursor. SL/TP still checks every 1s bar inside the jump.</p>
            </div>
          )}
        </div>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[0.25, 0.5, 1, 2, 5, 10].map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
        <input type="range" min={1} max={max} value={Math.min(cursor, max)} onChange={(e) => setCursor(Number(e.target.value))} />
        <span className="cursor-count">{cursor.toLocaleString()}/{baseBars.length.toLocaleString()}s</span>
      </div>

      <aside className="replay-info">
        <p>{currentBase ? new Date(currentBase.time * 1000).toLocaleString() : "—"}</p>
        <p>
          TF {formatTf(timeframeSeconds)} · Step {formatTf(replayStepSeconds)} · {visibleBars.length} candles · Space
          play/pause · ←/→ step
        </p>
      </aside>
    </section>
  );
}
