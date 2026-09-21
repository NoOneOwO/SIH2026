/**
 * AquaShield 3D — last impact assessment handoff.
 *
 * The dashboard must not invent its own numbers, so it shows the most recent
 * assessment the user actually ran. Only a compact, already-computed summary
 * travels through sessionStorage (never a fabricated default).
 */

export const LAST_ASSESSMENT_KEY = 'aquashield-last-assessment';

export interface LastAssessment {
  dam_id: string;
  dam_name: string;
  case: 'best' | 'likely' | 'worst' | string;
  generated_at_utc: string;
  overall_risk: string;
  population_exposed: { low: number; mid: number; high: number };
  population_displaced: { low: number; mid: number; high: number };
  damage: { low_inr: number; mid_inr: number; high_inr: number };
  avoided: { low_inr: number; mid_inr: number; high_inr: number };
  confidence: { level: string; score: number };
  settlements_assessed: number;
  settlements_inundated: number;
  settlements_at_risk: number;
  critical_assets_exposed: number;
  flooded_area_km2: number;
  engine: string;
  asset_provenance: string;
}

export function saveLastAssessment(a: LastAssessment): void {
  try {
    sessionStorage.setItem(LAST_ASSESSMENT_KEY, JSON.stringify(a));
  } catch {
    /* private mode / quota — the dashboard simply shows no assessment */
  }
}

export function loadLastAssessment(): LastAssessment | null {
  try {
    const raw = sessionStorage.getItem(LAST_ASSESSMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.dam_id || !parsed.population_exposed) return null;
    return parsed as LastAssessment;
  } catch {
    return null;
  }
}
