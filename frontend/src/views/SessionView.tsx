import { useCallback, useEffect, useState } from "react";
import { SYMBOLS } from "../lib/types";
import {
  createSession,
  deleteSessionAll,
  emitSessionChanged,
  ensureSessionAccounts,
  getActiveSessionId,
  listSessions,
  migrateLegacyToSessionIfNeeded,
  setActiveSessionId,
  type SessionMeta,
} from "../lib/sessionStore";
import {
  defaultAccount,
  defaultInstrument,
  defaultPropFirm,
  type AccountProfile,
  type InstrumentSpec,
  type PropFirmConfig,
} from "../lib/riskModel";

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function newAccount(n: number): AccountProfile {
  return defaultAccount({
    name: `Account ${n}`,
    initialBalance: n === 1 ? 5000 : n === 2 ? 10000 : 25000,
    balance: n === 1 ? 5000 : n === 2 ? 10000 : 25000,
    leverage: n === 1 ? 20 : n === 2 ? 50 : 100,
  });
}

export function SessionView({ backendOnline }: { backendOnline: boolean | null }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sessionType, setSessionType] = useState<"backtest" | "prop">("backtest");
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("");
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [start, setStart] = useState(() => isoDaysAgo(31));
  const [end, setEnd] = useState(() => isoDaysAgo(0));
  const [dataSource, setDataSource] = useState<"demo" | "loaded" | "csv">("demo");

  const [accounts, setAccounts] = useState<AccountProfile[]>(() => [newAccount(1)]);
  const [activeAccountId, setActiveAccountId] = useState(() => accounts[0]?.accountId || "");
  const [instrument, setInstrument] = useState<InstrumentSpec>(() => defaultInstrument(SYMBOLS[0]));
  const [propFirm, setPropFirm] = useState<PropFirmConfig>(() => defaultPropFirm());

  useEffect(() => {
    setInstrument((prev) => ({ ...defaultInstrument(symbol), ...prev, symbol }));
  }, [symbol]);

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

  function updateAccount(id: string, patch: Partial<AccountProfile>) {
    setAccounts((prev) => prev.map((a) => (a.accountId === id ? { ...a, ...patch } : a)));
  }

  function addAccount() {
    if (accounts.length >= 3) return;
    const a = newAccount(accounts.length + 1);
    setAccounts((prev) => [...prev, a]);
    if (!activeAccountId) setActiveAccountId(a.accountId);
  }

  function removeAccount(id: string) {
    if (accounts.length <= 1) return;
    const next = accounts.filter((a) => a.accountId !== id);
    setAccounts(next);
    if (activeAccountId === id) setActiveAccountId(next[0].accountId);
  }

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
      const pf = { ...propFirm, enabled: sessionType === "prop" };
      const meta = await createSession({
        name: name.trim(),
        symbol,
        start,
        end,
        dataSource,
        strategy: strategy.trim() || undefined,
        sessionType,
        accounts: accounts.slice(0, 3).map((a) => ({
          ...a,
          balance: a.balance || a.initialBalance,
          initialBalance: a.initialBalance || a.balance,
        })),
        activeAccountId: activeAccountId || accounts[0].accountId,
        instrument: { ...instrument, symbol },
        propFirm: pf,
      });
      setName("");
      setStrategy("");
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
        Each session is an isolated workspace (accounts, instrument, drawings, journal). Market 1s data
        is shared by symbol/day.
        {backendOnline === false ? " Backend offline — sessions still work offline." : null}
      </p>
      {error && <p className="notice warn-text">{error}</p>}

      <div className="session-form">
        <div className="session-form-grid">
          <label>
            Session type
            <select value={sessionType} onChange={(e) => setSessionType(e.target.value as "backtest" | "prop")}>
              <option value="backtest">Backtesting Session</option>
              <option value="prop">Prop Firm Session</option>
            </select>
          </label>
          <label>
            Name
            <input id="session-name" type="text" placeholder="US30 August 2026" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Strategy
            <input type="text" placeholder="e.g. ORB / ICT" value={strategy} onChange={(e) => setStrategy(e.target.value)} />
          </label>
          <label>
            Symbol
            <select id="session-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {SYMBOLS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Start
            <input id="session-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            End
            <input id="session-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <label>
            Data source
            <select value={dataSource} onChange={(e) => setDataSource(e.target.value as any)}>
              <option value="demo">Demo</option>
              <option value="loaded">Loaded (1s cache)</option>
              <option value="csv">CSV import</option>
            </select>
          </label>
        </div>

        <h3>Accounts (max 3) · Risk % is per order, not here</h3>
        {accounts.map((a) => (
          <div className="account-card" key={a.accountId}>
            <div className="session-form-grid">
              <label>
                Name
                <input value={a.name} onChange={(e) => updateAccount(a.accountId, { name: e.target.value })} />
              </label>
              <label>
                Balance
                <input
                  type="number"
                  value={a.balance}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    updateAccount(a.accountId, { balance: v, initialBalance: v });
                  }}
                />
              </label>
              <label>
                Currency
                <input value={a.currency} onChange={(e) => updateAccount(a.accountId, { currency: e.target.value })} />
              </label>
              <label>
                Leverage (1:N)
                <input
                  type="number"
                  min={1}
                  value={a.leverage}
                  onChange={(e) => updateAccount(a.accountId, { leverage: Math.max(1, Number(e.target.value) || 1) })}
                />
              </label>
              <label>
                Enabled
                <select
                  value={a.enabled ? "1" : "0"}
                  onChange={(e) => updateAccount(a.accountId, { enabled: e.target.value === "1" })}
                >
                  <option value="1">Yes</option>
                  <option value="0">No</option>
                </select>
              </label>
            </div>
            <div className="session-actions">
              <label>
                <input
                  type="radio"
                  name="active-acc"
                  checked={activeAccountId === a.accountId}
                  onChange={() => setActiveAccountId(a.accountId)}
                />{" "}
                Active
              </label>
              {accounts.length > 1 && (
                <button type="button" onClick={() => removeAccount(a.accountId)}>Remove</button>
              )}
            </div>
          </div>
        ))}
        {accounts.length < 3 && (
          <button type="button" onClick={addAccount}>Add account</button>
        )}

        <h3>Instrument specification</h3>
        <div className="session-form-grid">
          {(
            [
              ["contractSize", "Contract size"],
              ["tickSize", "Tick size"],
              ["tickValue", "Tick value"],
              ["pointValue", "Point value"],
              ["pipValue", "Pip value"],
              ["minLot", "Min lot"],
              ["maxLot", "Max lot"],
              ["lotStep", "Lot step"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                step="any"
                value={(instrument as any)[key]}
                onChange={(e) => setInstrument({ ...instrument, [key]: Number(e.target.value) || 0 })}
              />
            </label>
          ))}
        </div>

        {sessionType === "prop" && (
          <div className="prop-block">
            <h3>Prop Firm rules</h3>
            <div className="session-form-grid">
              <label>
                Account size
                <input
                  type="number"
                  value={propFirm.accountSize}
                  onChange={(e) => setPropFirm({ ...propFirm, accountSize: Number(e.target.value) || 0 })}
                />
              </label>
              <label>
                Phase
                <select value={propFirm.phase} onChange={(e) => setPropFirm({ ...propFirm, phase: e.target.value })}>
                  <option>Single</option>
                  <option>Phase 1</option>
                  <option>Phase 2</option>
                  <option>Custom</option>
                </select>
              </label>
              <label>
                Profit target %
                <input
                  type="number"
                  value={propFirm.profitTargetPercent}
                  onChange={(e) => setPropFirm({ ...propFirm, profitTargetPercent: Number(e.target.value) || 0 })}
                />
              </label>
              <label>
                Daily DD %
                <input
                  type="number"
                  value={propFirm.dailyDdPercent}
                  onChange={(e) => setPropFirm({ ...propFirm, dailyDdPercent: Number(e.target.value) || 0 })}
                />
              </label>
              <label>
                Overall DD %
                <input
                  type="number"
                  value={propFirm.overallDdPercent}
                  onChange={(e) => setPropFirm({ ...propFirm, overallDdPercent: Number(e.target.value) || 0 })}
                />
              </label>
              <label>
                Min trading days
                <input
                  type="number"
                  value={propFirm.minTradingDays}
                  onChange={(e) => setPropFirm({ ...propFirm, minTradingDays: Number(e.target.value) || 0 })}
                />
              </label>
              <label>
                Max trading days
                <input
                  type="number"
                  value={propFirm.maxTradingDays ?? ""}
                  placeholder="optional"
                  onChange={(e) =>
                    setPropFirm({
                      ...propFirm,
                      maxTradingDays: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Consistency %
                <input
                  type="number"
                  value={propFirm.consistencyRulePercent ?? ""}
                  placeholder="optional"
                  onChange={(e) =>
                    setPropFirm({
                      ...propFirm,
                      consistencyRulePercent: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
          </div>
        )}

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
          {sessions.map((s) => {
            const full = ensureSessionAccounts(s);
            const acc = full.accounts?.find((a) => a.accountId === full.activeAccountId) || full.accounts?.[0];
            return (
              <li key={s.id} className={s.id === activeId ? "session-active" : undefined}>
                <div>
                  <b>{s.name}</b>
                  <span className="muted">
                    {" "}
                    · {s.sessionType || "backtest"} · {s.symbol} · {s.start} → {s.end}
                    {s.strategy ? ` · ${s.strategy}` : ""}
                    {s.id === activeId ? " · ACTIVE" : ""}
                  </span>
                  {acc ? (
                    <div className="muted">
                      Acct {acc.name}: {acc.currency} {acc.balance.toLocaleString()} · 1:{acc.leverage}
                    </div>
                  ) : null}
                </div>
                <div className="session-actions">
                  {s.id !== activeId && (
                    <button type="button" className="on" onClick={() => void handleActivate(s.id)}>
                      Open
                    </button>
                  )}
                  <button type="button" onClick={() => void handleDelete(s.id)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
