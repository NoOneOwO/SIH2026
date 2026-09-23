/**
 * AquaShield 3D — feature flags.
 *
 * Both water paths are on and both label their provenance in the UI:
 *   sandboxFlood — the screening model (terrain-constrained propagation,
 *                  explicitly "not hydrodynamics/CFD") or its precomputed
 *                  offline demo bundle.
 *   lisflood     — real LISFLOOD-FP jobs: run panel + result overlay, also
 *                  reachable as a shared result link (`?dam=<id>&lisflood=1&job=<id>`;
 *                  the dam id is required — without it the link opens nothing).
 *
 * Set a flag to false to remove that path from the console entirely.
 */
export const FEATURES = {
  /** Legacy sandbox screening overlay (mock/exploratory results, clearly labelled). */
  sandboxFlood: true,
  /** Real LISFLOOD-FP jobs: run panel + result overlay. */
  lisflood: true,
} as const;

