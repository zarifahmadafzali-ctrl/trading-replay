import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { JournalTrade } from "../lib/journal";
import {
  accountFloor,
  clampWindow,
  dailyFloor,
  decimate,
  floorAt,
  formatStamp,
  formatTick,
  fullWindow,
  isFullWindow,
  nearestPointIndex,
  niceTicks,
  normalizePoints,
  panWindow,
  peakAt,
  peakGapAreaD,
  rangeWindow,
  runningPeak,
  stepAreaD,
  stepPathD,
  stepValueAt,
  timeFormatFor,
  timeTicks,
  yDomain,
  zoomWindow,
  type CurvePoint,
  type FloorSeg,
  type RangePreset,
  type Win,
} from "../lib/equityCurveModel";

/**
 * Equity curve (replaces UnifiedEquityPanel). One component for the desktop app AND the mobile PWA.
 *  - FX Replay look: area under a clean line, a dot on every closed trade, date axis, balance axis.
 *  - Prop-dashboard options: vertical crosshair + tooltip with every enabled series, toggles for the
 *    allowed DAILY and ACCOUNT drawdown lines (drawn from the account's prop rules), range buttons, zoom.
 * Data: the closed-trade balance only (steps at each close). Nothing is interpolated.
 */

type Props = {
  points: { time: number; balance: number; pnl: number; tradeId: string; r?: number | null }[];
  trades: JournalTrade[];
  startingBalance: number;
  allowedDailyDdPct: number | null;
  allowedMaxDdPct: number | null;
  /** MUST be the same trading-day function the prop rules use (timezone / reset hour). Default: UTC day. */
  dayKeyOf?: (unixSec: number) => string;
  /** Optional IANA time zone for axis labels (default: the device's). */
  timeZone?: string;
};

const ACCENT = "#3b82f6";
const DAILY = "#f59e0b";
const ACCOUNT = "#ef4444";
const PEAK = "#9ca3af";
const OPTS_KEY = "tr-equity-opts-v1";
const utcDay = (t: number) => String(Math.floor(t / 86400));

type Opts = { daily: boolean; account: boolean; peak: boolean };
const DEFAULT_OPTS: Opts = { daily: true, account: true, peak: false };

function loadOpts(): Opts {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(OPTS_KEY) : null;
    if (!raw) return DEFAULT_OPTS;
    const o = JSON.parse(raw) as Partial<Opts>;
    return { daily: o.daily !== false, account: o.account !== false, peak: o.peak === true };
  } catch {
    return DEFAULT_OPTS;
  }
}

