import { useEffect } from "react";

/**
 * Replay hotkeys (v3.25.0):
 *   Space  — play/pause
 *   ← / →  — step back / forward
 *   F      — toggle follow price
 *   Escape — cancel draft / clear selection (optional)
 * Ignored while focus is in INPUT / TEXTAREA / contentEditable.
 */
export function useReplayHotkeys(opts: {
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onToggleFollow?: () => void;
  onEscape?: () => void;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (opts.enabled === false) return;

    function onKeyDown(ev: KeyboardEvent) {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
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
      } else if (ev.code === "KeyF" && opts.onToggleFollow) {
        ev.preventDefault();
        opts.onToggleFollow();
      } else if (ev.code === "Escape" && opts.onEscape) {
        ev.preventDefault();
        opts.onEscape();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    opts.onTogglePlay,
    opts.onStepForward,
    opts.onStepBack,
    opts.onToggleFollow,
    opts.onEscape,
    opts.enabled,
  ]);
}
