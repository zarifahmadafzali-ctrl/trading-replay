/**
 * Minimal ZIP reader for delivery packages (supports stored + deflate).
 * Used for TR Market Data range ZIPs (typically ZIP_STORED).
 */

export type ZipEntry = { name: string; data: Uint8Array };

function u16(v: DataView, o: number) {
  return v.getUint16(o, true);
}
function u32(v: DataView, o: number) {
  return v.getUint32(o, true);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Deflate ZIP entries need DecompressionStream (modern browser/desktop webview)");
  }
  // raw deflate — ZIP uses method 8 without zlib header in some cases; try deflate-raw
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Parse a ZIP ArrayBuffer into entries (local file headers).
 * Skips directories. Throws on unsupported compression.
 */
export async function readZipEntries(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const out: ZipEntry[] = [];
  let o = 0;
  while (o + 30 <= bytes.length) {
    const sig = u32(view, o);
    if (sig === 0x02014b50 || sig === 0x06054b50) break; // central dir / EOCD
    if (sig !== 0x04034b50) break;
    const method = u16(view, o + 8);
    const compSize = u32(view, o + 18);
    const nameLen = u16(view, o + 26);
    const extraLen = u16(view, o + 28);
    const nameStart = o + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) throw new Error(`ZIP truncated at entry ${name}`);
    const payload = bytes.subarray(dataStart, dataEnd);
    if (!name.endsWith("/")) {
      let data: Uint8Array;
      if (method === 0) {
        data = payload.slice();
      } else if (method === 8) {
        data = await inflateRaw(payload);
      } else {
        throw new Error(`Unsupported ZIP compression ${method} for ${name}`);
      }
      out.push({ name: name.replace(/\\/g, "/"), data });
    }
    o = dataEnd;
  }
  return out;
}

export function groupZipByDay(entries: ZipEntry[]): {
  packageJson: Uint8Array | null;
  /** day key YYYY-MM-DD → file basename → bytes */
  days: Map<string, Map<string, Uint8Array>>;
  symbolHint: string | null;
} {
  let packageJson: Uint8Array | null = null;
  const days = new Map<string, Map<string, Uint8Array>>();
  let symbolHint: string | null = null;

  for (const e of entries) {
    const n = e.name.replace(/^\/+/, "");
    if (n === "package.json" || n.endsWith("/package.json")) {
      packageJson = e.data;
      continue;
    }
    // SYMBOL/YYYY-MM-DD/file  OR provider=…/symbol=…/year=…/month=…/day=…/file
    const parts = n.split("/").filter(Boolean);
    let day: string | null = null;
    let base: string | null = null;
    let sym: string | null = null;

    if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 2]!)) {
      day = parts[parts.length - 2]!;
      base = parts[parts.length - 1]!;
      sym = parts[parts.length - 3] || null;
    } else {
      // hive layout day=DD
      const dayPart = parts.find((p) => p.startsWith("day="));
      if (dayPart && parts.length >= 2) {
        const dd = dayPart.slice(4);
        const year = parts.find((p) => p.startsWith("year="))?.slice(5);
        const month = parts.find((p) => p.startsWith("month="))?.slice(6);
        if (year && month && dd) {
          day = `${year}-${month.padStart(2, "0")}-${dd.padStart(2, "0")}`;
          base = parts[parts.length - 1]!;
          const sp = parts.find((p) => p.startsWith("symbol="));
          if (sp) sym = sp.slice(7);
        }
      }
    }

    if (!day || !base) continue;
    if (!days.has(day)) days.set(day, new Map());
    days.get(day)!.set(base.toLowerCase(), e.data);
    if (sym && !symbolHint) symbolHint = sym;
  }

  return { packageJson, days, symbolHint };
}
