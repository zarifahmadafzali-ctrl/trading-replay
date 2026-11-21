/**
 * Decide whether parent `shapes` may replace the live Chart shapesRef.
 * Pure helper so the stale-parent race can be unit-tested without React.
 */
export function shouldApplyParentShapes(opts: {
  awaitingParent: boolean;
  isGeneralDrawingDrag: boolean;
  liveIds: readonly string[];
  parentIds: readonly string[];
}): { apply: boolean; clearAwaiting: boolean } {
  if (opts.isGeneralDrawingDrag) {
    return { apply: false, clearAwaiting: false };
  }
  if (opts.awaitingParent) {
    const parentSet = new Set(opts.parentIds);
    const parentHasLive = opts.liveIds.every((id) => parentSet.has(id));
    if (parentHasLive) return { apply: true, clearAwaiting: true };
    return { apply: false, clearAwaiting: false };
  }
  return { apply: true, clearAwaiting: false };
}
