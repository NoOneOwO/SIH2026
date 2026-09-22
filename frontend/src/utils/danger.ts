/**
 * Shared danger-index rule (mirrors backend explain_simulation).
 * Band base + up to 10 for critical assets, capped at 100.
 */
export function dangerIndex(band: string | undefined, criticalCount: number): { score: number; label: string } {
  // Both vocabularies: sandbox bands (CRITICAL/VERY HIGH/HIGH/MODERATE) and
  // engine bands (EXTREME/HIGH/MODERATE/LOW/DRY).
  const base =
    band === 'EXTREME' || band === 'CRITICAL' ? 90 :
    band === 'VERY HIGH' ? 80 :
    band === 'HIGH' ? 70 :
    band === 'MODERATE' ? 45 :
    band === 'LOW' ? 20 : 5;
  const score = Math.min(100, base + Math.min(10, Math.max(0, criticalCount) * 2));
  const label = score < 30 ? 'Low' : score < 55 ? 'Moderate' : score < 75 ? 'High' : 'Extreme';
  return { score, label };
}

/** Severity band from a max-depth value (mirrors backend _band). */
export function bandForDepth(maxDepth: number | null | undefined): string {
  const d = maxDepth ?? 0;
  if (d < 0.05) return 'DRY';
  if (d < 0.3) return 'LOW';
  if (d < 1.0) return 'MODERATE';
  if (d < 2.5) return 'HIGH';
  return 'EXTREME';
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
