import { useEffect, useMemo, useRef, useState } from "react";
import { Chart, type DrawTool, type OrderType, type Shape } from "../components/Chart";
import { fetchBars } from "../lib/api";
import { cacheGetRange, cachePutBars } from "../lib/barCache";
import { generateDemoBars, readCsvFile } from "../lib/demoData";
import { aggregateVisible } from "../lib/replay";
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

export function ReplayView({ backendOnline }: { backendOnline: boolean | null }) {
  const [baseBars, setBaseBars] = useState<Bar[]>(() => generateDemoBars());
  const [cursor, setCursor] = useState(800);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [timeframeSeconds, setTimeframeSeconds] = useState(300);
  const [customTfs, setCustomTfs] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem("tr-custom-tfs");
      if (raw) return JSON.parse(raw) as number[];
    } catch { /* */ }
    return [];
  });
  const [tfOpen, setTfOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [customTfInput, setCustomTfInput] = useState("");
  const [start, setStart] = useState(isoDaysAgo(3));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [message, setMessage] = useState("Demo data · Sync then Load");
  const [loading, setLoading] = useState(false);
  const [drawTool, setDrawTool] = useState<DrawTool>("crosshair");
  const [goToValue, setGoToValue] = useState("");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [followPrice, setFollowPrice] = useState(false);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const tfPanelRef = useRef<HTMLDivElement | null>(null);
  const toolsPanelRef = useRef<HTMLDivElement | null>(null);

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
    if (!playing) return;
    const id = window.setInterval(() => {
      setCursor((c) => {
        if (c >= baseBars.length) {
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, Math.max(15, 250 / speed));
    return () => window.clearInterval(id);
  }, [playing, speed, baseBars.length]);

  useEffect(() => {
    const b = baseBars[Math.max(0, cursor - 1)];
    if (b) setGoToValue(toLocalInputValue(b.time));
  }, [cursor, baseBars]);

  // close panels on outside tap
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (tfOpen && tfPanelRef.current && !tfPanelRef.current.contains(t)) setTfOpen(false);
      if (toolsOpen && toolsPanelRef.current && !toolsPanelRef.current.contains(t)) {
        // keep tools open if clicking chart for drawing
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [tfOpen, toolsOpen]);

  async function loadRange() {
    setLoading(true);
    setPlaying(false);
    try {
      const local = await cacheGetRange(symbol, start, end);
      if (local.missingDays.length === 0 && local.bars.length) {
        setBaseBars(local.bars);
        setCursor(Math.min(800, local.bars.length));
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
    setCustomTfs((prev) => (prev.includes(sec) ? prev : [...prev, sec].sort((a, b) => a - b)));
    setTimeframeSeconds(sec);
    setCustomTfInput("");
    setTfOpen(false);
    setMessage(`Timeframe ${formatTf(sec)} added`);
  }

  function pickTool(t: DrawTool) {
    setDrawTool(t);
    if (t === "long" || t === "short" || t === "trendline" || t === "rectangle") {
      setToolsOpen(true);
    }
  }

  const visibleBars = useMemo(
    () => aggregateVisible(baseBars, cursor, timeframeSeconds),
    [baseBars, cursor, timeframeSeconds]
  );
  const currentBase = baseBars[Math.max(0, cursor - 1)];
  const max = Math.max(1, baseBars.length);

  return (
    <section className="replay-view">
      {/* Compact top: symbol + TF dropdown + Tools + data */}
      <div className="bar replay-topbar mobile-scroll">
        <select value={symbol} onChange={(e) => { setSymbol(e.target.value); setPlaying(false); }}>
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="tf-wrap" ref={tfPanelRef}>
          <button type="button" className="tf-current on" onClick={() => setTfOpen((v) => !v)}>
            TF {formatTf(timeframeSeconds)} ▾
          </button>
          {tfOpen && (
            <div className="tf-panel">
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

        <div className="tools-wrap" ref={toolsPanelRef}>
          <button
            type="button"
            className={toolsOpen ? "on" : ""}
            onClick={() => setToolsOpen((v) => !v)}
          >
            Tools ▾
          </button>
          {toolsOpen && (
            <div className="tools-panel">
              <button type="button" className={drawTool === "crosshair" ? "on" : ""} onClick={() => pickTool("crosshair")}>Crosshair</button>
              <button type="button" className={drawTool === "trendline" ? "on" : ""} onClick={() => pickTool("trendline")}>Trendline</button>
              <button type="button" className={drawTool === "rectangle" ? "on" : ""} onClick={() => pickTool("rectangle")}>Rectangle</button>
              <button type="button" className={drawTool === "long" ? "on green" : "green"} onClick={() => pickTool("long")}>Long</button>
              <button type="button" className={drawTool === "short" ? "on red" : "red"} onClick={() => pickTool("short")}>Short</button>
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
                <option value="market">Market</option>
                <option value="buy_limit">Buy Limit</option>
                <option value="sell_limit">Sell Limit</option>
                <option value="buy_stop">Buy Stop</option>
                <option value="sell_stop">Sell Stop</option>
                <option value="buy_stop_limit">Buy Stop Limit</option>
                <option value="sell_stop_limit">Sell Stop Limit</option>
              </select>
              <button type="button" className="on" onClick={() => window.dispatchEvent(new Event("tr-confirm-position"))}>Confirm</button>
              <button type="button" onClick={() => window.dispatchEvent(new Event("tr-cancel-draft"))}>Cancel draft</button>
              <button type="button" onClick={() => { setShapes([]); setSelectedShapeId(null); }}>Clear drawings</button>
              <p className="tools-note">Drawings stay selectable: drag handles to edit. Trend/Rect: double-click two points, then drag ends.</p>
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
        <Chart
          bars={visibleBars}
          cursor={visibleBars.length}
          drawTool={drawTool}
          orderType={orderType}
          marketPrice={currentBase?.close ?? null}
          marketTime={currentBase?.time ?? null}
          followPrice={followPrice}
          shapes={shapes}
          onShapesChange={setShapes}
          selectedShapeId={selectedShapeId}
          onSelectedShapeId={setSelectedShapeId}
        />
      </div>

      <div className="replay mobile-scroll">
        <button onClick={() => setPlaying(false)}>Pause</button>
        <button onClick={() => setPlaying(true)} disabled={cursor >= baseBars.length}>Play</button>
        <button type="button" className={followPrice ? "on" : ""} onClick={() => setFollowPrice((v) => !v)}>
          {followPrice ? "Follow ON" : "Follow OFF"}
        </button>
        <button onClick={() => setCursor((c) => Math.max(1, c - 1))}>Prev</button>
        <button onClick={() => setCursor((c) => Math.min(baseBars.length, c + 1))}>Next</button>
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
        <p>TF {formatTf(timeframeSeconds)} · {visibleBars.length} candles</p>
      </aside>
    </section>
  );
}
