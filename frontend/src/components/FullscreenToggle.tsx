import { useCallback, useEffect, useState } from "react";

function getFullscreenElement(): Element | null {
  const d = document as Document & {
    webkitFullscreenElement?: Element | null;
    msFullscreenElement?: Element | null;
  };
  return document.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement || null;
}

function isStandaloneDisplay(): boolean {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function canRequestFullscreen(): boolean {
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => void;
    msRequestFullscreen?: () => void;
  };
  return !!(
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.msRequestFullscreen
  );
}

async function requestFs(): Promise<void> {
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
    msRequestFullscreen?: () => Promise<void> | void;
  };
  if (el.requestFullscreen) {
    await el.requestFullscreen();
    return;
  }
  if (el.webkitRequestFullscreen) {
    await Promise.resolve(el.webkitRequestFullscreen());
    return;
  }
  if (el.msRequestFullscreen) {
    await Promise.resolve(el.msRequestFullscreen());
  }
}

async function exitFs(): Promise<void> {
  const d = document as Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
    msExitFullscreen?: () => Promise<void> | void;
  };
  if (document.exitFullscreen) {
    await document.exitFullscreen();
    return;
  }
  if (d.webkitExitFullscreen) {
    await Promise.resolve(d.webkitExitFullscreen());
    return;
  }
  if (d.msExitFullscreen) {
    await Promise.resolve(d.msExitFullscreen());
  }
}

/**
 * v3.26.1 — Browser Fullscreen API toggle (not the same as PWA standalone).
 */
export function FullscreenToggle() {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setSupported(canRequestFullscreen());
    setStandalone(isStandaloneDisplay());
    setActive(!!getFullscreenElement());

    const onChange = () => {
      const fs = !!getFullscreenElement();
      setActive(fs);
      // v3.35.0 — CSS hook for scrollable fullscreen layouts
      document.documentElement.classList.toggle("tr-fullscreen", fs);
    };
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange as EventListener);
      document.documentElement.classList.remove("tr-fullscreen");
    };
  }, []);

  const onClick = useCallback(async () => {
    try {
      if (getFullscreenElement()) {
        await exitFs();
      } else if (canRequestFullscreen()) {
        await requestFs();
      }
    } catch {
      // User denial / browser policy — stay usable
      setActive(!!getFullscreenElement());
    }
  }, []);

  const label = active ? "Exit fullscreen" : "Enter fullscreen";
  const title = standalone
    ? active
      ? "Exit browser fullscreen"
      : "Enter browser fullscreen (PWA may already fill the screen)"
    : !supported
      ? "Fullscreen not supported in this browser"
      : label;

  return (
    <button
      type="button"
      className={`fs-toggle${active ? " on" : ""}${!supported ? " fs-disabled" : ""}`}
      onClick={() => void onClick()}
      title={title}
      aria-label={label}
      aria-pressed={active}
      disabled={!supported && !active}
    >
      {active ? (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      )}
    </button>
  );
}
