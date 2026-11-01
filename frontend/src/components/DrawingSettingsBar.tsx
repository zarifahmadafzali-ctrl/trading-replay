import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, SyntheticEvent } from "react";
import type { DrawingShape, FibLevel, LineStyle, TextAlign, DrawingTemplate } from "../lib/drawingModel";
import {
  DEFAULT_FIB_LEVELS,
  resolveStyle,
  listTemplates,
  saveNamedTemplate,
  deleteNamedTemplate,
} from "../lib/drawingModel";

/**
 * TradingView-style floating settings bar for the SELECTED drawing.
 * Rendered inside Chart's container (position:absolute). It only emits patches via onChange;
 * Chart owns the state (setShapes) and persistence.
 */

const PALETTE = [
  "#FFFFFF", "#B2B5BE", "#787B86", "#363A45", "#F23645", "#FF9800",
  "#FFEB3B", "#4CAF50", "#089981", "#00BCD4", "#2962FF", "#9C27B0",
  "#E91E63", "#FF5252", "#FFB74D", "#81C784", "#4DD0E1", "#7E57C2",
];

export type DrawingSettingsBarProps = {
  shape: DrawingShape | null;
  /** px box of the selected shape, relative to the chart container */
  anchor?: { x0: number; y0: number; x1: number; y1: number } | null;
  container: { w: number; h: number };
  onChange: (patch: Partial<DrawingShape>) => void;
  onClone: () => void;
  onDelete: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onSaveAsDefault?: () => void;
};

const BAR: CSSProperties = {
  position: "absolute", zIndex: 40, display: "flex", alignItems: "center", gap: 2, padding: "4px 6px",
  background: "#1e222d", border: "1px solid #363a45", borderRadius: 8, boxShadow: "0 4px 18px rgba(0,0,0,.5)",
  color: "#d1d4dc", fontSize: 12, userSelect: "none", touchAction: "none", maxWidth: "calc(100% - 8px)", flexWrap: "wrap",
};
const POP: CSSProperties = {
  position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41, background: "#1e222d",
  border: "1px solid #363a45", borderRadius: 8, padding: 8, boxShadow: "0 6px 20px rgba(0,0,0,.55)", minWidth: 200,
};

function Btn(p: { title: string; active?: boolean; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button" title={p.title} aria-label={p.title} aria-pressed={p.active}
      onClick={p.onClick}
      style={{
        minWidth: 32, height: 32, padding: "0 6px", borderRadius: 6, border: "1px solid transparent", cursor: "pointer",
        background: p.active ? "#2a2e39" : "transparent", color: p.danger ? "#F23645" : "#d1d4dc",
        outline: p.active ? "1px solid #2962FF" : "none",
      }}
    >{p.children}</button>
  );
}
const Sep = () => <span style={{ width: 1, height: 20, background: "#363a45", margin: "0 4px" }} />;

function Swatches(p: { value?: string; onPick: (c: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 24px)", gap: 4 }}>
      {PALETTE.map((c) => (
        <button key={c} type="button" title={c} aria-label={c} onClick={() => p.onPick(c)}
          style={{ width: 24, height: 24, borderRadius: 4, background: c, cursor: "pointer",
            border: p.value?.toLowerCase() === c.toLowerCase() ? "2px solid #fff" : "1px solid #363a45" }} />
      ))}
      <input type="color" aria-label="custom color" value={/^#[0-9a-f]{6}$/i.test(p.value || "") ? (p.value as string) : "#2962FF"}
        onChange={(e) => p.onPick(e.target.value)} style={{ width: 24, height: 24, padding: 0, border: "none", background: "none" }} />
    </div>
  );
}

function Opacity(p: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
      <span style={{ width: 52 }}>{p.label}</span>
      <input type="range" min={0} max={100} value={Math.round(p.value * 100)} onChange={(e) => p.onChange(Number(e.target.value) / 100)} />
      <span style={{ width: 32, textAlign: "right" }}>{Math.round(p.value * 100)}%</span>
    </label>
  );
}

