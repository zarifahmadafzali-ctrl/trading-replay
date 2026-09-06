import { useEffect, useMemo, useState } from "react";
import { Chart } from "../components/Chart";
import { fetchBars } from "../lib/api";
import { generateDemoBars, readCsvFile } from "../lib/demoData";
import { aggregateVisible } from "../lib/replay";
import { SYMBOLS, TIMEFRAMES } from "../lib/types";
import type { Bar } from "../lib/types";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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

  async function loadRange() {
    if (!backendOnline) {
      setMessage("Backend is offline · local demo/CSV mode");
      return;
    }
    setLoading(true);
    setPlaying(false);
    try {
      const res = await fetchBars(symbol, 1, start, end);
      if (!res.bars.length) {
        setMessage(`No 1-second cache for ${symbol} in ${start} → ${end}. Sync it first.`);
        return;
      }
      setBaseBars(res.bars);
      setCursor(Math.min(800, res.bars.length));
      setMessage(`Loaded ${res.bars.length.toLocaleString()} real 1-second bars (${start} → ${end})`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Backend request failed");
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
    } catch { setMessage("Could not read that file"); }
  }

  function changeSymbol(next: string) {
    setSymbol(next);
    setPlaying(false);
  }

  const visibleBars = useMemo(
    () => aggregateVisible(baseBars, cursor, timeframeSeconds),
    [baseBars, cursor, timeframeSeconds]
  );
  const currentBase = baseBars[Math.max(0, cursor - 1)];
  const max = Math.max(1, baseBars.length);

  return (
    <section className="replay-view">
      <div className="bar replay-topbar">
        <select value={symbol} onChange={(e) => changeSymbol(e.target.value)}>
          {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {TIMEFRAMES.map((tf) => (
          <button key={tf.seconds} className={timeframeSeconds === tf.seconds ? "on" : ""} onClick={() => setTimeframeSeconds(tf.seconds)}>
            {tf.label}
          </button>
        ))}
        <label className="import-btn">Import CSV<input type="file" accept=".csv,.txt" onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}/></label>
      </div>

      <div className="bar replay-range">
        <span>Data:</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span>→</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button onClick={loadRange} disabled={loading || !backendOnline}>{loading ? "Loading…" : "Load 1s Replay"}</button>
        <span className="status-message">{message}</span>
      </div>

      <div className="chartbox">
        <Chart bars={visibleBars} cursor={visibleBars.length} />
        <small>Replay clock = 1 second · Chart timeframe = {TIMEFRAMES.find((x) => x.seconds === timeframeSeconds)?.label}</small>
      </div>

      <div className="replay">
        <button onClick={() => setPlaying(false)} title="Pause">⏸</button>
        <button onClick={() => setPlaying(true)} disabled={cursor >= baseBars.length} title="Play">▶</button>
        <button onClick={() => setCursor((c) => Math.max(1, c - 1))} title="Previous second">|←</button>
        <button onClick={() => setCursor((c) => Math.min(baseBars.length, c + 1))} title="Next second">→|</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[0.25, 0.5, 1, 2, 5, 10].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <input type="range" min={1} max={max} value={Math.min(cursor, max)} onChange={(e) => setCursor(Number(e.target.value))}/>
        <span className="cursor-count">{cursor.toLocaleString()} / {baseBars.length.toLocaleString()}s</span>
      </div>

      <aside className="replay-info">
        <p>Current second: {currentBase ? new Date(currentBase.time * 1000).toLocaleString() : "—"}</p>
        <p>Base: {baseBars.length.toLocaleString()} × 1s</p>
        <p>Chart: {TIMEFRAMES.find((x) => x.seconds === timeframeSeconds)?.label}</p>
        <p>Visible candles: {visibleBars.length.toLocaleString()}</p>
      </aside>
    </section>
  );
}
