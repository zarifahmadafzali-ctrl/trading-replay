import { useEffect, useRef, useState } from "react";
import { fetchBars, fetchCapability, fetchDataStatus, syncDukascopy, type DataStatus, type SyncReport } from "../lib/api";
import { cacheGetRange, cachePutBars } from "../lib/barCache";
import { SYMBOLS } from "../lib/types";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type Phase =
  | "idle"
  | "retrying"
  | "syncing"
  | "verifying"
  | "warming"
  | "complete"
  | "partial"
  | "failed";

export function DataEngineView({ backendOnline }: { backendOnline: boolean | null }) {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [start, setStart] = useState(isoDaysAgo(3));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [localMissing, setLocalMissing] = useState<string[]>([]);
  const [capability, setCapability] = useState<{
    base_resolution: string;
    derived: string[];
    warning: string;
  } | null>(null);
  const busyRef = useRef(false);
  const genRef = useRef(0);

  useEffect(() => {
    if (!backendOnline) return;
    fetchCapability()
      .then(setCapability)
      .catch(() => {});
  }, [backendOnline]);

  function pushLog(line: string) {
    setLog((prev) => [...prev.slice(-40), line]);
  }

  async function handleSync() {
    if (busyRef.current) return;
    if (!backendOnline) {
      pushLog("Backend offline — cannot sync.");
      setPhase("failed");
      return;
    }
    if (!start || !end || end < start) {
      pushLog("Invalid date range.");
      setPhase("failed");
      return;
    }

    busyRef.current = true;
    const gen = ++genRef.current;
    setReport(null);
    setStatus(null);
    setLocalMissing([]);
    setPhase("syncing");
    pushLog(`Sync start ${symbol} ${start} → ${end}`);

    try {
      const res = await syncDukascopy(symbol, start, end, {
        onRetry: (attempt, err) => {
          if (gen !== genRef.current) return;
          setPhase("retrying");
          pushLog(`Retry ${attempt}/2 after transient error: ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      if (gen !== genRef.current) return;
      setReport(res);
      pushLog(
        `Backend: days=${res.days} ticks=${res.ticks} 1s-bars=${res.seconds} files_ok=${res.files_ok} missing_hours=${res.files_missing} failed=${res.files_failed}`
      );
      if (res.errors?.length) {
        for (const e of res.errors.slice(0, 5)) pushLog(`  · ${e}`);
      }

      setPhase("verifying");
      const st = await fetchDataStatus(symbol, start, end);
      if (gen !== genRef.current) return;
      setStatus(st);
      const missingBackend = st.missing_days || [];
      pushLog(
        st.has_1s_cache
          ? "Backend verify: all requested days present"
          : `Backend verify: missing days [${missingBackend.join(", ") || "none listed"}]`
      );

      // Warm browser IndexedDB so Chart Load does not false-Missing
      setPhase("warming");
      pushLog("Warming device cache from backend…");
      try {
        const barsRes = await fetchBars(symbol, 1, start, end);
        if (gen !== genRef.current) return;
        const n = barsRes.bars?.length || 0;
        if (n > 0) {
          const days = await cachePutBars(symbol, barsRes.bars);
          pushLog(`Device cache: ${n.toLocaleString()} bars → ${days} day shard(s)`);
        } else {
          pushLog("Device cache: backend returned 0 bars for range (holiday/weekend or no ticks).");
        }
        const local = await cacheGetRange(symbol, start, end);
        setLocalMissing(local.missingDays);
        if (local.missingDays.length) {
          pushLog(`Local still missing: ${local.missingDays.join(", ")}`);
        } else {
          pushLog("Local verify: all requested days have data on device (or empty non-trading).");
        }
      } catch (warmErr) {
        pushLog(`Warm cache failed: ${warmErr instanceof Error ? warmErr.message : String(warmErr)}`);
      }

      const backendOk = res.files_failed === 0 && (res.files_ok > 0 || res.seconds > 0);
      const partial =
        !st.has_1s_cache ||
        (res.files_failed > 0) ||
        (status?.missing_days && status.missing_days.length > 0);

      if (!backendOk && res.files_ok === 0 && res.seconds === 0) {
        setPhase("failed");
        pushLog("Sync finished with no usable data.");
      } else if (partial || res.files_failed > 0 || (st.missing_days && st.missing_days.length)) {
        setPhase("partial");
        pushLog("Sync partial — some days incomplete. Successful days kept.");
      } else {
        setPhase("complete");
        pushLog("Sync complete and verified.");
      }
    } catch (e) {
      if (gen !== genRef.current) return;
      setPhase("failed");
      pushLog(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
    }
  }

  const busy = phase === "syncing" || phase === "retrying" || phase === "verifying" || phase === "warming";

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
          Sync downloads Dukascopy ticks, builds 1s OHLC on the server, then warms this device&apos;s
          IndexedDB so Chart Load does not report false Missing.
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
          <select
            value={symbol}
            disabled={busy}
            onChange={(e) => setSymbol(e.target.value)}
          >
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input type="date" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} />
          <span>to</span>
          <input type="date" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} />
          <button onClick={() => void handleSync()} disabled={busy || !backendOnline}>
            {busy ? phase : "Sync"}
          </button>
        </div>
        <p className="hint">
          Phase: <b>{phase}</b>
          {report ? ` · backend days ${report.days} · 1s bars ${report.seconds.toLocaleString()}` : null}
        </p>
        {status && (
          <p className="sync-result">
            Backend cache: {status.has_1s_cache ? "complete for range" : "incomplete"}
            {status.missing_days?.length ? ` · missing ${status.missing_days.join(", ")}` : ""}
          </p>
        )}
        {localMissing.length > 0 && (
          <p className="sync-result warn-text">Device still missing: {localMissing.join(", ")}</p>
        )}
        {log.length > 0 && (
          <pre className="sync-log">{log.join("\n")}</pre>
        )}
        <p className="hint">
          Weekend/holiday days may be empty (expected). Failed network hours are reported separately.
          Double-click Sync is ignored while busy.
        </p>
      </div>
    </section>
  );
}
