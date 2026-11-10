/**
 * Pure helpers for Replay load path: device cache before remote API.
 * Desktop builds often see backendOnline=true while private imports exist only in IndexedDB.
 */

export type CacheFirstDecision = {
  /** Apply local bars to the chart immediately */
  paintLocal: boolean;
  /** Attempt network fill for missing days */
  fetchRemote: boolean;
  /** Stop after local paint (full hit or offline) */
  doneAfterLocal: boolean;
};

export function decideCacheFirstLoad(opts: {
  localBarCount: number;
  missingDayCount: number;
  backendOnline: boolean | null;
}): CacheFirstDecision {
  const hasLocal = opts.localBarCount > 0;
  const missing = opts.missingDayCount > 0;
  const online = opts.backendOnline === true;

  if (hasLocal && !missing) {
    return { paintLocal: true, fetchRemote: false, doneAfterLocal: true };
  }
  if (hasLocal && missing && !online) {
    return { paintLocal: true, fetchRemote: false, doneAfterLocal: true };
  }
  if (hasLocal && missing && online) {
    return { paintLocal: true, fetchRemote: true, doneAfterLocal: false };
  }
  if (!hasLocal && !online) {
    return { paintLocal: false, fetchRemote: false, doneAfterLocal: true };
  }
  // No local, online → try remote
  return { paintLocal: false, fetchRemote: true, doneAfterLocal: false };
}

/** After a network error, keep chart if we already painted local bars. */
export function messageAfterNetworkFailure(localBarsApplied: number, errMsg: string): string {
  if (localBarsApplied > 0) {
    return `Network failed · showing ${localBarsApplied.toLocaleString()} local bars`;
  }
  return errMsg || "Load failed";
}
