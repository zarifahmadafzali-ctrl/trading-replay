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

/** CRC32 for ZIP local/central headers. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive using stored (method 0) entries only.
 * Suitable for journal backups with embedded image bytes.
 */
export function writeZipStored(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = f.name.replace(/^\/+/, "").replace(/\\/g, "/");
    if (name.includes("..") || name.startsWith("/")) {
      throw new Error(`Unsafe ZIP path: ${f.name}`);
    }
    const nameBytes = enc.encode(name);
    const data = f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    centrals.push(cen);
    offset += local.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of centrals) centralSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const l of locals) {
    out.set(l, o);
    o += l.length;
  }
  for (const c of centrals) {
    out.set(c, o);
    o += c.length;
  }
  out.set(end, o);
  return out;
}