const fmtMoney = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSigned = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))}`;

const box: CSSProperties = { position: "relative", width: "100%", userSelect: "none", WebkitUserSelect: "none" };
const bar: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 6 };
const seg: CSSProperties = { display: "inline-flex", border: "1px solid rgba(128,128,128,0.35)", borderRadius: 8, overflow: "hidden" };
const btnBase: CSSProperties = {
  minWidth: 36,
  height: 34,
  padding: "0 10px",
  background: "transparent",
  color: "inherit",
  border: 0,
  cursor: "pointer",
  font: "inherit",
};

export function EquityCurveChart(props: Props) {
  const { startingBalance, allowedDailyDdPct, allowedMaxDdPct, timeZone } = props;
  const dayKeyOf = props.dayKeyOf ?? utcDay;

  const points: CurvePoint[] = useMemo(() => normalizePoints(props.points), [props.points]);
  const tradeById = useMemo(() => {
    const m = new Map<string, JournalTrade>();
    for (const t of props.trades) m.set(t.id, t);
    return m;
  }, [props.trades]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gradRef = useRef("eqg-" + Math.random().toString(36).slice(2, 8));
  const [width, setWidth] = useState(0);
  const bounds: Win = useMemo(() => fullWindow(points), [points]);
  const [win, setWin] = useState<Win>(bounds);
  const [preset, setPreset] = useState<RangePreset | null>("all");
  const [opts, setOpts] = useState<Opts>(loadOpts);
  const [cursor, setCursor] = useState<{ t: number } | null>(null);

  // reset the view whenever the data set changes
  useEffect(() => {
    setWin(bounds);
    setPreset("all");
    setCursor(null);
  }, [bounds.t0, bounds.t1, points.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
    } catch {
      /* storage unavailable */
    }
  }, [opts]);

  // responsive width
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setWidth(Math.floor(el.clientWidth));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = Math.max(280, width || 640);
  const compact = W < 520;
  const H = compact ? 260 : 340;
  const padL = compact ? 46 : 56;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const span = Math.max(1, win.t1 - win.t0);
  const xOf = useCallback((t: number) => padL + ((t - win.t0) / span) * plotW, [padL, win.t0, span, plotW]);
  const timeAtX = useCallback((x: number) => win.t0 + ((x - padL) / plotW) * span, [padL, win.t0, plotW, span]);

  const peaks = useMemo(() => runningPeak(points, startingBalance), [points, startingBalance]);
  const accountLevel = useMemo(() => accountFloor(startingBalance, allowedMaxDdPct), [startingBalance, allowedMaxDdPct]);
  const dailySegs: FloorSeg[] = useMemo(
    () => dailyFloor(points, startingBalance, allowedDailyDdPct, dayKeyOf, bounds),
    [points, startingBalance, allowedDailyDdPct, dayKeyOf, bounds]
  );
  const hasDaily = dailySegs.length > 0;
  const hasAccount = accountLevel != null;
  const showDaily = opts.daily && hasDaily;
  const showAccount = opts.account && hasAccount;

  const drawn = useMemo(() => decimate(points, win, Math.max(60, Math.floor(plotW / 2))), [points, win, plotW]);

  // y domain over what is visible (balance + enabled limit lines + peak)
  const { yMin, yMax } = useMemo(() => {
    const vals: number[] = [stepValueAt(points, win.t0, startingBalance), stepValueAt(points, win.t1, startingBalance)];
    for (const p of drawn) vals.push(p.balance);
    if (showAccount && accountLevel != null) vals.push(accountLevel);
    if (showDaily) {
      for (const s of dailySegs) if (s.t1 >= win.t0 && s.t0 <= win.t1) vals.push(s.level);
    }
    if (opts.peak) vals.push(peakAt(points, peaks, win.t1, startingBalance));
    const d = yDomain(vals);
    return { yMin: d.min, yMax: d.max };
  }, [points, drawn, win, startingBalance, showAccount, accountLevel, showDaily, dailySegs, opts.peak, peaks]);

  const yOf = useCallback((v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH, [padT, yMin, yMax, plotH]);
  const yBottom = padT + plotH;

  const linePath = useMemo(() => stepPathD(points, win, startingBalance, xOf, yOf, drawn), [points, win, startingBalance, xOf, yOf, drawn]);
  const areaPath = useMemo(() => stepAreaD(points, win, startingBalance, xOf, yOf, yBottom, drawn), [points, win, startingBalance, xOf, yOf, yBottom, drawn]);
  const peakArea = useMemo(
    () => (opts.peak ? peakGapAreaD(points, peaks, win, startingBalance, xOf, yOf, drawn) : ""),
    [opts.peak, points, peaks, win, startingBalance, xOf, yOf, drawn]
  );
  const peakLine = useMemo(() => {
    if (!opts.peak) return "";
    const idx = new Map<CurvePoint, number>();
    points.forEach((p, i) => idx.set(p, i));
    let d = `M${xOf(win.t0).toFixed(1)},${yOf(peakAt(points, peaks, win.t0, startingBalance)).toFixed(1)}`;
    for (const p of drawn) d += ` H${xOf(p.time).toFixed(1)} V${yOf(peaks[idx.get(p) ?? 0] ?? 0).toFixed(1)}`;
    return `${d} H${xOf(win.t1).toFixed(1)}`;
  }, [opts.peak, points, peaks, win, startingBalance, xOf, yOf, drawn]);

  const dailyPath = useMemo(() => {
    if (!showDaily) return "";
    const vis = dailySegs.filter((s) => s.t1 >= win.t0 && s.t0 <= win.t1);
    let d = "";
    vis.forEach((s, i) => {
      const a = Math.max(s.t0, win.t0);
      const b = Math.min(s.t1, win.t1);
      d += i === 0 ? `M${xOf(a).toFixed(1)},${yOf(s.level).toFixed(1)}` : ` V${yOf(s.level).toFixed(1)}`;
      d += ` H${xOf(b).toFixed(1)}`;
    });
    return d;
  }, [showDaily, dailySegs, win, xOf, yOf]);

  const yTicks = useMemo(() => niceTicks(yMin, yMax, compact ? 4 : 5), [yMin, yMax, compact]);
  const fmtY = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: yMax - yMin >= 20 ? 0 : 2 });
  const xTicks = useMemo(() => timeTicks(win, compact ? 3 : 6), [win, compact]);
  const xFmt = timeFormatFor(win);
  const showDots = drawn.length <= 250;

  // ---- interaction ------------------------------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; win: Win; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; win: Win } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const localX = (e: { clientX: number }) => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? ((e.clientX - r.left) / Math.max(1, r.width)) * W : 0;
  };
  const clampT = (t: number) => Math.min(win.t1, Math.max(win.t0, t));

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, win };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, win, moved: false };
    }
    setCursor({ t: clampT(timeAtX(localX(e))) });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
      const midX = localX({ clientX: (a!.x + b!.x) / 2 });
      const anchor = timeAtX(midX);
      setWin(zoomWindow(pinch.current.win, dist / pinch.current.dist, anchor, bounds));
      setPreset(null);
      return;
    }
    const isMouse = e.pointerType === "mouse";
    const d = drag.current;
    // mouse drag pans when zoomed in; touch uses one finger for the crosshair, two fingers for zoom
    if (d && isMouse && e.buttons === 1 && !isFullWindow(win, bounds)) {
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        const r = svgRef.current?.getBoundingClientRect();
        const pxToSvg = r ? W / Math.max(1, r.width) : 1;
        setWin(panWindow(d.win, -((dx * pxToSvg) / plotW) * (d.win.t1 - d.win.t0), bounds));
        setPreset(null);
        return;
      }
    }
    if (isMouse || e.buttons === 1 || e.pointerType === "touch" || e.pointerType === "pen") {
      setCursor({ t: clampT(timeAtX(localX(e))) });
    }
  };

  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
    if (e.type === "pointerleave" && e.pointerType === "mouse") setCursor(null);
  };

  // wheel zoom (ctrl/cmd + wheel, also trackpad pinch) — native listener so we may preventDefault
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / Math.max(1, r.width)) * W;
      const anchor = win.t0 + ((x - padL) / plotW) * (win.t1 - win.t0);
      setWin((w) => zoomWindow(w, ev.deltaY < 0 ? 1.25 : 0.8, anchor, bounds));
      setPreset(null);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [W, padL, plotW, win.t0, win.t1, bounds]);

  const zoomBy = (f: number) => {
    setWin((w) => zoomWindow(w, f, cursor?.t ?? (w.t0 + w.t1) / 2, bounds));
    setPreset(null);
  };
  const pickPreset = (p: RangePreset) => {
    setWin(rangeWindow(points, p));
    setPreset(p);
  };
  const home = () => pickPreset("all");
  const shift = (dir: -1 | 1) => {
    setWin((w) => panWindow(w, dir * (w.t1 - w.t0) * 0.5, bounds));
    setPreset(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const i = nearestPointIndex(points, cursor?.t ?? win.t1);
      const j = Math.min(points.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)));
      const p = points[j];
      if (p) {
        setCursor({ t: clampT(p.time) });
        e.preventDefault();
      }
    } else if (e.key === "+" || e.key === "=") zoomBy(1.4);
    else if (e.key === "-") zoomBy(1 / 1.4);
    else if (e.key === "Home") home();
    else if (e.key === "Escape") setCursor(null);
  };

  // ---- hover / selected values -----------------------------------------------------------------
  const info = useMemo(() => {
    if (!cursor) return null;
    let t = cursor.t;
    let idx = -1;
    const ni = nearestPointIndex(points, t);
    if (ni >= 0 && ni > 0) {
      const p = points[ni]!;
      if (p.time >= win.t0 && p.time <= win.t1 && Math.abs(xOf(p.time) - xOf(t)) <= 14) {
        idx = ni;
        t = p.time;
      }
    }
    const balance = stepValueAt(points, t, startingBalance);
    const pk = peakAt(points, peaks, t, startingBalance);
    return {
      t,
      x: xOf(t),
      idx,
      balance,
      daily: showDaily ? floorAt(dailySegs, t) : null,
      account: showAccount ? accountLevel : null,
      peak: pk,
      dd: pk - balance,
      trade: idx > 0 ? tradeById.get(points[idx]!.tradeId) : undefined,
      pnl: idx > 0 ? points[idx]!.pnl : null,
    };
  }, [cursor, points, win, xOf, startingBalance, peaks, showDaily, dailySegs, showAccount, accountLevel, tradeById]);

  if (points.length < 2) {
    return <div className="chart-empty">Not enough closed trades for equity curve</div>;
  }

  const tipRight = info ? info.x < padL + plotW * 0.55 : true;
  const full = isFullWindow(win, bounds);
  const gradId = gradRef.current;
  const chip = (on: boolean, color: string): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 10px",
    borderRadius: 15,
    border: `1px solid ${on ? color : "rgba(128,128,128,0.35)"}`,
    background: "transparent",
    color: "inherit",
    opacity: on ? 1 : 0.55,
    cursor: "pointer",
    font: "inherit",
    fontSize: 12,
  });
  const dot = (c: string): CSSProperties => ({ width: 10, height: 10, borderRadius: 5, background: c, display: "inline-block" });
  const presets: [RangePreset, string][] = [["all", "All"], ["month", "Month"], ["week", "Week"], ["day", "Day"]];

  return (
    <div ref={wrapRef} style={box} tabIndex={0} onKeyDown={onKeyDown} aria-label="Equity curve">
      <div style={bar}>
        <div style={seg} role="group" aria-label="Range">
          {presets.map(([p, label]) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              style={{ ...btnBase, background: preset === p ? "rgba(59,130,246,0.22)" : "transparent", fontWeight: preset === p ? 600 : 400 }}
              onClick={() => pickPreset(p)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={seg} role="group" aria-label="Zoom">
          {!full && (
            <>
              <button type="button" style={btnBase} aria-label="Pan left" onClick={() => shift(-1)}>‹</button>
              <button type="button" style={btnBase} aria-label="Pan right" onClick={() => shift(1)}>›</button>
            </>
          )}
          <button type="button" style={btnBase} aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>−</button>
          <button type="button" style={btnBase} aria-label="Zoom in" onClick={() => zoomBy(1.5)}>+</button>
          <button type="button" style={btnBase} aria-label="Reset view" onClick={home}>⌂</button>
        </div>
      </div>

      <div style={{ position: "relative" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ display: "block", height: "auto", touchAction: "pan-y", cursor: full ? "crosshair" : "grab" }}
          role="img"
          aria-label={`Equity curve, ${points.length - 1} closed trades, balance ${fmtMoney(points[0]!.balance)} to ${fmtMoney(points[points.length - 1]!.balance)}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={endPointer}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.38} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0.03} />
            </linearGradient>
            <clipPath id={`${gradId}-clip`}>
              <rect x={padL} y={padT} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {/* grid + y labels */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={padL} x2={padL + plotW} y1={yOf(v)} y2={yOf(v)} stroke="currentColor" strokeOpacity={0.14} strokeDasharray="4 4" />
              <text x={padL - 6} y={yOf(v) + 3} fontSize={10} textAnchor="end" fill="currentColor" opacity={0.7}>{fmtY(v)}</text>
            </g>
          ))}
          {/* x labels */}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={xOf(t)} y={H - 8} fontSize={10} textAnchor="middle" fill="currentColor" opacity={0.7}>
              {formatTick(t, xFmt, timeZone)}
            </text>
          ))}
          <line x1={padL} x2={padL + plotW} y1={yBottom} y2={yBottom} stroke="currentColor" strokeOpacity={0.35} />

          <g clipPath={`url(#${gradId}-clip)`}>
            {opts.peak && <path d={peakArea} fill={ACCOUNT} fillOpacity={0.14} />}
            <path d={areaPath} fill={`url(#${gradId})`} />
            {opts.peak && <path d={peakLine} fill="none" stroke={PEAK} strokeWidth={1} strokeDasharray="5 4" />}
            {showAccount && accountLevel != null && (
              <line x1={padL} x2={padL + plotW} y1={yOf(accountLevel)} y2={yOf(accountLevel)} stroke={ACCOUNT} strokeWidth={1.75} />
            )}
            {showDaily && <path d={dailyPath} fill="none" stroke={DAILY} strokeWidth={1.75} />}
            <path d={linePath} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" />
            {showDots &&
              drawn.map((p, i) => (
                <circle key={`d${i}`} cx={xOf(p.time)} cy={yOf(p.balance)} r={3.2} fill="#fff" stroke={ACCENT} strokeWidth={1.5} />
              ))}
          </g>

          {/* crosshair */}
          {info && (
            <g pointerEvents="none">
              <line x1={info.x} x2={info.x} y1={padT} y2={yBottom} stroke="currentColor" strokeOpacity={0.75} strokeDasharray="4 4" />
              <circle cx={info.x} cy={yOf(info.balance)} r={5} fill={ACCENT} stroke="#fff" strokeWidth={1.5} />
              {info.daily != null && <circle cx={info.x} cy={yOf(info.daily)} r={4.5} fill={DAILY} stroke="#fff" strokeWidth={1.5} />}
              {info.account != null && <circle cx={info.x} cy={yOf(info.account)} r={4.5} fill={ACCOUNT} stroke="#fff" strokeWidth={1.5} />}
              <g transform={`translate(${Math.min(W - padR - 62, Math.max(padL + 62, info.x))},${yBottom + 2})`}>
                <rect x={-62} y={0} width={124} height={18} rx={3} fill="#0b0f14" stroke="rgba(255,255,255,0.25)" />
                <text x={0} y={12.5} fontSize={10} textAnchor="middle" fill="#fff">{formatStamp(info.t, timeZone).replace(",", "")}</text>
              </g>
            </g>
          )}
        </svg>

        {info && (
          <div
            style={{
              position: "absolute",
              top: 8,
              ...(tipRight ? { right: 10 } : { left: 52 }),
              maxWidth: "min(260px, 70%)",
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(11,15,20,0.92)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.18)",
              fontSize: 12,
              lineHeight: 1.45,
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div style={{ opacity: 0.8 }}>{formatStamp(info.t, timeZone)}</div>
            <div><span style={dot(ACCENT)} /> Balance: <b>{fmtMoney(info.balance)}</b></div>
            {info.trade && info.pnl != null && (
              <div style={{ marginTop: 2 }}>
                {(info.trade.tradeId || info.trade.id).slice(0, 12)} · {info.trade.symbol} · {info.trade.side.toUpperCase()} · {info.trade.reason}
                <br />
                P&amp;L: <b style={{ color: info.pnl >= 0 ? "#34d399" : "#f87171" }}>{fmtSigned(info.pnl)}</b>
                {info.trade.rMultiple != null ? ` · ${info.trade.rMultiple.toFixed(2)}R` : ""}
              </div>
            )}
            {info.daily != null && <div><span style={dot(DAILY)} /> Allowed daily drawdown: <b>{fmtMoney(info.daily)}</b></div>}
            {info.account != null && <div><span style={dot(ACCOUNT)} /> Allowed account drawdown: <b>{fmtMoney(info.account)}</b></div>}
            {opts.peak && <div><span style={dot(PEAK)} /> From peak: <b>{fmtMoney(info.peak)}</b> ({info.dd > 0 ? "−" : ""}{fmtMoney(info.dd)})</div>}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }} role="group" aria-label="Series">
        <span style={{ ...chip(true, ACCENT), cursor: "default" }}><span style={dot(ACCENT)} />Balance</span>
        <button type="button" style={chip(showDaily, DAILY)} aria-pressed={showDaily} disabled={!hasDaily} title={hasDaily ? "Allowed daily drawdown" : "No daily loss rule for this account"} onClick={() => setOpts((o) => ({ ...o, daily: !o.daily }))}>
          <span style={dot(DAILY)} />Daily drawdown limit{hasDaily && allowedDailyDdPct != null ? ` (${allowedDailyDdPct}%)` : ""}
        </button>
        <button type="button" style={chip(showAccount, ACCOUNT)} aria-pressed={showAccount} disabled={!hasAccount} title={hasAccount ? "Allowed account drawdown" : "No overall loss rule for this account"} onClick={() => setOpts((o) => ({ ...o, account: !o.account }))}>
          <span style={dot(ACCOUNT)} />Account drawdown limit{hasAccount && allowedMaxDdPct != null ? ` (${allowedMaxDdPct}%)` : ""}
        </button>
        <button type="button" style={chip(opts.peak, PEAK)} aria-pressed={opts.peak} onClick={() => setOpts((o) => ({ ...o, peak: !o.peak }))}>
          <span style={dot(PEAK)} />Drawdown from peak
        </button>
      </div>
      <p className="hint" style={{ marginTop: 6, fontSize: 11 }}>
        Closed-trade balance (steps at each close, nothing interpolated). Tap or hover for values; drag to move the crosshair, two fingers or Ctrl+wheel to zoom.
      </p>
    </div>
  );
}