export function DrawingSettingsBar(props: DrawingSettingsBarProps) {
  const { shape, anchor, container, onChange } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(360);
  const [h, setH] = useState(40);
  const [open, setOpen] = useState<null | "color" | "fill" | "fib" | "text" | "width" | "style" | "more" | "template">(null);
  const [tplName, setTplName] = useState("");
  const [, setTplTick] = useState(0);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const lastId = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (ref.current) { setW(ref.current.offsetWidth); setH(ref.current.offsetHeight); }
  });
  if (shape && lastId.current !== shape.id) {
    lastId.current = shape.id;
    if (drag.dx || drag.dy) setDrag({ dx: 0, dy: 0 });
    if (open) setOpen(null);
  }
  if (!shape) return null;

  const k = shape.kind;
  const st = resolveStyle(shape);
  const hasFill = k === "rectangle" || k === "measure" || k === "fib" || k === "channel" || k === "text";
  const hasLine = k !== "text";
  const isTrend = k === "trendline" || k === "ray" || k === "extended";
  const set = (patch: Partial<DrawingShape>) => onChange(patch);
  const s = shape as unknown as Record<string, unknown>;
  const flag = (key: string, def = false) => (s[key] === undefined ? def : !!s[key]);
  const toggle = (key: string, def = false) => set({ [key]: !flag(key, def) } as Partial<DrawingShape>);
  const levels: FibLevel[] = (k === "fib" && (shape as { levels?: FibLevel[] }).levels?.length)
    ? (shape as { levels: FibLevel[] }).levels : DEFAULT_FIB_LEVELS;

  // Fixed floating strip near top-center (user can drag). Not glued to the shape.
  void anchor;
  let left = container.w / 2 - w / 2 + drag.dx;
  let top = 10 + drag.dy;
  left = Math.max(4, Math.min(left, Math.max(4, container.w - w - 4)));
  top = Math.max(4, Math.min(top, Math.max(4, container.h - h - 4)));

  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, dx: drag.dx, dy: drag.dy };
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) setDrag({ dx: d.dx + e.clientX - d.x, dy: d.dy + e.clientY - d.y });
  };
  const onGripUp = () => { dragRef.current = null; };

  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div ref={ref} style={{ ...BAR, left, top }} onPointerDown={stop} onPointerUp={stop} onMouseDown={stop} onTouchStart={stop}
      role="toolbar" aria-label="Drawing settings">
      <div title="Drag" aria-label="Drag toolbar" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp}
        style={{ width: 22, height: 32, cursor: "grab", color: "#B2B5BE", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4, background: "#2a2e39" }}>⠿</div>

      <div style={{ position: "relative" }}>
        <Btn title="Line color" active={open === "color"} onClick={() => setOpen(open === "color" ? null : "color")}>
          <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: st.color, border: "1px solid #fff4" }} />
        </Btn>
        {open === "color" && (
          <div style={POP}>
            <Swatches value={st.color} onPick={(c) => set({ color: c })} />
            <Opacity
              label="Opacity"
              value={typeof shape.strokeOpacity === "number" ? shape.strokeOpacity : 1}
              onChange={(v) => set({ strokeOpacity: v })}
            />
            {k === "measure" && <button type="button" onClick={() => set({ color: undefined, strokeOpacity: undefined })} style={{ marginTop: 8 }}>Auto (blue up / red down)</button>}
          </div>
        )}
      </div>

      {hasFill && (
        <div style={{ position: "relative" }}>
          <Btn title="Fill color / opacity" active={open === "fill"} onClick={() => setOpen(open === "fill" ? null : "fill")}>
            <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: st.fillColor, opacity: Math.max(0.25, st.fillOpacity) }} />
          </Btn>
          {open === "fill" && (
            <div style={POP}>
              <Swatches value={st.fillColor} onPick={(c) => set({ fillColor: c })} />
              <Opacity label="Opacity" value={st.fillOpacity} onChange={(v) => set({ fillOpacity: v })} />
            </div>
          )}
        </div>
      )}

      {hasLine && (
        <>
          <Sep />
          <div style={{ position: "relative" }}>
            <Btn title={`Line width ${Math.round(st.lineWidth)}`} active={open === "width"} onClick={() => setOpen(open === "width" ? null : "width")}>
              <span style={{ display: "inline-block", width: 18, height: Math.max(1, Math.round(st.lineWidth)), background: "currentColor", borderRadius: 1 }} />
            </Btn>
            {open === "width" && (
              <div style={POP}>
                {[1, 2, 3, 4].map((n) => (
                  <button key={n} type="button" onClick={() => { set({ lineWidth: n }); setOpen(null); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px", background: Math.round(st.lineWidth) === n ? "#2a2e39" : "transparent", border: "none", color: "#d1d4dc", cursor: "pointer", borderRadius: 4 }}>
                    <span style={{ width: 24, height: n, background: "currentColor" }} /> {n}px
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ position: "relative" }}>
            <Btn title={`Line style: ${st.lineStyle}`} active={open === "style"} onClick={() => setOpen(open === "style" ? null : "style")}>
              {st.lineStyle === "solid" ? "━━" : st.lineStyle === "dashed" ? "╍╍" : "···"}
            </Btn>
            {open === "style" && (
              <div style={POP}>
                {([
                  ["solid", "━━ Solid"],
                  ["dashed", "╍╍ Dashed"],
                  ["dotted", "··· Dotted"],
                ] as [LineStyle, string][]).map(([ls, label]) => (
                  <button key={ls} type="button" onClick={() => { set({ lineStyle: ls }); setOpen(null); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px", background: st.lineStyle === ls ? "#2a2e39" : "transparent", border: "none", color: "#d1d4dc", cursor: "pointer", borderRadius: 4 }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {(isTrend || k === "channel" || k === "fib" || k === "rectangle") && (
        <div style={{ position: "relative" }}>
          <Btn title="More options" active={open === "more"} onClick={() => setOpen(open === "more" ? null : "more")}>⋯</Btn>
          {open === "more" && (
            <div style={{ ...POP, minWidth: 180 }}>
              {k !== "rectangle" && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={flag("extendLeft")} onChange={() => toggle("extendLeft")} /> Extend left
                </label>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                <input type="checkbox" checked={flag("extendRight")} onChange={() => toggle("extendRight")} /> Extend right
              </label>
              {isTrend && (
                <>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={flag("arrowStart")} onChange={() => toggle("arrowStart")} /> Arrow start
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={flag("arrowEnd")} onChange={() => toggle("arrowEnd")} /> Arrow end
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={flag("showStats")} onChange={() => toggle("showStats")} /> Price / bars
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={flag("showAngle")} onChange={() => toggle("showAngle")} /> Angle
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                    <input type="checkbox" checked={flag("showMidpoint")} onChange={() => toggle("showMidpoint")} /> Midpoint
                  </label>
                </>
              )}
              {k === "rectangle" && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={flag("showStats")} onChange={() => toggle("showStats")} /> Show range
                </label>
              )}
              {k === "channel" && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={flag("showMiddle")} onChange={() => toggle("showMiddle")} /> Middle line
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {k === "fib" && (
        <div style={{ position: "relative" }}>
          <Btn title="Fibonacci levels" active={open === "fib"} onClick={() => setOpen(open === "fib" ? null : "fib")}>Fib</Btn>
          {open === "fib" && (
            <div style={{ ...POP, maxHeight: 260, overflowY: "auto" }}>
              {levels.map((lv, i) => (
                <label key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                  <input type="checkbox" checked={lv.enabled !== false} onChange={() => {
                    const next = levels.map((x, j) => j === i ? { ...x, enabled: x.enabled === false } : x);
                    set({ levels: next } as Partial<DrawingShape>);
                  }} />
                  <span style={{ width: 10, height: 10, background: lv.color, borderRadius: 2 }} />
                  {lv.value}
                </label>
              ))}
              <label style={{ display: "block", marginTop: 6 }}><input type="checkbox" checked={flag("reverse")} onChange={() => toggle("reverse")} /> Reverse</label>
              <label style={{ display: "block" }}><input type="checkbox" checked={flag("showPercents", true)} onChange={() => toggle("showPercents", true)} /> Show levels</label>
              <label style={{ display: "block" }}><input type="checkbox" checked={flag("showPrices", true)} onChange={() => toggle("showPrices", true)} /> Show prices</label>
              <label style={{ display: "block" }}><input type="checkbox" checked={flag("trendLine", true)} onChange={() => toggle("trendLine", true)} /> Trend line</label>
            </div>
          )}
        </div>
      )}

      {(isTrend || k === "rectangle" || k === "text") && (
        <div style={{ position: "relative" }}>
          <Btn title="Text" active={open === "text" || !!shape.text} onClick={() => setOpen(open === "text" ? null : "text")}>T</Btn>
          {open === "text" && (
            <div style={{ ...POP, minWidth: 220 }}>
              <input type="text" value={shape.text || ""} placeholder="Label" aria-label="Label text"
                onChange={(e) => set({ text: e.target.value })}
                style={{ width: "100%", background: "#131722", color: "#d1d4dc", border: "1px solid #363a45", borderRadius: 4, padding: 6 }} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                <span>Size</span>
                <input type="range" min={10} max={28} value={shape.fontSize || 13} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
              </label>
              <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                {([
                  ["top-left", "↖"], ["top", "↑"], ["top-right", "↗"],
                  ["left", "←"], ["center", "·"], ["right", "→"],
                  ["bottom-left", "↙"], ["bottom", "↓"], ["bottom-right", "↘"],
                ] as [TextAlign, string][]).map(([al, ic]) => (
                  <button key={al} type="button" title={al} onClick={() => set({ textAlign: al })}
                    style={{ padding: 6, borderRadius: 4, border: "1px solid #363a45", cursor: "pointer",
                      background: (shape.textAlign || "center") === al ? "#2962FF" : "#131722", color: "#d1d4dc" }}>{ic}</button>
                ))}
              </div>
              <div style={{ marginTop: 8 }}><Swatches value={shape.textColor} onPick={(c) => set({ textColor: c })} /></div>
            </div>
          )}
        </div>
      )}

      <Sep />
      <Btn title={shape.locked ? "Unlock" : "Lock"} active={!!shape.locked} onClick={() => set({ locked: !shape.locked })}>{shape.locked ? "🔒" : "🔓"}</Btn>
      <Btn title={shape.visible === false ? "Show" : "Hide"} active={shape.visible === false} onClick={() => set({ visible: shape.visible === false })}>👁</Btn>
      <Btn title="Clone" onClick={props.onClone}>⧉</Btn>
      {props.onBringToFront && <Btn title="Bring to front" onClick={props.onBringToFront}>⤒</Btn>}
      {props.onSendToBack && <Btn title="Send to back" onClick={props.onSendToBack}>⤓</Btn>}
      <div style={{ position: "relative" }}>
        <Btn title="Templates / save appearance" active={open === "template"} onClick={() => setOpen(open === "template" ? null : "template")}>★</Btn>
        {open === "template" && (
          <div style={{ ...POP, minWidth: 220, right: 0, left: "auto" }}>
            <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>Appearance only (not size/position)</div>
            {props.onSaveAsDefault && (
              <button type="button" onClick={() => { props.onSaveAsDefault?.(); setOpen(null); }}
                style={{ width: "100%", textAlign: "left", padding: "6px 8px", marginBottom: 4, background: "#2a2e39", border: "1px solid #363a45", borderRadius: 4, color: "#d1d4dc", cursor: "pointer" }}>
                Save as default for new {k}
              </button>
            )}
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Template name"
                style={{ flex: 1, background: "#131722", color: "#d1d4dc", border: "1px solid #363a45", borderRadius: 4, padding: 6 }} />
              <button type="button" onClick={() => {
                if (!tplName.trim()) return;
                saveNamedTemplate(k, tplName.trim(), shape);
                setTplName("");
                setTplTick((n) => n + 1);
              }} style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #2962FF", background: "#2962FF", color: "#fff", cursor: "pointer" }}>Save</button>
            </div>
            {listTemplates(k).map((tpl: DrawingTemplate) => (
              <div key={tpl.id} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                <button type="button" onClick={() => {
                  onChange(tpl.style as Partial<DrawingShape>);
                  setOpen(null);
                }} style={{ flex: 1, textAlign: "left", padding: "6px 8px", background: "#131722", border: "1px solid #363a45", borderRadius: 4, color: "#d1d4dc", cursor: "pointer" }}>
                  {tpl.name}
                </button>
                <button type="button" title="Delete template" onClick={() => { deleteNamedTemplate(tpl.id); setTplTick((n) => n + 1); }}
                  style={{ padding: "4px 8px", background: "transparent", border: "1px solid #363a45", borderRadius: 4, color: "#F23645", cursor: "pointer" }}>×</button>
              </div>
            ))}
            {listTemplates(k).length === 0 && <div style={{ opacity: 0.6, fontSize: 11 }}>No saved templates yet</div>}
          </div>
        )}
      </div>
      <Btn title="Delete" danger onClick={props.onDelete}>🗑</Btn>
    </div>
  );
}

export default DrawingSettingsBar;
