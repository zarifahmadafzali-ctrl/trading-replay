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
  MAX_SESSION_ACCOUNTS,
  upsertSession,
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
import {
  defaultPropProgram,
  ensurePropProgram,
  emptyPropRules,
  type PropPhaseConfig,
  type PropProgramConfig,
  type PropRuleSet,
} from "../lib/propRules";
import { normalizePayoutSchedule, type PayoutSchedule, type PayoutScheduleMode } from "../lib/payoutSchedule";

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAccounts, setEditAccounts] = useState<AccountProfile[]>([]);
  const [editActiveId, setEditActiveId] = useState("");
  /** String drafts so Balance/Leverage can be temporarily empty while typing. */
  const [createBalDraft, setCreateBalDraft] = useState<Record<string, string>>({});
  const [createLevDraft, setCreateLevDraft] = useState<Record<string, string>>({});
  const [editBalDraft, setEditBalDraft] = useState<Record<string, string>>({});
  const [editLevDraft, setEditLevDraft] = useState<Record<string, string>>({});
  const [createMinLotDraft, setCreateMinLotDraft] = useState<Record<string, string>>({});
  const [createMaxLotDraft, setCreateMaxLotDraft] = useState<Record<string, string>>({});
  const [createStepDraft, setCreateStepDraft] = useState<Record<string, string>>({});
  const [editMinLotDraft, setEditMinLotDraft] = useState<Record<string, string>>({});
  const [editMaxLotDraft, setEditMaxLotDraft] = useState<Record<string, string>>({});
  const [editStepDraft, setEditStepDraft] = useState<Record<string, string>>({});
  const [propNumDraft, setPropNumDraft] = useState<Record<string, string>>({});
  /** Session-level legacy PropFirmConfig editor drafts (string while typing). */
  const [pfDraft, setPfDraft] = useState<Record<string, string>>({});
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

  function setAccountType(id: string, accountType: "personal" | "prop", isEdit = false) {
    const patch: Partial<AccountProfile> = { accountType };
    if (accountType === "prop") {
      const list = isEdit ? editAccounts : accounts;
      const a = list.find((x) => x.accountId === id);
      const size = a?.initialBalance || a?.balance || 5000;
      const prog = a?.propProgram || defaultPropProgram(size);
      patch.propProgram = prog;
      patch.propProgramId = prog.id;
      patch.propFirmName = prog.firmName || a?.propFirmName || "";
      patch.propProgramName = prog.programName || a?.propProgramName || "";
      patch.activePropPhaseId = a?.activePropPhaseId || prog.phases[0]?.id;
    }
    if (isEdit) updateEditAccount(id, patch);
    else updateAccount(id, patch);
  }

  function patchActivePhaseRules(id: string, rulesPatch: Partial<PropRuleSet>, isEdit = false) {
    const list = isEdit ? editAccounts : accounts;
    const a = list.find((x) => x.accountId === id);
    if (!a) return;
    const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.initialBalance || a.balance);
    const phaseId = a.activePropPhaseId || prog.phases[0]?.id;
    const phases = prog.phases.map((ph) => {
      if (ph.id !== phaseId) return ph;
      const nextRules = { ...ph.rules, ...rulesPatch };
      // Explicit undefined means "clear optional field"; accountSize empty restores previous only if not in patch
      for (const k of Object.keys(rulesPatch) as (keyof typeof rulesPatch)[]) {
        if (rulesPatch[k] === undefined) {
          delete (nextRules as any)[k];
        }
      }
      // accountSize is required on PropRuleSet — if cleared, keep prior numeric size for storage stability
      if (!("accountSize" in rulesPatch) || rulesPatch.accountSize == null || !Number.isFinite(Number(rulesPatch.accountSize))) {
        if (!Number.isFinite(Number(nextRules.accountSize)) || Number(nextRules.accountSize) <= 0) {
          nextRules.accountSize = ph.rules.accountSize || a.initialBalance || a.balance || 0;
        }
      }
      return { ...ph, rules: nextRules };
    });
    const nextProg: PropProgramConfig = { ...prog, phases };
    const patch: Partial<AccountProfile> = {
      propProgram: nextProg,
      propProgramId: nextProg.id,
      activePropPhaseId: phaseId,
      propFirmName: nextProg.firmName,
      propProgramName: nextProg.programName,
    };
    if (isEdit) updateEditAccount(id, patch);
    else updateAccount(id, patch);
  }

  function propRulesDraftKey(accountId: string, field: string) {
    return `${accountId}:${field}`;
  }

  function patchActivePhasePayout(id: string, payoutPatch: Partial<PayoutSchedule>, isEdit = false) {
    const list = isEdit ? editAccounts : accounts;
    const a = list.find((x) => x.accountId === id);
    if (!a) return;
    const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.initialBalance || a.balance);
    const phaseId = a.activePropPhaseId || prog.phases[0]?.id;
    const phases = prog.phases.map((ph) => {
      if (ph.id !== phaseId) return ph;
      const prev = normalizePayoutSchedule(ph.rules.payout || { mode: "on_demand" });
      const next = { ...prev, ...payoutPatch, enabled: true };
      return { ...ph, rules: { ...ph.rules, payout: next } };
    });
    const nextProg: PropProgramConfig = { ...prog, phases };
    const patch: Partial<AccountProfile> = {
      propProgram: nextProg,
      propProgramId: nextProg.id,
      activePropPhaseId: phaseId,
    };
    if (isEdit) updateEditAccount(id, patch);
    else updateAccount(id, patch);
  }

  function commitBalance(raw: string, fallback: number): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function commitLeverage(raw: string, fallback: number): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 1) return null;
    return Math.floor(n);
  }

  function commitLot(raw: string, fallback: number): number | null {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) return null;
    return n;
  }


  function addAccount() {
    if (accounts.length >= MAX_SESSION_ACCOUNTS) return;
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
        accounts: accounts.slice(0, MAX_SESSION_ACCOUNTS).map((a) => {
          const balRaw = createBalDraft[a.accountId] ?? String(a.balance);
          const levRaw = createLevDraft[a.accountId] ?? String(a.leverage);
          const bal = commitBalance(balRaw, a.balance) ?? a.balance ?? a.initialBalance;
          const lev = commitLeverage(levRaw, a.leverage) ?? a.leverage;
          return {
            ...a,
            balance: bal,
            initialBalance: bal,
            leverage: lev,
          };
        }),
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


  async function startEditAccounts(s: SessionMeta) {
    const full = ensureSessionAccounts(s);
    const list = (full.accounts || []).map((a) => ({ ...a }));
    setEditingId(s.id);
    setEditAccounts(list);
    setEditActiveId(full.activeAccountId || full.accounts?.[0]?.accountId || "");
    const bal: Record<string, string> = {};
    const lev: Record<string, string> = {};
    const minD: Record<string, string> = {};
    const maxD: Record<string, string> = {};
    const stepD: Record<string, string> = {};
    for (const a of list) {
      bal[a.accountId] = String(a.balance ?? a.initialBalance ?? "");
      lev[a.accountId] = String(a.leverage ?? "");
      minD[a.accountId] = String(a.minLot ?? 0.01);
      maxD[a.accountId] = String(a.maxLot ?? 100);
      stepD[a.accountId] = String(a.lotStep ?? 0.01);
    }
    setEditBalDraft(bal);
    setEditLevDraft(lev);
    setEditMinLotDraft(minD);
    setEditMaxLotDraft(maxD);
    setEditStepDraft(stepD);
  }

  function updateEditAccount(id: string, patch: Partial<AccountProfile>) {
    setEditAccounts((prev) => prev.map((a) => (a.accountId === id ? { ...a, ...patch } : a)));
  }

  function addEditAccount() {
    if (editAccounts.length >= MAX_SESSION_ACCOUNTS) return;
    const a = newAccount(editAccounts.length + 1);
    setEditAccounts((prev) => [...prev, a]);
  }

  function removeEditAccount(id: string) {
    if (editAccounts.length <= 1) return;
    const next = editAccounts.filter((a) => a.accountId !== id);
    setEditAccounts(next);
    if (editActiveId === id) setEditActiveId(next[0].accountId);
  }

  async function saveEditAccounts() {
    if (!editingId) return;
    const meta = sessions.find((s) => s.id === editingId);
    if (!meta) return;
    // Commit open string drafts into numeric profiles before persist
    const committed = editAccounts.map((a) => {
      const balRaw = editBalDraft[a.accountId] ?? String(a.balance);
      const levRaw = editLevDraft[a.accountId] ?? String(a.leverage);
      const bal = commitBalance(balRaw, a.balance) ?? a.balance;
      const lev = commitLeverage(levRaw, a.leverage) ?? a.leverage;
      const minL = commitLot(editMinLotDraft[a.accountId] ?? String(a.minLot ?? 0.01), a.minLot ?? 0.01) ?? a.minLot;
      const maxL = commitLot(editMaxLotDraft[a.accountId] ?? String(a.maxLot ?? 100), a.maxLot ?? 100) ?? a.maxLot;
      const step = commitLot(editStepDraft[a.accountId] ?? String(a.lotStep ?? 0.01), a.lotStep ?? 0.01) ?? a.lotStep;
      return {
        ...a,
        balance: bal,
        leverage: lev,
        minLot: minL,
        maxLot: maxL,
        lotStep: step,
      };
    });
    const enabled = committed.filter((a) => a.enabled !== false);
    const list = (enabled.length ? enabled : committed).slice(0, MAX_SESSION_ACCOUNTS).map((a) => ({
      ...a,
      balance: a.balance || a.initialBalance,
      initialBalance: a.initialBalance || a.balance,
    }));
    let active = list.find((a) => a.accountId === editActiveId && a.enabled !== false)?.accountId;
    if (!active) active = list.find((a) => a.enabled !== false)?.accountId || list[0]?.accountId;
    const next: SessionMeta = {
      ...meta,
      accounts: list,
      activeAccountId: active,
      updatedAt: Date.now(),
    };
    await upsertSession(next);
    setSessions((prev) => prev.map((s) => (s.id === editingId ? next : s)));
    setEditingId(null);
    // If this is the active session, notify replay to refresh meta via storage event / reload list
    if (getActiveSessionId() === editingId) {
      try {
        window.dispatchEvent(new CustomEvent("tr-session-accounts-updated", { detail: next }));
      } catch { /* */ }
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

        <h3>{`Accounts (max ${MAX_SESSION_ACCOUNTS}) · Risk % is per order, not here`}</h3>
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
                  type="text"
                  inputMode="decimal"
                  value={createBalDraft[a.accountId] ?? String(a.balance)}
                  onChange={(e) => setCreateBalDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                  onBlur={() => {
                    const raw = createBalDraft[a.accountId] ?? String(a.balance);
                    const v = commitBalance(raw, a.balance);
                    if (v == null) {
                      setCreateBalDraft((d) => ({ ...d, [a.accountId]: String(a.balance) }));
                      return;
                    }
                    updateAccount(a.accountId, { balance: v, initialBalance: v });
                    setCreateBalDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
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
                  type="text"
                  inputMode="numeric"
                  value={createLevDraft[a.accountId] ?? String(a.leverage)}
                  onChange={(e) => setCreateLevDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                  onBlur={() => {
                    const raw = createLevDraft[a.accountId] ?? String(a.leverage);
                    const v = commitLeverage(raw, a.leverage);
                    if (v == null) {
                      setCreateLevDraft((d) => ({ ...d, [a.accountId]: String(a.leverage) }));
                      return;
                    }
                    updateAccount(a.accountId, { leverage: v });
                    setCreateLevDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </label>
              <label>
                Min Lot
                <input
                  type="text"
                  inputMode="decimal"
                  value={createMinLotDraft[a.accountId] ?? String(a.minLot ?? 0.01)}
                  onChange={(e) => setCreateMinLotDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                  onBlur={() => {
                    const raw = createMinLotDraft[a.accountId] ?? String(a.minLot ?? 0.01);
                    const v = commitLot(raw, a.minLot ?? 0.01);
                    if (v == null) {
                      setCreateMinLotDraft((d) => ({ ...d, [a.accountId]: String(a.minLot ?? 0.01) }));
                      return;
                    }
                    updateAccount(a.accountId, { minLot: v });
                    setCreateMinLotDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                  }}
                />
              </label>
              <label>
                Max Lot
                <input
                  type="text"
                  inputMode="decimal"
                  value={createMaxLotDraft[a.accountId] ?? String(a.maxLot ?? 100)}
                  onChange={(e) => setCreateMaxLotDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                  onBlur={() => {
                    const raw = createMaxLotDraft[a.accountId] ?? String(a.maxLot ?? 100);
                    const v = commitLot(raw, a.maxLot ?? 100);
                    if (v == null) {
                      setCreateMaxLotDraft((d) => ({ ...d, [a.accountId]: String(a.maxLot ?? 100) }));
                      return;
                    }
                    updateAccount(a.accountId, { maxLot: v });
                    setCreateMaxLotDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                  }}
                />
              </label>
              <label>
                Lot Step
                <input
                  type="text"
                  inputMode="decimal"
                  value={createStepDraft[a.accountId] ?? String(a.lotStep ?? 0.01)}
                  onChange={(e) => setCreateStepDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                  onBlur={() => {
                    const raw = createStepDraft[a.accountId] ?? String(a.lotStep ?? 0.01);
                    const v = commitLot(raw, a.lotStep ?? 0.01);
                    if (v == null) {
                      setCreateStepDraft((d) => ({ ...d, [a.accountId]: String(a.lotStep ?? 0.01) }));
                      return;
                    }
                    updateAccount(a.accountId, { lotStep: v });
                    setCreateStepDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                  }}
                />
              </label>
              <label>
                Account Type
                <select
                  value={a.accountType || "personal"}
                  onChange={(e) => setAccountType(a.accountId, e.target.value as "personal" | "prop", false)}
                >
                  <option value="personal">Personal</option>
                  <option value="prop">Prop</option>
                </select>
              </label>
              {(a.accountType || "personal") === "prop" && (
                <div className="prop-rules-box">
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>PROP PROGRAM</div>
                  <label>
                    Prop Firm
                    <input
                      value={a.propFirmName || a.propProgram?.firmName || ""}
                      onChange={(e) => {
                        const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.balance);
                        const next = { ...prog, firmName: e.target.value };
                        updateAccount(a.accountId, { propFirmName: e.target.value, propProgram: next, propProgramId: next.id });
                      }}
                    />
                  </label>
                  <label>
                    Program
                    <input
                      value={a.propProgramName || a.propProgram?.programName || ""}
                      onChange={(e) => {
                        const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.balance);
                        const next = { ...prog, programName: e.target.value };
                        updateAccount(a.accountId, { propProgramName: e.target.value, propProgram: next, propProgramId: next.id });
                      }}
                    />
                  </label>
                  <label>
                    Phase
                    <select
                      value={a.activePropPhaseId || a.propProgram?.phases?.[0]?.id || ""}
                      onChange={(e) => updateAccount(a.accountId, { activePropPhaseId: e.target.value })}
                    >
                      {(a.propProgram?.phases || ensurePropProgram({ ...a, accountType: "prop" })?.phases || []).map((ph) => (
                        <option key={ph.id} value={ph.id}>{ph.name}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.balance);
                      const n = prog.phases.length + 1;
                      const ph = {
                        id: `phase_${Math.random().toString(36).slice(2, 8)}`,
                        name: `Phase ${n}`,
                        type: (n > 2 ? "funded" : "challenge") as "challenge" | "funded" | "custom",
                        rules: { accountSize: a.initialBalance || a.balance || 5000 },
                      };
                      updateAccount(a.accountId, { propProgram: { ...prog, phases: [...prog.phases, ph] }, activePropPhaseId: ph.id });
                    }}
                  >
                    + Phase
                  </button>
                  <div className="muted" style={{ fontSize: 11, margin: "6px 0 4px" }}>PROP RULES (active phase)</div>
                  {(["accountSize", "profitTargetPct", "dailyLossLimitPct", "maxOverallLossPct", "minimumTradingDays", "consistencyPct", "leverage"] as const).map((field) => {
                    const phase = (a.propProgram?.phases || []).find((p) => p.id === (a.activePropPhaseId || a.propProgram?.phases?.[0]?.id)) || a.propProgram?.phases?.[0];
                    const rules = phase?.rules || emptyPropRules(a.balance);
                    const val = rules[field];
                    const key = propRulesDraftKey(a.accountId, field);
                    const label = field === "accountSize" ? "Account Size" : field === "profitTargetPct" ? "Profit Target %" : field === "dailyLossLimitPct" ? "Daily Loss Limit %" : field === "maxOverallLossPct" ? "Max Overall Loss %" : field === "minimumTradingDays" ? "Minimum Trading Days" : field === "consistencyPct" ? "Consistency %" : "Leverage (phase)";
                    return (
                      <label key={field}>
                        {label}
                        <input
                          type="text"
                          inputMode="decimal"
                          value={propNumDraft[key] ?? (val != null ? String(val) : "")}
                          onChange={(e) => setPropNumDraft((d) => ({ ...d, [key]: e.target.value }))}
                          onBlur={(e) => {
                            const raw = e.currentTarget.value;
                            setPropNumDraft((d) => ({ ...d, [key]: raw }));
                            if (raw.trim() === "") {
                              // Keep draft empty while editing; optional fields clear; accountSize reverts on empty commit
                              if (field === "accountSize") {
                                setPropNumDraft((d) => ({ ...d, [key]: val != null ? String(val) : "" }));
                                return;
                              }
                              patchActivePhaseRules(a.accountId, { [field]: undefined }, false);
                              return;
                            }
                            const n = Number(raw);
                            if (!Number.isFinite(n) || n < 0) {
                              setPropNumDraft((d) => ({ ...d, [key]: val != null ? String(val) : "" }));
                              return;
                            }
                            patchActivePhaseRules(a.accountId, { [field]: n }, false);
                            setPropNumDraft((d) => ({ ...d, [key]: String(n) }));
                          }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        />
                      </label>
                    );
                  })}

                  <div className="muted" style={{ fontSize: 11, margin: "8px 0 4px" }}>PAYOUT SCHEDULE</div>
                  {(() => {
                    const phase = (a.propProgram?.phases || []).find((p) => p.id === (a.activePropPhaseId || a.propProgram?.phases?.[0]?.id)) || a.propProgram?.phases?.[0];
                    const sch = normalizePayoutSchedule(phase?.rules?.payout || { mode: "on_demand" });
                    const mode = sch.mode || "on_demand";
                    const numField = (field: keyof PayoutSchedule, label: string) => {
                      const key = propRulesDraftKey(a.accountId, `payout_${String(field)}`);
                      const val = sch[field];
                      return (
                        <label key={String(field)}>
                          {label}
                          <input
                            type="text"
                            inputMode="decimal"
                            value={propNumDraft[key] ?? (val != null && typeof val !== "boolean" ? String(val) : "")}
                            onChange={(e) => setPropNumDraft((d) => ({ ...d, [key]: e.target.value }))}
                            onBlur={(e) => {
                              const raw = e.currentTarget.value;
                              setPropNumDraft((d) => ({ ...d, [key]: raw }));
                              if (raw.trim() === "") {
                                patchActivePhasePayout(a.accountId, { [field]: undefined }, false);
                                return;
                              }
                              const n = Number(raw);
                              if (!Number.isFinite(n) || n < 0) {
                                setPropNumDraft((d) => ({ ...d, [key]: val != null ? String(val) : "" }));
                                return;
                              }
                              patchActivePhasePayout(a.accountId, { [field]: n } as Partial<PayoutSchedule>, false);
                              setPropNumDraft((d) => ({ ...d, [key]: String(n) }));
                            }}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          />
                        </label>
                      );
                    };
                    return (
                      <>
                        <label>
                          Payout Mode
                          <select
                            value={mode}
                            onChange={(e) =>
                              patchActivePhasePayout(a.accountId, { mode: e.target.value as PayoutScheduleMode }, false)
                            }
                          >
                            <option value="on_demand">On Demand</option>
                            <option value="weekly">Weekly</option>
                            <option value="biweekly">Bi-Weekly</option>
                            <option value="monthly">Monthly</option>
                            <option value="interval">Interval</option>
                          </select>
                        </label>
                        {(mode === "weekly" || mode === "biweekly") && (
                          <label>
                            Payout Day
                            <select
                              value={sch.weekday != null ? String(sch.weekday) : "5"}
                              onChange={(e) =>
                                patchActivePhasePayout(a.accountId, { weekday: Number(e.target.value) }, false)
                              }
                            >
                              <option value="1">Monday</option>
                              <option value="2">Tuesday</option>
                              <option value="3">Wednesday</option>
                              <option value="4">Thursday</option>
                              <option value="5">Friday</option>
                              <option value="6">Saturday</option>
                              <option value="0">Sunday</option>
                            </select>
                          </label>
                        )}
                        {mode === "biweekly" && (
                          <label>
                            Anchor Date (YYYY-MM-DD)
                            <input
                              type="date"
                              value={
                                sch.anchorDate
                                  ? new Date(sch.anchorDate * 1000).toISOString().slice(0, 10)
                                  : ""
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (!v) {
                                  patchActivePhasePayout(a.accountId, { anchorDate: undefined, anchor: "fixed_date" }, false);
                                  return;
                                }
                                const sec = Math.floor(new Date(v + "T00:00:00Z").getTime() / 1000);
                                patchActivePhasePayout(a.accountId, { anchorDate: sec, anchor: "fixed_date" }, false);
                              }}
                            />
                          </label>
                        )}
                        {mode === "monthly" && numField("monthDay", "Day of Month (1–31)")}
                        {mode === "interval" && (
                          <>
                            {numField("intervalDays", "Interval Days")}
                            <label>
                              Count From
                              <select
                                value={sch.anchor || "funded_start"}
                                onChange={(e) =>
                                  patchActivePhasePayout(
                                    a.accountId,
                                    { anchor: e.target.value as PayoutSchedule["anchor"] },
                                    false
                                  )
                                }
                              >
                                <option value="funded_start">Funded Start</option>
                                <option value="first_funded_trade">First Funded Trade</option>
                                <option value="last_payout">Last Payout</option>
                                <option value="fixed_date">Fixed Date</option>
                              </select>
                            </label>
                          </>
                        )}
                        {numField("firstPayoutDelayDays", "First Payout Delay (days)")}
                        {numField("minimumTradingDays", "Min Trading Days (payout)")}
                        {numField("minimumPayoutPct", "Minimum Payout %")}
                        {numField("minimumPayoutAmount", "Minimum Payout Amount")}
                        {numField("profitSplitPct", "Profit Split % (trader)")}
                        {numField("processingDays", "Processing Days")}
                        {numField("cooldownDays", "Cooldown Days")}
                      </>
                    );
                  })()}
                </div>
              )}
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
        {accounts.length < MAX_SESSION_ACCOUNTS && (
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
            <h3>Prop Firm rules (session defaults)</h3>
            <div className="session-form-grid">
              <label>
                Account size
                <input
                  type="text"
                  inputMode="decimal"
                  value={pfDraft["accountSize"] ?? String(propFirm.accountSize ?? "")}
                  onChange={(e) => setPfDraft((d) => ({ ...d, accountSize: e.target.value }))}
                  onBlur={(e) => {
                    const raw = e.currentTarget.value;
                    setPfDraft((d) => ({ ...d, accountSize: raw }));
                    if (raw.trim() === "") {
                      setPfDraft((d) => ({ ...d, accountSize: String(propFirm.accountSize ?? "") }));
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n < 0) {
                      setPfDraft((d) => ({ ...d, accountSize: String(propFirm.accountSize ?? "") }));
                      return;
                    }
                    setPropFirm({ ...propFirm, accountSize: n });
                    setPfDraft((d) => ({ ...d, accountSize: String(n) }));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
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
              {([
                ["profitTargetPercent", "Profit target %"],
                ["dailyDdPercent", "Daily DD %"],
                ["overallDdPercent", "Overall DD %"],
                ["minTradingDays", "Min trading days"],
              ] as const).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={pfDraft[key] ?? String((propFirm as any)[key] ?? "")}
                    onChange={(e) => setPfDraft((d) => ({ ...d, [key]: e.target.value }))}
                    onBlur={(e) => {
                      const raw = e.currentTarget.value;
                      setPfDraft((d) => ({ ...d, [key]: raw }));
                      if (raw.trim() === "") {
                        setPfDraft((d) => ({ ...d, [key]: String((propFirm as any)[key] ?? "") }));
                        return;
                      }
                      const n = Number(raw);
                      if (!Number.isFinite(n) || n < 0) {
                        setPfDraft((d) => ({ ...d, [key]: String((propFirm as any)[key] ?? "") }));
                        return;
                      }
                      setPropFirm({ ...propFirm, [key]: n });
                      setPfDraft((d) => ({ ...d, [key]: String(n) }));
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
              ))}
              <label>
                Max trading days
                <input
                  type="text"
                  inputMode="numeric"
                  value={pfDraft["maxTradingDays"] ?? (propFirm.maxTradingDays != null ? String(propFirm.maxTradingDays) : "")}
                  placeholder="optional"
                  onChange={(e) => setPfDraft((d) => ({ ...d, maxTradingDays: e.target.value }))}
                  onBlur={(e) => {
                    const raw = e.currentTarget.value;
                    setPfDraft((d) => ({ ...d, maxTradingDays: raw }));
                    if (raw.trim() === "") {
                      setPropFirm({ ...propFirm, maxTradingDays: null });
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n < 0) {
                      setPfDraft((d) => ({ ...d, maxTradingDays: propFirm.maxTradingDays != null ? String(propFirm.maxTradingDays) : "" }));
                      return;
                    }
                    setPropFirm({ ...propFirm, maxTradingDays: n });
                    setPfDraft((d) => ({ ...d, maxTradingDays: String(n) }));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
              </label>
              <label>
                Consistency %
                <input
                  type="text"
                  inputMode="decimal"
                  value={pfDraft["consistencyRulePercent"] ?? (propFirm.consistencyRulePercent != null ? String(propFirm.consistencyRulePercent) : "")}
                  placeholder="optional"
                  onChange={(e) => setPfDraft((d) => ({ ...d, consistencyRulePercent: e.target.value }))}
                  onBlur={(e) => {
                    const raw = e.currentTarget.value;
                    setPfDraft((d) => ({ ...d, consistencyRulePercent: raw }));
                    if (raw.trim() === "") {
                      setPropFirm({ ...propFirm, consistencyRulePercent: null });
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n < 0) {
                      setPfDraft((d) => ({ ...d, consistencyRulePercent: propFirm.consistencyRulePercent != null ? String(propFirm.consistencyRulePercent) : "" }));
                      return;
                    }
                    setPropFirm({ ...propFirm, consistencyRulePercent: n });
                    setPfDraft((d) => ({ ...d, consistencyRulePercent: String(n) }));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
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
                  <button type="button" onClick={() => void startEditAccounts(s)}>
                    Edit Accounts
                  </button>
                  <button type="button" onClick={() => void handleDelete(s.id)}>
                    Delete
                  </button>
                </div>
                {editingId === s.id && (
                  <div className="account-edit-panel">
                    <h4>{`Edit accounts (max ${MAX_SESSION_ACCOUNTS})`}</h4>
                    {editAccounts.map((a) => (
                      <div className="account-card" key={a.accountId}>
                        <div className="session-form-grid">
                          <label>
                            Name
                            <input value={a.name} onChange={(e) => updateEditAccount(a.accountId, { name: e.target.value })} />
                          </label>
                          <label>
                            Balance
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editBalDraft[a.accountId] ?? String(a.balance)}
                              onChange={(e) => setEditBalDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                              onBlur={() => {
                                const raw = editBalDraft[a.accountId] ?? String(a.balance);
                                const v = commitBalance(raw, a.balance);
                                if (v == null) {
                                  setEditBalDraft((d) => ({ ...d, [a.accountId]: String(a.balance) }));
                                  return;
                                }
                                updateEditAccount(a.accountId, { balance: v });
                                setEditBalDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                            />
                          </label>
                          <label>
                            Currency
                            <input value={a.currency} onChange={(e) => updateEditAccount(a.accountId, { currency: e.target.value })} />
                          </label>
                          <label>
                            Leverage (1:N)
                            <input
                              type="text"
                              inputMode="numeric"
                              value={editLevDraft[a.accountId] ?? String(a.leverage)}
                              onChange={(e) => setEditLevDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                              onBlur={() => {
                                const raw = editLevDraft[a.accountId] ?? String(a.leverage);
                                const v = commitLeverage(raw, a.leverage);
                                if (v == null) {
                                  setEditLevDraft((d) => ({ ...d, [a.accountId]: String(a.leverage) }));
                                  return;
                                }
                                updateEditAccount(a.accountId, { leverage: v });
                                setEditLevDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                            />
                          </label>
                          <label>
                            Min Lot
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editMinLotDraft[a.accountId] ?? String(a.minLot ?? 0.01)}
                              onChange={(e) => setEditMinLotDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                              onBlur={() => {
                                const raw = editMinLotDraft[a.accountId] ?? String(a.minLot ?? 0.01);
                                const v = commitLot(raw, a.minLot ?? 0.01);
                                if (v == null) {
                                  setEditMinLotDraft((d) => ({ ...d, [a.accountId]: String(a.minLot ?? 0.01) }));
                                  return;
                                }
                                updateEditAccount(a.accountId, { minLot: v });
                                setEditMinLotDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                              }}
                            />
                          </label>
                          <label>
                            Max Lot
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editMaxLotDraft[a.accountId] ?? String(a.maxLot ?? 100)}
                              onChange={(e) => setEditMaxLotDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                              onBlur={() => {
                                const raw = editMaxLotDraft[a.accountId] ?? String(a.maxLot ?? 100);
                                const v = commitLot(raw, a.maxLot ?? 100);
                                if (v == null) {
                                  setEditMaxLotDraft((d) => ({ ...d, [a.accountId]: String(a.maxLot ?? 100) }));
                                  return;
                                }
                                updateEditAccount(a.accountId, { maxLot: v });
                                setEditMaxLotDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                              }}
                            />
                          </label>
                          <label>
                            Lot Step
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editStepDraft[a.accountId] ?? String(a.lotStep ?? 0.01)}
                              onChange={(e) => setEditStepDraft((d) => ({ ...d, [a.accountId]: e.target.value }))}
                              onBlur={() => {
                                const raw = editStepDraft[a.accountId] ?? String(a.lotStep ?? 0.01);
                                const v = commitLot(raw, a.lotStep ?? 0.01);
                                if (v == null) {
                                  setEditStepDraft((d) => ({ ...d, [a.accountId]: String(a.lotStep ?? 0.01) }));
                                  return;
                                }
                                updateEditAccount(a.accountId, { lotStep: v });
                                setEditStepDraft((d) => ({ ...d, [a.accountId]: String(v) }));
                              }}
                            />
                          </label>

              <label>
                Account Type
                <select
                  value={a.accountType || "personal"}
                  onChange={(e) => setAccountType(a.accountId, e.target.value as "personal" | "prop", true)}
                >
                  <option value="personal">Personal</option>
                  <option value="prop">Prop</option>
                </select>
              </label>
              {(a.accountType || "personal") === "prop" && (
                <div className="prop-rules-box">
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>PROP PROGRAM</div>
                  <label>
                    Prop Firm
                    <input
                      value={a.propFirmName || a.propProgram?.firmName || ""}
                      onChange={(e) => {
                        const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.balance);
                        const next = { ...prog, firmName: e.target.value };
                        updateEditAccount(a.accountId, {
                          propFirmName: e.target.value,
                          propProgram: next,
                          propProgramId: next.id,
                        });
                      }}
                    />
                  </label>
                  <label>
                    Program
                    <input
                      value={a.propProgramName || a.propProgram?.programName || ""}
                      onChange={(e) => {
                        const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.balance);
                        const next = { ...prog, programName: e.target.value };
                        updateEditAccount(a.accountId, {
                          propProgramName: e.target.value,
                          propProgram: next,
                          propProgramId: next.id,
                        });
                      }}
                    />
                  </label>
                  <label>
                    Phase
                    <select
                      value={a.activePropPhaseId || a.propProgram?.phases?.[0]?.id || ""}
                      onChange={(e) => updateEditAccount(a.accountId, { activePropPhaseId: e.target.value })}
                    >
                      {(a.propProgram?.phases || ensurePropProgram({ ...a, accountType: "prop" })?.phases || []).map((ph) => (
                        <option key={ph.id} value={ph.id}>{ph.name}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      const prog = ensurePropProgram({ ...a, accountType: "prop" }) || defaultPropProgram(a.balance);
                      const n = prog.phases.length + 1;
                      const ph: PropPhaseConfig = {
                        id: `phase_${Math.random().toString(36).slice(2, 8)}`,
                        name: `Phase ${n}`,
                        type: n > 2 ? "funded" : "challenge",
                        rules: { accountSize: a.initialBalance || a.balance || 5000 },
                      };
                      const next = { ...prog, phases: [...prog.phases, ph] };
                      updateEditAccount(a.accountId, { propProgram: next, activePropPhaseId: ph.id });
                    }}
                  >
                    + Phase
                  </button>
                  <div className="muted" style={{ fontSize: 11, margin: "6px 0 4px" }}>PROP RULES (active phase)</div>
                  {(["accountSize", "profitTargetPct", "dailyLossLimitPct", "maxOverallLossPct", "minimumTradingDays", "consistencyPct", "leverage"] as const).map((field) => {
                    const phase = (a.propProgram?.phases || []).find((p) => p.id === (a.activePropPhaseId || a.propProgram?.phases?.[0]?.id))
                      || a.propProgram?.phases?.[0];
                    const rules = phase?.rules || emptyPropRules(a.balance);
                    const val = rules[field];
                    const key = propRulesDraftKey(a.accountId, field);
                    const label =
                      field === "accountSize" ? "Account Size" :
                      field === "profitTargetPct" ? "Profit Target %" :
                      field === "dailyLossLimitPct" ? "Daily Loss Limit %" :
                      field === "maxOverallLossPct" ? "Max Overall Loss %" :
                      field === "minimumTradingDays" ? "Minimum Trading Days" :
                      field === "consistencyPct" ? "Consistency %" :
                      "Leverage (phase)";
                    return (
                      <label key={field}>
                        {label}
                        <input
                          type="text"
                          inputMode="decimal"
                          value={propNumDraft[key] ?? (val != null ? String(val) : "")}
                          onChange={(e) => setPropNumDraft((d) => ({ ...d, [key]: e.target.value }))}
                          onBlur={(e) => {
                            const raw = e.currentTarget.value;
                            setPropNumDraft((d) => ({ ...d, [key]: raw }));
                            if (raw.trim() === "") {
                              if (field === "accountSize") {
                                setPropNumDraft((d) => ({ ...d, [key]: val != null ? String(val) : "" }));
                                return;
                              }
                              patchActivePhaseRules(a.accountId, { [field]: undefined }, true);
                              return;
                            }
                            const n = Number(raw);
                            if (!Number.isFinite(n) || n < 0) {
                              setPropNumDraft((d) => ({ ...d, [key]: val != null ? String(val) : "" }));
                              return;
                            }
                            patchActivePhaseRules(a.accountId, { [field]: n }, true);
                            setPropNumDraft((d) => ({ ...d, [key]: String(n) }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      </label>
                    );
                  })}

                  <div className="muted" style={{ fontSize: 11, margin: "8px 0 4px" }}>PAYOUT SCHEDULE</div>
                  {(() => {
                    const phase = (a.propProgram?.phases || []).find((p) => p.id === (a.activePropPhaseId || a.propProgram?.phases?.[0]?.id)) || a.propProgram?.phases?.[0];
                    const sch = normalizePayoutSchedule(phase?.rules?.payout || { mode: "on_demand" });
                    const mode = sch.mode || "on_demand";
                    const numField = (field: keyof PayoutSchedule, label: string) => {
                      const key = propRulesDraftKey(a.accountId, `payout_${String(field)}`);
                      const val = sch[field];
                      return (
                        <label key={String(field)}>
                          {label}
                          <input
                            type="text"
                            inputMode="decimal"
                            value={propNumDraft[key] ?? (val != null && typeof val !== "boolean" ? String(val) : "")}
                            onChange={(e) => setPropNumDraft((d) => ({ ...d, [key]: e.target.value }))}
                            onBlur={(e) => {
                              const raw = e.currentTarget.value;
                              setPropNumDraft((d) => ({ ...d, [key]: raw }));
                              if (raw.trim() === "") {
                                patchActivePhasePayout(a.accountId, { [field]: undefined }, true);
                                return;
                              }
                              const n = Number(raw);
                              if (!Number.isFinite(n) || n < 0) {
                                setPropNumDraft((d) => ({ ...d, [key]: val != null ? String(val) : "" }));
                                return;
                              }
                              patchActivePhasePayout(a.accountId, { [field]: n } as Partial<PayoutSchedule>, true);
                              setPropNumDraft((d) => ({ ...d, [key]: String(n) }));
                            }}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          />
                        </label>
                      );
                    };
                    return (
                      <>
                        <label>
                          Payout Mode
                          <select
                            value={mode}
                            onChange={(e) =>
                              patchActivePhasePayout(a.accountId, { mode: e.target.value as PayoutScheduleMode }, true)
                            }
                          >
                            <option value="on_demand">On Demand</option>
                            <option value="weekly">Weekly</option>
                            <option value="biweekly">Bi-Weekly</option>
                            <option value="monthly">Monthly</option>
                            <option value="interval">Interval</option>
                          </select>
                        </label>
                        {(mode === "weekly" || mode === "biweekly") && (
                          <label>
                            Payout Day
                            <select
                              value={sch.weekday != null ? String(sch.weekday) : "5"}
                              onChange={(e) =>
                                patchActivePhasePayout(a.accountId, { weekday: Number(e.target.value) }, true)
                              }
                            >
                              <option value="1">Monday</option>
                              <option value="2">Tuesday</option>
                              <option value="3">Wednesday</option>
                              <option value="4">Thursday</option>
                              <option value="5">Friday</option>
                              <option value="6">Saturday</option>
                              <option value="0">Sunday</option>
                            </select>
                          </label>
                        )}
                        {mode === "biweekly" && (
                          <label>
                            Anchor Date (YYYY-MM-DD)
                            <input
                              type="date"
                              value={
                                sch.anchorDate
                                  ? new Date(sch.anchorDate * 1000).toISOString().slice(0, 10)
                                  : ""
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (!v) {
                                  patchActivePhasePayout(a.accountId, { anchorDate: undefined, anchor: "fixed_date" }, true);
                                  return;
                                }
                                const sec = Math.floor(new Date(v + "T00:00:00Z").getTime() / 1000);
                                patchActivePhasePayout(a.accountId, { anchorDate: sec, anchor: "fixed_date" }, true);
                              }}
                            />
                          </label>
                        )}
                        {mode === "monthly" && numField("monthDay", "Day of Month (1–31)")}
                        {mode === "interval" && (
                          <>
                            {numField("intervalDays", "Interval Days")}
                            <label>
                              Count From
                              <select
                                value={sch.anchor || "funded_start"}
                                onChange={(e) =>
                                  patchActivePhasePayout(
                                    a.accountId,
                                    { anchor: e.target.value as PayoutSchedule["anchor"] },
                                    false
                                  )
                                }
                              >
                                <option value="funded_start">Funded Start</option>
                                <option value="first_funded_trade">First Funded Trade</option>
                                <option value="last_payout">Last Payout</option>
                                <option value="fixed_date">Fixed Date</option>
                              </select>
                            </label>
                          </>
                        )}
                        {numField("firstPayoutDelayDays", "First Payout Delay (days)")}
                        {numField("minimumTradingDays", "Min Trading Days (payout)")}
                        {numField("minimumPayoutPct", "Minimum Payout %")}
                        {numField("minimumPayoutAmount", "Minimum Payout Amount")}
                        {numField("profitSplitPct", "Profit Split % (trader)")}
                        {numField("processingDays", "Processing Days")}
                        {numField("cooldownDays", "Cooldown Days")}
                      </>
                    );
                  })()}
                  <label>
                    News Trading
                    <select
                      value={(
                        (a.propProgram?.phases || []).find((p) => p.id === (a.activePropPhaseId || a.propProgram?.phases?.[0]?.id))?.rules.newsTradingAllowed
                      ) ? "1" : "0"}
                      onChange={(e) =>
                        patchActivePhaseRules(a.accountId, { newsTradingAllowed: e.target.value === "1" }, true)
                      }
                    >
                      <option value="1">Allowed</option>
                      <option value="0">Not allowed</option>
                    </select>
                  </label>
                  <label>
                    Weekend Holding
                    <select
                      value={(
                        (a.propProgram?.phases || []).find((p) => p.id === (a.activePropPhaseId || a.propProgram?.phases?.[0]?.id))?.rules.weekendHoldingAllowed
                      ) ? "1" : "0"}
                      onChange={(e) =>
                        patchActivePhaseRules(a.accountId, { weekendHoldingAllowed: e.target.value === "1" }, true)
                      }
                    >
                      <option value="1">Allowed</option>
                      <option value="0">Not allowed</option>
                    </select>
                  </label>
                </div>
              )}
                          <label>
                            Enabled
                            <select
                              value={a.enabled !== false ? "1" : "0"}
                              onChange={(e) => updateEditAccount(a.accountId, { enabled: e.target.value === "1" })}
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
                              name={`edit-active-${s.id}`}
                              checked={editActiveId === a.accountId}
                              onChange={() => setEditActiveId(a.accountId)}
                            />{" "}
                            Active
                          </label>
                          {editAccounts.length > 1 && (
                            <button type="button" onClick={() => removeEditAccount(a.accountId)}>
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {editAccounts.length < MAX_SESSION_ACCOUNTS && (
                      <button type="button" onClick={addEditAccount}>
                        + Add account
                      </button>
                    )}
                    <div className="session-actions">
                      <button type="button" className="on" onClick={() => void saveEditAccounts()}>
                        Save accounts
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
