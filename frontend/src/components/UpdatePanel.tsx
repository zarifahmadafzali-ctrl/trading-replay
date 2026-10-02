/**
 * v3.42.0 — Compact desktop update UI (NavBar).
 * Hidden on web/PWA. Does not block trading or offline use.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkForDesktopUpdate,
  downloadAndInstallDesktopUpdate,
  initialUpdateState,
  type UpdateState,
} from "../lib/desktopUpdater";
import { isDesktopPlatform } from "../lib/platform";
import { APP_VERSION } from "../lib/storageVersions";

export function UpdatePanel() {
  const [state, setState] = useState<UpdateState>(initialUpdateState);
  const [open, setOpen] = useState(false);
  const autoChecked = useRef(false);

  const runCheck = useCallback(async () => {
    setState((s) => ({ ...s, status: "checking", error: null }));
    const next = await checkForDesktopUpdate();
    setState(next);
    if (next.status === "available") setOpen(true);
  }, []);

  useEffect(() => {
    if (!isDesktopPlatform() || autoChecked.current) return;
    autoChecked.current = true;
    // Non-blocking background check after first paint
    const t = window.setTimeout(() => {
      void runCheck();
    }, 4000);
    return () => window.clearTimeout(t);
  }, [runCheck]);

  if (!isDesktopPlatform()) return null;

  async function onInstall() {
    setState((s) => ({ ...s, status: "downloading", progress: null, error: null }));
    const result = await downloadAndInstallDesktopUpdate((pct, phase) => {
      setState((s) => ({
        ...s,
        status: phase === "installing" ? "installing" : "downloading",
        progress: pct,
      }));
    });
    if (!result.ok) {
      setState((s) => ({
        ...s,
        status: "error",
        error: result.error || "Update failed",
        progress: null,
      }));
    }
  }

  const badge =
    state.status === "available"
      ? "Update"
      : state.status === "error"
        ? "!"
        : null;

  return (
    <div className="update-panel-wrap">
      <button
        type="button"
        className={`update-panel-btn${state.status === "available" ? " on" : ""}`}
        title="Application updates"
        onClick={() => setOpen((v) => !v)}
      >
        v{APP_VERSION}
        {badge ? <span className="update-badge">{badge}</span> : null}
      </button>
      {open && (
        <div className="update-panel-dropdown panel-top tools-panel" role="dialog">
          <div className="update-panel-head">
            <strong>Updates</strong>
            <span className="muted">Desktop</span>
          </div>
          <div className="update-panel-row">
            <span className="risk-calc-k">Current</span>
            <span className="risk-calc-v">v{state.currentVersion}</span>
          </div>
          {state.status === "checking" && <p className="muted">Checking for updates…</p>}
          {state.status === "up_to_date" && <p className="muted">You&apos;re up to date.</p>}
          {state.status === "unavailable" && (
            <p className="muted">{state.error || "Update server unavailable."}</p>
          )}
          {state.status === "available" && (
            <>
              <p>
                Update available: <strong>v{state.availableVersion}</strong>
              </p>
              <button type="button" className="on" onClick={() => void onInstall()}>
                Download &amp; Install
              </button>
            </>
          )}
          {(state.status === "downloading" || state.status === "installing") && (
            <p className="muted">
              {state.status === "installing"
                ? "Installing… the app will restart."
                : state.progress != null
                  ? `Downloading… ${state.progress}%`
                  : "Downloading…"}
            </p>
          )}
          {state.status === "error" && (
            <p className="update-error">{state.error || "Update failed"}</p>
          )}
          <div className="update-panel-actions">
            <button
              type="button"
              disabled={state.status === "checking" || state.status === "downloading" || state.status === "installing"}
              onClick={() => void runCheck()}
            >
              Check for Updates
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Updates replace the app only. Journal, Sessions, and market data are kept.
          </p>
        </div>
      )}
    </div>
  );
}
