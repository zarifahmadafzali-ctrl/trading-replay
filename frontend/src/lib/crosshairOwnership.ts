/**
 * Pure rules for which input stream may write crosshairRef / preview anchors.
 * Chart.tsx must keep writers exclusive per mode to avoid jump/lag.
 */
export type CrosshairMode = "lwc-hover" | "pointer-draw";

export function crosshairMode(opts: {
  dragActive: boolean;
  placementSteps: number;
}): CrosshairMode {
  if (opts.dragActive || opts.placementSteps >= 1) return "pointer-draw";
  return "lwc-hover";
}

/** LWC onMove may update crosshairRef only in lwc-hover mode. */
export function lwcMayWriteCrosshair(mode: CrosshairMode): boolean {
  return mode === "lwc-hover";
}

/** Pointer continuous fromXY may update crosshairRef in pointer-draw mode. */
export function pointerMayWriteCrosshair(mode: CrosshairMode): boolean {
  return mode === "pointer-draw";
}
