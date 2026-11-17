/**
 * P0 Drawing state integrity — pure merge helpers.
 * Engine may run on a stale snapshot; general drawings added after capture must not be dropped.
 */

export type ShapeLike = {
  id: string;
  kind: string;
  [key: string]: unknown;
};

/**
 * Publish engine output without deleting non-position drawings that were not in the
 * engine input snapshot (e.g. user placed a trendline while a tick/bar step ran).
 *
 * - Non-position shapes: always taken from `current` (authoritative live list).
 * - Position shapes present in engineOut: use engine version (fills, SL/TP, closes).
 * - Position shapes in current but not in inputIds: kept (created after engine started).
 * - Position shapes in inputIds but missing from engineOut: dropped (engine removed them).
 * - Engine-only ids not in current: appended (defensive).
 */
export function mergeEngineShapeResult<T extends ShapeLike>(
  current: readonly T[],
  engineOut: readonly T[],
  inputIds: ReadonlySet<string>
): T[] {
  const engineById = new Map<string, T>();
  for (const s of engineOut) engineById.set(s.id, s);

  const out: T[] = [];
  const seen = new Set<string>();

  for (const s of current) {
    if (s.kind === "position") {
      const eng = engineById.get(s.id);
      if (eng) {
        out.push(eng);
        seen.add(s.id);
      } else if (!inputIds.has(s.id)) {
        // Position appeared after the engine snapshot was taken — keep live version.
        out.push(s);
        seen.add(s.id);
      }
      // else: was in the engine input and engine dropped it — omit
    } else {
      out.push(s);
      seen.add(s.id);
    }
  }

  for (const eng of engineOut) {
    if (!seen.has(eng.id)) {
      out.push(eng);
      seen.add(eng.id);
    }
  }

  return out;
}
