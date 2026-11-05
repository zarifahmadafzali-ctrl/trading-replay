import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  LevelUnit,
  PositionIssue,
  PositionLike,
  PositionRiskInput,
  PositionStyle,
  RiskModeId,
  TypeChoice,
} from "../lib/positionModel";
import {
  DEFAULT_RR,
  hasErrors,
  levelFromInput,
  levelToInput,
  resolveStyle,
  retypeDraft,
  typeChoiceOf,
} from "../lib/positionModel";
import type { SizingInfo } from "../lib/positionSizing";

/**
 * ONE floating bar for the selected position (same slot DrawingSettingsBar uses for other shapes;
 * Chart renders exactly one of them). It is the whole order ticket:
 *   row 1: side/status, order type (Auto / Market / Limit / Stop / Stop-Limit), colors, settings, lock, collapse, close/cancel
 *   row 2: sizing (mode + value), fixed R:R lock, live lot / risk / reward preview, Confirm / Cancel (draft)
 * Settings dialog = TradingView-style tabs: Inputs / Style / Coordinates.
 */

type Props = {
  position: PositionLike;
  container: { w: number; h: number };
  priceDecimals: number;
  tick: number;
  barSec: number;
  issues: PositionIssue[];
  /** Live numbers from sizingInfo() (lot, risk, reward, P&L). */
  info?: SizingInfo;
  /** Current replay price: needed to place the entry when the order type is changed by hand. */
  marketPrice?: number | null;
  savedDefaults?: Partial<PositionStyle>;
  onChange: (patch: Partial<PositionLike>) => void;
  /** Draft only: goes through the same gate as the old Orders panel (prop lifecycle, etc.). */
  onConfirm?: () => void;
  /** Open position -> manual close at the current replay price. */
  onClosePosition?: () => void;
  /** Draft/pending -> remove the order. */
  onCancelOrder?: () => void;
  onSaveStyleAsDefault?: (style: Partial<PositionStyle>) => void;
};

const bar: CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 40,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 6,
  padding: "6px 8px",
  background: "rgba(17,24,32,0.96)",
  border: "1px solid #293542",
  borderRadius: 8,
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  width: "max-content",
  maxWidth: "calc(100% - 16px)",
  pointerEvents: "auto",
  font: "12px system-ui, sans-serif",
  color: "#cdd7e3",
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "center" };
const btn: CSSProperties = {
  height: 30,
  minWidth: 30,
  padding: "0 8px",
  background: "#111820",
  color: "#cdd7e3",
  border: "1px solid #293542",
  borderRadius: 5,
  cursor: "pointer",
};
const swatch: CSSProperties = { width: 26, height: 26, padding: 0, border: "1px solid #293542", borderRadius: 4, background: "none", cursor: "pointer" };
const field: CSSProperties = { height: 30, background: "#111820", color: "#cdd7e3", border: "1px solid #293542", borderRadius: 5, padding: "0 6px" };

const TYPE_LABEL: Record<string, string> = {
  market: "Market",
  buy_limit: "Buy Limit",
  sell_limit: "Sell Limit",
  buy_stop: "Buy Stop",
  sell_stop: "Sell Stop",
  buy_stop_limit: "Buy Stop-Limit",
  sell_stop_limit: "Sell Stop-Limit",
};

function money(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) ? n.toFixed(2) : "—";
}
function pct(n: number | null | undefined): string {
  return n != null && Number.isFinite(n) ? `${n.toFixed(2)}%` : "";
}

