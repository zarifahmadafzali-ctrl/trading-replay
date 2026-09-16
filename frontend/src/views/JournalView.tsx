import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadJournalForSession,
  resolveCurrencyPnL,
  type JournalTrade,
  type CloseReason,
} from "../lib/journal";
import {
  getActiveSessionId,
  listSessions,
  SESSION_CHANGED_EVENT,
  type SessionMeta,
} from "../lib/sessionStore";

type SortKey =
  | "exitTime"
  | "currencyPnL"
  | "rMultiple"
  | "durationSeconds"
  | "riskPercent"
  | "accountId";

function fmtTime(unix: number): string {
  if (!unix) return "—";
  const ms = unix > 1e12 ? unix : unix * 1000;
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "—";
  }
}

function fmtNum(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(d);
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

function durationLabel(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function JournalView(_props: { backendOnline?: boolean | null }) {
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(() => getActiveSessionId());
  const [selected, setSelected] = useState<JournalTrade | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("exitTime");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [fAccount, setFAccount] = useState("all");
  const [fSymbol, setFSymbol] = useState("all");
  const [fSide, setFSide] = useState("all");
  const [fOrder, setFOrder] = useState("all");
  const [fReason, setFReason] = useState("all");
  const [fPhase, setFPhase] = useState("all");

  const reload = useCallback(async () => {
    const sid = getActiveSessionId();
    setSessionId(sid);
    const [rows, sess] = await Promise.all([loadJournalForSession(sid), listSessions()]);
    setTrades(rows);
    setSessions(sess);
  }, []);

  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener(SESSION_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onChange);
  }, [reload]);

  const accounts = useMemo(() => {
    const s = new Set<string>();
    for (const t of trades) if (t.accountId) s.add(t.accountId);
    return [...s];
  }, [trades]);
  const symbols = useMemo(() => {
    const s = new Set<string>();
    for (const t of trades) if (t.symbol) s.add(t.symbol);
    return [...s];
  }, [trades]);
  const phases = useMemo(() => {
    const s = new Set<string>();
    for (const t of trades) if (t.propPhaseName || t.propPhaseId) s.add(t.propPhaseName || t.propPhaseId || "");
    return [...s].filter(Boolean);
  }, [trades]);

  const filtered = useMemo(() => {
    let rows = trades.slice();
    if (fAccount !== "all") rows = rows.filter((t) => t.accountId === fAccount);
    if (fSymbol !== "all") rows = rows.filter((t) => t.symbol === fSymbol);
    if (fSide !== "all") rows = rows.filter((t) => t.side === fSide);
    if (fOrder !== "all") rows = rows.filter((t) => t.orderType === fOrder);
    if (fReason !== "all") rows = rows.filter((t) => t.reason === fReason);
    if (fPhase !== "all")
      rows = rows.filter((t) => (t.propPhaseName || t.propPhaseId) === fPhase);

    rows.sort((a, b) => {
      const av =
        sortKey === "currencyPnL"
          ? resolveCurrencyPnL(a) ?? -Infinity
          : sortKey === "rMultiple"
            ? a.rMultiple ?? -Infinity
            : sortKey === "durationSeconds"
              ? a.durationSeconds ?? 0
              : sortKey === "riskPercent"
                ? a.riskPercent ?? 0
                : sortKey === "accountId"
                  ? a.accountId || ""
                  : a.exitTime || 0;
      const bv =
        sortKey === "currencyPnL"
          ? resolveCurrencyPnL(b) ?? -Infinity
          : sortKey === "rMultiple"
            ? b.rMultiple ?? -Infinity
            : sortKey === "durationSeconds"
              ? b.durationSeconds ?? 0
              : sortKey === "riskPercent"
                ? b.riskPercent ?? 0
                : sortKey === "accountId"
                  ? b.accountId || ""
                  : b.exitTime || 0;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = Number(av);
      const bn = Number(bv);
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return rows;
  }, [trades, fAccount, fSymbol, fSide, fOrder, fReason, fPhase, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "exitTime" ? "desc" : "desc");
    }
  }

  const sessionName =
    sessions.find((s) => s.id === sessionId)?.name || sessionId || "—";

  return (
    <section className="journal-view journal-pro">
      <header className="journal-pro-head">
        <div>
          <h2>Trade Journal</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Automated from closed positions · Session: <b>{sessionName}</b> · {filtered.length} trade
            {filtered.length === 1 ? "" : "s"}
          </p>
        </div>
      </header>

      <div className="journal-filters card">
        <label>
          Account
          <select value={fAccount} onChange={(e) => setFAccount(e.target.value)}>
            <option value="all">All</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Symbol
          <select value={fSymbol} onChange={(e) => setFSymbol(e.target.value)}>
            <option value="all">All</option>
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Side
          <select value={fSide} onChange={(e) => setFSide(e.target.value)}>
            <option value="all">All</option>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <label>
          Order
          <select value={fOrder} onChange={(e) => setFOrder(e.target.value)}>
            <option value="all">All</option>
            <option value="market">Market</option>
            <option value="buy_limit">Buy Limit</option>
            <option value="sell_limit">Sell Limit</option>
            <option value="buy_stop">Buy Stop</option>
            <option value="sell_stop">Sell Stop</option>
            <option value="buy_stop_limit">Buy Stop Limit</option>
            <option value="sell_stop_limit">Sell Stop Limit</option>
          </select>
        </label>
        <label>
          Exit
          <select value={fReason} onChange={(e) => setFReason(e.target.value)}>
            <option value="all">All</option>
            <option value="sl">SL</option>
            <option value="tp">TP</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label>
          Phase
          <select value={fPhase} onChange={(e) => setFPhase(e.target.value)}>
            <option value="all">All</option>
            {phases.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Desktop table */}
      <div className="journal-table-wrap card journal-desktop-only">
        <table className="journal-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("exitTime")}>Date</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Type</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>SL</th>
              <th>TP</th>
              <th>Lot</th>
              <th onClick={() => toggleSort("riskPercent")}>Risk %</th>
              <th>Risk $</th>
              <th>Reward $</th>
              <th onClick={() => toggleSort("rMultiple")}>R</th>
              <th onClick={() => toggleSort("currencyPnL")}>P&amp;L</th>
              <th onClick={() => toggleSort("durationSeconds")}>Dur</th>
              <th>Exit</th>
              <th>Phase</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={17} className="empty-state">
                  No closed trades in this session yet. Close a position on the chart to auto-journal.
                </td>
              </tr>
            )}
            {filtered.map((t) => {
              const pnl = resolveCurrencyPnL(t);
              return (
                <tr key={t.id} onClick={() => setSelected(t)} className="journal-row">
                  <td>{fmtTime(t.exitTime)}</td>
                  <td>{t.symbol || "—"}</td>
                  <td className={t.side === "long" ? "up" : "down"}>{t.side.toUpperCase()}</td>
                  <td>{t.orderType}</td>
                  <td>{fmtNum(t.entryPrice)}</td>
                  <td>{fmtNum(t.exitPrice)}</td>
                  <td>{fmtNum(t.stopPrice)}</td>
                  <td>{fmtNum(t.takeProfitPrice)}</td>
                  <td>{fmtNum(t.finalLot, 2)}</td>
                  <td>{fmtNum(t.riskPercent, 2)}</td>
                  <td>{fmtUsd(t.actualRiskAmount ?? t.riskAmount)}</td>
                  <td>{fmtUsd(t.rewardAmount)}</td>
                  <td className={(t.rMultiple ?? 0) >= 0 ? "up" : "down"}>{fmtNum(t.rMultiple, 2)}</td>
                  <td className={(pnl ?? 0) >= 0 ? "up" : "down"}>{fmtUsd(pnl)}</td>
                  <td>{durationLabel(t.durationSeconds)}</td>
                  <td>{(t.reason as CloseReason).toUpperCase()}</td>
                  <td>{t.propPhaseName || t.propPhaseId || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="journal-mobile-only">
        {filtered.length === 0 && (
          <p className="empty-state card">No closed trades yet. Close a position to auto-journal.</p>
        )}
        {filtered.map((t) => {
          const pnl = resolveCurrencyPnL(t);
          return (
            <button
              type="button"
              key={t.id}
              className="journal-card card"
              onClick={() => setSelected(t)}
            >
              <div className="journal-card-top">
                <strong>
                  {t.symbol} · <span className={t.side === "long" ? "up" : "down"}>{t.side.toUpperCase()}</span>
                </strong>
                <span className={(pnl ?? 0) >= 0 ? "up" : "down"}>{fmtUsd(pnl)}</span>
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                {fmtTime(t.exitTime)} · {t.reason.toUpperCase()} · R {fmtNum(t.rMultiple, 2)}
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="journal-drawer-backdrop" onClick={() => setSelected(null)}>
          <aside className="journal-drawer card" onClick={(e) => e.stopPropagation()}>
            <header className="journal-drawer-head">
              <h3>
                {selected.symbol} {selected.side.toUpperCase()}
              </h3>
              <button type="button" className="btn-ghost" onClick={() => setSelected(null)}>
                Close
              </button>
            </header>

            <section>
              <h4>Trade summary</h4>
              <div className="journal-detail-grid">
                <span>Order</span>
                <span>{selected.orderType}</span>
                <span>Entry</span>
                <span>
                  {fmtNum(selected.entryPrice)} @ {fmtTime(selected.entryTime)}
                </span>
                <span>Exit</span>
                <span>
                  {fmtNum(selected.exitPrice)} @ {fmtTime(selected.exitTime)}
                </span>
                <span>Duration</span>
                <span>{durationLabel(selected.durationSeconds)}</span>
                <span>Exit reason</span>
                <span>{selected.reason.toUpperCase()}</span>
              </div>
            </section>

            <section>
              <h4>Risk</h4>
              <div className="journal-detail-grid">
                <span>Account</span>
                <span>{selected.accountId || "—"}</span>
                <span>Balance before</span>
                <span>{fmtUsd(selected.balanceBefore)}</span>
                <span>Risk %</span>
                <span>{fmtNum(selected.riskPercent, 2)}</span>
                <span>Actual risk $</span>
                <span>{fmtUsd(selected.actualRiskAmount ?? selected.riskAmount)}</span>
                <span>Actual risk %</span>
                <span>{fmtNum(selected.actualRiskPercent, 2)}</span>
                <span>Lot</span>
                <span>{fmtNum(selected.finalLot, 2)}</span>
                <span>Margin</span>
                <span>{fmtUsd(selected.marginUsed)}</span>
              </div>
            </section>

            <section>
              <h4>Reward</h4>
              <div className="journal-detail-grid">
                <span>SL</span>
                <span>{fmtNum(selected.stopPrice)}</span>
                <span>TP</span>
                <span>{fmtNum(selected.takeProfitPrice)}</span>
                <span>Reward $</span>
                <span>{fmtUsd(selected.rewardAmount)}</span>
                <span>R multiple</span>
                <span>{fmtNum(selected.rMultiple, 2)}</span>
              </div>
            </section>

            <section>
              <h4>Result</h4>
              <div className="journal-detail-grid">
                <span>Points</span>
                <span>{fmtNum(selected.pnlPoints, 2)}</span>
                <span>Currency P&amp;L</span>
                <span className={(resolveCurrencyPnL(selected) ?? 0) >= 0 ? "up" : "down"}>
                  {fmtUsd(resolveCurrencyPnL(selected))}
                </span>
                <span>Balance after</span>
                <span>{fmtUsd(selected.balanceAfter)}</span>
              </div>
            </section>

            {(selected.accountType === "prop" || selected.propPhaseId) && (
              <section>
                <h4>Prop</h4>
                <div className="journal-detail-grid">
                  <span>Firm</span>
                  <span>{selected.propFirmName || "—"}</span>
                  <span>Program</span>
                  <span>{selected.propProgramName || "—"}</span>
                  <span>Phase</span>
                  <span>{selected.propPhaseName || selected.propPhaseId || "—"}</span>
                </div>
              </section>
            )}

            {selected.closeScreenshot && (
              <section>
                <h4>Chart at close</h4>
                <img
                  src={selected.closeScreenshot}
                  alt="Trade close chart"
                  className="journal-screenshot"
                />
              </section>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
