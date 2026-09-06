import { useEffect, useState } from "react";
import { addWatchlistItem, fetchWatchlist, removeWatchlistItem } from "../lib/api";
import type { WatchlistItem } from "../lib/types";
import { SYMBOLS } from "../lib/types";

export function WatchlistView({ backendOnline }: { backendOnline: boolean | null }) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!backendOnline) {
      setLoading(false);
      return;
    }
    fetchWatchlist()
      .then((r) => setItems(r.items))
      .catch(() => setError("Could not load watchlist from backend"))
      .finally(() => setLoading(false));
  }, [backendOnline]);

  async function handleAdd() {
    if (!backendOnline) {
      setItems((prev) =>
        prev.some((i) => i.symbol === symbol) ? prev : [...prev, { symbol, note }]
      );
      setNote("");
      return;
    }
    try {
      const res = await addWatchlistItem({ symbol, note });
      setItems(res.items);
      setNote("");
    } catch {
      setError("Could not save to backend");
    }
  }

  async function handleRemove(sym: string) {
    if (!backendOnline) {
      setItems((prev) => prev.filter((i) => i.symbol !== sym));
      return;
    }
    try {
      const res = await removeWatchlistItem(sym);
      setItems(res.items);
    } catch {
      setError("Could not remove from backend");
    }
  }

  return (
    <section className="watchlist-view">
      <h2>Watchlist</h2>
      {!backendOnline && (
        <p className="notice">Backend offline — changes are kept in this browser tab only.</p>
      )}
      {error && <p className="notice warn-text">{error}</p>}

      <div className="watchlist-add">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button onClick={handleAdd}>Add</button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="empty-state">No symbols on your watchlist yet.</p>
      ) : (
        <ul className="watchlist-items">
          {items.map((item) => (
            <li key={item.symbol}>
              <b>{item.symbol}</b>
              <span>{item.note}</span>
              <button onClick={() => handleRemove(item.symbol)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
