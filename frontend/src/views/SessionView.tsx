import { useCallback, useEffect, useState } from "react";
import { SYMBOLS } from "../lib/types";
import {
  createSession,
  deleteSessionAll,
  emitSessionChanged,
  getActiveSessionId,
  listSessions,
  migrateLegacyToSessionIfNeeded,
  setActiveSessionId,
  type SessionMeta,
} from "../lib/sessionStore";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function SessionView({ backendOnline }: { backendOnline: boolean | null }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [start, setStart] = useState(() => isoDaysAgo(31));
  const [end, setEnd] = useState(() => isoDaysAgo(0));

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await migrateLegacyToSessionIfNeeded();
      const list = await listSessions();
      setSessions(list);
      setActiveId(getActiveSessionId());
      setError(null);
    } catch {
      setError("Could not load sessions from IndexedDB");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!name.trim()) {
      setError("Give the session a name first");
      return;
    }
    if (!start || !end || end < start) {
      setError("Invalid date range");
      return;
    }
    try {
      const meta = await createSession({
        name: name.trim(),
        symbol,
        start,
        end,
        dataSource: "demo",
      });
      setName("");
      await refresh();
      setActiveSessionId(meta.id);
      setActiveId(meta.id);
      emitSessionChanged(meta.id);
      setError(null);
    } catch {
      setError("Could not create session");
    }
  }

  async function handleActivate(id: string) {
    setActiveSessionId(id);
    setActiveId(id);
    emitSessionChanged(id);
  }

  async function handleDelete(id: string) {
    try {
      await deleteSessionAll(id);
      await refresh();
      emitSessionChanged(getActiveSessionId());
    } catch {
      setError("Could not delete session");
    }
  }

  return (
    <section className="session-view">
      <h2>Backtest Sessions</h2>
      <p className="notice">
        Each session is an isolated workspace (cursor, drawings, positions, journal, indicators).
        Market 1s data is shared in IndexedDB by symbol/day.
        {backendOnline === false ? " Backend offline — sessions still work offline." : null}
      </p>
      {error && <p className="notice warn-text">{error}</p>}

      <div className="session-form">
        <input
          id="session-name"
          type="text"
          placeholder="Name · e.g. US30 August 2026"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select id="session-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input id="session-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <input id="session-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button id="session-create" type="button" className="on" onClick={() => void handleCreate()}>
          Create session
        </button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="empty-state">No sessions yet. Create one to start an isolated backtest.</p>
      ) : (
        <ul className="session-items">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeId ? "session-active" : undefined}>
              <div>
                <b>{s.name}</b>
                <span className="muted"> · {s.symbol} · {s.start} → {s.end}{s.id === activeId ? " · ACTIVE" : ""}</span>
              </div>
              <div className="session-actions">
                {s.id !== activeId && (
                  <button type="button" className="on" onClick={() => void handleActivate(s.id)}>Open</button>
                )}
                <button type="button" onClick={() => void handleDelete(s.id)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
