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
  const [deviceVerified, setDeviceVerified] = useState(false);
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
    setLog((prev) => [...prev.slice(-80), line]);
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
    setDeviceVerified(false);
    setPhase("syncing");
    pushLog(`Sync start ${symbol} ${start} → ${end}`);
    pushLog("Downloader: sequential hours, 429 backoff, skip already-verified days");

    try {
      const res = await syncDukascopy(symbol, start, end, {
        onRetry: (attempt, err) => {
          if (gen !== genRef.current) return;
          setPhase("retrying");
          pushLog(`Transport retry ${attempt}/2: ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      if (gen !== genRef.current) return;
      setReport(res);

      if (res.log?.length) {
        for (const line of res.log.slice(-60)) pushLog(line);
      }
      for (const dr of res.day_results || []) {
        pushLog(
          `Day ${dr.date}: ${dr.status}` +
            (dr.bars1s != null ? ` bars1s=${dr.bars1s}` : "") +
            (dr.ticks != null ? ` ticks=${dr.ticks}` : "") +
            (dr.failedHours ? ` failedHours=${dr.failedHours}` : "")
        );
      }

      pushLog(
        `Summary ticks=${res.ticks} 1s-bars=${res.seconds} ` +
          `ok_hours=${res.files_ok} empty_hours=${res.files_missing} failed_hours=${res.files_failed}`
      );
      pushLog(
        `SUCCESS days: ${(res.success_days || []).join(", ") || "—"} | ` +
          `EMPTY: ${(res.expected_empty_days || []).join(", ") || "—"} | ` +
          `FAILED: ${(res.failed_days || []).join(", ") || "—"}`
      );
      pushLog(`Backend verified: ${res.backend_verified ? "YES" : "NO"}`);

      setPhase("verifying");
      const st = await fetchDataStatus(symbol, start, end);
      if (gen !== genRef.current) return;
      setStatus(st);

      if (st.backend_verified) {
        pushLog("Status API: backend_verified=true");
      } else {
        pushLog(
          `Status API: NOT verified · failed=[${(st.failed_days || []).join(", ")}] ` +
            `missing=[${(st.missing_days || []).join(", ")}]`
        );
      }

      // Warm device only when backend has some usable SUCCESS days
      const hasUsable = (st.usable_bars || 0) > 0 || (st.success_days || []).length > 0;
      if (hasUsable) {
        setPhase("warming");
        pushLog("Warming device IndexedDB from backend…");
        try {
          const barsRes = await fetchBars(symbol, 1, start, end);
          const n = barsRes.bars?.length || 0;
          if (n > 0) {
            const days = await cachePutBars(symbol, barsRes.bars);
            pushLog(`Device cache wrote ${n.toLocaleString()} bars → ${days} day shard(s)`);
          } else {
            pushLog("Device cache: backend returned 0 bars (only empty/failed days).");
          }
          const local = await cacheGetRange(symbol, start, end);
          // Missing only for days that backend says should have data (SUCCESS) but device lacks
          const need = new Set(st.success_days || []);
          const still = local.missingDays.filter((d) => need.has(d));
          setLocalMissing(still);
          const ok = still.length === 0 && (st.success_days || []).every((d) => local.fromCacheDays.includes(d));
          setDeviceVerified(ok);
          pushLog(
            ok
              ? "Device verified: all SUCCESS days present on device"
              : `Device incomplete: still missing ${still.join(", ") || "—"}`
          );
        } catch (warmErr) {
          setDeviceVerified(false);
          pushLog(`Warm cache failed: ${warmErr instanceof Error ? warmErr.message : String(warmErr)}`);
        }
      } else {
        pushLog("Skip device warm — no usable SUCCESS days on backend yet.");
        setDeviceVerified(false);
      }

      if (res.backend_verified && deviceVerified !== false) {
        // phase from backend_verified + warm outcome
      }
      if (res.backend_verified) {
        setPhase(hasUsable ? "complete" : "complete");
        pushLog("Sync finished: backend range fully classified (SUCCESS + EXPECTED_EMPTY only).");
      } else if ((res.success_days || []).length > 0) {
        setPhase("partial");
        pushLog("Sync partial — retry later to fill FAILED days (already-good days will be skipped).");
      } else {
        setPhase("failed");
        pushLog("Sync finished with no usable data. Check 429 / network and retry.");
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
          Sequential Dukascopy downloads with 429 backoff. Days are classified SUCCESS /
          EXPECTED_EMPTY / FAILED. Only verified data warms this device&apos;s IndexedDB.
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
          <select value={symbol} disabled={busy} onChange={(e) => setSymbol(e.target.value)}>
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>{s}</option>
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
          {report ? ` · ticks ${report.ticks.toLocaleString()} · 1s bars ${report.seconds.toLocaleString()}` : null}
        </p>

        {status && (
          <div className="sync-result">
            <p>
              Backend verified:{" "}
              <b>{status.backend_verified ? "YES" : "NO"}</b>
              {status.usable_bars != null ? ` · usable 1s bars ~${status.usable_bars.toLocaleString()}` : ""}
            </p>
            {status.success_days?.length ? (
              <p>SUCCESS: {status.success_days.join(", ")}</p>
            ) : null}
            {status.expected_empty_days?.length ? (
              <p>EXPECTED_EMPTY (weekend/holiday): {status.expected_empty_days.join(", ")}</p>
            ) : null}
            {status.failed_days?.length ? (
              <p className="warn-text">FAILED (retry): {status.failed_days.join(", ")}</p>
            ) : null}
            {status.missing_days?.length ? (
              <p className="warn-text">MISSING: {status.missing_days.join(", ")}</p>
            ) : null}
          </div>
        )}

        <p className="sync-result">
          Device verified: <b>{deviceVerified ? "YES" : "NO"}</b>
          {localMissing.length > 0 ? ` · still missing SUCCESS days: ${localMissing.join(", ")}` : ""}
        </p>

        {log.length > 0 && <pre className="sync-log">{log.join("\n")}</pre>}

        <p className="hint">
          Re-sync skips already-verified SUCCESS / EXPECTED_EMPTY days and only retries FAILED.
          Double-click while busy is ignored. HTTP 429 uses exponential backoff (not parallel storms).
        </p>
      </div>
    </section>
  );
}
