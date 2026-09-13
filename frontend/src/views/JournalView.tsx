import { useEffect, useMemo, useState } from "react";
import { addTrade, deleteTrade, fetchTrades } from "../lib/api";
import type { Trade, TradeStats } from "../lib/api";
import { appendTrade, loadJournalForSession, saveJournalForSession, rMultiple, type JournalTrade } from "../lib/journal";
import { getActiveSessionId, SESSION_CHANGED_EVENT } from "../lib/sessionStore";

const emptyForm = {
  symbol: "",
  direction: "long" as "long" | "short",
  entry_price: "",
  exit_price: "",
  stop_price: "",
  take_profit_price: "",
  size: "1",
  notes: "",
};

function tradeR(t: Trade): number | null {
  const pnl = t.direction === "long" ? t.exit_price - t.entry_price : t.entry_price - t.exit_price;
  if (!t.stop_price) return null;
  const risk = t.direction === "long" ? t.entry_price - t.stop_price : t.stop_price - t.entry_price;
  if (!risk || risk <= 0) return null;
  return pnl / risk;
}

/** Small dependency-free equity curve — cumulative R across trades in order. */
function EquityCurve({ trades }: { trades: Trade[] }) {
  const points = trades.reduce<number[]>((acc, t) => {
    const r = tradeR(t) ?? 0;
    acc.push((acc[acc.length - 1] ?? 0) + r);
    return acc;
  }, []);
  if (points.length < 2) {
    return <p className="empty-state">Log at least 2 trades with stop prices to see an equity curve.</p>;
  }

  const w = 600;
  const h = 140;
  const pad = 8;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (points.length - 1);
  const toY = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2);

  const path = points.map((v, i) => `${i === 0 ? "M" : "L"} ${pad + i * stepX} ${toY(v)}`).join(" ");
  const zeroY = toY(0);
  const positive = points[points.length - 1] >= 0;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 140 }}>
      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="#293542" strokeWidth={1} strokeDasharray="4 3" />
      <path d={path} fill="none" stroke={positive ? "#26a69a" : "#ef5350"} strokeWidth={2} />
    </svg>
  );
}

