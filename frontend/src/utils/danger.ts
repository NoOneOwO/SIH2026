/**
 * Band -> base danger score. Mirrors backend assistant.danger_index. Two ladders exist in the app and either can reach
 * this helper: the sandbox ladder (MODERATE/HIGH/VERY HIGH/CRITICAL, from
 * backend response.severity_band) and the explainer ladder (DRY/LOW/MODERATE/
 * HIGH/EXTREME, from backend assistant._band). Both are listed explicitly so
 * the same depth scores identically whichever one arrives. Default matches
 * backend danger_index (45 for an unknown band).
 */
const BAND_BASE: Record<string, number> = {
  DRY: 5, LOW: 20, MODERATE: 45, HIGH: 70, 'VERY HIGH': 80, EXTREME: 90, CRITICAL: 90,
};

export function dangerIndex(band: string | undefined, criticalCount: number): { score: number; label: string } {
  const base = BAND_BASE[band ?? ''] ?? 45;
  const score = Math.min(100, base + Math.min(10, Math.max(0, criticalCount) * 2));
  const label = score < 30 ? 'Low' : score < 55 ? 'Moderate' : score < 75 ? 'High' : 'Extreme';
  return { score, label };
}

/**
 * Severity band from a max-depth value alone.
 *
 * Mirrors backend `sandbox.response.severity_band` — same depth cut-offs
 * (1.0 / 2.5 / 5.0 m) and the same MODERATE/HIGH/VERY HIGH/CRITICAL vocabulary
 * — so the fallback used when a run arrives without a band can never score
 * differently from the band a live run reports. That helper also escalates on
 * flooded area and critical-asset count, which a depth-only fallback cannot
 * see; this is therefore a fallback, not a decision.
 */
export function bandForDepth(maxDepth: number | null | undefined): string {
  const d = maxDepth ?? 0;
  if (d >= 5.0) return 'CRITICAL';
  if (d >= 2.5) return 'VERY HIGH';
  if (d >= 1.0) return 'HIGH';
  return 'MODERATE';
}
/**
 * Plain-language summary of what a run did downstream.
 *
 * `reachedSettlements` / `sampledSettlements` are both needed: the asset
 * inventory falls back to modelled sample points when no OSM settlements are
 * cached, and in that case there is nothing to say about villages — saying
 * "no villages get wet" while reporting water at four points reads as a
 * contradiction.
 */
export function dangerSentence(
  reachedSettlements: number,
  sampledSettlements: number,
  firstArrivalMin: number | null,
  maxDepth: number | null,
): string {
  const where = sampledSettlements === 0
    ? 'No mapped settlements were sampled downstream — exposure below is on modelled sample points, not real places.'
    : reachedSettlements === 0
      ? 'No villages in the modelled area get wet.'
      : reachedSettlements === 1
        ? 'Water reaches 1 village in the modelled area.'
        : `Water reaches ${reachedSettlements} villages in the modelled area.`;
  const when = firstArrivalMin == null
    ? ''
    : firstArrivalMin < 1
      ? ' The first water arrives almost immediately.'
      : ` The first water arrives in about ${Math.round(firstArrivalMin)} minutes.`;
  const deep = maxDepth == null
    ? ''
    : maxDepth < 0.3
      ? ' Water stays shallow (below knee height).'
      : maxDepth < 1.0
        ? ' Water gets up to about waist height in the deepest places.'
        : maxDepth < 2.5
          ? ' Water gets deeper than a person is tall in places.'
          : ' Water gets several metres deep — extremely dangerous.';
  return `${where}${when}${deep}`;
}
