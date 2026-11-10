import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { appendTradeAsync, rMultiple, auditJournalEvent } from "../lib/journal";
import {
  buildHtfSnapshots,
  normalizeJournalSnapshotConfig,
} from "../lib/journalSnapshots";
import { cacheGetRange, cachePutBars } from "../lib/barCache";
import { tickCacheGetDayWithAlias, tickCacheListCompleteDaysWithAlias } from "../lib/tickCache";
import type { TickRecord } from "../lib/tickTypes";
import {
  enumerateUtcDaysInclusive,
  findBars1sCursorForUnixTime,
  hasEligibleTickDayInRange,
  mapTickTimeToBars1sCursor,
  mapTimeToTickIndex,
  nextUtcDay,
  prevUtcDay,
  secondsModeNextDeltaSec,
  shouldApplyTickNav,
  sortTicksStable,
  tickModeNextDeltaSec,
  unixToUtcDay,
  wallClockDelayMs,
  type ReplayResolution,
} from "../lib/tickReplay";

import { normalizeBars } from "../lib/marketDataIntegrity";
import { decideCacheFirstLoad } from "../lib/cacheFirstLoad";
import { recordRangeLoad, recordReplayWindow } from "../lib/replayDiagnostics";

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
import { isRiskMode, type RiskMode,
  applyRealizedPnL,
  calculateRisk,
  calculateLivePositionMetrics,
  currencyPnLFromTradeFields,
  defaultInstrument,
  normalizeAccount,
  type RiskCalcResult,
} from "../lib/riskModel";
import { buildPropRuleSnapshot, getEffectiveLeverage } from "../lib/propRules";
import {
  appendLifecycleEvents,
  applyPhaseFromLifecycle,
  canOpenNewTrades,
  deriveLifecycleFromEvents,
  suggestLifecycleTransitions,
} from "../lib/accountLifecycle";
import { loadJournalForSession } from "../lib/journal";
import type { PropTradeLike } from "../lib/propRules";
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
  /** C1: "tick" steps real ticks; "seconds" uses replayStepSeconds on 1s bars. */
  const [replayResolution, setReplayResolution] = useState<ReplayResolution>("seconds");
  const [tickWindow, setTickWindow] = useState<TickRecord[]>([]);
  const [tickDay, setTickDay] = useState<string | null>(null);
  const [tickIndex, setTickIndex] = useState(0);
  const [tickEligible, setTickEligible] = useState(false);
  const [tickSymbolUsed, setTickSymbolUsed] = useState<string | null>(null);
  const tickLoadGenRef = useRef(0);
  /** Bumped on every Jump/session navigation so stale async tick loads cannot apply. */
  const tickNavGenRef = useRef(0);
  const replayResolutionRef = useRef<ReplayResolution>("seconds");
  const tickWindowRef = useRef<TickRecord[]>([]);
  const tickIndexRef = useRef(0);
  const tickDayRef = useRef<string | null>(null);
  const stepTickRef = useRef<(dir: number) => void>(() => {});
  const navigateReplayToUnixTimeRef = useRef<(t: number, opts?: { cursor?: number }) => void>(() => {});
  const tickTransitionLockRef = useRef(false);
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
  const [customTfInput, setCustomTfInput] = useState("");
  const [start, setStart] = useState(() => saved?.start ?? isoDaysAgo(3));
  const [end, setEnd] = useState(() => saved?.end ?? isoDaysAgo(0));
  const [dataSource, setDataSource] = useState<ReplayDataSource>(() => saved?.dataSource ?? "demo");
  // v3.20.2: do not enter "Restoring…" when there is no active session (market data is global).
  const [message, setMessage] = useState(() => {
    const hasActive = !!getActiveSessionId();
    if (hasActive && saved && saved.dataSource !== "demo") return "Restoring previous session…";
    return saved?.message ?? "Demo data · Sync then Load";
  });
  const [loading, setLoading] = useState(() => {
    const hasActive = !!getActiveSessionId();
    return !!(hasActive && saved && saved.dataSource !== "demo");
  });
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
  /** When true, do not overwrite goToValue from cursor (desktop time edit). */
  const [goToEditing, setGoToEditing] = useState(false);
  /** Compact Session jump menu (Tokyo/London/NY/Custom) — separate from Go To. */
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [customSessionOpen, setCustomSessionOpen] = useState(false);
  const [customName, setCustomName] = useState("Custom");
  const [customTz, setCustomTz] = useState("America/New_York");
  const [customStart, setCustomStart] = useState("09:30");
  const [customEnd, setCustomEnd] = useState("16:00");
  const [shapes, setShapes] = useState<Shape[]>(() => loadShapesFor(saved?.symbol ?? SYMBOLS[0]));
  const [workspaceLog, setWorkspaceLog] = useState<{ t: number; text: string }[]>([]);
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
  const [propTrades, setPropTrades] = useState<PropTradeLike[]>([]);
  const [riskPercent, setRiskPercent] = useState(2);
  /** Per-order risk mode (does not permanently rewrite account profile). */
  const [orderRiskMode, setOrderRiskMode] = useState<RiskMode>("percent_equity");
  const [fixedRiskInput, setFixedRiskInput] = useState("100");
  const [fixedLotInput, setFixedLotInput] = useState("0.10");
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const lastRiskSnapshotRef = useRef<RiskCalcResult | null>(null);
  const [followPrice, setFollowPrice] = useState(() => saved?.followPrice ?? false);
  /** Floating replay panel position (px from viewport top-left). null = CSS default bottom-center. */
  const [replayBarPos, setReplayBarPos] = useState<{ x: number; y: number } | null>(null);
  const replayBarRef = useRef<HTMLDivElement | null>(null);
  const replayDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

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
  const indPanelRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(getActiveSessionId());
  /** Stale async Load 1s / cache reads must not overwrite newer requests (v3.23.0). */
  const loadGenRef = useRef(0);
  const playLenRef = useRef(0);
  const playStepRef = useRef(1);
  /** C1.2 real-time scheduler */
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playGenRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const cursorRef = useRef(1);
  const baseBarsRef = useRef<Bar[]>([]);
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
      // No active session: idle/ready. Market data (Load 1s / Data Engine) must remain usable.
      if (!id || cancelled) {
        if (cancelled) return;
        sessionIdRef.current = null;
        loadedSessionRef.current = null;
        setSessionMeta(null);
        setSessionLabel("");
        setSessionReady(true);
        setLoading(false);
        setPlaying(false);
        setMessage("No active session · Use Data Engine or Load 1s (market data is global)");
        return;
      }
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
          if (cancelled) return;
          if (local.bars.length) {
            setBaseBars(local.bars);
            setDataSource("loaded");
            const c = Math.min(Math.max(1, rt.cursor || 1), local.bars.length);
            setCursor(Math.max(1, c));
            if (local.missingDays.length) {
              setMessage(
                `Session restore · ${local.fromCacheDays.length} local day(s), missing ${local.missingDays.length} (${local.missingDays.slice(0, 3).join(", ")}${local.missingDays.length > 3 ? "…" : ""})`
              );
            } else {
              setMessage(
                `Session restore · ${local.bars.length.toLocaleString()} bars from device`
              );
            }
          } else if (local.missingDays.length) {
            setMessage(
              `No local bars for ${meta.symbol} ${meta.start}→${meta.end}. Missing: ${local.missingDays.slice(0, 5).join(", ")}${local.missingDays.length > 5 ? "…" : ""}. Use Load 1s or import in Data Engine.`
            );
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
      const barT = baseBars[Math.max(0, cursor - 1)]?.time;
      void putRuntime({
        sessionId: sid,
        timeframeSeconds,
        customTfs,
        replayStepSeconds,
        cursor,
        replayTimeUnix: barT != null && Number.isFinite(barT) ? barT : 0,
        speed,
        followPrice,
        orderType,
        workspaceLog: workspaceLog.slice(0, 40),
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
    workspaceLog,
  ]);

  // Keep playback loop deps minimal: length/step/cursor read from refs (C1.2).
  playLenRef.current = baseBars.length;
  playStepRef.current = Math.max(1, replayStepSeconds);
  replayResolutionRef.current = replayResolution;
  tickWindowRef.current = tickWindow;
  tickIndexRef.current = tickIndex;
  tickDayRef.current = tickDay;
  playingRef.current = playing;
  speedRef.current = speed > 0 ? speed : 1;
  cursorRef.current = cursor;
  baseBarsRef.current = baseBars;

  useEffect(() => {
    function clearPlayTimer() {
      if (playTimerRef.current != null) {
        window.clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    }

    if (!playing) {
      playGenRef.current += 1;
      clearPlayTimer();
      return;
    }

    const gen = ++playGenRef.current;
    clearPlayTimer();

    const scheduleNext = () => {
      if (gen !== playGenRef.current) return;
      if (!playingRef.current) return;

      // Wait while an async tick day transition is in flight.
      if (replayResolutionRef.current === "tick" && tickTransitionLockRef.current) {
        playTimerRef.current = window.setTimeout(() => {
          playTimerRef.current = null;
          scheduleNext();
        }, 25);
        return;
      }

      let delayMs = 0;

      if (replayResolutionRef.current === "tick") {
        const win = tickWindowRef.current;
        const idx = tickIndexRef.current;
        if (!win.length) {
          setPlaying(false);
          return;
        }
        const info = tickModeNextDeltaSec(win, idx);
        if (info.atEnd) {
          // May trigger async day load inside stepTick; poll until unlocked or paused.
          stepTickRef.current(1);
          playTimerRef.current = window.setTimeout(() => {
            playTimerRef.current = null;
            if (gen !== playGenRef.current) return;
            if (!playingRef.current) return;
            // If still at end of the same day with no progress, stop.
            // (Must stop here: playingRef may lag setPlaying until the next render.)
            if (
              tickWindowRef.current.length > 0 &&
              tickIndexRef.current >= tickWindowRef.current.length - 1 &&
              !tickTransitionLockRef.current
            ) {
              setPlaying(false);
              return;
            }
            scheduleNext();
          }, 25);
          return;
        }
        delayMs = wallClockDelayMs(info.deltaSec, speedRef.current);
      } else {
        const bars = baseBarsRef.current;
        const len = playLenRef.current;
        const cur = cursorRef.current;
        const step = playStepRef.current;
        if (cur >= len || !bars.length) {
          setPlaying(false);
          return;
        }
        const info = secondsModeNextDeltaSec(bars, cur, step);
        delayMs = wallClockDelayMs(info.deltaSec, speedRef.current);
      }

      playTimerRef.current = window.setTimeout(() => {
        playTimerRef.current = null;
        if (gen !== playGenRef.current) return;
        if (!playingRef.current) return;

        if (replayResolutionRef.current === "tick") {
          const beforeDay = tickDayRef.current;
          const beforeIdx = tickIndexRef.current;
          stepTickRef.current(1);
          // If step could not advance (still same day/index, no lock), stop.
          if (
            !tickTransitionLockRef.current &&
            tickDayRef.current === beforeDay &&
            tickIndexRef.current === beforeIdx &&
            tickWindowRef.current.length > 0 &&
            tickIndexRef.current >= tickWindowRef.current.length - 1
          ) {
            setPlaying(false);
            return;
          }
        } else {
          const len = playLenRef.current;
          const step = playStepRef.current;
          const c = cursorRef.current;
          if (c >= len) {
            setPlaying(false);
            return;
          }
          const next = Math.min(len, c + step);
          cursorRef.current = next;
          setCursor(next);
          if (next >= len) {
            setPlaying(false);
            return;
          }
        }

        // One step per firing — no catch-up burst if the timer was late.
        scheduleNext();
      }, delayMs);
    };

    scheduleNext();

    return () => {
      playGenRef.current += 1;
      clearPlayTimer();
    };
  }, [playing, speed, replayResolution, replayStepSeconds]);

  useEffect(() => {
    if (goToEditing) return; // preserve user datetime edits on desktop
    const b = baseBars[Math.max(0, cursor - 1)];
    if (b) setGoToValue(toLocalInputValue(b.time));
  }, [cursor, baseBars, goToEditing]);


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
      if (indOpen && indPanelRef.current && !indPanelRef.current.contains(t)) setIndOpen(false);
      if (stepOpen && stepPanelRef.current && !stepPanelRef.current.contains(t)) setStepOpen(false);
    }
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [tfOpen, indOpen, stepOpen, drawMenuOpen]);

  // Space = play/pause, ArrowRight/ArrowLeft = step one second. Ignored
  // while typing in an input (symbol search, custom TF box, etc).
  useReplayHotkeys({
    onTogglePlay: () =>
      setPlaying((p) => {
        if (p) return false;
        if (replayResolution === "tick") {
          return tickWindow.length > 0 && tickIndex < tickWindow.length - 1 ? true : p;
        }
        return cursor < baseBars.length ? true : p;
      }),
    onStepForward: () => {
      setPlaying(false);
      if (replayResolution === "tick") {
        stepTickRef.current(1);
        return;
      }
      setCursor((c) => Math.min(baseBars.length, c + Math.max(1, replayStepSeconds)));
    },
    onStepBack: () => {
      setPlaying(false);
      if (replayResolution === "tick") {
        stepTickRef.current(-1);
        return;
      }
      setCursor((c) => Math.max(1, c - Math.max(1, replayStepSeconds)));
    },
    onToggleFollow: () => setFollowPrice((v) => !v),
    onEscape: () => {
      window.dispatchEvent(new Event("tr-cancel-draft"));
      setSelectedShapeId(null);
    },
  });

  useEffect(() => {
    const onEv = (ev: Event) => {
      const text = (ev as CustomEvent<{ text?: string }>).detail?.text;
      if (text) pushWorkspaceEvent(text);
    };
    window.addEventListener("tr-workspace-event", onEv);
    return () => window.removeEventListener("tr-workspace-event", onEv);
  }, []);

  async function loadRange() {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setPlaying(false);
    let localBarsApplied = 0;
    try {
      const local = await cacheGetRange(symbol, start, end);
      if (gen !== loadGenRef.current) return;
      const plan = decideCacheFirstLoad({
        localBarCount: local.bars.length,
        missingDayCount: local.missingDays.length,
        backendOnline,
      });

      // Cache-first: paint device bars before any network call.
      // Desktop builds often report backendOnline=true while private imports
      // only exist in IndexedDB — never block the chart on remote success.
      if (plan.paintLocal && local.bars.length) {
        setBaseBars(local.bars);
        setCursor(Math.min(800, Math.max(1, local.bars.length)));
        setDataSource("loaded");
        localBarsApplied = local.bars.length;
        const d = local.diagnostics;
        recordRangeLoad({
          symbol,
          start,
          end,
          source: local.missingDays.length === 0 ? "local-cache" : "partial-cache",
          barCount: local.bars.length,
          daysHit: d.daysHit,
          daysMiss: d.daysMiss,
          daysEmpty: d.daysEmpty,
          loadMs: d.loadMs,
          sorted: d.sorted,
          at: Date.now(),
        });
        if (plan.doneAfterLocal) {
          setMessage(
            local.missingDays.length === 0
              ? `From device · ${local.bars.length.toLocaleString()} bars · ${local.fromCacheDays.length} day(s) · ${d.loadMs}ms · ${start} → ${end}`
              : `Offline · ${local.fromCacheDays.length} cached day(s) · ${local.bars.length.toLocaleString()} bars`
          );
          return;
        }
        setMessage(
          `From device · ${local.bars.length.toLocaleString()} bars · ${local.fromCacheDays.length} day(s), missing ${local.missingDays.length}…`
        );
      }

      if (!plan.fetchRemote) {
        if (gen !== loadGenRef.current) return;
        if (!local.bars.length) setMessage("No cache · backend offline");
        return;
      }

      // Online: only fill gaps. On failure keep already-painted local bars.
      try {
        const res = await fetchBars(symbol, 1, start, end);
        if (gen !== loadGenRef.current) return;
        if (!res.bars.length && !local.bars.length) {
          setMessage(`No data · Sync in Data Engine first`);
          return;
        }
        if (!res.bars.length) {
          setMessage(
            `From device · ${local.bars.length.toLocaleString()} bars · remote had no extra days`
          );
          return;
        }
        const merged = normalizeBars([...local.bars, ...res.bars]).bars;
        if (gen !== loadGenRef.current) return;
        setBaseBars(merged);
        setCursor(Math.min(800, Math.max(1, merged.length)));
        setDataSource("loaded");
        const d = local.diagnostics;
        recordRangeLoad({
          symbol,
          start,
          end,
          source: "backend-merge",
          barCount: merged.length,
          daysHit: d.daysHit,
          daysMiss: d.daysMiss,
          daysEmpty: d.daysEmpty,
          loadMs: d.loadMs,
          sorted: true,
          at: Date.now(),
        });
        const daysSaved = await cachePutBars(symbol, merged);
        if (gen !== loadGenRef.current) return;
        setMessage(
          `Loaded ${merged.length.toLocaleString()} · saved ${daysSaved} day(s) on device`
        );
      } catch (netErr) {
        if (gen !== loadGenRef.current) return;
        if (localBarsApplied > 0) {
          setMessage(
            `Network failed · showing ${localBarsApplied.toLocaleString()} local bars`
          );
        } else {
          setMessage(netErr instanceof Error ? netErr.message : "Load failed");
        }
      }
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setMessage(e instanceof Error ? e.message : "Load failed");
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
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
    setGoToEditing(false);
    const target = Math.floor(new Date(goToValue).getTime() / 1000);
    if (!Number.isFinite(target)) return;
    // C1.1: always sync Tick window/index when Tick mode is active (via navigate ref).
    void navigateReplayToUnixTimeRef.current(target);
  }

  /**
   * Session navigation (not same-day time jump).
   * First click: jump to this session's start on the current calendar day if still ahead
   * of the cursor; otherwise the next occurrence in available bars.
   * Subsequent clicks after that session has passed: next trading day's occurrence.
   * Timezones: Asia/Tokyo, Europe/London, America/New_York (DST-aware via Intl).
   */
  function jumpSession(kind: "tokyo" | "london" | "ny") {
    if (!baseBars.length) return;
    setPlaying(false);
    const cur = baseBars[Math.max(0, cursor - 1)] ?? baseBars[0];
    const curSec = cur.time;
    const tz =
      kind === "tokyo" ? "Asia/Tokyo" : kind === "london" ? "Europe/London" : "America/New_York";
    const startHour = kind === "ny" ? 9 : kind === "london" ? 8 : 9;
    const startMin = kind === "ny" ? 30 : 0;

    function localParts(unixSec: number) {
      const d = new Date(unixSec * 1000);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = fmt.formatToParts(d);
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
      return {
        y: get("year"),
        m: get("month"),
        day: get("day"),
        hour: get("hour"),
        minute: get("minute"),
      };
    }

    /** Approximate unix for local y-m-d H:M in tz by binary search on bars/time. */
    function localWallToUnix(y: number, m: number, day: number, hour: number, minute: number): number {
      // Seed: treat as UTC then refine using Intl offset
      let guess = Math.floor(Date.UTC(y, m - 1, day, hour, minute, 0, 0) / 1000);
      for (let i = 0; i < 8; i++) {
        const lp = localParts(guess);
        const targetMin = hour * 60 + minute;
        const actualMin = lp.hour * 60 + lp.minute;
        let dayDelta =
          Date.UTC(y, m - 1, day) - Date.UTC(lp.y, lp.m - 1, lp.day);
        dayDelta = Math.round(dayDelta / 86400000);
        const minDelta = dayDelta * 1440 + (targetMin - actualMin);
        if (minDelta === 0) break;
        guess += minDelta * 60;
      }
      return guess;
    }

    function addLocalDays(y: number, m: number, day: number, add: number) {
      const dt = new Date(Date.UTC(y, m - 1, day + add));
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
    }

    const lp = localParts(curSec);
    // If we are still before today's session start → go there; else next day onward
    const todayStart = localWallToUnix(lp.y, lp.m, lp.day, startHour, startMin);
    let searchFrom = todayStart;
    // Already at/past this session start (with 1s tolerance) → next day
    if (curSec >= todayStart - 1) {
      const n = addLocalDays(lp.y, lp.m, lp.day, 1);
      searchFrom = localWallToUnix(n.y, n.m, n.day, startHour, startMin);
    }

    // Walk forward up to ~14 calendar days until we land on/after a bar
    let target = searchFrom;
    for (let d = 0; d < 14; d++) {
      const cand =
        d === 0
          ? searchFrom
          : (() => {
              const base = localParts(searchFrom);
              const n = addLocalDays(base.y, base.m, base.day, d);
              return localWallToUnix(n.y, n.m, n.day, startHour, startMin);
            })();
      if (cand > curSec) {
        target = cand;
        // Prefer first candidate that exists in bar range or is after last bar end
        if (cand <= baseBars[baseBars.length - 1].time + 86400) {
          target = cand;
          break;
        }
      }
    }

    let lo = 0;
    let hi = baseBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (baseBars[mid].time < target) lo = mid + 1;
      else hi = mid;
    }
    // If exact target is in the past relative to found index, step to next bar
    if (baseBars[lo] && baseBars[lo].time <= curSec && lo + 1 < baseBars.length) {
      lo = lo + 1;
    }
    const newCursor = Math.min(baseBars.length, Math.max(1, lo + 1));
    const mapT = baseBars[Math.max(0, newCursor - 1)]?.time ?? target;
    void navigateReplayToUnixTimeRef.current(mapT, { cursor: newCursor });
    setMessage(
      `Session → ${kind === "ny" ? "New York" : kind === "london" ? "London" : "Tokyo"} next start`
    );
    setSessionMenuOpen(false);
  }

  /** Jump to next occurrence of a custom local wall-clock time (timezone-aware). */
  function jumpCustomSession(tz: string, startHHMM: string, label: string) {
    if (!baseBars.length) return;
    const m = startHHMM.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      setMessage("Custom session: use HH:MM start time");
      return;
    }
    const startHour = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const startMin = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    setPlaying(false);
    const cur = baseBars[Math.max(0, cursor - 1)] ?? baseBars[0];
    const curSec = cur.time;

    function localParts(unixSec: number) {
      const d = new Date(unixSec * 1000);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = fmt.formatToParts(d);
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
      return { y: get("year"), m: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
    }
    function localWallToUnix(y: number, mo: number, day: number, hour: number, minute: number): number {
      let guess = Math.floor(Date.UTC(y, mo - 1, day, hour, minute, 0, 0) / 1000);
      for (let i = 0; i < 8; i++) {
        const lp = localParts(guess);
        const targetMin = hour * 60 + minute;
        const actualMin = lp.hour * 60 + lp.minute;
        let dayDelta = Date.UTC(y, mo - 1, day) - Date.UTC(lp.y, lp.m - 1, lp.day);
        dayDelta = Math.round(dayDelta / 86400000);
        const minDelta = dayDelta * 1440 + (targetMin - actualMin);
        if (minDelta === 0) break;
        guess += minDelta * 60;
      }
      return guess;
    }
    function addLocalDays(y: number, mo: number, day: number, add: number) {
      const dt = new Date(Date.UTC(y, mo - 1, day + add));
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
    }

    const lp = localParts(curSec);
    const todayStart = localWallToUnix(lp.y, lp.m, lp.day, startHour, startMin);
    let searchFrom = todayStart;
    if (curSec >= todayStart - 1) {
      const n = addLocalDays(lp.y, lp.m, lp.day, 1);
      searchFrom = localWallToUnix(n.y, n.m, n.day, startHour, startMin);
    }
    let target = searchFrom;
    for (let d = 0; d < 14; d++) {
      const cand =
        d === 0
          ? searchFrom
          : (() => {
              const base = localParts(searchFrom);
              const n = addLocalDays(base.y, base.m, base.day, d);
              return localWallToUnix(n.y, n.m, n.day, startHour, startMin);
            })();
      if (cand > curSec) {
        target = cand;
        if (cand <= baseBars[baseBars.length - 1].time + 86400) {
          target = cand;
          break;
        }
      }
    }
    let lo = 0;
    let hi = baseBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (baseBars[mid].time < target) lo = mid + 1;
      else hi = mid;
    }
    if (baseBars[lo] && baseBars[lo].time <= curSec && lo + 1 < baseBars.length) lo = lo + 1;
    const newCursor = Math.min(baseBars.length, Math.max(1, lo + 1));
    const mapT = baseBars[Math.max(0, newCursor - 1)]?.time ?? target;
    void navigateReplayToUnixTimeRef.current(mapT, { cursor: newCursor });
    setMessage(`Session → ${label || "Custom"} next start (${tz} ${startHHMM})`);
    setSessionMenuOpen(false);
    setCustomSessionOpen(false);
    try {
      localStorage.setItem(
        "tr-custom-session-v1",
        JSON.stringify({ name: label, tz, start: startHHMM, end: customEnd })
      );
    } catch {
      /* */
    }
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
    if (replayResolution === "tick") setReplayResolution("seconds");
    setMessage(`Replay step ${formatTf(sec)}`);
  }

  
  function pushWorkspaceEvent(text: string, timeSec?: number) {
    const tsec = timeSec ?? baseBars[Math.max(0, cursor - 1)]?.time ?? Math.floor(Date.now() / 1000);
    setWorkspaceLog((prev) => [{ t: tsec, text }, ...prev].slice(0, 40));
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
    const rMultEarly = rMultiple(closed.side, closed.entry.price, closed.stop.price, closed.exitPrice);
    const actualRiskEarly = num("actualRiskAmount") ?? num("riskAmount") ?? null;
    const ccyEarly =
      rMultEarly != null && actualRiskEarly != null && Number.isFinite(actualRiskEarly)
        ? rMultEarly * actualRiskEarly
        : null;
    const balBefore = num("balanceBefore") ?? num("balance") ?? acc?.balance;
    const balAfter =
      balBefore != null && ccyEarly != null && Number.isFinite(ccyEarly) ? balBefore + ccyEarly : null;
    const rewardAmt =
      rMultEarly != null && actualRiskEarly != null && rMultEarly > 0
        ? rMultEarly * actualRiskEarly
        : null;
    const propSnap = (snap as any)?.propRuleSnapshot;

    const localTrade = {
      id: `replay-${closed.id}-${closed.exitTime}`,
      tradeId: `replay-${closed.id}-${closed.exitTime}`,
      symbol,
      side: closed.side,
      orderType: closed.orderType,
      entryPrice: closed.entry.price,
      exitPrice: closed.exitPrice,
      stopPrice: closed.stop.price,
      takeProfitPrice: closed.takeProfit.price,
      entryTime: closed.entry.time,
      exitTime: closed.exitTime,
      reason: (closed.reason === "sl" || closed.reason === "tp" ? closed.reason : "manual") as "sl" | "tp" | "manual",
      pnlPoints: closed.pnlPoints,
      rMultiple: rMultEarly,
      note,
      accountId: (snap?.accountId as string) || acc?.accountId,
      balanceBefore: balBefore,
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
      targetRiskPercent: num("riskPercent") ?? riskPercent ?? null,
      rewardAmount: rewardAmt,
      rewardPercent:
        balBefore && rewardAmt != null && balBefore > 0 ? (rewardAmt / balBefore) * 100 : null,
      currencyPnL: ccyEarly,
      balanceAfter: balAfter,
      marginUsed: num("marginRequired") ?? null,
      pointValue: num("pointValue") ?? null,
      slDistance: num("slDistance") ?? Math.abs(closed.entry.price - closed.stop.price),
      tpDistance: num("tpDistance") ?? Math.abs(closed.takeProfit.price - closed.entry.price),
      durationSeconds: Math.max(0, closed.exitTime - closed.entry.time),
      snapshot: snap as any,
      closeScreenshot: closed.screenshot,
      entryScreenshot: closed.entryScreenshot,
      fillStatus: "closed" as const,
      entrySource: closed.orderType === "market" ? "market" : "pending_fill",
      accountType: (acc?.accountType as "personal" | "prop") || "personal",
      propFirmName: propSnap?.propFirmName || acc?.propFirmName,
      propProgramName: propSnap?.propProgramName || acc?.propProgramName,
      propPhaseId: propSnap?.phaseId || acc?.activePropPhaseId,
      propPhaseName: propSnap?.phaseName,
      createdAt: Date.now(),
    };
    auditJournalEvent("position_closed", {
      id: localTrade.id,
      reason: localTrade.reason,
      side: localTrade.side,
    });
    // v3.43.9: optional compact HTF bar snapshots (no look-ahead; uses same aggregateVisible)
    let htfSnapshots = undefined as ReturnType<typeof buildHtfSnapshots> | undefined;
    try {
      const cfg = normalizeJournalSnapshotConfig(sessionMeta?.journalSnapshotConfig);
      const reason = localTrade.reason as "sl" | "tp" | "manual";
      const wantClose =
        cfg.enabled &&
        ((reason === "tp" && cfg.atClose.tp) ||
          (reason === "sl" && cfg.atClose.sl) ||
          (reason === "manual" && cfg.atClose.manual));
      if (wantClose && cfg.timeframes.length && baseBars.length) {
        const cursorIdx = Math.max(0, Math.min(cursor, baseBars.length));
        htfSnapshots = buildHtfSnapshots({
          bars1s: baseBars,
          cursorIndex: cursorIdx,
          timeframes: cfg.timeframes,
          event: reason,
          eventTimeUnix: closed.exitTime || baseBars[Math.max(0, cursorIdx - 1)]?.time || 0,
          entry: closed.entry.price,
          sl: closed.stop.price,
          tp: closed.takeProfit.price,
          exit: closed.exitPrice,
          aggregateVisible,
        });
      }
    } catch {
      htfSnapshots = undefined;
    }

    // Session IndexedDB is source of truth; idempotent on tradeId
    await appendTradeAsync({
      ...localTrade,
      ...(htfSnapshots && htfSnapshots.length ? { htfSnapshots } : {}),
      sessionId: sessionIdRef.current || undefined,
    });

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
      if (sessionMeta && ownerId) {
        const full = ensureSessionAccounts(sessionMeta);
        const replayTs = closed.exitTime || baseBars[Math.max(0, cursor - 1)]?.time || 0;
        const tradeLike = {
          accountId: ownerId,
          phaseId: (localTrade as any).snapshot?.propRuleSnapshot?.phaseId || (localTrade as any).phaseId,
          entryTime: localTrade.entryTime,
          exitTime: localTrade.exitTime,
          currencyPnL: ccy,
          rMultiple: localTrade.rMultiple,
          actualRiskAmount: localTrade.actualRiskAmount,
          riskAmount: localTrade.riskAmount,
          pnlPoints: localTrade.pnlPoints,
          finalLot: localTrade.finalLot,
        };
        // CRITICAL: daily loss is same-day AGGREGATE — load all prior session trades + this close.
        const sid = sessionIdRef.current;
        const priorRaw = sid ? await loadJournalForSession(sid) : [];
        const priorLike = (priorRaw || []).map((tr: any) => ({
          accountId: tr.accountId,
          phaseId: tr.phaseId || tr.snapshot?.propRuleSnapshot?.phaseId,
          entryTime: tr.entryTime ?? tr.opened_at ?? 0,
          exitTime: tr.exitTime ?? tr.closed_at,
          currencyPnL:
            tr.currencyPnL ??
            (tr.rMultiple != null && tr.actualRiskAmount != null
              ? tr.rMultiple * tr.actualRiskAmount
              : undefined),
          rMultiple: tr.rMultiple,
          actualRiskAmount: tr.actualRiskAmount,
          riskAmount: tr.riskAmount,
          pnlPoints: tr.pnlPoints,
          finalLot: tr.finalLot,
        }));
        // De-dupe by exitTime+accountId+entryTime if the just-closed trade was already appended async
        const allTrades = [...priorLike, tradeLike];

        let nextAccounts = (full.accounts || []).map((a) => {
          if (a.accountId !== ownerId) return a;
          let updated = Number.isFinite(ccy) && ccy !== 0 ? applyRealizedPnL(a, ccy) : a;
          const suggested = suggestLifecycleTransitions({
            account: updated,
            events: updated.lifecycleEvents,
            trades: allTrades,
            replayTime: replayTs,
          });
          if (suggested.length) {
            updated = appendLifecycleEvents(updated, suggested);
            updated = applyPhaseFromLifecycle(updated, updated.lifecycleEvents || [], replayTs);
            // Phase pass / FUNDED: working equity resets to the *next* phase baseline (accountSize).
            // Phase 1 profit must NOT carry into Phase 2 or FUNDED (v3.19.3).
            const fundedEv = suggested.find((e) => e.type === "FUNDED");
            const passedEv = suggested.filter((e) => e.type === "PHASE_PASSED").pop();
            const startedEv = suggested.filter((e) => e.type === "PHASE_STARTED").pop();
            if (fundedEv) {
              const size =
                updated.propProgram?.phases?.find((p) => p.type === "funded")?.rules?.accountSize ||
                updated.propProgram?.phases?.find((p) => p.id === updated.activePropPhaseId)?.rules?.accountSize ||
                updated.propProgram?.phases?.find((p) => p.id === fundedEv.phaseId)?.rules?.accountSize ||
                updated.initialBalance ||
                0;
              if (size > 0) {
                updated = { ...updated, balance: size, initialBalance: size };
              }
            } else if (passedEv || startedEv) {
              // Next challenge phase baseline = that phase accountSize
              const nextId =
                startedEv?.phaseId ||
                updated.activePropPhaseId ||
                passedEv?.phaseId;
              const nextPhase = updated.propProgram?.phases?.find((p) => p.id === nextId);
              const size =
                nextPhase?.rules?.accountSize ||
                updated.initialBalance ||
                0;
              if (size > 0) {
                updated = { ...updated, balance: size };
              }
            }
          }
          return updated;
        });
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
    if ((t === "long" || t === "short") && sessionMeta) {
      const full = ensureSessionAccounts(sessionMeta);
      const acc = getActiveAccount(full);
      const replayTs = currentBase?.time ?? 0;
      if (acc && (acc.accountType || "personal") === "prop" && !canOpenNewTrades(acc, acc.lifecycleEvents, replayTs)) {
        const d = deriveLifecycleFromEvents(acc, acc.lifecycleEvents, replayTs);
        setMessage(`Orders blocked · ${d.state}${d.reasons.length ? " · " + d.reasons[0] : ""}`);
        return;
      }
    }
    setDrawTool(t);
  }

  function confirmOrder() {
    if (sessionMeta) {
      const full = ensureSessionAccounts(sessionMeta);
      const acc = getActiveAccount(full);
      const replayTs = currentBase?.time ?? 0;
      if (acc && (acc.accountType || "personal") === "prop") {
        if (!canOpenNewTrades(acc, acc.lifecycleEvents, replayTs)) {
          const d = deriveLifecycleFromEvents(acc, acc.lifecycleEvents, replayTs);
          setMessage(`Orders blocked · ${d.state}${d.reasons.length ? " · " + d.reasons[0] : ""}`);
          return;
        }
      }
    }
    window.dispatchEvent(new Event("tr-confirm-position"));
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
  // Read-only window metrics (no trading side effects)
  useEffect(() => {
    const prev = prevCursorRef.current;
    const lo = Math.min(prev, cursor);
    const hi = Math.max(prev, cursor);
    recordReplayWindow({
      baseBars: baseBars.length,
      displayCandles: visibleBars.length,
      execWindow: Math.max(0, hi - lo) || (baseBars.length ? 1 : 0),
      cursor,
      timeframeSeconds,
      replayStepSeconds,
      note:
        baseBars.length > 500_000
          ? "Large working set in memory; display still windowed (~1200 candles)"
          : undefined,
    });
  }, [baseBars.length, visibleBars.length, cursor, timeframeSeconds, replayStepSeconds]);
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
  const atEnd =
    replayResolution === "tick"
      ? !tickWindow.length || tickIndex >= tickWindow.length - 1
      : cursor >= baseBars.length;

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


  // —— Phase C1 Tick Replay (same engine; execution still 1s) ——
  const activeTick: TickRecord | null =
    replayResolution === "tick" && tickWindow.length
      ? tickWindow[Math.max(0, Math.min(tickIndex, tickWindow.length - 1))] ?? null
      : null;

  const loadTickDay = useCallback(
    async (day: string): Promise<{ ticks: TickRecord[]; symbolUsed: string } | null> => {
      const gen = ++tickLoadGenRef.current;
      const got = await tickCacheGetDayWithAlias(symbol, day);
      if (gen !== tickLoadGenRef.current) return null;
      if (!got || got.row.complete === false) return null;
      const ticks = sortTicksStable(got.row.ticks || []);
      if (!ticks.length) return null;
      return { ticks, symbolUsed: got.symbolUsed };
    },
    [symbol]
  );

  // Eligibility: any complete tick day (metadata only) intersecting loaded bar calendar range
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!baseBars.length) {
        if (!cancelled) setTickEligible(false);
        return;
      }
      const startDay = unixToUtcDay(baseBars[0].time);
      const endDay = unixToUtcDay(baseBars[baseBars.length - 1].time);
      const listed = await tickCacheListCompleteDaysWithAlias(symbol);
      if (cancelled) return;
      const completeDays = listed.map((r) => r.day);
      const ok = hasEligibleTickDayInRange(completeDays, startDay, endDay);
      setTickEligible(ok);
      if (ok && listed.length) {
        // Prefer symbol actually used on a day inside the range
        const rangeSet = new Set(enumerateUtcDaysInclusive(startDay, endDay));
        const hit = listed.find((r) => rangeSet.has(r.day));
        if (hit) setTickSymbolUsed(hit.symbol);
      }
      if (!ok && replayResolution === "tick") {
        setReplayResolution("seconds");
        setTickWindow([]);
        setTickDay(null);
        tickTransitionLockRef.current = false;
        setMessage("Tick data unavailable for this range · switched to 1s step");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, baseBars.length, baseBars[0]?.time, baseBars[baseBars.length - 1]?.time, replayResolution]);

  const syncBarsCursorFromTickTime = useCallback(
    (t: number) => {
      if (!baseBars.length) return;
      const c = mapTickTimeToBars1sCursor(baseBars, t);
      setCursor(c);
    },
    [baseBars]
  );

  const applyTickWindow = useCallback(
    (ticks: TickRecord[], day: string, index: number, symbolUsed: string) => {
      const sorted = sortTicksStable(ticks);
      const i = Math.max(0, Math.min(index, Math.max(0, sorted.length - 1)));
      setTickWindow(sorted);
      setTickDay(day);
      setTickIndex(i);
      setTickSymbolUsed(symbolUsed);
      tickWindowRef.current = sorted;
      tickDayRef.current = day;
      tickIndexRef.current = i;
      if (sorted[i]) syncBarsCursorFromTickTime(sorted[i].time);
    },
    [syncBarsCursorFromTickTime]
  );

  /**
   * C1.1 — Unified time navigation for 1s + Tick.
   * Always updates the 1s cursor; when Tick mode is active also remaps tick day/window/index
   * so Next/Previous cannot continue from a stale tick region after Jump To.
   */
  const navigateReplayToUnixTime = useCallback(
    async (targetUnixSec: number, opts?: { cursor?: number }) => {
      setPlaying(false);
      if (!baseBars.length || !Number.isFinite(targetUnixSec)) return;

      const newCursor =
        opts?.cursor != null
          ? Math.min(baseBars.length, Math.max(1, opts.cursor))
          : findBars1sCursorForUnixTime(baseBars, targetUnixSec);
      setCursor(newCursor);

      // Invalidate in-flight tick day loads and prior navigations.
      const navGen = ++tickNavGenRef.current;
      tickLoadGenRef.current += 1;
      // Drop locks held by abandoned day-boundary stepTick loads.
      tickTransitionLockRef.current = false;

      if (replayResolutionRef.current !== "tick") return;

      const day = unixToUtcDay(targetUnixSec);

      const applyMapped = (ticks: TickRecord[], d: string, symbolUsed: string) => {
        if (!shouldApplyTickNav(tickNavGenRef.current, navGen)) return;
        const idx = mapTimeToTickIndex(ticks, targetUnixSec);
        applyTickWindow(ticks, d, idx, symbolUsed);
      };

      // Fast path: target day already loaded
      if (tickDayRef.current === day && tickWindowRef.current.length > 0) {
        applyMapped(
          tickWindowRef.current,
          day,
          tickSymbolUsed ?? symbol
        );
        return;
      }

      tickTransitionLockRef.current = true;
      try {
        const loaded = await loadTickDay(day);
        if (!shouldApplyTickNav(tickNavGenRef.current, navGen)) return;
        if (!loaded) {
          // Fail safe: drop stale tick window so activeTick cannot point at the old day.
          setTickWindow([]);
          setTickDay(null);
          setTickIndex(0);
          tickWindowRef.current = [];
          tickDayRef.current = null;
          tickIndexRef.current = 0;
          setMessage(
            `No tick data for ${day} · 1s cursor updated · Tick window cleared`
          );
          return;
        }
        applyMapped(loaded.ticks, day, loaded.symbolUsed);
      } finally {
        if (shouldApplyTickNav(tickNavGenRef.current, navGen)) {
          tickTransitionLockRef.current = false;
        }
      }
    },
    [applyTickWindow, baseBars, loadTickDay, symbol, tickSymbolUsed]
  );

  navigateReplayToUnixTimeRef.current = navigateReplayToUnixTime;

  const stepTick = useCallback(
    (dir: number) => {
      // Ignore further steps while a day transition / navigation load is in flight.
      if (tickTransitionLockRef.current) return;

      const win = tickWindowRef.current;
      const idx = tickIndexRef.current;
      const day = tickDayRef.current;
      if (!win.length || !day) {
        setPlaying(false);
        return;
      }
      const next = idx + dir;
      if (next >= 0 && next < win.length) {
        setTickIndex(next);
        tickIndexRef.current = next;
        const t = win[next];
        if (t) syncBarsCursorFromTickTime(t.time);
        return;
      }
      // Day boundary — exclusive lock until load completes
      const targetDay = dir > 0 ? nextUtcDay(day) : prevUtcDay(day);
      const navGenAtStart = tickNavGenRef.current;
      tickTransitionLockRef.current = true;
      void (async () => {
        try {
          const loaded = await loadTickDay(targetDay);
          // A Jump To that started after this step must win.
          if (!shouldApplyTickNav(tickNavGenRef.current, navGenAtStart)) return;
          if (!loaded) {
            setPlaying(false);
            setMessage(
              dir > 0
                ? `No tick data for ${targetDay} · paused`
                : `No earlier tick day before ${day} · paused`
            );
            return;
          }
          const newIdx = dir > 0 ? 0 : loaded.ticks.length - 1;
          applyTickWindow(loaded.ticks, targetDay, newIdx, loaded.symbolUsed);
        } finally {
          if (shouldApplyTickNav(tickNavGenRef.current, navGenAtStart)) {
            tickTransitionLockRef.current = false;
          } else {
            // Newer navigation owns the lock lifecycle.
          }
        }
      })();
    },
    [applyTickWindow, loadTickDay, syncBarsCursorFromTickTime]
  );

  stepTickRef.current = stepTick;

  const enterTickMode = useCallback(async () => {
    setPlaying(false);
    const bar = baseBars[Math.max(0, cursor - 1)];
    if (!bar) {
      setMessage("Load 1s data before Tick replay");
      return;
    }
    const day = unixToUtcDay(bar.time);
    const loaded = await loadTickDay(day);
    if (!loaded) {
      setTickEligible(false);
      setMessage(
        "Tick Replay needs imported tick data for this symbol/day. Only 1-second OHLC is available."
      );
      return;
    }
    const idx = mapTimeToTickIndex(loaded.ticks, bar.time);
    applyTickWindow(loaded.ticks, day, idx, loaded.symbolUsed);
    setReplayResolution("tick");
    setTickEligible(true);
    setMessage(
      `Tick Replay · ${loaded.ticks.length.toLocaleString()} ticks on ${day} · execution still uses 1s OHLC`
    );
  }, [applyTickWindow, baseBars, cursor, loadTickDay]);

  const exitTickMode = useCallback(() => {
    setPlaying(false);
    const t = tickWindowRef.current[tickIndexRef.current]?.time;
    if (t != null) syncBarsCursorFromTickTime(t);
    setReplayResolution("seconds");
    setMessage("Replay step: 1s bars (Tick mode off)");
  }, [syncBarsCursorFromTickTime]);

  const STEP_PRESETS = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];




  useEffect(() => {
    const sid = sessionMeta?.id || getActiveSessionId();
    let cancelled = false;
    void loadJournalForSession(sid).then((rows) => {
      if (cancelled) return;
      setPropTrades(
        (rows || []).map((tr) => ({
          accountId: tr.accountId,
          entryTime: tr.entryTime,
          exitTime: tr.exitTime,
          currencyPnL:
            tr.actualRiskAmount != null && tr.rMultiple != null
              ? tr.rMultiple * tr.actualRiskAmount
              : undefined,
          rMultiple: tr.rMultiple,
          actualRiskAmount: tr.actualRiskAmount,
          riskAmount: tr.riskAmount,
          pnlPoints: tr.pnlPoints,
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [sessionMeta?.id, shapes]);

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
  // Brief 01: tick size of the active instrument (drag snapping, decimals, tick counts on the chart).
  const chartTickSize = useMemo(() => {
    const inst = (sessionMeta ? ensureSessionAccounts(sessionMeta).instrument : null) || defaultInstrument(symbol);
    return inst.tickSize > 0 ? inst.tickSize : 0.01;
  }, [sessionMeta, symbol]);

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
      const lev = getEffectiveLeverage(account);
      const accountForRisk = lev !== account.leverage ? { ...account, leverage: lev } : account;
      // Sum margin of other open positions on the same account (personal + prop)
      let usedMargin = 0;
      for (const s of shapes) {
        if (s.kind !== "position" || s.status !== "open") continue;
        if (s.id === pos.id) continue;
        const owner = s.accountId || account.accountId;
        if (owner !== account.accountId) continue;
        const lot = Number((s.riskSnapshot as any)?.finalLot);
        if (!(lot > 0)) continue;
        const levSnap = Math.max(1, Number((s.riskSnapshot as any)?.leverage) || lev);
        usedMargin += (s.entry.price * (instrument.contractSize || 1) * lot) / levSnap;
      }
      // v3.47: per-position risk frozen on draft beats live order-panel values
      const posRisk = (pos as { risk?: { mode?: string; percent?: number; amount?: number; lot?: number } }).risk;
      const mode = (posRisk?.mode as string) || orderRiskMode || account.riskMode || "percent_equity";
      const pct =
        posRisk?.percent != null && Number.isFinite(posRisk.percent)
          ? posRisk.percent
          : mode === "percent_equity" || mode === "percent_balance"
            ? account.riskPercent != null && Number.isFinite(account.riskPercent)
              ? account.riskPercent
              : riskPercent
            : riskPercent;
      const result = calculateRisk({
        account: accountForRisk,
        instrument,
        riskPercent: pct,
        entryPrice: pos.entry.price,
        stopPrice: pos.stop.price,
        takeProfitPrice: pos.takeProfit.price,
        side: pos.side,
        usedMargin,
        riskMode: (mode as "percent_equity" | "percent_balance" | "fixed_money" | "fixed_lot"),
        fixedRiskAmount:
          mode === "fixed_money"
            ? (posRisk?.amount != null ? posRisk.amount : Number(fixedRiskInput) || account.fixedRiskAmount)
            : account.fixedRiskAmount,
        fixedLot:
          mode === "fixed_lot"
            ? (posRisk?.lot != null ? posRisk.lot : Number(fixedLotInput) || account.fixedLot)
            : account.fixedLot,
      });
      const propSnap = buildPropRuleSnapshot(account);
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
        // Brief 01: store the mode/values ACTUALLY used for this snapshot (was: the order panel's mode,
        // which could differ from the position's own risk input).
        riskMode: mode,
        fixedRiskAmount:
          mode === "fixed_money"
            ? (posRisk?.amount != null ? posRisk.amount : Number(fixedRiskInput) || account.fixedRiskAmount)
            : account.fixedRiskAmount,
        fixedLot:
          mode === "fixed_lot"
            ? (posRisk?.lot != null ? posRisk.lot : Number(fixedLotInput) || account.fixedLot)
            : account.fixedLot,
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
        actualRewardPercent: result.actualRewardPercent,
        potentialProfit: result.potentialProfit,
        rr: result.rr,
        marginConstrained: result.marginConstrained,
        targetRiskPercent: result.targetRiskPercent,
        usedMargin,
        entryTime: pos.entry.time,
        // Debug sizing breakdown (persisted in journal snapshot)
        sizingDebug: {
          riskBasedLot: result.riskBasedLot,
          marginMaxLot: result.marginMaxLot,
          finalLot: result.finalLot,
          marginRequired: result.marginRequired,
          freeMargin: result.freeMargin,
          usedMargin,
          equity: result.equity,
          leverage: result.leverage,
        },
        ...(propSnap ? { propRuleSnapshot: propSnap } : {}),
      };
    },
    [sessionMeta, riskPercent, symbol, shapes, orderRiskMode, fixedRiskInput, fixedLotInput]
  );

  const activeAccount = useMemo(() => {
    if (!sessionMeta) return null;
    const full = ensureSessionAccounts(sessionMeta);
    return full.accounts?.find((a) => a.accountId === full.activeAccountId) || null;
  }, [sessionMeta]);

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
    // Margin already committed by OTHER open positions on this account
    let usedMargin = 0;
    for (const s of shapes) {
      if (s.kind !== "position" || s.status !== "open") continue;
      if (s.id === p.id) continue;
      const owner = s.accountId || account.accountId;
      if (owner !== account.accountId) continue;
      const lot = Number((s.riskSnapshot as any)?.finalLot);
      if (!(lot > 0)) continue;
      const lev = Math.max(1, Number((s.riskSnapshot as any)?.leverage) || account.leverage || 1);
      usedMargin += (s.entry.price * (instrument.contractSize || 1) * lot) / lev;
    }
    const mode = account.riskMode || "percent_equity";
    const pct =
      mode === "percent_equity"
        ? account.riskPercent != null && Number.isFinite(account.riskPercent)
          ? account.riskPercent
          : riskPercent
        : riskPercent;
    const result = calculateRisk({
      account,
      instrument,
      riskPercent: pct,
      entryPrice: p.entry.price,
      stopPrice: p.stop.price,
      takeProfitPrice: p.takeProfit.price,
      side: p.side,
      usedMargin,
      riskMode: mode,
      fixedRiskAmount: account.fixedRiskAmount,
      fixedLot: account.fixedLot,
    });
    lastRiskSnapshotRef.current = result;
    return result;
  }, [sessionMeta, shapes, selectedShapeId, riskPercent, symbol, orderRiskMode, fixedRiskInput, fixedLotInput]);


  function clampReplayBar(x: number, y: number) {
    const el = replayBarRef.current;
    const w = el?.offsetWidth || 320;
    const h = el?.offsetHeight || 48;
    const maxX = Math.max(0, window.innerWidth - w - 8);
    const maxY = Math.max(0, window.innerHeight - h - 8);
    return {
      x: Math.min(maxX, Math.max(8, x)),
      y: Math.min(maxY, Math.max(8, y)),
    };
  }

  function onReplayHandlePointerDown(ev: ReactPointerEvent) {
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    const el = replayBarRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const origX = replayBarPos?.x ?? rect.left;
    const origY = replayBarPos?.y ?? rect.top;
    replayDragRef.current = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      origX,
      origY,
    };
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onReplayHandlePointerMove(ev: ReactPointerEvent) {
    const d = replayDragRef.current;
    if (!d || d.pointerId !== ev.pointerId) return;
    const next = clampReplayBar(
      d.origX + (ev.clientX - d.startX),
      d.origY + (ev.clientY - d.startY)
    );
    setReplayBarPos(next);
    ev.preventDefault();
  }

  function onReplayHandlePointerUp(ev: ReactPointerEvent) {
    const d = replayDragRef.current;
    if (!d || d.pointerId !== ev.pointerId) return;
    replayDragRef.current = null;
    try {
      (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
  }

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

        <div className={`tf-wrap${tfOpen ? " is-open" : ""}`} ref={tfPanelRef}>
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

        <div className={`tools-wrap${indOpen ? " is-open" : ""}`} ref={indPanelRef}>
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


        <div className="session-jump-wrap">
          <button
            type="button"
            className={sessionMenuOpen ? "on" : undefined}
            onClick={() => {
              setSessionMenuOpen((o) => !o);
              setCustomSessionOpen(false);
            }}
            aria-expanded={sessionMenuOpen}
          >
            Session ▾
          </button>
          {sessionMenuOpen && (
            <div className="session-jump-panel panel-top tools-panel" role="menu">
              <button type="button" role="menuitem" onClick={() => jumpSession("tokyo")}>
                Tokyo · 09:00 Asia/Tokyo
              </button>
              <button type="button" role="menuitem" onClick={() => jumpSession("london")}>
                London · 08:00 Europe/London
              </button>
              <button type="button" role="menuitem" onClick={() => jumpSession("ny")}>
                New York · 09:30 America/New_York
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setCustomSessionOpen((o) => !o)}
              >
                Custom…
              </button>
              {customSessionOpen && (
                <div className="session-custom-form">
                  <label>
                    Name
                    <input value={customName} onChange={(e) => setCustomName(e.target.value)} />
                  </label>
                  <label>
                    Timezone
                    <select value={customTz} onChange={(e) => setCustomTz(e.target.value)}>
                      <option value="America/New_York">America/New_York</option>
                      <option value="Europe/London">Europe/London</option>
                      <option value="Asia/Tokyo">Asia/Tokyo</option>
                      <option value="UTC">UTC</option>
                    </select>
                  </label>
                  <label>
                    Start
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                    />
                  </label>
                  <label>
                    End
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="on"
                    onClick={() => jumpCustomSession(customTz, customStart, customName || "Custom")}
                  >
                    Jump to start
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <label className="goto-label">
          Go To
          <input
            type="datetime-local"
            step="1"
            value={goToValue}
            onFocus={() => setGoToEditing(true)}
            onChange={(e) => {
              setGoToEditing(true);
              setGoToValue(e.target.value);
            }}
            onBlur={() => {
              /* keep goToEditing until Jump so cursor ticks do not wipe time edits */
            }}
          />
        </label>
        <button
          type="button"
          className="on"
          onClick={handleGoTo}
        >
          Jump
        </button>
        {goToEditing && (
          <button type="button" className="btn-ghost" onClick={() => {
            setGoToEditing(false);
            const b = baseBars[Math.max(0, cursor - 1)];
            if (b) setGoToValue(toLocalInputValue(b.time));
          }}>
            Reset
          </button>
        )}
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

      <div className="workspace-strip">
        <span className="ws-item">
          <b>Session</b> {sessionMeta?.name || (sessionReady ? "— none —" : "…")}
        </span>
        <span className="ws-item">
          <b>{symbol}</b> {start} → {end}
        </span>
        <span className="ws-item">
          <b>Account</b>{" "}
          {activeAccount
            ? `${activeAccount.name} · ${(activeAccount.balance ?? activeAccount.initialBalance).toLocaleString()} · risk ${riskPercent}%`
            : "—"}
        </span>
        <span className="ws-item muted">{dataSource === "loaded" ? "1s data" : dataSource}</span>
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
          marketPrice={activeTick ? activeTick.mid : currentBase?.close ?? null}
          marketTime={activeTick ? activeTick.time : currentBase?.time ?? null}
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
          barSeconds={timeframeSeconds}
          tickSize={chartTickSize}
          onRequestConfirm={confirmOrder}
          getDraftRisk={() => ({
            mode: orderRiskMode,
            percent: riskPercent,
            amount: Number(fixedRiskInput) || undefined,
            lot: Number(fixedLotInput) || undefined,
          })}
          canFillPosition={(pos, bar) => {
            if (!sessionMeta) return true;
            const full = ensureSessionAccounts(sessionMeta);
            const acc =
              (pos.accountId
                ? full.accounts?.find((a) => a.accountId === pos.accountId)
                : null) || getActiveAccount(full);
            if (!acc || (acc.accountType || "personal") !== "prop") return true;
            return canOpenNewTrades(acc, acc.lifecycleEvents, bar.time);
          }}
        />
      </div>

      <div
        className="replay mobile-scroll replay-float"
        ref={replayBarRef}
        style={
          replayBarPos
            ? { left: replayBarPos.x, top: replayBarPos.y, bottom: "auto", transform: "none" }
            : undefined
        }
      >
        <div
          className="replay-drag-handle"
          title="Drag to move"
          onPointerDown={onReplayHandlePointerDown}
          onPointerMove={onReplayHandlePointerMove}
          onPointerUp={onReplayHandlePointerUp}
          onPointerCancel={onReplayHandlePointerUp}
        >
          ⋮⋮
        </div>
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
            if (replayResolution === "tick") stepTick(-1);
            else setCursor((c) => Math.max(1, c - Math.max(1, replayStepSeconds)));
          }}
          title="←"
        >
          Prev
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            if (replayResolution === "tick") stepTick(1);
            else setCursor((c) => Math.min(baseBars.length, c + Math.max(1, replayStepSeconds)));
          }}
          title="→"
        >
          Next
        </button>
        <div className={`tools-wrap${stepOpen ? " is-open" : ""}`} ref={stepPanelRef}>
          <button type="button" className={stepOpen ? "on" : ""} onClick={() => setStepOpen((v) => !v)}>
            Step {replayResolution === "tick" ? "Tick" : formatTf(replayStepSeconds)} ▾
          </button>
          {stepOpen && (
            <div className="tools-panel panel-bottom">
              <button
                type="button"
                className={replayResolution === "tick" ? "on" : ""}
                disabled={!tickEligible && replayResolution !== "tick"}
                title={
                  tickEligible
                    ? "Advance one imported tick at a time"
                    : "Import tick Parquet for this symbol/range to enable Tick step"
                }
                onClick={() => {
                  void enterTickMode();
                  setStepOpen(false);
                }}
              >
                Tick{tickEligible ? "" : " (no data)"}
              </button>
              {STEP_PRESETS.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className={replayResolution === "seconds" && sec === replayStepSeconds ? "on" : ""}
                  onClick={() => {
                    if (replayResolution === "tick") exitTickMode();
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
              <p className="tools-note">
                {replayResolution === "tick"
                  ? "Tick Replay is active. Trade execution and SL/TP still use 1-second OHLC. Tick-based execution comes later."
                  : "Step moves the 1s cursor. SL/TP still checks every 1s bar inside the jump."}
              </p>
            </div>
          )}
        </div>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[0.25, 0.5, 1, 2, 5, 10].map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
        {/* Range scrubber removed — only floating control buttons remain. */}
        <span className="cursor-count">
          {replayResolution === "tick" && tickWindow.length
            ? `Tick ${(tickIndex + 1).toLocaleString()}/${tickWindow.length.toLocaleString()}${tickDay ? ` · ${tickDay}` : ""}`
            : `${cursor.toLocaleString()}/${baseBars.length.toLocaleString()}s`}
        </span>
      </div>

      <aside className="replay-info">
        <p>
          {activeTick
            ? new Date(activeTick.time * 1000).toISOString().replace("T", " ").replace("Z", " UTC")
            : currentBase
              ? new Date(currentBase.time * 1000).toLocaleString()
              : "—"}
          {activeTick ? ` · mid ${activeTick.mid}` : ""}
        </p>
        <p>
          TF {formatTf(timeframeSeconds)} · Step{" "}
          {replayResolution === "tick" ? "Tick" : formatTf(replayStepSeconds)} · {visibleBars.length} candles · Space
          play/pause · ←/→ step
          {replayResolution === "tick" ? " · exec=1s OHLC" : ""}
        </p>
      </aside>
    </section>
  );
}
