import { useEffect } from "react";

/**
 * Standard replay hotkeys: Space toggles play/pause, ArrowRight/ArrowLeft
 * step one bar forward/back. Ignored while focus is in a text input so
 * typing a symbol or note doesn't accidentally trigger playback.
 *
 * Usage in your replay view:
 *
 *   useReplayHotkeys({
 *     onTogglePlay: () => setPlaying((p) => !p),
 *     onStepForward: () => setCursor((c) => Math.min(bars.length, c + 1)),
 *     onStepBack: () => setCursor((c) => Math.max(20, c - 1)),
 *   });
 */
export function useReplayHotkeys(opts: {
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (opts.enabled === false) return;

    function onKeyDown(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (ev.code === "Space") {
        ev.preventDefault();
        opts.onTogglePlay();
      } else if (ev.code === "ArrowRight") {
        ev.preventDefault();
        opts.onStepForward();
      } else if (ev.code === "ArrowLeft") {
        ev.preventDefault();
        opts.onStepBack();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.onTogglePlay, opts.onStepForward, opts.onStepBack, opts.enabled]);
}
