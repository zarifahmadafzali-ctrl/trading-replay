import { useEffect, useState } from "react";
import { addTrade, deleteTrade, fetchTradeStats, fetchTrades } from "../lib/api";
import type { Trade, TradeStats } from "../lib/api";

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
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  function load() {
    if (!backendOnline) {
      setLoading(false);
      return;
    }
    Promise.all([fetchTrades(), fetchTradeStats()])
      .then(([t, s]) => {
        setTrades(t.trades);
        setStats(s);
      })
      .catch(() => setError("Could not load journal from backend"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [backendOnline]);

  async function handleAdd() {
    if (!form.symbol.trim() || !form.entry_price || !form.exit_price) {
      setError("Symbol, entry price, and exit price are required");
      return;
    }
    if (!backendOnline) {
      setError("Backend is offline — trades can't be saved right now");
      return;
    }
    try {
      await addTrade({
        symbol: form.symbol.trim().toUpperCase(),
        direction: form.direction,
        entry_price: Number(form.entry_price),
        exit_price: Number(form.exit_price),
        stop_price: form.stop_price ? Number(form.stop_price) : null,
        take_profit_price: form.take_profit_price ? Number(form.take_profit_price) : null,
        size: Number(form.size) || 1,
        notes: form.notes,
        opened_at: null,
        closed_at: Date.now() / 1000,
      });
      setForm(emptyForm);
      setError(null);
      load();
    } catch {
      setError("Could not save trade to backend");
    }
  }

  async function handleDelete(id: string) {
    if (!backendOnline) return;
    try {
      await deleteTrade(id);
      load();
    } catch {
      setError("Could not delete trade");
    }
  }

  return (
    <section className="journal-view">
      <h2>Trade Journal</h2>

      {!backendOnline && (
        <p className="notice warn-text">
          Backend is offline — start the FastAPI server to log and review trades.
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
