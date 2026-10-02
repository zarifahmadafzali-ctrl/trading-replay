/**
 * v3.42.0 — Native Windows auto-update (Tauri 2 plugin-updater).
 *
 * Only active on desktop (isTauri). Web/PWA ignores this module.
 * Never blocks startup; never requires network for trading features.
 * Updater replaces application binaries only — SQLite / IndexedDB data stay intact.
 */

import { APP_VERSION } from "./storageVersions";
import { isDesktopPlatform } from "./platform";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "installing"
  | "error"
  | "unavailable";

export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  error: string | null;
};

export function initialUpdateState(): UpdateState {
  return {
    status: "idle",
    currentVersion: APP_VERSION,
    availableVersion: null,
    progress: null,
    error: null,
  };
}

type UpdaterUpdate = {
  version: string;
  downloadAndInstall: (
    onEvent?: (event: {
      event: string;
      data?: { contentLength?: number; chunkLength?: number };
    }) => void
  ) => Promise<void>;
};

type CheckFn = () => Promise<UpdaterUpdate | null>;

async function loadCheck(): Promise<CheckFn | null> {
  if (!isDesktopPlatform()) return null;
  try {
    // Dynamic import so the web/PWA bundle does not hard-depend on Tauri plugins.
    const mod = await import("@tauri-apps/plugin-updater");
    return mod.check as CheckFn;
  } catch {
    return null;
  }
}

async function relaunchApp(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-process");
    await mod.relaunch();
  } catch {
    // If relaunch fails, installer still applied; user can restart manually.
  }
}

/**
 * Background / manual check. Returns next state; does not throw.
 */
export async function checkForDesktopUpdate(): Promise<UpdateState> {
  const base = initialUpdateState();
  if (!isDesktopPlatform()) {
    return { ...base, status: "unavailable", error: "Updates are only available in the Windows desktop app." };
  }
  const check = await loadCheck();
  if (!check) {
    return {
      ...base,
      status: "unavailable",
      error: "Updater plugin not available in this build.",
    };
  }
  try {
    const update = await check();
    if (!update) {
      return { ...base, status: "up_to_date" };
    }
    return {
      ...base,
      status: "available",
      availableVersion: update.version || null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Offline / DNS / 404 → non-fatal
    const offline =
      /network|fetch|offline|failed to fetch|dns|ENOTFOUND|timeout/i.test(msg);
    return {
      ...base,
      status: offline ? "unavailable" : "error",
      error: offline ? "Could not reach update server (offline or unavailable)." : msg,
    };
  }
}

/**
 * Download + install the pending update, then relaunch.
 * Calls onProgress with 0–100 when content length is known.
 */
export async function downloadAndInstallDesktopUpdate(
  onProgress?: (pct: number | null, phase: "downloading" | "installing") => void
): Promise<{ ok: boolean; error?: string }> {
  if (!isDesktopPlatform()) {
    return { ok: false, error: "Not a desktop build." };
  }
  const check = await loadCheck();
  if (!check) return { ok: false, error: "Updater plugin not available." };
  try {
    const update = await check();
    if (!update) return { ok: false, error: "No update available." };

    let total = 0;
    let received = 0;
    onProgress?.(null, "downloading");
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data?.contentLength ?? 0;
        received = 0;
        onProgress?.(total > 0 ? 0 : null, "downloading");
      } else if (event.event === "Progress") {
        received += event.data?.chunkLength ?? 0;
        if (total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)), "downloading");
        else onProgress?.(null, "downloading");
      } else if (event.event === "Finished") {
        onProgress?.(100, "installing");
      }
    });
    onProgress?.(100, "installing");
    await relaunchApp();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
