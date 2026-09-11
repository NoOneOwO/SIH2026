/**
 * DamSafe Twin — feature flags (TEST MODE).
 *
 * LISFLOOD-FP integration phase: the legacy sandbox/mock flood overlay is
 * DISABLED so it can never masquerade as engine output. The only water
 * rendered comes from parsed LISFLOOD-FP result grids.
 *
 * Sandbox code is untouched and recoverable — set `sandboxFlood: true` to
 * restore the old path. Terrain rendering is unaffected either way.
 */
export const FEATURES = {
  /** Legacy sandbox screening overlay (mock/exploratory results, clearly labelled). */
  sandboxFlood: true,
  /** Real LISFLOOD-FP jobs: run panel + result overlay. */
  lisflood: true,
} as const;
