import { useEffect, useRef, useState } from "react";
import {
  fetchBars,
  fetchCapability,
  fetchDataStatus,
  syncDukascopy,
  SyncClientAbortError,
  SyncConflictError,
  type DataStatus,
  type SyncReport,
} from "../lib/api";
import { cacheGetRange, cachePutBars } from "../lib/barCache";
import { SYMBOLS } from "../lib/types";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type Phase =
  | "idle"
  | "syncing"
  | "retrying"
  | "waiting_server"
  | "conflict_409"
  | "verifying"
  | "warming"
  | "complete"
  | "partial"
  | "incomplete"
  | "failed";

const RECOVERY_POLL_MS = 3000;
/** Max time to poll status after abort/409 before giving up (no new POST). */
const RECOVERY_MAX_MS = 20 * 60 * 1000;

/** Range is fully classified: every day SUCCESS or EXPECTED_EMPTY, none MISSING/FAILED. */
function isRangeComplete(st: DataStatus): boolean {
  if (st.backend_verified) return true;
  const missing = st.missing_days || [];
  const failed = st.failed_days || [];
  if (missing.length > 0 || failed.length > 0) return false;
  const ok =
    (st.success_days || []).length + (st.expected_empty_days || []).length > 0;
  return ok;
}

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

  async function warmDevice(
    sym: string,
    rangeStart: string,
    rangeEnd: string,
    st: DataStatus,
    gen: number
  ): Promise<boolean> {
    if (!isRangeComplete(st)) {
      pushLog("Sync incomplete — device warm skipped until backend verification.");
      setDeviceVerified(false);
      return false;
    }
    setPhase("warming");
    pushLog("Warming device IndexedDB from backend…");
    try {
      const barsRes = await fetchBars(sym, 1, rangeStart, rangeEnd);
      if (gen !== genRef.current) return false;
      const n = barsRes.bars?.length || 0;
      if (n > 0) {
        const days = await cachePutBars(sym, barsRes.bars);
        pushLog(`Device cache wrote ${n.toLocaleString()} bars → ${days} day shard(s)`);
      } else {
        pushLog("Device cache: backend returned 0 bars (only empty days in range).");
      }
      const local = await cacheGetRange(sym, rangeStart, rangeEnd);
      const need = new Set(st.success_days || []);
      const still = local.missingDays.filter((d) => need.has(d));
      setLocalMissing(still);
      const ok =
        still.length === 0 &&
        (st.success_days || []).every((d) => local.fromCacheDays.includes(d));
      setDeviceVerified(ok);
      pushLog(
        ok
          ? "Device verified: all SUCCESS days present on device"
          : `Device incomplete: still missing ${still.join(", ") || "—"}`
      );
      return ok;
    } catch (warmErr) {
      setDeviceVerified(false);
      pushLog(`Warm cache failed: ${warmErr instanceof Error ? warmErr.message : String(warmErr)}`);
      return false;
    }
  }

  function applyTerminalFromStatus(st: DataStatus) {
    setStatus(st);
    if (isRangeComplete(st)) {
      setPhase("complete");
      pushLog("Backend verified: all days SUCCESS or EXPECTED_EMPTY.");
      return "complete" as const;
    }
    if ((st.failed_days || []).length > 0 && (st.missing_days || []).length === 0) {
      setPhase("incomplete");
      pushLog(
        `Incomplete — success=[${(st.success_days || []).join(", ")}] ` +
          `failed=[${(st.failed_days || []).join(", ")}]`
      );
      return "incomplete" as const;
    }
    if ((st.missing_days || []).length > 0) {
      // Still open — not terminal for recovery
      return "running" as const;
    }
    return "running" as const;
  }

  /**
   * After AbortError or 409: do NOT POST again.
   * Poll /api/data/status for the SAME symbol/start/end until verified, failed-complete, or max time.
   * Do NOT treat stable partial progress (trailing MISSING) as finished.
   */
  async function recoverViaStatusPoll(
    sym: string,
    rangeStart: string,
    rangeEnd: string,
    gen: number,
    reason: "abort" | "conflict"
  ): Promise<DataStatus | null> {
    if (reason === "abort") {
      setPhase("waiting_server");
      pushLog(
        "Sync connection interrupted. The server may still be syncing. Checking progress…"
      );
    } else {
      setPhase("conflict_409");
      pushLog("Another sync is already running. Waiting for it to finish…");
    }

    const started = Date.now();
    let lastFingerprint = "";

    while (Date.now() - started < RECOVERY_MAX_MS) {
      if (gen !== genRef.current) return null;
      await new Promise((r) => setTimeout(r, RECOVERY_POLL_MS));
      if (gen !== genRef.current) return null;

      try {
        const st = await fetchDataStatus(sym, rangeStart, rangeEnd);
        if (gen !== genRef.current) return null;
        setStatus(st);

        const fp = JSON.stringify({
          v: st.backend_verified,
          running: st.sync_in_progress,
          s: st.success_days,
          e: st.expected_empty_days,
          f: st.failed_days,
          m: st.missing_days,
          u: st.usable_bars,
        });
        if (fp !== lastFingerprint) {
          lastFingerprint = fp;
          pushLog(
            `Status: verified=${!!st.backend_verified} running=${st.sync_in_progress ?? "?"} ` +
              `usable=${st.usable_bars ?? 0} ` +
              `S=${(st.success_days || []).join("|") || "—"} ` +
              `E=${(st.expected_empty_days || []).join("|") || "—"} ` +
              `F=${(st.failed_days || []).join("|") || "—"} ` +
              `M=${(st.missing_days || []).join("|") || "—"}`
          );
        }

        // A) fully verified
        if (st.backend_verified || isRangeComplete(st)) {
          return st;
        }

        // C) no MISSING left, but some FAILED → terminal incomplete (job done with failures)
        const missing = st.missing_days || [];
        const failed = st.failed_days || [];
        if (missing.length === 0 && failed.length > 0) {
          // Prefer waiting while lock still held (optional signal)
          if (st.sync_in_progress) {
            continue;
          }
          return st;
        }

        // Trailing MISSING: keep polling (backend may still be on those days)
        // Optional: if sync_in_progress is explicitly false AND missing remains for a long
        // stretch after max time — handled by outer timeout (D).
      } catch (e) {
        pushLog(`Status poll error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    pushLog(
      "Recovery timeout — the server may still be syncing. Reopen later to check progress. No new Sync was started."
    );
    return null;
  }

  async function finishFromStatus(
    sym: string,
    rangeStart: string,
    rangeEnd: string,
    st: DataStatus,
    gen: number
  ) {
    setPhase("verifying");
    const terminal = applyTerminalFromStatus(st);
    if (terminal === "running") {
      setPhase("incomplete");
      pushLog("No terminal backend state yet (days still missing or unknown).");
      // Do not warm incomplete range
      pushLog("Sync incomplete — device warm skipped until backend verification.");
      setDeviceVerified(false);
      return;
    }
    if (terminal === "incomplete") {
      // failed days present, no missing — skip warm
      pushLog("Sync incomplete — device warm skipped until backend verification.");
      setDeviceVerified(false);
      return;
    }
    // complete only
    await warmDevice(sym, rangeStart, rangeEnd, st, gen);
    if (gen !== genRef.current) return;
    setPhase("complete");
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

    // Capture original range for the whole operation (including recovery)
    const rangeSymbol = symbol;
    const rangeStart = start;
    const rangeEnd = end;

    busyRef.current = true;
    const gen = ++genRef.current;
    setReport(null);
    setStatus(null);
    setLocalMissing([]);
    setDeviceVerified(false);
    setPhase("syncing");
    pushLog(`Sync start ${rangeSymbol} ${rangeStart} → ${rangeEnd}`);
    pushLog("Downloader: sequential hours, 429 backoff, skip already-verified days");

    try {
      const res = await syncDukascopy(rangeSymbol, rangeStart, rangeEnd, {
        onRetry: (attempt, err) => {
          if (gen !== genRef.current) return;
          setPhase("retrying");
          pushLog(
            `Cold-start transport retry ${attempt}: ${err instanceof Error ? err.message : String(err)}`
          );
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
      pushLog(`Backend verified: ${res.backend_verified ? "YES" : "NO"}`);

      setPhase("verifying");
      const st = await fetchDataStatus(rangeSymbol, rangeStart, rangeEnd);
      if (gen !== genRef.current) return;
      setStatus(st);

      if (isRangeComplete(st) || res.backend_verified) {
        await warmDevice(rangeSymbol, rangeStart, rangeEnd, st, gen);
        if (gen !== genRef.current) return;
        setPhase("complete");
        pushLog("Sync finished: backend range fully classified.");
      } else {
        pushLog("Sync incomplete — device warm skipped until backend verification.");
        setDeviceVerified(false);
        setPhase("incomplete");
        pushLog(
          `Incomplete — success=[${(st.success_days || []).join(", ")}] ` +
            `failed=[${(st.failed_days || []).join(", ")}] ` +
            `missing=[${(st.missing_days || []).join(", ")}]`
        );
      }
    } catch (e) {
      if (gen !== genRef.current) return;

      if (e instanceof SyncClientAbortError || e instanceof SyncConflictError) {
        const reason = e instanceof SyncConflictError ? "conflict" : "abort";
        pushLog(
          reason === "abort"
            ? "Client wait ended (timeout/abort). Not starting another POST."
            : "HTTP 409 — not starting another POST."
        );
        const st = await recoverViaStatusPoll(rangeSymbol, rangeStart, rangeEnd, gen, reason);
        if (gen !== genRef.current) return;
        if (st) {
          await finishFromStatus(rangeSymbol, rangeStart, rangeEnd, st, gen);
        } else {
          setPhase("incomplete");
          setDeviceVerified(false);
        }
        return;
      }

      setPhase("failed");
      pushLog(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
    }
  }

  const busy =
    phase === "syncing" ||
    phase === "retrying" ||
    phase === "waiting_server" ||
    phase === "conflict_409" ||
    phase === "verifying" ||
    phase === "warming";

  const phaseLabel: Record<Phase, string> = {
    idle: "idle",
    syncing: "Syncing market data…",
    retrying: "Cold-start retry…",
    waiting_server: "Server sync still running — checking…",
    conflict_409: "Another sync running — waiting…",
    verifying: "Verifying…",
    warming: "Warming device cache…",
    complete: "complete",
    partial: "partial",
    incomplete: "incomplete",
    failed: "failed",
  };

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
          Sequential Dukascopy downloads with 429 backoff. Recovery polling continues while
          requested days are still MISSING (does not stop after a few quiet seconds).
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
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input type="date" value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} />
          <span>to</span>
          <input type="date" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} />
          <button onClick={() => void handleSync()} disabled={busy || !backendOnline}>
            {busy ? phaseLabel[phase] : "Sync"}
          </button>
        </div>

        <p className="hint">
          Phase: <b>{phaseLabel[phase]}</b>
          {report ? ` · ticks ${report.ticks.toLocaleString()} · 1s bars ${report.seconds.toLocaleString()}` : null}
        </p>

        {status && (
          <div className="sync-result">
            <p>
              Backend verified: <b>{status.backend_verified ? "YES" : "NO"}</b>
              {status.sync_in_progress != null
                ? ` · sync_in_progress=${status.sync_in_progress ? "yes" : "no"}`
                : ""}
              {status.usable_bars != null ? ` · usable 1s bars ~${status.usable_bars.toLocaleString()}` : ""}
            </p>
            {status.success_days?.length ? <p>SUCCESS: {status.success_days.join(", ")}</p> : null}
            {status.expected_empty_days?.length ? (
              <p>EXPECTED_EMPTY: {status.expected_empty_days.join(", ")}</p>
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
          Abort/timeout and HTTP 409 never start a second Sync POST. Trailing MISSING days keep
          recovery polling until verified, failed-complete, or 20-minute recovery timeout.
        </p>
      </div>
    </section>
  );
}

/** Exported for unit tests of termination rules (no React). */
export function shouldStopRecoveryPoll(st: DataStatus, syncInProgressUnknown = false): boolean {
  if (st.backend_verified || isRangeComplete(st)) return true;
  const missing = st.missing_days || [];
  const failed = st.failed_days || [];
  if (missing.length === 0 && failed.length > 0) {
    if (st.sync_in_progress === true) return false;
    if (st.sync_in_progress === false) return true;
    // unknown lock: treat failed-complete as terminal
    return syncInProgressUnknown || st.sync_in_progress == null;
  }
  // Trailing missing: never stop solely due to silence
  return false;
}
