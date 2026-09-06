import { useEffect, useState } from "react";
import { fetchCapability, fetchDataStatus, syncDukascopy } from "../lib/api";
import { SYMBOLS } from "../lib/types";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function DataEngineView({ backendOnline }: { backendOnline: boolean | null }) {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [start, setStart] = useState(isoDaysAgo(3));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [capability, setCapability] = useState<{
    base_resolution: string;
    derived: string[];
    warning: string;
  } | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!backendOnline) return;
    fetchCapability()
      .then(setCapability)
      .catch(() => {});
  }, [backendOnline]);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    try {
      const res = await syncDukascopy(symbol, start, end);
      setResult(
        `Synced ${res.ticks.toLocaleString()} ticks → ${res.seconds.toLocaleString()} real 1-second bars over ${res.days} day(s). Files OK: ${res.files_ok}, missing: ${res.files_missing}, failed: ${res.files_failed}.`
      );
      const status = await fetchDataStatus(symbol, start, end);
      setCacheStatus(status.has_1s_cache ? "1-second cache ready for this symbol" : "No cache yet");
    } catch (e) {
      setResult("Sync failed — Dukascopy may not have data for that symbol/range, or the backend is unreachable.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="data-engine-view">
      <h2>Data Engine</h2>

      {!backendOnline && (
        <p className="notice warn-text">
          Backend is offline. Start the FastAPI server to sync real tick data — until then, Replay
          uses demo data or CSV import.
        </p>
      )}

      <div className="card">
        <b>True 1-second base</b>
        <p>
          When a tick source is available, data is collected at one-second resolution. From that
          base, any coarser timeframe — 2s, 5s, 15s, 30s, 1m, 2m, 5m, and up — can be derived
          without guessing.
        </p>
      </div>

      <div className="card warn">
        <b>Important limitation</b>
        <p>
          One-minute OHLC bars cannot be used to reconstruct the real price movement that happened
          inside that minute. True second-by-second replay requires tick or 1-second data to be
          stored directly.
        </p>
      </div>

      {capability && (
        <div className="card">
          <b>Backend capability</b>
          <p>{capability.base_resolution}</p>
          <p className="derived-list">Derivable timeframes: {capability.derived.join(", ")}</p>
        </div>
      )}

      <div className="sync-form">
        <h3>Sync tick data (Dukascopy)</h3>
        <div className="sync-row">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <span>to</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          <button onClick={handleSync} disabled={syncing || !backendOnline}>
            {syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
        {result && <p className="sync-result">{result}</p>}
        {cacheStatus && <p className="sync-result">{cacheStatus}</p>}
        <p className="hint">
          Each day is saved separately, so you can sync a month at a time or build a year in smaller batches. Existing days are replaced only by a successful fresh sync; other days remain intact.
        </p>
      </div>
    </section>
  );
}
