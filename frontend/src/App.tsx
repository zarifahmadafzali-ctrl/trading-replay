import { useEffect, useState } from "react";
import { NavBar } from "./components/NavBar";
import { ReplayView } from "./views/ReplayView";
import { WatchlistView } from "./views/WatchlistView";
import { SessionView } from "./views/SessionView";
import { DataEngineView } from "./views/DataEngineView";
import { JournalView } from "./views/JournalView";
import { checkHealth } from "./lib/api";
import type { ViewName } from "./lib/types";

export function App() {
  const [view, setView] = useState<ViewName>("replay");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkHealth().then((ok) => {
      if (!cancelled) setBackendOnline(ok);
    });
    const interval = setInterval(() => {
      checkHealth().then((ok) => {
        if (!cancelled) setBackendOnline(ok);
      });
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="app">
      <NavBar active={view} onChange={setView} backendOnline={backendOnline} />
      <main>
        {view === "replay" && <ReplayView backendOnline={backendOnline} />}
        {view === "watchlist" && <WatchlistView backendOnline={backendOnline} />}
        {view === "session" && <SessionView backendOnline={backendOnline} />}
        {view === "journal" && <JournalView backendOnline={backendOnline} />}
        {view === "dataEngine" && <DataEngineView backendOnline={backendOnline} />}
      </main>
      <footer>Paper Trading Only · PWA · Data Engine v3.2</footer>
    </div>
  );
}