function Num({
  value,
  onCommit,
  disabled,
  step,
  width = 80,
}: {
  value: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
  step?: string;
  width?: number;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <input
      style={{ ...field, width }}
      type="number"
      inputMode="decimal"
      step={step || "any"}
      disabled={disabled}
      value={txt ?? String(Number.isFinite(value) ? value : "")}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        if (txt != null) {
          const v = Number(txt);
          if (Number.isFinite(v)) onCommit(v);
          setTxt(null);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function PositionSettingsBar(props: Props) {
  const { position: p, issues, info } = props;
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(p.status !== "draft");
  const st = resolveStyle(p, props.savedDefaults);
  const errs = issues.filter((i) => i.level === "error");
  const live = p.status === "open";
  const isDraft = p.status === "draft";
  const risk: PositionRiskInput = p.risk || {};
  const mode: RiskModeId = risk.mode || "percent_equity";
  const riskValue = mode === "fixed_money" ? risk.amount : mode === "fixed_lot" ? risk.lot : risk.percent;
  const lock = p.rrLock;
  const choice = typeChoiceOf(p);
  const m = props.marketPrice ?? null;

  const setRisk = (patch: Partial<PositionRiskInput>) => props.onChange({ risk: { ...risk, ...patch } });
  const setRiskValue = (v: number) => {
    if (!(v > 0)) return;
    setRisk(mode === "fixed_money" ? { amount: v } : mode === "fixed_lot" ? { lot: v } : { percent: v });
  };
  const retype = (c: TypeChoice) => {
    if (m == null) return;
    props.onChange(retypeDraft(p, c, { market: m, tick: props.tick }));
  };

  return (
    <>
      <div style={bar} role="toolbar" aria-label="Position ticket" onPointerDown={(e) => e.stopPropagation()}>
        <div style={rowStyle}>
          <span style={{ color: p.side === "long" ? st.profitColor : st.stopColor, fontWeight: 600 }}>
            {p.side === "long" ? "Long" : "Short"} · {p.status}
          </span>
          {isDraft ? (
            <select
              style={{ ...field, maxWidth: 150 }}
              aria-label="Order type"
              value={choice}
              disabled={p.locked || m == null}
              onChange={(e) => retype(e.target.value as TypeChoice)}
            >
              <option value="auto">Auto · {TYPE_LABEL[p.orderType] || p.orderType}</option>
              <option value="market">Market</option>
              <option value="limit">Limit</option>
              <option value="stop">Stop</option>
              <option value="stop_limit">Stop-Limit</option>
            </select>
          ) : (
            <span style={{ opacity: 0.85 }}>{TYPE_LABEL[p.orderType] || p.orderType}</span>
          )}
          <input
            type="color"
            title="Profit color"
            aria-label="Profit color"
            style={swatch}
            value={st.profitColor}
            disabled={p.locked}
            onChange={(e) => props.onChange({ style: { ...(p.style || {}), profitColor: e.target.value } })}
          />
          <input
            type="color"
            title="Stop color"
            aria-label="Stop color"
            style={swatch}
            value={st.stopColor}
            disabled={p.locked}
            onChange={(e) => props.onChange({ style: { ...(p.style || {}), stopColor: e.target.value } })}
          />
          <button type="button" style={btn} title="Settings" aria-label="Settings" onClick={() => setOpen(true)}>
            ⚙
          </button>
          <button
            type="button"
            style={{ ...btn, background: p.locked ? "#263442" : "#111820" }}
            title={p.locked ? "Unlock" : "Lock"}
            aria-pressed={!!p.locked}
            onClick={() => props.onChange({ locked: !p.locked })}
          >
            {p.locked ? "🔒" : "🔓"}
          </button>
          <button type="button" style={btn} aria-label={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? "▾" : "▴"}
          </button>
          {live && props.onClosePosition && (
            <button type="button" style={{ ...btn, color: "#f87171" }} onClick={props.onClosePosition}>
              Close position
            </button>
          )}
          {!live && !isDraft && props.onCancelOrder && (
            <button type="button" style={{ ...btn, color: "#f87171" }} onClick={props.onCancelOrder}>
              Cancel order
            </button>
          )}
        </div>

        {!collapsed && (
          <div style={rowStyle}>
            {isDraft && (
              <>
                <select
                  style={{ ...field, maxWidth: 110 }}
                  aria-label="Sizing mode"
                  value={mode}
                  disabled={p.locked}
                  onChange={(e) => setRisk({ mode: e.target.value as RiskModeId })}
                >
                  <option value="percent_equity">Risk % equity</option>
                  <option value="percent_balance">Risk % balance</option>
                  <option value="fixed_money">Risk $</option>
                  <option value="fixed_lot">Lot</option>
                </select>
                <Num value={riskValue ?? 0} disabled={p.locked} onCommit={setRiskValue} width={70} />
              </>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={!!lock?.enabled}
                disabled={p.locked}
                onChange={(e) => props.onChange({ rrLock: { enabled: e.target.checked, ratio: lock?.ratio ?? DEFAULT_RR } })}
              />
              R:R
            </label>
            <Num
              value={lock?.ratio ?? DEFAULT_RR}
              step="0.1"
              width={60}
              disabled={p.locked || !lock?.enabled}
              onCommit={(v) => v > 0 && props.onChange({ rrLock: { enabled: true, ratio: v } })}
            />
            {info && (
              <span style={{ opacity: 0.9 }}>
                Lot {info.lot != null ? info.lot : "—"} · Risk ${money(info.riskAmount)}
                {info.riskPercent != null ? ` (${pct(info.riskPercent)})` : ""} · Reward ${money(info.rewardAmount)}
                {info.rr != null ? ` · 1:${info.rr.toFixed(2)}` : ""}
                {live && info.openPnL != null ? ` · P&L ${info.openPnL >= 0 ? "+" : ""}${money(info.openPnL)}` : ""}
              </span>
            )}
            {isDraft && props.onConfirm && (
              <button
                type="button"
                style={{ ...btn, background: errs.length ? "#1b2530" : "#2962ff", borderColor: errs.length ? "#293542" : "#2962ff", color: "#fff", opacity: errs.length ? 0.6 : 1 }}
                disabled={errs.length > 0}
                onClick={props.onConfirm}
              >
                Confirm ✓
              </button>
            )}
            {isDraft && props.onCancelOrder && (
              <button type="button" style={{ ...btn, color: "#f87171" }} onClick={props.onCancelOrder}>
                Cancel ✕
              </button>
            )}
          </div>
        )}
        {errs.length > 0 && <div style={{ color: "#fca5a5", fontSize: 11, textAlign: "center" }}>⚠ {errs[0].message}</div>}
      </div>
      {open && <PositionSettingsDialog {...props} onDismiss={() => setOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ dialog

type Tab = "inputs" | "style" | "coords";
const overlay: CSSProperties = { position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 8 };
const dlg: CSSProperties = { width: "min(420px, 100%)", maxHeight: "92dvh", overflow: "auto", background: "#0f151c", border: "1px solid #293542", borderRadius: 10, color: "#d9e1eb", font: "13px system-ui, sans-serif" };
const row: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 14px" };
const inp: CSSProperties = { ...field, width: 110, padding: "0 8px" };

function PositionSettingsDialog(props: Props & { onDismiss: () => void }) {
  const { position: p, tick, priceDecimals, barSec } = props;
  const [tab, setTab] = useState<Tab>("inputs");
  const [draft, setDraft] = useState<PositionLike>(() => JSON.parse(JSON.stringify(p)) as PositionLike);
  const [tpUnit, setTpUnit] = useState<LevelUnit>("price");
  const [slUnit, setSlUnit] = useState<LevelUnit>("price");
  const st = resolveStyle(draft, props.savedDefaults);
  const live = p.status === "open";
  const entryEditable = !live && p.orderType !== "market";
  const risk: PositionRiskInput = draft.risk || {};
  const mode: RiskModeId = risk.mode || "percent_equity";
  const entry = draft.entry.price;
  const widthBars = useMemo(
    () => (draft.rightTime != null ? Math.max(3, Math.round((draft.rightTime - draft.entry.time) / Math.max(1, barSec))) : 24),
    [draft.rightTime, draft.entry.time, barSec]
  );

  const setStyle = (patch: Partial<PositionStyle>) => setDraft({ ...draft, style: { ...(draft.style || {}), ...patch } });
  const setRisk = (patch: Partial<PositionRiskInput>) => setDraft({ ...draft, risk: { ...risk, ...patch } });
  const setLevel = (kind: "stop" | "takeProfit", value: number, unit: LevelUnit) => {
    const px = levelFromInput(draft.side, kind, entry, value, unit, tick);
    if (px == null) return;
    setDraft({ ...draft, [kind]: { ...draft[kind], price: px } } as PositionLike);
  };

  // Only the fields the trader actually changed are sent, so the R:R lock can tell
  // "target edited by hand" (ratio changes) from "ratio edited" (target follows).
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const apply = () => {
    const patch: Partial<PositionLike> = {};
    if (!same(draft.entry, p.entry)) patch.entry = draft.entry;
    if (!same(draft.stop, p.stop)) patch.stop = draft.stop;
    if (!same(draft.takeProfit, p.takeProfit)) patch.takeProfit = draft.takeProfit;
    if (!same(draft.style, p.style)) patch.style = draft.style;
    if (!same(draft.risk, p.risk)) patch.risk = draft.risk;
    if (!same(draft.rrLock, p.rrLock)) patch.rrLock = draft.rrLock;
    if (draft.rightTime != null && draft.rightTime !== p.rightTime) patch.rightTime = draft.rightTime;
    if (Object.keys(patch).length) props.onChange(patch);
    props.onDismiss();
  };
  const draftIssues = draftHasProblems(draft);
  const riskValue = mode === "fixed_money" ? risk.amount ?? 100 : mode === "fixed_lot" ? risk.lot ?? 0.1 : risk.percent ?? 1;

  return (
    <div style={overlay} onPointerDown={(e) => e.stopPropagation()} onClick={props.onDismiss}>
      <div style={dlg} role="dialog" aria-label="Position settings" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", borderBottom: "1px solid #293542" }}>
          {(["inputs", "style", "coords"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{ flex: 1, height: 38, background: tab === t ? "#1b2530" : "transparent", color: tab === t ? "#fff" : "#8b9bb0", border: 0, borderBottom: tab === t ? "2px solid #2962ff" : "2px solid transparent", cursor: "pointer" }}
            >
              {t === "inputs" ? "Inputs" : t === "style" ? "Style" : "Coordinates"}
            </button>
          ))}
        </div>

        {tab === "inputs" && (
          <div style={{ padding: "8px 0" }}>
            <div style={row}>
              <span>Sizing</span>
              <select style={inp} value={mode} disabled={live || p.status === "pending"} onChange={(e) => setRisk({ mode: e.target.value as RiskModeId })}>
                <option value="percent_equity">Risk % of equity</option>
                <option value="percent_balance">Risk % of balance</option>
                <option value="fixed_money">Risk amount ($)</option>
                <option value="fixed_lot">Fixed lot</option>
              </select>
            </div>
            <div style={row}>
              <span>{mode === "fixed_money" ? "Risk $" : mode === "fixed_lot" ? "Lot size" : "Risk %"}</span>
              <Num
                value={riskValue}
                width={110}
                disabled={live || p.status === "pending"}
                onCommit={(v) =>
                  v > 0 && setRisk(mode === "fixed_money" ? { amount: v } : mode === "fixed_lot" ? { lot: v } : { percent: v })
                }
              />
            </div>
            <div style={{ ...row, color: "#8b9bb0", fontSize: 11 }}>
              <span>
                {p.status === "draft"
                  ? "Account size and margin come from the active session account. The lot is frozen when you press Confirm."
                  : "The lot was frozen at Confirm and cannot change."}
              </span>
            </div>
            <div style={row}>
              <span>Entry price</span>
              <Num value={entry} width={110} disabled={!entryEditable} onCommit={(v) => setDraft({ ...draft, entry: { ...draft.entry, price: v } })} />
            </div>
            <div style={row}>
              <span>Profit level</span>
              <span style={{ display: "flex", gap: 4 }}>
                <Num width={110} value={Number(levelToInput(entry, draft.takeProfit.price, tpUnit, tick).toFixed(tpUnit === "price" ? priceDecimals : 2))} onCommit={(v) => setLevel("takeProfit", v, tpUnit)} />
                <select style={{ ...inp, width: 70 }} value={tpUnit} onChange={(e) => setTpUnit(e.target.value as LevelUnit)}>
                  <option value="price">price</option>
                  <option value="ticks">ticks</option>
                  <option value="percent">%</option>
                </select>
              </span>
            </div>
            <div style={row}>
              <span>Stop level</span>
              <span style={{ display: "flex", gap: 4 }}>
                <Num width={110} value={Number(levelToInput(entry, draft.stop.price, slUnit, tick).toFixed(slUnit === "price" ? priceDecimals : 2))} onCommit={(v) => setLevel("stop", v, slUnit)} />
                <select style={{ ...inp, width: 70 }} value={slUnit} onChange={(e) => setSlUnit(e.target.value as LevelUnit)}>
                  <option value="price">price</option>
                  <option value="ticks">ticks</option>
                  <option value="percent">%</option>
                </select>
              </span>
            </div>
            <label style={row}>
              <span>Fixed R:R (target follows stop)</span>
              <input
                type="checkbox"
                checked={!!draft.rrLock?.enabled}
                onChange={(e) => setDraft({ ...draft, rrLock: { enabled: e.target.checked, ratio: draft.rrLock?.ratio ?? DEFAULT_RR } })}
              />
            </label>
            <div style={row}>
              <span>R:R ratio</span>
              <Num value={draft.rrLock?.ratio ?? DEFAULT_RR} step="0.1" width={110} disabled={!draft.rrLock?.enabled} onCommit={(v) => v > 0 && setDraft({ ...draft, rrLock: { enabled: true, ratio: v } })} />
            </div>
            <label style={row}>
              <span>Compact stats mode</span>
              <input type="checkbox" checked={st.compactStats} onChange={(e) => setStyle({ compactStats: e.target.checked })} />
            </label>
            <label style={row}>
              <span>Always show stats</span>
              <input type="checkbox" checked={st.alwaysShowStats} onChange={(e) => setStyle({ alwaysShowStats: e.target.checked })} />
            </label>
          </div>
        )}

        {tab === "style" && (
          <div style={{ padding: "8px 0" }}>
            {([
              ["Profit color", "profitColor"],
              ["Stop color", "stopColor"],
              ["Line color", "lineColor"],
              ["Text color", "textColor"],
            ] as [string, keyof PositionStyle][]).map(([label, key]) => (
              <div style={row} key={key}>
                <span>{label}</span>
                <input type="color" style={swatch} value={String(st[key])} onChange={(e) => setStyle({ [key]: e.target.value } as Partial<PositionStyle>)} />
              </div>
            ))}
            <div style={row}>
              <span>Profit opacity</span>
              <input type="range" min={0} max={1} step={0.05} value={st.profitOpacity} onChange={(e) => setStyle({ profitOpacity: Number(e.target.value) })} />
            </div>
            <div style={row}>
              <span>Stop opacity</span>
              <input type="range" min={0} max={1} step={0.05} value={st.stopOpacity} onChange={(e) => setStyle({ stopOpacity: Number(e.target.value) })} />
            </div>
            <div style={row}>
              <span>Line width</span>
              <select style={inp} value={st.lineWidth} onChange={(e) => setStyle({ lineWidth: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((w) => (
                  <option key={w} value={w}>{w}px</option>
                ))}
              </select>
            </div>
            <div style={row}>
              <span>Font size</span>
              <select style={inp} value={st.fontSize} onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}>
                {[9, 10, 11, 12, 14, 16].map((w) => (
                  <option key={w} value={w}>{w}px</option>
                ))}
              </select>
            </div>
            <label style={row}>
              <span>Price labels</span>
              <input type="checkbox" checked={st.showPriceLabels} onChange={(e) => setStyle({ showPriceLabels: e.target.checked })} />
            </label>
            <div style={{ ...row, justifyContent: "flex-start" }}>
              <button type="button" style={btn} onClick={() => setDraft({ ...draft, style: undefined })}>Reset to defaults</button>
              <button type="button" style={btn} onClick={() => props.onSaveStyleAsDefault?.(draft.style || {})}>Save as default</button>
            </div>
          </div>
        )}

        {tab === "coords" && (
          <div style={{ padding: "8px 0" }}>
            <div style={row}><span>Entry</span><Num width={110} value={draft.entry.price} disabled={!entryEditable} onCommit={(v) => setDraft({ ...draft, entry: { ...draft.entry, price: v } })} /></div>
            <div style={row}><span>Target</span><Num width={110} value={draft.takeProfit.price} onCommit={(v) => setDraft({ ...draft, takeProfit: { ...draft.takeProfit, price: v } })} /></div>
            <div style={row}><span>Stop</span><Num width={110} value={draft.stop.price} onCommit={(v) => setDraft({ ...draft, stop: { ...draft.stop, price: v } })} /></div>
            <div style={row}><span>Width (bars)</span>
              <Num width={110} value={widthBars} step="1" onCommit={(v) => v >= 3 && setDraft({ ...draft, rightTime: draft.entry.time + Math.round(v) * Math.max(1, barSec) })} />
            </div>
            <div style={{ ...row, color: "#8b9bb0", fontSize: 11 }}>
              <span>Entry time: {new Date(draft.entry.time * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC</span>
            </div>
          </div>
        )}

        {draftIssues && <div style={{ ...row, color: "#fca5a5" }}>⚠ {draftIssues}</div>}
        <div style={{ ...row, justifyContent: "flex-end", borderTop: "1px solid #293542", padding: "10px 14px" }}>
          <button type="button" style={btn} onClick={props.onDismiss}>Cancel</button>
          <button type="button" style={{ ...btn, background: "#2962ff", borderColor: "#2962ff", color: "#fff" }} disabled={!!draftIssues} onClick={apply}>Ok</button>
        </div>
      </div>
    </div>
  );
}

function draftHasProblems(d: PositionLike): string | null {
  const long = d.side === "long";
  const e = d.entry.price, sl = d.stop.price, tp = d.takeProfit.price;
  if (![e, sl, tp].every((x) => Number.isFinite(x))) return "Entry, Stop and Target must be numbers";
  if (long ? sl >= e : sl <= e) return long ? "Stop must be below entry" : "Stop must be above entry";
  if (long ? tp <= e : tp >= e) return long ? "Target must be above entry" : "Target must be below entry";
  return null;
}

export { hasErrors };
