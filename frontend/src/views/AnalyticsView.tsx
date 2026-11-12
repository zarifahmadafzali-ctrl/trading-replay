import { useEffect, useMemo, useState } from "react";
import {
  breakdownByAccount,
  breakdownByDirection,
  breakdownByExitReason,
  breakdownByOrderType,
  breakdownBySymbol,
  buildEquityCurve,
  computeSummary,
  filterTrades,
  formatDuration,
  formatNum,
  formatPct,
  maxDrawdownFromCurve,
  rDistribution,
  timeAnalysis,
  type AnalyticsFilters,
} from "../lib/analytics";
import {
  loadJournalForSession,
  JOURNAL_CHANGED_EVENT,
  downloadJournalCsv,
  resolveCurrencyPnL,
  type JournalTrade,
} from "../lib/journal";
import {
  downloadJournalBackupZip,
  downloadAnalyticsJson,
  parseJournalBackupZip,
  importJournalBackup,
} from "../lib/journalBackup";
import {
  ensureSessionAccounts,
  getActiveSessionId,
  getSession,
  type SessionMeta,
} from "../lib/sessionStore";
import { getSessionStorageAdapter } from "../lib/storageAdapter";
import type { AccountProfile } from "../lib/riskModel";
import {
  aggregateRiskGap,
  durationStatsByExit,
  durationStatsByProfitability,
  analyzeDailyTwoTradeBehavior,
  whatIfFixedRiskPercent,
  whatIfFixedProfitPercent,
} from "../lib/tradeAnalyticsAdvanced";


