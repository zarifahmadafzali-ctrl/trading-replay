import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, SyntheticEvent } from "react";
import type { DrawingShape, FibLevel, LineStyle } from "../lib/drawingModel";
import { DEFAULT_FIB_LEVELS, resolveStyle } from "../lib/drawingModel";

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

export default function DrawingSettingsBar(props: DrawingSettingsBarProps) {
  const { shape, anchor, container, onChange } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(360);
  const [h, setH] = useState(40);
  const [open, setOpen] = useState<null | "color" | "fill" | "fib" | "text">(null);
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

  // position: above the shape, below it if there is no room, clamped to the container
  const box = anchor || { x0: container.w / 2, x1: container.w / 2, y0: 60, y1: 60 };
  let left = (box.x0 + box.x1) / 2 - w / 2 + drag.dx;
  let top = box.y0 - h - 12 + drag.dy;
  if (top < 4 && !drag.dy) top = box.y1 + 14;
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
        style={{ width: 14, height: 28, cursor: "grab", color: "#787B86", display: "flex", alignItems: "center", justifyContent: "center" }}>⋮⋮</div>

      <div style={{ position: "relative" }}>
        <Btn title="Line color" active={open === "color"} onClick={() => setOpen(open === "color" ? null : "color")}>
          <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: st.color, border: "1px solid #fff4" }} />
        </Btn>
        {open === "color" && (
          <div style={POP}>
            <Swatches value={st.color} onPick={(c) => set({ color: c })} />
            {k === "measure" && <button type="button" onClick={() => set({ color: undefined })} style={{ marginTop: 8 }}>Auto (blue up / red down)</button>}
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
          {[1, 2, 3, 4].map((n) => (
            <Btn key={n} title={`Line width ${n}`} active={Math.round(st.lineWidth) === n} onClick={() => set({ lineWidth: n })}>
              <span style={{ display: "inline-block", width: 16, height: n, background: "currentColor" }} />
            </Btn>
          ))}
          {(["solid", "dashed", "dotted"] as LineStyle[]).map((ls) => (
            <Btn key={ls} title={ls} active={st.lineStyle === ls} onClick={() => set({ lineStyle: ls })}>
              {ls === "solid" ? "──" : ls === "dashed" ? "– –" : "···"}
            </Btn>
          ))}
        </>
      )}

      {(isTrend || k === "channel" || k === "fib" || k === "rectangle") && (
        <>
          <Sep />
          {k !== "rectangle" && (
            <Btn title="Extend left" active={flag("extendLeft")} onClick={() => toggle("extendLeft")}>⇤</Btn>
          )}
          <Btn title="Extend right" active={flag("extendRight")} onClick={() => toggle("extendRight")}>⇥</Btn>
        </>
      )}
      {isTrend && (
        <>
          <Btn title="Arrow at start" active={flag("arrowStart")} onClick={() => toggle("arrowStart")}>◀</Btn>
          <Btn title="Arrow at end" active={flag("arrowEnd")} onClick={() => toggle("arrowEnd")}>▶</Btn>
          <Btn title="Show price / bars" active={flag("showStats")} onClick={() => toggle("showStats")}>Δ</Btn>
          <Btn title="Show angle" active={flag("showAngle")} onClick={() => toggle("showAngle")}>∠</Btn>
          <Btn title="Midpoint" active={flag("showMidpoint")} onClick={() => toggle("showMidpoint")}>•</Btn>
        </>
      )}
      {k === "rectangle" && <Btn title="Show price range" active={flag("showStats")} onClick={() => toggle("showStats")}>Δ</Btn>}
      {k === "channel" && <Btn title="Middle line" active={flag("showMiddle")} onClick={() => toggle("showMiddle")}>═</Btn>}

      {k === "fib" && (
        <div style={{ position: "relative" }}>
          <Btn title="Fibonacci levels" active={open === "fib"} onClick={() => setOpen(open === "fib" ? null : "fib")}>Levels</Btn>
          {open === "fib" && (
            <div style={{ ...POP, maxHeight: 260, overflowY: "auto" }}>
              {levels.map((l, i) => (
                <label key={l.value} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                  <input type="checkbox" checked={l.enabled}
                    onChange={() => set({ levels: levels.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)) } as Partial<DrawingShape>)} />
                  <span style={{ width: 44 }}>{l.value}</span>
                  <input type="color" value={/^#[0-9a-f]{6}$/i.test(l.color) ? l.color : "#787B86"} aria-label={`color ${l.value}`}
                    onChange={(e) => set({ levels: levels.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) } as Partial<DrawingShape>)}
                    style={{ width: 24, height: 20, padding: 0, border: "none", background: "none" }} />
                </label>
              ))}
              <hr style={{ borderColor: "#363a45" }} />
              <label style={{ display: "block" }}><input type="checkbox" checked={flag("reverse")} onChange={() => toggle("reverse")} /> Reverse</label>
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
            <div style={POP}>
              <input type="text" value={shape.text || ""} placeholder="Label" aria-label="Label text"
                onChange={(e) => set({ text: e.target.value })}
                style={{ width: "100%", background: "#131722", color: "#d1d4dc", border: "1px solid #363a45", borderRadius: 4, padding: 6 }} />
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                <span>Size</span>
                <input type="range" min={10} max={28} value={shape.fontSize || 13} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
              </label>
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
      {props.onSaveAsDefault && <Btn title="Save style as default for this tool" onClick={props.onSaveAsDefault}>★</Btn>}
      <Btn title="Delete" danger onClick={props.onDelete}>🗑</Btn>
    </div>
  );
}
