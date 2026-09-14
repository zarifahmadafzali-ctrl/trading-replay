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
import { loadJournalForSession, type JournalTrade } from "../lib/journal";
import {
  getActiveSessionId,
  listSessions,
  type SessionMeta,
} from "../lib/sessionStore";

function EquitySvg({
  points,
  height = 160,
}: {
  points: { time: number; equity: number }[];
  height?: number;
}) {
  if (points.length < 2) {
    return <div className="chart-empty">Not enough closed trades for equity curve</div>;
  }
  const w = 640;
  const pad = 12;
  const xs = points.map((p) => p.time);
  const ys = points.map((p) => p.equity);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs) || minX + 1;
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanY = maxY - minY || 1;
  const path = points
    .map((p, i) => {
      const x = pad + ((p.time - minX) / (maxX - minX || 1)) * (w - pad * 2);
      const y = height - pad - ((p.equity - minY) / spanY) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="analytics-svg" role="img" aria-label="Equity curve">
      <path d={path} fill="none" stroke="#3d9cfd" strokeWidth="2" />
    </svg>
  );
}

function DrawdownSvg({
  points,
  height = 120,
}: {
  points: { time: number; equity: number }[];
  height?: number;
}) {
  if (points.length < 2) return <div className="chart-empty">No drawdown data</div>;
  const w = 640;
  const pad = 12;
  let peak = points[0].equity;
  const dds = points.map((p) => {
    if (p.equity > peak) peak = p.equity;
    return { time: p.time, dd: p.equity - peak };
  });
  const xs = dds.map((p) => p.time);
  const ys = dds.map((p) => p.dd);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs) || minX + 1;
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  const spanY = maxY - minY || 1;
  const path = dds
    .map((p, i) => {
      const x = pad + ((p.time - minX) / (maxX - minX || 1)) * (w - pad * 2);
      const y = height - pad - ((p.dd - minY) / spanY) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="analytics-svg" role="img" aria-label="Drawdown">
      <path d={path} fill="none" stroke="#e05c5c" strokeWidth="2" />
    </svg>
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
  const [rangePreset, setRangePreset] = useState<"all" | "today" | "week" | "month" | "custom">(
    "all"
  );
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sess = await listSessions();
      if (cancelled) return;
      setSessions(sess);
      const active = getActiveSessionId();
      let all: JournalTrade[] = [];
      if (sessionFilter === "all") {
        for (const s of sess) {
          const t = await loadJournalForSession(s.id);
          all = all.concat(t);
        }
        const legacy = await loadJournalForSession(null);
        all = all.concat(legacy);
      } else {
        const sid = sessionFilter === "active" ? active : sessionFilter;
        all = await loadJournalForSession(sid);
      }
      if (!cancelled) {
        setTrades(all);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionFilter]);

  const accounts = useMemo(() => {
    const ids = new Set<string>();
    for (const t of trades) if (t.accountId) ids.add(t.accountId);
    return Array.from(ids);
  }, [trades]);

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
    }),
    [sessionFilter, accountFilter, symbolFilter, timeBounds]
  );

  const filtered = useMemo(() => filterTrades(trades, filters), [trades, filters]);

  const startingBalance = useMemo(() => {
    const withBal = filtered.find((t) => t.balanceBefore != null);
    if (withBal?.balanceBefore != null) return withBal.balanceBefore;
    return 10000;
  }, [filtered]);

  const summary = useMemo(
    () => computeSummary(filtered, startingBalance),
    [filtered, startingBalance]
  );
  const curve = useMemo(
    () => buildEquityCurve(filtered, startingBalance),
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
      const sum = computeSummary(st, startingBalance);
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
            <option value="all">All</option>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a}
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
            <Card label="Starting" value={formatNum(summary.startingBalance, 0)} />
            <Card label="Ending" value={formatNum(summary.endingBalance, 0)} />
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
            <EquitySvg points={curve} />
            <p className="hint">
              Peak ≈ {formatNum(ddInfo.peak)} · Max DD {formatNum(ddInfo.maxDrawdown)} (
              {formatPct(ddInfo.maxDrawdownPercent)})
            </p>
          </div>

          <h3>Drawdown</h3>
          <div className="card chart-card">
            <DrawdownSvg points={curve} />
          </div>

          <h3>R-multiple</h3>
          <div className="stat-grid">
            <Card label="Median R" value={formatNum(summary.medianR)} />
            <Card label="Max R" value={formatNum(summary.maxR)} />
            <Card label="Min R" value={formatNum(summary.minR)} />
            <Card label="Avg win R" value={formatNum(summary.avgWinR)} />
            <Card label="Avg loss R" value={formatNum(summary.avgLossR)} />
            <Card label="Win streak max" value={String(summary.maxWinStreak)} />
            <Card label="Loss streak max" value={String(summary.maxLossStreak)} />
          </div>
          <div className="card chart-card">
            <RHist buckets={rHist} />
          </div>

          <h3>Duration</h3>
          <div className="stat-grid">
            <Card label="Avg" value={formatDuration(summary.avgDurationSec)} />
            <Card label="Median" value={formatDuration(summary.medianDurationSec)} />
            <Card label="Shortest" value={formatDuration(summary.minDurationSec)} />
            <Card label="Longest" value={formatDuration(summary.maxDurationSec)} />
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