function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${points[0]!.x},${points[0]!.y} L${points[1]!.x},${points[1]!.y}`;
  }
  // Catmull-Rom → cubic Bezier for visual smoothness; control points only (data unchanged)
  let d = `M${points[0]!.x.toFixed(1)},${points[0]!.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

type MarkerGroup = {
  x: number;
  time: number;
  trades: JournalTrade[];
};

function UnifiedEquityPanel({
  points,
  trades,
  startingBalance,
  allowedDailyDdPct,
  allowedMaxDdPct,
  height = 280,
}: {
  points: { time: number; equity: number; balance: number; tradeId: string; pnl: number }[];
  trades: JournalTrade[];
  startingBalance: number;
  allowedDailyDdPct: number | null;
  allowedMaxDdPct: number | null;
  height?: number;
}) {
  const [hover, setHover] = useState<null | {
    kind: "curve" | "marker";
    time: number;
    equity?: number;
    balance?: number;
    dd?: number;
    trades?: JournalTrade[];
  }>(null);

  if (points.length < 2) {
    return <div className="chart-empty">Not enough closed trades for equity curve</div>;
  }

  const w = 720;
  const padL = 12;
  const padR = 52;
  const padT = 16;
  const padB = 36;
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;

  const xs = points.map((p) => p.time);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs) || minX + 1;
  const ys = points.map((p) => p.equity);
  let minY = Math.min(...ys, startingBalance);
  let maxY = Math.max(...ys, startingBalance);
  // Include allowed drawdown floors for scale awareness
  if (startingBalance > 0) {
    if (allowedMaxDdPct != null) {
      minY = Math.min(minY, startingBalance * (1 - allowedMaxDdPct / 100));
    }
    if (allowedDailyDdPct != null) {
      minY = Math.min(minY, startingBalance * (1 - allowedDailyDdPct / 100));
    }
  }
  const spanY = maxY - minY || 1;

  const xOf = (time: number) => padL + ((time - minX) / (maxX - minX || 1)) * plotW;
  const yOf = (v: number) => padT + (1 - (v - minY) / spanY) * plotH;

  // Peak-to-trough drawdown amount series (actual), parallel to equity points
  let peak = points[0]!.equity;
  const ddAmounts: number[] = [];
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    ddAmounts.push(peak - p.equity); // >= 0
  }
  const maxDdAmt = Math.max(...ddAmounts, 1);

  const balancePts = points.map((p) => ({ x: xOf(p.time), y: yOf(p.equity) }));
  const balancePath = smoothPath(balancePts);

  // Drawdown path on secondary visual band (bottom 28% of plot) — separate visual treatment
  const ddBandTop = padT + plotH * 0.72;
  const ddBandH = plotH * 0.28;
  const ddPathPts = points.map((p, i) => ({
    x: xOf(p.time),
    y: ddBandTop + ddBandH - (ddAmounts[i]! / maxDdAmt) * ddBandH,
  }));
  const ddPath = smoothPath(ddPathPts);

  // Allowed max account DD line (absolute level from starting balance)
  const allowedMaxLevel =
    allowedMaxDdPct != null && startingBalance > 0
      ? startingBalance * (1 - allowedMaxDdPct / 100)
      : null;
  const allowedDailyLevel =
    allowedDailyDdPct != null && startingBalance > 0
      ? startingBalance * (1 - allowedDailyDdPct / 100)
      : null;

  // Trade markers: group entries within 2 minutes
  const sortedTrades = trades
    .slice()
    .sort((a, b) => a.entryTime - b.entryTime);
  const groups: MarkerGroup[] = [];
  for (const tr of sortedTrades) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(tr.entryTime - last.time) <= 120) {
      last.trades.push(tr);
    } else {
      groups.push({ x: xOf(tr.entryTime), time: tr.entryTime, trades: [tr] });
    }
  }

  const fmtT = (sec: number) => {
    try {
      return new Date(sec * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(sec);
    }
  };

  return (
    <div className="unified-equity-panel" style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        className="analytics-svg"
        role="img"
        aria-label="Unified equity curve"
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseLeave={() => setHover(null)}
      >
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + f * plotH;
          const val = maxY - f * spanY;
          return (
            <g key={f}>
              <line
                x1={padL}
                x2={w - padR}
                y1={y}
                y2={y}
                stroke="currentColor"
                opacity={0.12}
              />
              <text
                x={w - padR + 6}
                y={y + 3}
                fontSize={10}
                fill="currentColor"
                opacity={0.7}
              >
                {val.toFixed(0)}
              </text>
            </g>
          );
        })}
        {/* Allowed drawdown reference levels (not actual performance) */}
        {allowedMaxLevel != null && (
          <line
            x1={padL}
            x2={w - padR}
            y1={yOf(allowedMaxLevel)}
            y2={yOf(allowedMaxLevel)}
            stroke="#e05c5c"
            strokeWidth={1.5}
            strokeDasharray="6 4"
            opacity={0.85}
          />
        )}
        {allowedDailyLevel != null && (
          <line
            x1={padL}
            x2={w - padR}
            y1={yOf(allowedDailyLevel)}
            y2={yOf(allowedDailyLevel)}
            stroke="#e0a15c"
            strokeWidth={1.25}
            strokeDasharray="4 4"
            opacity={0.8}
          />
        )}
        {/* Actual drawdown magnitude (secondary band) */}
        <path d={ddPath} fill="none" stroke="#e0895c" strokeWidth={1.5} opacity={0.85} />
        {/* Balance / equity (realized closed-trade curve — same series when no open equity tracked) */}
        <path d={balancePath} fill="none" stroke="#7c6cf0" strokeWidth={2.5} />
        {/* Data point hits for tooltip (original values) */}
        {points.map((p, i) => (
          <circle
            key={`pt-${i}`}
            cx={xOf(p.time)}
            cy={yOf(p.equity)}
            r={4}
            fill="transparent"
            onMouseEnter={() =>
              setHover({
                kind: "curve",
                time: p.time,
                equity: p.equity,
                balance: p.balance,
                dd: ddAmounts[i],
              })
            }
          />
        ))}
        {/* Trade activity markers */}
        {groups.map((g, i) => {
          const n = g.trades.length;
          const cy = height - 14;
          const winish = g.trades.every((tr) => (resolveCurrencyPnL(tr) ?? 0) > 0);
          const lossish = g.trades.every((tr) => (resolveCurrencyPnL(tr) ?? 0) < 0);
          const fill = winish ? "#3dbf7a" : lossish ? "#e05c5c" : "#9aa4b2";
          return (
            <g
              key={`m-${i}`}
              onMouseEnter={() => setHover({ kind: "marker", time: g.time, trades: g.trades })}
              style={{ cursor: "pointer" }}
            >
              <line
                x1={g.x}
                x2={g.x}
                y1={padT}
                y2={height - padB}
                stroke={fill}
                strokeWidth={1}
                opacity={0.25}
              />
              {n === 1 ? (
                <circle cx={g.x} cy={cy} r={5} fill={fill} stroke="#0b0f14" strokeWidth={1} />
              ) : (
                <>
                  <rect
                    x={g.x - 10}
                    y={cy - 8}
                    width={20}
                    height={16}
                    rx={4}
                    fill={fill}
                    stroke="#0b0f14"
                    strokeWidth={1}
                  />
                  <text
                    x={g.x}
                    y={cy + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={700}
                    fill="#0b0f14"
                  >
                    {n}
                  </text>
                </>
              )}
            </g>
          );
        })}
        {/* Time labels */}
        <text x={padL} y={height - 6} fontSize={10} fill="currentColor" opacity={0.65}>
          {fmtT(minX)}
        </text>
        <text
          x={w - padR}
          y={height - 6}
          fontSize={10}
          fill="currentColor"
          opacity={0.65}
          textAnchor="end"
        >
          {fmtT(maxX)}
        </text>
      </svg>
      <div
        className="hint"
        style={{ display: "flex", flexWrap: "wrap", gap: "10px 16px", marginTop: 6, fontSize: 11 }}
      >
        <span>
          <span style={{ color: "#7c6cf0" }}>●</span> Balance (realized after each close)
        </span>
        <span>
          <span style={{ color: "#e0895c" }}>●</span> Actual drawdown from peak
        </span>
        {allowedDailyLevel != null && (
          <span>
            <span style={{ color: "#e0a15c" }}>—</span> Allowed daily DD (
            {allowedDailyDdPct}%)
          </span>
        )}
        {allowedMaxLevel != null && (
          <span>
            <span style={{ color: "#e05c5c" }}>—</span> Allowed max account DD (
            {allowedMaxDdPct}%)
          </span>
        )}
        <span>Markers: trade entries (count badge if clustered ≤2 min)</span>
      </div>
      <p className="hint" style={{ marginTop: 4 }}>
        Equity tracks the same realized closed-trade curve (no separate open-equity feed in journal).
        Curve smoothing is visual only; tooltips use original point values.
      </p>
      {hover && (
        <div
          className="card"
          style={{
            position: "absolute",
            left: 8,
            top: 8,
            padding: "8px 10px",
            fontSize: 12,
            maxWidth: 280,
            pointerEvents: "none",
            zIndex: 2,
          }}
        >
          <div>{fmtT(hover.time)}</div>
          {hover.kind === "curve" && (
            <>
              <div>Balance: {hover.balance?.toFixed(2)}</div>
              <div>DD from peak: {hover.dd?.toFixed(2)}</div>
            </>
          )}
          {hover.kind === "marker" && hover.trades && (
            <>
              <div>
                <b>{hover.trades.length}</b> trade{hover.trades.length > 1 ? "s" : ""}
              </div>
              {hover.trades.slice(0, 4).map((tr) => (
                <div key={tr.id} style={{ marginTop: 4 }}>
                  {(tr.tradeId || tr.id).slice(0, 12)} · {tr.symbol} · {tr.side.toUpperCase()} ·{" "}
                  {resolveCurrencyPnL(tr) != null
                    ? resolveCurrencyPnL(tr)!.toFixed(2)
                    : "—"}
                </div>
              ))}
              {hover.trades.length > 4 && <div>…</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RHist({ buckets }: { buckets: { bucket: string; count: number }[] }) {
  if (!buckets.length) return <div className="chart-empty">No R data</div>;
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div className="r-hist">
      {buckets.map((b) => (
        <div key={b.bucket} className="r-hist-col" title={`${b.bucket}R: ${b.count}`}>
          <div className="r-hist-bar" style={{ height: `${(b.count / max) * 100}%` }} />
          <span>{b.bucket}</span>
        </div>
      ))}
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className={`stat-card ${tone || ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div className="table-wrap">
      <table className="analytics-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalyticsView({ backendOnline: _bo }: { backendOnline: boolean | null }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [sessionFilter, setSessionFilter] = useState<string>("active");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [symbolFilter, setSymbolFilter] = useState<string>("all");
  const [sideFilter, setSideFilter] = useState<"all" | "long" | "short">("all");
  const [orderFilter, setOrderFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState<"all" | "win" | "loss" | "breakeven">("all");
  const [rangePreset, setRangePreset] = useState<"all" | "today" | "week" | "month" | "custom">(
    "all"
  );
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionAccounts, setSessionAccounts] = useState<AccountProfile[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sess = await getSessionStorageAdapter().listSessions();
      if (cancelled) return;
      setSessions(sess);
      const active = getActiveSessionId();
      let all: JournalTrade[] = [];
      let profiles: AccountProfile[] = [];
      if (sessionFilter === "all") {
        for (const s of sess) {
          const jt = await loadJournalForSession(s.id);
          all = all.concat(jt);
          const full = ensureSessionAccounts(s);
          profiles = profiles.concat(full.accounts || []);
        }
        const legacy = await loadJournalForSession(null);
        all = all.concat(legacy);
      } else {
        const sid = sessionFilter === "active" ? active : sessionFilter;
        all = await loadJournalForSession(sid);
        if (sid) {
          const meta = await getSession(sid);
          if (meta) profiles = ensureSessionAccounts(meta).accounts || [];
        }
      }
      if (!cancelled) {
        setTrades(all);
        setSessionAccounts(profiles);
        // Invalid accountFilter after session change → All
        const ids = new Set(profiles.map((a) => a.accountId));
        setAccountFilter((prev) => (prev !== "all" && !ids.has(prev) ? "all" : prev));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionFilter]);

  // v3.24.0: refresh when Journal mutates (delete/append) without changing session filter
  useEffect(() => {
    const onJournal = () => setSessionFilter((s) => s); // force? better reload trades
    // Soft bump: re-run load by toggling a nonce
    const handler = () => {
      setSessionFilter((prev) => prev); // no-op state
      // explicit reload
      void (async () => {
        const sess = await getSessionStorageAdapter().listSessions();
        setSessions(sess);
        const active = getActiveSessionId();
        let all: JournalTrade[] = [];
        if (sessionFilter === "all") {
          for (const s of sess) {
            all = all.concat(await loadJournalForSession(s.id));
          }
          all = all.concat(await loadJournalForSession(null));
        } else {
          const sid = sessionFilter === "active" ? active : sessionFilter;
          all = await loadJournalForSession(sid);
        }
        setTrades(all);
      })();
    };
    window.addEventListener(JOURNAL_CHANGED_EVENT, handler);
    return () => window.removeEventListener(JOURNAL_CHANGED_EVENT, handler);
  }, [sessionFilter]);

  const symbols = useMemo(() => {
    const ids = new Set<string>();
    for (const t of trades) if (t.symbol) ids.add(t.symbol);
    return Array.from(ids);
  }, [trades]);

  const timeBounds = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    if (rangePreset === "all") return { from: null as number | null, to: null as number | null };
    if (rangePreset === "today") {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return { from: Math.floor(d.getTime() / 1000), to: now };
    }
    if (rangePreset === "week") return { from: now - 7 * 86400, to: now };
    if (rangePreset === "month") return { from: now - 30 * 86400, to: now };
    const from = customFrom ? Math.floor(new Date(customFrom + "T00:00:00Z").getTime() / 1000) : null;
    const to = customTo ? Math.floor(new Date(customTo + "T23:59:59Z").getTime() / 1000) : null;
    return { from, to };
  }, [rangePreset, customFrom, customTo]);

  const filters: AnalyticsFilters = useMemo(
    () => ({
      sessionId: sessionFilter === "all" ? "all" : sessionFilter === "active" ? getActiveSessionId() : sessionFilter,
      accountId: accountFilter,
      symbol: symbolFilter,
      fromTime: timeBounds.from,
      toTime: timeBounds.to,
      side: sideFilter,
      orderType: orderFilter,
      reason: reasonFilter,
      result: resultFilter,
    }),
    [sessionFilter, accountFilter, symbolFilter, timeBounds, sideFilter, orderFilter, reasonFilter, resultFilter]
  );

  const filtered = useMemo(() => filterTrades(trades, filters), [trades, filters]);

  const startingBalance = useMemo((): number | null => {
    const fromAccount = (acc: (typeof sessionAccounts)[0] | undefined): number | null => {
      if (!acc) return null;
      // Prop: prefer configured phase accountSize (challenge size), never invent 10000
      if ((acc.accountType || "personal") === "prop" && acc.propProgram?.phases?.length) {
        const phase =
          acc.propProgram.phases.find((ph) => ph.id === acc.activePropPhaseId) ||
          acc.propProgram.phases[0];
        const size = phase?.rules?.accountSize;
        if (size != null && Number.isFinite(size) && size > 0) return size;
      }
      if (acc.initialBalance != null && Number.isFinite(acc.initialBalance) && acc.initialBalance > 0) {
        return acc.initialBalance;
      }
      if (acc.balance != null && Number.isFinite(acc.balance) && acc.balance > 0) {
        return acc.balance;
      }
      return null;
    };
    if (accountFilter !== "all") {
      return fromAccount(sessionAccounts.find((a) => a.accountId === accountFilter));
    }
    // All accounts: prefer account profile sizes; then trade snapshot; never invent 10000
    if (sessionAccounts.length === 1) return fromAccount(sessionAccounts[0]);
    if (sessionAccounts.length > 1) {
      // Sum of configured sizes for multi-account view when all selected
      let sum = 0;
      let any = false;
      for (const acc of sessionAccounts) {
        const v = fromAccount(acc);
        if (v != null) {
          sum += v;
          any = true;
        }
      }
      if (any) return sum;
    }
    const withBal = filtered.find((t) => t.balanceBefore != null && Number(t.balanceBefore) > 0);
    if (withBal?.balanceBefore != null) return Number(withBal.balanceBefore);
    return null;
  }, [accountFilter, sessionAccounts, filtered]);

  const summary = useMemo(
    () => computeSummary(filtered, startingBalance ?? 0),
    [filtered, startingBalance]
  );
  const durationByExit = useMemo(() => durationStatsByExit(filtered), [filtered]);
  const durationByProfit = useMemo(() => durationStatsByProfitability(filtered), [filtered]);
  const dailyTwo = useMemo(
    () => analyzeDailyTwoTradeBehavior(filtered, "America/New_York"),
    [filtered]
  );
  const riskGap = useMemo(() => aggregateRiskGap(filtered), [filtered]);
  const allowedDailyDdPct = useMemo(() => {
    for (const a of sessionAccounts) {
      const phases = a.propProgram?.phases || [];
      for (const ph of phases) {
        const v = ph.rules?.dailyLossLimitPct;
        if (v != null && Number.isFinite(v)) return Number(v);
      }
    }
    for (const s of sessions) {
      const v = s.propFirm?.dailyDdPercent;
      if (v != null && Number.isFinite(v)) return Number(v);
    }
    return null;
  }, [sessionAccounts, sessions]);
  const allowedMaxDdPct = useMemo(() => {
    for (const a of sessionAccounts) {
      const phases = a.propProgram?.phases || [];
      for (const ph of phases) {
        const v = ph.rules?.maxOverallLossPct;
        if (v != null && Number.isFinite(v)) return Number(v);
      }
    }
    for (const s of sessions) {
      const pf = s.propFirm;
      if (!pf) continue;
      const v =
        pf.overallDdPercent ??
        pf.trailingDrawdownPercent ??
        pf.staticDrawdownPercent;
      if (v != null && Number.isFinite(v)) return Number(v);
    }
    return null;
  }, [sessionAccounts, sessions]);
  const whatIfSample = useMemo(() => {
    // Aggregate hypothetical scale to 2% risk on trades that have balance+actual risk
    let n = 0;
    let sumDiff = 0;
    for (const tr of filtered) {
      const w = whatIfFixedRiskPercent(tr, 2);
      if (w.available && w.pnlDiffVsActual != null) {
        n++;
        sumDiff += w.pnlDiffVsActual;
      }
    }
    return { samples: n, totalPnlDiffIf2pctRisk: n ? sumDiff : null };
  }, [filtered]);
  const curve = useMemo(
    () => buildEquityCurve(filtered, startingBalance ?? 0),
    [filtered, startingBalance]
  );
  const ddInfo = useMemo(() => maxDrawdownFromCurve(curve), [curve]);
  const rHist = useMemo(() => rDistribution(filtered), [filtered]);
  const bySide = useMemo(() => breakdownByDirection(filtered), [filtered]);
  const byOrder = useMemo(() => breakdownByOrderType(filtered), [filtered]);
  const byExit = useMemo(() => breakdownByExitReason(filtered), [filtered]);
  const bySym = useMemo(() => breakdownBySymbol(filtered), [filtered]);
  const byAcc = useMemo(() => breakdownByAccount(filtered), [filtered]);
  const byDow = useMemo(() => timeAnalysis(filtered, "dow"), [filtered]);
  const byHour = useMemo(() => timeAnalysis(filtered, "hour"), [filtered]);

  const sessionCompare = useMemo(() => {
    if (sessionFilter !== "all") return [];
    return sessions.map((s) => {
      const st = filterTrades(trades, {
        sessionId: s.id,
        accountId: accountFilter,
        symbol: symbolFilter,
        fromTime: timeBounds.from,
        toTime: timeBounds.to,
      });
      const sum = computeSummary(st, startingBalance ?? 0);
      return {
        name: s.name || s.id,
        trades: sum.totalTrades,
        winRate: formatPct(sum.winRate),
        netPnl: formatNum(sum.netPnl),
        totalR: formatNum(sum.totalR),
        avgR: formatNum(sum.averageR),
        pf: formatNum(sum.profitFactor),
        maxDd: formatNum(sum.maxDrawdown),
        exp: formatNum(sum.expectancyR),
      };
    });
  }, [sessionFilter, sessions, trades, accountFilter, symbolFilter, timeBounds, startingBalance]);

  return (
    <section className="analytics-view">
      <h2>Analytics</h2>
      <p className="hint">Closed Journal trades only · Session-scoped · No market-data dependency</p>

      <div className="analytics-filters">
        <label>
          Session
          <select value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)}>
            <option value="active">Active session</option>
            <option value="all">All sessions</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Account
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="all">All Accounts</option>
            {sessionAccounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name} · {(a.initialBalance ?? a.balance).toLocaleString()} {a.currency}
              </option>
            ))}
          </select>
        </label>
        <label>
          Symbol
          <select value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)}>
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
          <select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as "all" | "long" | "short")}>
            <option value="all">All</option>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <label>
          Result
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value as "all" | "win" | "loss" | "breakeven")}
          >
            <option value="all">All</option>
            <option value="win">Win</option>
            <option value="loss">Loss</option>
            <option value="breakeven">Breakeven</option>
          </select>
        </label>
        <label>
          Exit
          <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="sl">SL</option>
            <option value="tp">TP</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <button type="button" onClick={() => downloadJournalCsv(filtered, "analytics-trades.csv")}>
          Export CSV
        </button>
        <button
          type="button"
          onClick={() => {
            try {
              downloadAnalyticsJson(filtered, "analytics-report.json");
            } catch (err) {
              alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        >
          Export JSON report
        </button>
        <button
          type="button"
          onClick={() => {
            try {
              downloadJournalBackupZip(filtered);
            } catch (err) {
              alert(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        >
          Export ZIP backup
        </button>
        <label className="import-btn" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
          Import Journal ZIP
          <input
            type="file"
            accept=".zip,application/zip"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void (async () => {
                try {
                  const buf = await file.arrayBuffer();
                  const preview = await parseJournalBackupZip(buf);
                  if (!preview.ok) {
                    alert(`Invalid backup:\n${preview.errors.join("\n")}`);
                    return;
                  }
                  if (
                    !window.confirm(
                      `Import Journal backup into Analytics source?\nTrades: ${preview.trades.length}\nScreenshots: ${preview.screenshotCount}\n\nMERGE only (OK).`
                    )
                  ) {
                    return;
                  }
                  const sid = getSessionStorageAdapter().getActiveSessionId();
                  const result = await importJournalBackup(preview, "merge", sid);
                  // reload journal-driven analytics
                  window.dispatchEvent(new Event("tr-journal-changed"));
                  alert(
                    result.ok
                      ? `Imported ${result.imported}, skipped ${result.skipped}. Analytics will refresh from Journal.`
                      : `Import failed: ${result.errors.join("; ")}`
                  );
                } catch (err) {
                  alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              })();
            }}
          />
        </label>
        <label>
          Range
          <select
            value={rangePreset}
            onChange={(e) => setRangePreset(e.target.value as typeof rangePreset)}
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {rangePreset === "custom" && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </>
        )}
      </div>

      {loading ? (
        <p>Loading journal…</p>
      ) : (
        <>
          <h3>Summary</h3>
          <div className="stat-grid">
            <Card
              label="Net P&L"
              value={formatNum(summary.netPnl)}
              tone={summary.netPnl >= 0 ? "pos" : "neg"}
            />
            <Card label="Return %" value={formatPct(summary.returnPercent)} />
            <Card
              label="Starting"
              value={startingBalance == null ? "—" : formatNum(startingBalance, 0)}
            />
            <Card
              label="Ending"
              value={startingBalance == null && filtered.length === 0 ? "—" : formatNum(summary.endingBalance, 0)}
            />
            <Card label="Gross profit" value={formatNum(summary.grossProfit)} tone="pos" />
            <Card label="Gross loss" value={formatNum(summary.grossLoss)} tone="neg" />
            <Card label="Profit factor" value={formatNum(summary.profitFactor)} />
            <Card label="Trades" value={String(summary.totalTrades)} />
            <Card label="Wins" value={String(summary.wins)} />
            <Card label="Losses" value={String(summary.losses)} />
            <Card label="Breakeven" value={String(summary.breakeven)} />
            <Card label="Win rate" value={formatPct(summary.winRate)} />
            <Card label="Total R" value={formatNum(summary.totalR)} />
            <Card label="Avg R" value={formatNum(summary.averageR)} />
            <Card label="Expectancy R" value={formatNum(summary.expectancyR)} />
            <Card label="Max DD" value={formatNum(summary.maxDrawdown)} tone="neg" />
            <Card label="Max DD %" value={formatPct(summary.maxDrawdownPercent)} />
            <Card label="Recovery factor" value={formatNum(summary.recoveryFactor)} />
          </div>

          <h3>Equity curve</h3>
          <div className="card chart-card">
            <UnifiedEquityPanel
              points={curve}
              trades={filtered}
              startingBalance={startingBalance ?? 0}
              allowedDailyDdPct={allowedDailyDdPct}
              allowedMaxDdPct={allowedMaxDdPct}
            />
            <p className="hint">
              Peak ≈ {formatNum(ddInfo.peak)} · Max actual DD {formatNum(ddInfo.maxDrawdown)} (
              {formatPct(ddInfo.maxDrawdownPercent)})
            </p>
          </div>

          <h3>R-multiple</h3>
          <div className="stat-grid">
            <Card label="Median R" value={formatNum(summary.medianR)} />
            <Card label="Max R" value={formatNum(summary.maxR)} />
            <Card label="Min R" value={formatNum(summary.minR)} />
            <Card label="Avg win R" value={formatNum(summary.avgWinR)} />
            <Card label="Avg loss R" value={formatNum(summary.avgLossR)} />
            <Card label="Avg win $" value={formatNum(summary.avgWinCurrency)} tone="pos" />
            <Card label="Avg loss $" value={formatNum(summary.avgLossCurrency)} tone="neg" />
            <Card label="Win streak max" value={String(summary.maxWinStreak)} />
            <Card label="Loss streak max" value={String(summary.maxLossStreak)} />
          </div>
          <div className="card chart-card">
            <RHist buckets={rHist} />
          </div>

          <h3>Duration (all exits combined)</h3>
          <div className="stat-grid">
            <Card label="Avg" value={formatDuration(summary.avgDurationSec)} />
            <Card label="Median" value={formatDuration(summary.medianDurationSec)} />
            <Card label="Shortest" value={formatDuration(summary.minDurationSec)} />
            <Card label="Longest" value={formatDuration(summary.maxDurationSec)} />
          </div>
          <h3>Duration by exit type</h3>
          <p className="hint">
            Separate min/max/avg for TP, SL, Breakeven, and Manual (respects current filters). Invalid
            timestamps excluded
            {durationByExit[0]?.excludedInvalidTimestamps
              ? ` (${durationByExit[0].excludedInvalidTimestamps} trades)`
              : ""}.
          </p>
          <Table
            headers={["Exit", "Count", "Min", "Max", "Avg", "Median"]}
            rows={durationByExit.map((r) => [
              r.reason.toUpperCase(),
              r.count,
              formatDuration(r.minSec),
              formatDuration(r.maxSec),
              formatDuration(r.avgSec),
              formatDuration(r.medianSec),
            ])}
          />

          <h3>Duration by profitability</h3>
          <p className="hint">
            Based on actual realized P&amp;L sign only (not exit type, not What-If). Respects current filters.
          </p>
          <Table
            headers={["Outcome", "Count", "Min", "Max", "Avg", "Median"]}
            rows={durationByProfit.map((r) => [
              r.outcome === "win" ? "Winning" : r.outcome === "loss" ? "Losing" : "Break-even",
              r.count,
              formatDuration(r.minSec),
              formatDuration(r.maxSec),
              formatDuration(r.avgSec),
              formatDuration(r.medianSec),
            ])}
          />

          <h3>Daily Trade Behavior</h3>
          <p className="hint">
            Days with exactly two completed trades (entry order). Trading day ={" "}
            {dailyTwo.timezone} calendar day via tradingDayKey (DST-aware). Single-trade wins model “TP first → no second trade”. Days with 3+ trades counted
            separately and excluded from percentages.
          </p>
          <div className="stat-grid">
            <Card label="Exactly 2-trade days" value={String(dailyTwo.exactlyTwoDays)} />
            <Card label="Days with 3+ trades" value={String(dailyTwo.moreThanTwoDays)} />
            <Card label="Single-trade days" value={String(dailyTwo.singleTradeDays)} />
            <Card
              label="Only 1 trade · win (stop after TP)"
              value={String(dailyTwo.singleWinDays)}
            />
            <Card label="Only 1 trade · loss" value={String(dailyTwo.singleLossDays)} />
            <Card label="2-trade · 1st was loss" value={String(dailyTwo.firstLossTwoTradeDays)} />
            <Card label="2-trade · 1st was win" value={String(dailyTwo.firstWinTwoTradeDays)} />
            <Card label="Both profitable %" value={formatNum(dailyTwo.pctBothProfitable)} />
            <Card label="Both losing %" value={formatNum(dailyTwo.pctBothLosing)} />
            <Card label="2nd trade profitable %" value={formatNum(dailyTwo.pctSecondProfitable)} />
            <Card
              label="2nd win after 1st loss %"
              value={formatNum(dailyTwo.pctSecondWinAfterFirstLoss)}
            />
          </div>
          <Table
            headers={["Category", "Days"]}
            rows={[
              ["Both profitable", dailyTwo.categories.both_profit],
              ["1st profit · 2nd loss", dailyTwo.categories.first_profit_second_loss],
              ["1st loss · 2nd profit", dailyTwo.categories.first_loss_second_profit],
              ["Both losing", dailyTwo.categories.both_loss],
              ["Has break-even", dailyTwo.categories.has_breakeven],
              ["Unclassified (missing P&L)", dailyTwo.categories.unclassified],
            ]}
          />

          <h3>Actual vs target risk</h3>
          <div className="stat-grid">
            <Card label="Samples" value={String(riskGap.samples)} />
            <Card label="Avg target %" value={formatNum(riskGap.avgTargetPct)} />
            <Card label="Avg actual %" value={formatNum(riskGap.avgActualPct)} />
            <Card label="Avg diff (pp)" value={formatNum(riskGap.avgDiffPct)} />
            <Card label="Avg target $" value={formatNum(riskGap.avgTargetAmt)} />
            <Card label="Avg actual $" value={formatNum(riskGap.avgActualAmt)} />
          </div>

          <h3>What-If (hypothetical)</h3>
          <p className="hint">
            Not real performance. Example: if every filtered trade with known risk had been sized at 2% of
            balance-before (scaled P&amp;L by risk ratio).
          </p>
          <div className="stat-grid">
            <Card label="2% risk samples" value={String(whatIfSample.samples)} />
            <Card
              label="Sum Δ P&L vs actual"
              value={formatNum(whatIfSample.totalPnlDiffIf2pctRisk)}
            />
          </div>

          <h3>Trade breakdown</h3>
          <h4>Direction</h4>
          <Table
            headers={["Side", "Trades", "W", "L", "BE", "Win%", "Net", "Total R", "Avg R"]}
            rows={bySide.map((r) => [
              r.key,
              r.trades,
              r.wins,
              r.losses,
              r.breakeven,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.totalR),
              formatNum(r.averageR),
            ])}
          />
          <h4>Order type</h4>
          <Table
            headers={["Type", "Trades", "W", "L", "Win%", "Net", "Avg R"]}
            rows={byOrder.map((r) => [
              r.key,
              r.trades,
              r.wins,
              r.losses,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.averageR),
            ])}
          />
          <h4>Exit reason</h4>
          <Table
            headers={["Reason", "Trades", "W", "L", "Win%", "Net", "Avg R"]}
            rows={byExit.map((r) => [
              r.key,
              r.trades,
              r.wins,
              r.losses,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.averageR),
            ])}
          />
          <h4>Symbol</h4>
          <Table
            headers={["Symbol", "Trades", "Win%", "Net", "Avg R"]}
            rows={bySym.map((r) => [
              r.key,
              r.trades,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.averageR),
            ])}
          />
          <h4>Account</h4>
          <Table
            headers={["Account", "Trades", "Win%", "Net", "Avg R"]}
            rows={byAcc.map((r) => [
              r.key,
              r.trades,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.averageR),
            ])}
          />

          <h3>Time analysis</h3>
          <h4>Day of week (UTC)</h4>
          <Table
            headers={["Day", "Trades", "Win%", "Net", "Total R"]}
            rows={byDow.map((r) => [
              r.key,
              r.trades,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.totalR),
            ])}
          />
          <h4>Hour (UTC)</h4>
          <Table
            headers={["Hour", "Trades", "Win%", "Net", "Avg R"]}
            rows={byHour.map((r) => [
              r.key,
              r.trades,
              formatPct(r.winRate),
              formatNum(r.netPnl),
              formatNum(r.averageR),
            ])}
          />

          {sessionCompare.length > 0 && (
            <>
              <h3>Session comparison</h3>
              <Table
                headers={[
                  "Session",
                  "Trades",
                  "Win%",
                  "Net",
                  "Total R",
                  "Avg R",
                  "PF",
                  "Max DD",
                  "Expectancy",
                ]}
                rows={sessionCompare.map((r) => [
                  r.name,
                  r.trades,
                  r.winRate,
                  r.netPnl,
                  r.totalR,
                  r.avgR,
                  r.pf,
                  r.maxDd,
                  r.exp,
                ])}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
