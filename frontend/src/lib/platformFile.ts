/**
 * Platform file I/O boundary.
 *
 * Web/PWA: Blob + temporary <a download>.
 * Desktop (Tauri): native Save dialog + filesystem write.
 *
 * Does NOT change BACKUP_FORMAT_VERSION or MARKET_DATA_EXPORT_FORMAT_VERSION.
 */

import { getAppPlatform } from "./platform";

export type ExportFileArgs = {
  content: string | Blob | Uint8Array | ArrayBuffer;
  filename: string;
  mime?: string;
};

/** Result of an export/save attempt. */
export type ExportOutcome =
  | { status: "saved"; path?: string }
  | { status: "cancelled" }
  | { status: "error"; message: string }
  | { status: "empty"; message: string };

export type PlatformFileService = {
  readonly platform: "web" | "desktop";
  /** Trigger a download or native save. */
  exportFile(args: ExportFileArgs): Promise<ExportOutcome>;
  /**
   * Open a single file via picker when available.
   * Web uses <input type="file">. Returns null if cancelled.
   */
  pickTextFile(accept?: string): Promise<{ name: string; text: string } | null>;
};

export async function contentToUint8Array(
  content: string | Blob | Uint8Array | ArrayBuffer
): Promise<Uint8Array> {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof Blob !== "undefined" && content instanceof Blob) {
    return new Uint8Array(await content.arrayBuffer());
  }
  return new TextEncoder().encode(String(content));
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  if (i < 0 || i === filename.length - 1) return "";
  return filename.slice(i + 1).toLowerCase();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const webFileService: PlatformFileService = {
  platform: "web",

  async exportFile({ content, filename, mime }: ExportFileArgs): Promise<ExportOutcome> {
    try {
      const blob =
        typeof Blob !== "undefined" && content instanceof Blob
          ? content
          : new Blob([await contentToUint8Array(content)], {
              type: mime || "application/octet-stream",
            });
      downloadBlob(blob, filename);
      return { status: "saved" };
    } catch (e) {
      return {
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
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
      input.click();
    });
  },
};

const desktopFileService: PlatformFileService = {
  platform: "desktop",

  async exportFile({ content, filename, mime: _mime }: ExportFileArgs): Promise<ExportOutcome> {
    try {
      const bytes = await contentToUint8Array(content);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const ext = extensionOf(filename);
      const path = await save({
        defaultPath: filename,
        filters: ext
          ? [
              {
                name: ext.toUpperCase(),
                extensions: [ext],
              },
            ]
          : undefined,
      });
      if (path == null || path === "") {
        return { status: "cancelled" };
      }
      await writeFile(path, bytes);
      return { status: "saved", path };
    } catch (e) {
      return {
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async pickTextFile(accept = ".json,.csv,.trdata,text/plain"): Promise<{ name: string; text: string } | null> {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Text", extensions: ["json", "csv", "trdata", "txt", "md"] }],
      });
      if (selected == null || Array.isArray(selected)) return null;
      const text = await readTextFile(selected);
      const name = String(selected).split(/[/\\]/).pop() || "file";
      return { name, text };
    } catch {
      // Fall back to web picker if plugins unavailable
      return webFileService.pickTextFile(accept);
    }
  },
};

export function getPlatformFileService(): PlatformFileService {
  return getAppPlatform() === "desktop" ? desktopFileService : webFileService;
}

/** Convenience: export UTF-8 text (backup JSON, CSV, etc.). */
export async function exportTextFile(
  content: string,
  filename: string,
  mime = "application/json"
): Promise<ExportOutcome> {
  return getPlatformFileService().exportFile({ content, filename, mime });
}

/** Binary/ZIP export through the same platform boundary. */
export async function exportBinaryFile(
  content: Uint8Array | ArrayBuffer | Blob,
  filename: string,
  mime = "application/octet-stream"
): Promise<ExportOutcome> {
  return getPlatformFileService().exportFile({ content, filename, mime });
}

/** User-facing feedback helper for Journal / Analytics export buttons. */
export function notifyExportOutcome(outcome: ExportOutcome): void {
  if (outcome.status === "cancelled") return;
  if (outcome.status === "empty") {
    alert(outcome.message);
    return;
  }
  if (outcome.status === "error") {
    alert(`Export failed: ${outcome.message}`);
    return;
  }
  // saved — optional path hint on desktop
  if (outcome.path) {
    // Quiet success; path available for future toast UI
  }
}

export function emptyExportOutcome(what = "trades"): ExportOutcome {
  return {
    status: "empty",
    message: `No ${what} to export. Close positions or clear filters so the list is not empty.`,
  };
}
