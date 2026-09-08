import React from "react";
import type { DrawTool } from "./Chart";
import "./Toolbar.css";

type ToolbarProps = {
  tool: DrawTool;
  onToolChange: (tool: DrawTool) => void;
  className?: string;
};

function Icon({ name }: { name: string }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "crosshair": return <svg {...common}><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="3"/></svg>;
    case "trendline": return <svg {...common}><path d="M4 18 20 6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="6" r="1.5"/></svg>;
    case "hline": return <svg {...common}><path d="M3 12h18"/><path d="M7 8v8"/></svg>;
    case "vline": return <svg {...common}><path d="M12 3v18"/><path d="M8 7h8"/></svg>;
    case "rectangle": return <svg {...common}><rect x="4" y="5" width="16" height="14" rx="1"/></svg>;
    case "fib": return <svg {...common}><path d="M4 5h16M4 9h16M4 13h16M4 17h16"/><path d="m5 19 14-14"/></svg>;
    case "measure": return <svg {...common}><path d="M5 19 19 5"/><path d="M6 15v4h4M14 5h4v4"/></svg>;
    case "long": return <svg {...common}><path d="M12 20V4"/><path d="m6 10 6-6 6 6"/><path d="M5 20h14"/></svg>;
    case "short": return <svg {...common}><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/><path d="M5 4h14"/></svg>;
    default: return null;
  }
}

const items: Array<{ tool: DrawTool; label: string; icon: string }> = [
  { tool: "crosshair", label: "Crosshair", icon: "crosshair" },
  { tool: "trendline", label: "Trend line", icon: "trendline" },
  { tool: "hline", label: "Horizontal line", icon: "hline" },
  { tool: "vline", label: "Vertical line", icon: "vline" },
  { tool: "rectangle", label: "Rectangle", icon: "rectangle" },
  { tool: "fib", label: "Fibonacci retracement", icon: "fib" },
  { tool: "measure", label: "Measure", icon: "measure" },
  { tool: "long", label: "Long position", icon: "long" },
  { tool: "short", label: "Short position", icon: "short" },
];

export function Toolbar({ tool, onToolChange, className = "" }: ToolbarProps) {
  return (
    <div
      className={`tv-toolbar ${className}`}
      role="toolbar"
      aria-label="Chart drawing tools"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.tool}
          type="button"
          title={item.label}
          aria-label={item.label}
          aria-pressed={tool === item.tool}
          className={`tv-tool ${tool === item.tool ? "active" : ""}`}
          onClick={() => onToolChange(item.tool)}
        >
          <Icon name={item.icon} />
        </button>
      ))}
    </div>
  );
}

export default Toolbar;
