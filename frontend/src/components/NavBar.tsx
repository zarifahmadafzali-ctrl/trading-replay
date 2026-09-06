import type { ViewName } from "../lib/types";

const TABS: { id: ViewName; label: string }[] = [
  { id: "replay", label: "Replay" },
  { id: "watchlist", label: "Watchlist" },
  { id: "session", label: "Session" },
  { id: "dataEngine", label: "Data Engine" },
];

export function NavBar({
  active,
  onChange,
  backendOnline,
}: {
  active: ViewName;
  onChange: (v: ViewName) => void;
  backendOnline: boolean | null;
}) {
  return (
    <header className="topbar">
      <b>
        TRADING <i>REPLAY</i>
      </b>
      <nav>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={active === t.id ? "on" : ""}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <span
        className={`status ${backendOnline ? "status-on" : "status-off"}`}
        title={
          backendOnline
            ? "Connected to Data Engine backend"
            : "Backend unreachable — using local/demo data"
        }
      >
        ● {backendOnline === null ? "Checking…" : backendOnline ? "Backend online" : "Offline mode"}
      </span>
    </header>
  );
}
