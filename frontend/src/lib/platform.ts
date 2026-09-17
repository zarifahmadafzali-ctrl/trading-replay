/**
 * v3.32.0 — Central platform detection.
 *
 * Trading / Journal / Analytics / Replay code must NOT branch on
 * window.__TAURI__ or navigator directly. Use this module instead.
 *
 * Runtime targets:
 *   "web"     — browser / PWA (authoritative production path today)
 *   "desktop" — future Tauri Windows shell (same React app)
 */

export type AppPlatform = "web" | "desktop";

export type PlatformInfo = {
  platform: AppPlatform;
  /** True when running under a Tauri webview */
  isTauri: boolean;
  /** True in a normal browser document */
  isBrowser: boolean;
  /** navigator.userAgent when available */
  userAgent: string;
};

function detectIsTauri(): boolean {
  try {
    // Tauri 1.x / 2.x inject globals; do not import @tauri-apps/* here.
    const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
    if (!w) return false;
    if (w.__TAURI_INTERNALS__ != null) return true;
    if (w.__TAURI__ != null) return true;
    return false;
  } catch {
    return false;
  }
}

/** Single source of truth for host environment. Safe to call from React. */
export function getPlatformInfo(): PlatformInfo {
  const isTauri = detectIsTauri();
  const isBrowser =
    typeof window !== "undefined" && typeof document !== "undefined" && !isTauri;
  const userAgent =
    typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "";
  return {
    platform: isTauri ? "desktop" : "web",
    isTauri,
    isBrowser: isBrowser || (!isTauri && typeof window !== "undefined"),
    userAgent,
  };
}

export function getAppPlatform(): AppPlatform {
  return getPlatformInfo().platform;
}

export function isWebPlatform(): boolean {
  return getAppPlatform() === "web";
}

export function isDesktopPlatform(): boolean {
  return getAppPlatform() === "desktop";
}
