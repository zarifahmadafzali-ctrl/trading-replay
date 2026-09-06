import { useEffect, useState } from "react";
import { deleteSession, fetchSessions, saveSession } from "../lib/api";
import type { ReplaySession } from "../lib/types";
import { SYMBOLS, TIMEFRAMES } from "../lib/types";

export function SessionView({ backendOnline }: { backendOnline: boolean | null }) {
  const [sessions, setSessions] = useState<ReplaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [timeframeSeconds, setTimeframeSeconds] = useState(300);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!backendOnline) {
      setLoading(false);
      return;
    }
    fetchSessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => setError("Could not load sessions from backend"))
      .finally(() => setLoading(false));
  }, [backendOnline]);

  async function handleSave() {
    if (!name.trim()) {
      setError("Give the session a name first");
      return;
    }
    const payload: ReplaySession = {
      name: name.trim(),
      symbol,
      timeframe_seconds: timeframeSeconds,
      cursor: 0,
      speed: 1,
      notes,
    };
    if (!backendOnline) {
      setSessions((prev) => [...prev.filter((s) => s.name !== payload.name), payload]);
      setName("");
      setNotes("");
      return;
    }
    try {
      const res = await saveSession(payload);
      setSessions(res.sessions);
      setName("");
      setNotes("");
      setError(null);
    } catch {
      setError("Could not save session to backend");
    }
  }

  async function handleDelete(sessionName: string) {
    if (!backendOnline) {
      setSessions((prev) => prev.filter((s) => s.name !== sessionName));
      return;
    }
    try {
      const res = await deleteSession(sessionName);
      setSessions(res.sessions);
    } catch {
      setError("Could not delete session on backend");
    }
  }

  return (
    <section className="session-view">
      <h2>Saved Sessions</h2>
      {!backendOnline && (
        <p className="notice">Backend offline — sessions are kept in this browser tab only.</p>
      )}
      {error && <p className="notice warn-text">{error}</p>}

      <div className="session-form">
        <input
          type="text"
          placeholder="Session name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={timeframeSeconds}
          onChange={(e) => setTimeframeSeconds(Number(e.target.value))}
        >
          {TIMEFRAMES.map((tf) => (
            <option key={tf.seconds} value={tf.seconds}>
              {tf.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <button onClick={handleSave}>Save session</button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="empty-state">No saved sessions yet.</p>
      ) : (
        <ul className="session-items">
          {sessions.map((s) => (
            <li key={s.name}>
              <div>
                <b>{s.name}</b>
                <span>
                  {s.symbol} · {s.timeframe_seconds < 60 ? `${s.timeframe_seconds}s` : `${s.timeframe_seconds / 60}m`}
                </span>
                {s.notes && <p className="session-notes">{s.notes}</p>}
              </div>
              <button onClick={() => handleDelete(s.name)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