export function JournalView({ backendOnline }: { backendOnline: boolean | null }) {
  const [backendTrades, setBackendTrades] = useState<Trade[]>([]);
  const [localTrades, setLocalTrades] = useState<JournalTrade[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const trades = useMemo<Trade[]>(() => {
    const local: Trade[] = localTrades.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      direction: t.side,
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      size: 1,
      stop_price: t.stopPrice,
      take_profit_price: t.takeProfitPrice,
      opened_at: t.entryTime,
      closed_at: t.exitTime,
      notes: t.note ?? `auto-${t.reason}`,
    }));
    const sameTrade = (a: Trade, b: Trade) =>
      a.symbol === b.symbol &&
      a.direction === b.direction &&
      Math.abs(a.entry_price - b.entry_price) < 1e-9 &&
      Math.abs(a.exit_price - b.exit_price) < 1e-9 &&
      a.opened_at != null && b.opened_at != null && Math.abs(a.opened_at - b.opened_at) <= 1 &&
      a.closed_at != null && b.closed_at != null && Math.abs(a.closed_at - b.closed_at) <= 1;
    const merged = [...backendTrades];
    for (const t of local) if (!merged.some((b) => sameTrade(b, t))) merged.push(t);
    return merged.sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  }, [backendTrades, localTrades]);

  function refreshLocal() {
    void loadJournalForSession(getActiveSessionId()).then(setLocalTrades);
  }

  useEffect(() => {
    refreshLocal();
    const onSess = () => refreshLocal();
    window.addEventListener(SESSION_CHANGED_EVENT, onSess);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onSess);
  }, []);

  function load() {
    refreshLocal();
    if (!backendOnline) {
      setLoading(false);
      return;
    }
    fetchTrades()
      .then((t) => setBackendTrades(t.trades))
      .catch(() => setError("Backend unavailable · local journal is still active"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [backendOnline]);

  useEffect(() => {
    const next: TradeStats = {
      total: trades.length,
      wins: trades.filter((t) => (tradeR(t) ?? 0) > 0).length,
      losses: trades.filter((t) => (tradeR(t) ?? 0) < 0).length,
      win_rate: trades.length ? Number(((trades.filter((t) => (tradeR(t) ?? 0) > 0).length / trades.length) * 100).toFixed(2)) : 0,
      avg_r: trades.length ? Number((trades.map((t) => tradeR(t)).filter((r): r is number => r != null).reduce((a, r) => a + r, 0) / Math.max(1, trades.map((t) => tradeR(t)).filter((r): r is number => r != null).length)).toFixed(2)) : null,
      total_r: Number(trades.reduce((a, t) => a + (tradeR(t) ?? 0), 0).toFixed(2)),
      best_r: trades.length ? Math.max(...trades.map((t) => tradeR(t) ?? 0)) : null,
      worst_r: trades.length ? Math.min(...trades.map((t) => tradeR(t) ?? 0)) : null,
    };
    setStats(next);
  }, [trades]);

  async function handleAdd() {
    if (!form.symbol.trim() || !form.entry_price || !form.exit_price) {
      setError("Symbol, entry price, and exit price are required");
      return;
    }
    const entry = Number(form.entry_price);
    const exit = Number(form.exit_price);
    const stop = form.stop_price ? Number(form.stop_price) : 0;
    const takeProfit = form.take_profit_price ? Number(form.take_profit_price) : 0;
    const exitTime = Date.now() / 1000;
    const local: JournalTrade = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: form.symbol.trim().toUpperCase(),
      side: form.direction,
      orderType: "manual",
      entryPrice: entry,
      exitPrice: exit,
      stopPrice: stop,
      takeProfitPrice: takeProfit,
      entryTime: exitTime,
      exitTime,
      reason: "manual",
      pnlPoints: form.direction === "long" ? exit - entry : entry - exit,
      rMultiple: stop ? rMultiple(form.direction, entry, stop, exit) : null,
      note: form.notes,
    };
    appendTrade(local);
    refreshLocal();
    setForm(emptyForm);
    setError(null);

    if (backendOnline) {
      try {
        await addTrade({
          symbol: local.symbol, direction: local.side, entry_price: entry, exit_price: exit,
          stop_price: form.stop_price ? stop : null, take_profit_price: form.take_profit_price ? takeProfit : null,
          size: Number(form.size) || 1, notes: form.notes, opened_at: null, closed_at: exitTime,
        });
        load();
      } catch {
        setError("Saved locally · backend sync failed");
      }
    }
  }

  async function handleDelete(id: string) {
    const local = localTrades.filter((t) => t.id !== id);
    if (local.length !== localTrades.length) {
      void saveJournalForSession(getActiveSessionId(), local);
      setLocalTrades(local);
    }
    if (backendOnline && !id.startsWith("replay-") && !id.startsWith("manual-")) {
      try {
        await deleteTrade(id);
        load();
      } catch {
        setError("Could not delete backend trade");
      }
    }
  }

  return (
    <section className="journal-view">
      <h2>Trade Journal</h2>

      {!backendOnline && (
        <p className="notice warn-text">
          Backend offline · local Journal is active. Replay auto-closes and manual entries are saved on this device.
        </p>
      )}
      {error && <p className="notice warn-text">{error}</p>}

      {stats && stats.total > 0 && (
        <div className="journal-stats">
          <div className="stat-card">
            <span className="stat-label">Trades</span>
            <span className="stat-value">{stats.total}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Win rate</span>
            <span className="stat-value">{stats.win_rate}%</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Avg R</span>
            <span className={`stat-value ${stats.avg_r != null && stats.avg_r >= 0 ? "up" : "down"}`}>
              {stats.avg_r ?? "—"}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Total R</span>
            <span className={`stat-value ${stats.total_r != null && stats.total_r >= 0 ? "up" : "down"}`}>
              {stats.total_r ?? "—"}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Best / Worst</span>
            <span className="stat-value">
              {stats.best_r ?? "—"} / {stats.worst_r ?? "—"}
            </span>
          </div>
        </div>
      )}

      <div className="card">
        <b>Equity curve (cumulative R)</b>
        <EquityCurve trades={trades} />
      </div>

      <div className="journal-form card">
        <b>Log a closed trade</b>
        <div className="journal-form-grid">
          <input
            type="text"
            placeholder="Symbol (e.g. EURUSD)"
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
          />
          <select
            value={form.direction}
            onChange={(e) => setForm({ ...form, direction: e.target.value as "long" | "short" })}
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
          <input
            type="number"
            placeholder="Entry price"
            value={form.entry_price}
            onChange={(e) => setForm({ ...form, entry_price: e.target.value })}
          />
          <input
            type="number"
            placeholder="Exit price"
            value={form.exit_price}
            onChange={(e) => setForm({ ...form, exit_price: e.target.value })}
          />
          <input
            type="number"
            placeholder="Stop price (for R calc)"
            value={form.stop_price}
            onChange={(e) => setForm({ ...form, stop_price: e.target.value })}
          />
          <input
            type="number"
            placeholder="Take profit (optional)"
            value={form.take_profit_price}
            onChange={(e) => setForm({ ...form, take_profit_price: e.target.value })}
          />
          <input
            type="text"
            placeholder="Notes (setup, mistake, lesson…)"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="notes-input"
          />
        </div>
        <button onClick={handleAdd}>Log trade</button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : trades.length === 0 ? (
        <p className="empty-state">No trades logged yet.</p>
      ) : (
        <table className="journal-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Dir</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>R</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...trades].reverse().map((t) => {
              const r = tradeR(t);
              return (
                <tr key={t.id}>
                  <td>{t.symbol}</td>
                  <td className={t.direction === "long" ? "up" : "down"}>{t.direction}</td>
                  <td>{t.entry_price}</td>
                  <td>{t.exit_price}</td>
                  <td className={r != null ? (r >= 0 ? "up" : "down") : ""}>{r != null ? r.toFixed(2) : "—"}</td>
                  <td className="notes-cell">{t.notes}</td>
                  <td>
                    <button onClick={() => handleDelete(t.id)}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
