/**
 * v3.32.0 — Platform file capability boundary.
 *
 * Web: HTML download + file input (existing behavior).
 * Desktop (future): same API surface; implementation can switch to
 * Tauri dialog/fs plugins without changing backup/market-data formats.
 *
 * Does NOT change BACKUP_FORMAT_VERSION or MARKET_DATA_EXPORT_FORMAT_VERSION.
 */

import { getAppPlatform } from "./platform";

export type ExportFileArgs = {
  content: string | Blob;
  filename: string;
  mime?: string;
};

export type PlatformFileService = {
  readonly platform: "web" | "desktop";
  /** Trigger a download or native save. */
  exportFile(args: ExportFileArgs): Promise<void>;
  /**
   * Open a single file via picker when available.
   * Web uses <input type="file">. Returns null if cancelled.
   */
  pickTextFile(accept?: string): Promise<{ name: string; text: string } | null>;
};

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const webFileService: PlatformFileService = {
  platform: "web",

  async exportFile({ content, filename, mime }: ExportFileArgs): Promise<void> {
    const blob =
      content instanceof Blob
        ? content
        : new Blob([content], { type: mime || "application/octet-stream" });
    downloadBlob(blob, filename);
  },

  async pickTextFile(accept = ".json,.csv,.trdata,text/plain"): Promise<{ name: string; text: string } | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const text = await file.text();
          resolve({ name: file.name, text });
        } catch {
          resolve(null);
        }
      };
      // Cancel is not reliably detectable across browsers; resolve null on no selection via blur is fragile.
      input.click();
    });
  },
};

/**
 * Desktop stub: identical to web until Tauri fs/dialog plugins are wired.
 * Keeps API stable; callers must not assume native dialogs exist yet.
 */
const desktopFileService: PlatformFileService = {
  ...webFileService,
  platform: "desktop",
};

export function getPlatformFileService(): PlatformFileService {
  return getAppPlatform() === "desktop" ? desktopFileService : webFileService;
}

/** Convenience: export UTF-8 text (backup JSON, CSV, etc.). */
export async function exportTextFile(
  content: string,
  filename: string,
  mime = "application/json"
): Promise<void> {
  await getPlatformFileService().exportFile({ content, filename, mime });
}
