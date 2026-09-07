import { useEffect, useMemo, useState } from "react";
import { Chart, type DrawTool, type OrderType, type Shape } from "../components/Chart";
import { fetchBars } from "../lib/api";
import { cacheGetRange, cachePutBars } from "../lib/barCache";
import { generateDemoBars, readCsvFile } from "../lib/demoData";
import { aggregateVisible } from "../lib/replay";
import { SYMBOLS, TIMEFRAMES } from "../lib/types";
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

export function ReplayView({ backendOnline }: { backendOnline: boolean | null }) {
  const [baseBars, setBaseBars] = useState<Bar[]>(() => generateDemoBars());
  const [cursor, setCursor] = useState(800);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [timeframeSeconds, setTimeframeSeconds] = useState(300);
  const [start, setStart] = useState(isoDaysAgo(3));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [message, setMessage] = useState("Demo data · Sync a date range in Data Engine, then load it here");
  const [loading, setLoading] = useState(false);
  const [drawTool, setDrawTool] = useState<DrawTool>("crosshair");
  const [goToValue, setGoToValue] = useState("");
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("market");

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

  async function loadRange() {
    setLoading(true);
    setPlaying(false);
    try {
      // Day-sharded device cache: any overlapping days load without re-download
      const local = await cacheGetRange(symbol, start, end);
      if (local.missingDays.length === 0 && local.bars.length) {
        setBaseBars(local.bars);
        setCursor(Math.min(800, local.bars.length));
        setMessage(
          `From device · ${local.bars.length.toLocaleString()} bars · ${local.fromCacheDays.length} day(s) cached · ${start} → ${end}`
        );
        return;
      }

      if (local.bars.length && local.missingDays.length) {
        setMessage(
          `Partial cache: ${local.fromCacheDays.length} day(s) on device, missing ${local.missingDays.length} day(s). Fetching rest…`
        );
      }

      if (!backendOnline) {
        if (local.bars.length) {
          setBaseBars(local.bars);
          setCursor(Math.min(800, local.bars.length));
          setMessage(
            `Offline · loaded ${local.fromCacheDays.length} cached day(s), missing ${local.missingDays.join(", ") || "none"}`
          );
        } else {
          setMessage("No device cache · backend offline · Sync/Load while online or use CSV");
        }
        return;
      }

      // Ask backend for full range (server may have shards from Sync)
      const res = await fetchBars(symbol, 1, start, end);
      if (!res.bars.length && !local.bars.length) {
        setMessage(`No data for ${symbol} ${start} → ${end}. Sync in Data Engine first.`);
        return;
      }

      // Merge: prefer backend bars, also keep any local-only seconds
      const byT = new Map<number, Bar>();
      for (const b of local.bars) byT.set(b.time, b);
      for (const b of res.bars) byT.set(b.time, b);
      const merged = Array.from(byT.values()).sort((a, b) => a.time - b.time);

      setBaseBars(merged);
      setCursor(Math.min(800, merged.length));
      const daysSaved = await cachePutBars(symbol, merged);
      setMessage(
        `Loaded ${merged.length.toLocaleString()} bars · saved ${daysSaved} day(s) on this device · ${start} → ${end}`
      );
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
        setMessage(`Imported ${parsed.length.toLocaleString()} base bars`);
      } else setMessage("No valid OHLC rows found in that file");
    } catch {
      setMessage("Could not read that file");
    }
  }

  function changeSymbol(next: string) {
    setSymbol(next);
    setPlaying(false);
  }

  function handleGoTo() {
    if (!goToValue || !baseBars.length) return;
    setPlaying(false);
    const target = Math.floor(new Date(goToValue).getTime() / 1000);
    if (!Number.isFinite(target)) {
      setMessage("Invalid Go To datetime");
      return;
    }
    let lo = 0;
    let hi = baseBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (baseBars[mid].time < target) lo = mid + 1;
      else hi = mid;
    }
    const idx = Math.min(baseBars.length, Math.max(1, lo + 1));
    setCursor(idx);
    const hit = baseBars[idx - 1];
    setMessage(
      hit
        ? `Go To → ${new Date(hit.time * 1000).toLocaleString()} (bar ${idx.toLocaleString()})`
        : "Go To: no bar at that time"
    );
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
    setMessage(`Session → ${kind.toUpperCase()}`);
  }

  const visibleBars = useMemo(
    () => aggregateVisible(baseBars, cursor, timeframeSeconds),
    [baseBars, cursor, timeframeSeconds]
  );
  const currentBase = baseBars[Math.max(0, cursor - 1)];
  const max = Math.max(1, baseBars.length);

  const toolHint =
    drawTool === "trendline"
      ? "Trend: move crosshair, double-click point A then B"
      : drawTool === "rectangle"
        ? "Rect: move crosshair, double-click two corners"
        : drawTool === "long"
          ? "Long: double-click Entry → SL → TP at crosshair"
          : drawTool === "short"
            ? "Short: double-click Entry → SL → TP at crosshair"
            : "Crosshair free · hover candle for OHLC";

  return (
    <section className="replay-view">
      <div className="bar replay-topbar">
        <select value={symbol} onChange={(e) => changeSymbol(e.target.value)}>
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.seconds}
            className={timeframeSeconds === tf.seconds ? "on" : ""}
            onClick={() => setTimeframeSeconds(tf.seconds)}
          >
            {tf.label}
          </button>
        ))}
        <label className="import-btn">
          Import CSV
          <input
            type="file"
            accept=".csv,.txt"
            onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}
          />
        </label>
      </div>

      <div className="bar replay-range">
        <span>Data:</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span>→</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button onClick={loadRange} disabled={loading || !backendOnline}>
          {loading ? "Loading…" : "Load 1s Replay"}
        </button>
        <span className="status-message">{message}</span>
      </div>

      <div className="bar tools-bar">
        <span className="tools-label">Tools</span>
        <button type="button" className={drawTool === "crosshair" ? "on" : ""} onClick={() => setDrawTool("crosshair")}>
          Crosshair
        </button>
        <button type="button" className={drawTool === "trendline" ? "on" : ""} onClick={() => setDrawTool("trendline")}>
          Trend
        </button>
        <button type="button" className={drawTool === "rectangle" ? "on" : ""} onClick={() => setDrawTool("rectangle")}>
          Rect
        </button>
        <button type="button" className={drawTool === "long" ? "on green" : "green"} onClick={() => setDrawTool("long")}>
          Long
        </button>
        <button type="button" className={drawTool === "short" ? "on red" : "red"} onClick={() => setDrawTool("short")}>
          Short
        </button>
        <select
          value={orderType}
          onChange={(e) => setOrderType(e.target.value as OrderType)}
          title="Order type"
        >
          <option value="market">Market</option>
          <option value="buy_limit">Buy Limit</option>
          <option value="sell_limit">Sell Limit</option>
          <option value="buy_stop">Buy Stop</option>
          <option value="sell_stop">Sell Stop</option>
          <option value="buy_stop_limit">Buy Stop Limit</option>
          <option value="sell_stop_limit">Sell Stop Limit</option>
        </select>
        <button type="button" onClick={() => setShapes([])} title="Clear all drawings">
          Clear
        </button>
        <button type="button" className={drawTool === "none" ? "on" : ""} onClick={() => setDrawTool("none")}>
          Hide
        </button>
        <span className="tools-sep">|</span>
        <button type="button" onClick={() => jumpSession("tokyo")}>Tokyo</button>
        <button type="button" onClick={() => jumpSession("london")}>London</button>
        <button type="button" onClick={() => jumpSession("ny")}>NY</button>
        <span className="tools-sep">|</span>
        <label className="goto-label">
          Go To
          <input type="datetime-local" step="1" value={goToValue} onChange={(e) => setGoToValue(e.target.value)} />
        </label>
        <button type="button" className="on" onClick={handleGoTo}>Jump</button>
      </div>
      <div className="tool-hint">{toolHint}</div>

      <div className="chartbox">
        <Chart
          bars={visibleBars}
          cursor={visibleBars.length}
          drawTool={drawTool}
          orderType={orderType}
          shapes={shapes}
          onShapesChange={setShapes}
        />
        <small>
          Replay = 1s · Chart = {TIMEFRAMES.find((x) => x.seconds === timeframeSeconds)?.label} · Drawings: {shapes.length}
        </small>
      </div>

      <div className="replay">
        <button onClick={() => setPlaying(false)} title="Pause">Pause</button>
        <button onClick={() => setPlaying(true)} disabled={cursor >= baseBars.length} title="Play">Play</button>
        <button onClick={() => setCursor((c) => Math.max(1, c - 1))} title="Previous second">Prev</button>
        <button onClick={() => setCursor((c) => Math.min(baseBars.length, c + 1))} title="Next second">Next</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[0.25, 0.5, 1, 2, 5, 10].map((s) => (
            <option key={s} value={s}>{s}x</option>
          ))}
        </select>
        <input type="range" min={1} max={max} value={Math.min(cursor, max)} onChange={(e) => setCursor(Number(e.target.value))} />
        <span className="cursor-count">{cursor.toLocaleString()} / {baseBars.length.toLocaleString()}s</span>
      </div>

      <aside className="replay-info">
        <p>Current second: {currentBase ? new Date(currentBase.time * 1000).toLocaleString() : "—"}</p>
        <p>Base: {baseBars.length.toLocaleString()} x 1s</p>
        <p>Chart: {TIMEFRAMES.find((x) => x.seconds === timeframeSeconds)?.label}</p>
        <p>Visible candles: {visibleBars.length.toLocaleString()}</p>
      </aside>
    </section>
  );
}
