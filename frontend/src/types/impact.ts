/**
 * AquaShield 3D — Flood impact domain types.
 *
 * Two families live here:
 *
 *  1. Viewer payload types (`ImpactData`, `VillageData`, …) consumed by the
 *     2D/3D/terrain viewers.
 *  2. `ImpactEstimate` — the transparent hazard → exposure → vulnerability →
 *     impact → economic-loss → avoided-loss payload produced by
 *     `POST /api/v1/impact/estimate`.
 *
 * Every modelled number in an estimate is a RANGE plus an evidence class.
 * Never render `mid` alone as if it were a measurement: the UI must show the
 * range and the confidence level next to it.
 */

// ── Evidence / labelling ─────────────────────────────────────────────────────

/** How a published value came to exist. Mirrors the backend's legend. */
export type EvidenceClass = 'observed' | 'derived' | 'modelled' | 'assumed';

export type ConfidenceLevel = 'Low' | 'Medium' | 'High';

/** Worst-last ordering shared by every risk chip and globe colour. */
export type RiskBand = 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';

export type SettlementStatus = 'INUNDATED' | 'AT RISK' | 'SAFE';

export type SeverityBand = 'DRY' | 'MINOR' | 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';

/** Population-at-Risk priority band (deterministic score, never casualties). */
export type PriorityBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface PriorityBlock {
  score: number;
  band: PriorityBand;
  basis: EvidenceClass;
  reasons: string[];
}

/** One mapped critical facility sampled against the modelled flood. */
export interface EstimateAsset {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  source: string;
  distance_km: number | null;
  arrival_min: number | null;
  depth_m: number;
  flood_risk: RiskBand;
  priority: RiskBand;
  status: 'EXPOSED' | 'DRY';
  reasons: string[];
}

export interface EvacCorridor {
  settlement_id: string;
  settlement_name: string;
  priority_band: PriorityBand | string;
  candidate_route: string | null;
  candidate_kind?: string;
  candidate_path?: [number, number][]; // [lon, lat] pairs
  status: 'RECOMMENDED CANDIDATE' | 'MARGINAL' | 'NO CANDIDATE' | string;
  usable_road_distance_km: number | null;
  travel_time_min: number | null;
  safe_direction: string | null;
  flood_risk: string;
  reasons: string[];
}

export interface UnsafeRoad {
  id: string;
  name: string;
  kind: string;
  is_bridge: boolean;
  status: 'FLOODED' | 'RESTRICTED' | 'OUTSIDE_DOMAIN' | string;
  max_depth_m: number;
  arrival_min: number | null;
  length_km: number;
}

export interface EvacuationBlock {
  data_source: 'osm-live' | 'osm-cache' | 'unavailable' | 'not_computed' | string;
  note: string;
  thresholds: { flooded_road_depth_m: number; restricted_road_depth_m: number; travel_speed_kmh: number };
  roads_total: number;
  unsafe_roads: UnsafeRoad[];
  unsafe_road_paths: [number, number][][]; // polylines [lon, lat]
  bottlenecks: UnsafeRoad[];
  corridors: EvacCorridor[];
  safe_zone: {
    sectors: Array<{ sector: string; bearing_deg: [number, number]; note: string }>;
    note: string;
  };
}

export interface DecisionSummary {
  where: string[];
  when: string[];
  who: string[];
  why: string[];
  basis: EvidenceClass;
  note: string;
}

/** A modelled value with its uncertainty band and its reason. */
export interface BasisBlock {
  basis: EvidenceClass;
  basis_note?: string;
}

/** Inclusive-minus/exclusive-max integer range, always low ≤ mid ≤ high. */
export interface PopRange extends BasisBlock {
  low: number;
  mid: number;
  high: number;
}

export interface MoneyRange {
  low_inr: number;
  mid_inr: number;
  high_inr: number;
}

export interface MoneyBlock extends MoneyRange, BasisBlock {}

// ── Estimate payload ─────────────────────────────────────────────────────────

export interface EstimateDam {
  name: string;
  lat: number | null;
  lon: number | null;
  bbox_wsen: [number, number, number, number];
}

export interface EstimateConfidence extends BasisBlock {
  level: ConfidenceLevel;
  score: number;
  factors: Array<{ factor: string; penalty: number }>;
}

export interface EstimateDriver {
  factor: string;
  value: string;
  direction: 'up' | 'down';
  note: string;
}

export interface EstimateAssumption {
  stage: string;
  parameter: string;
  value: string;
  basis: EvidenceClass;
  note: string;
}

export interface EstimateMethodStep {
  stage: string;
  formula: string;
  class: string;
}

export interface EstimatePopulation extends BasisBlock {
  value: number;
  range: { low: number; mid: number; high: number };
}

export interface EstimateSettlement {
  id: string;
  name: string;
  kind: string;
  lon: number;
  lat: number;
  source: string;
  status: SettlementStatus;
  risk: RiskBand;
  severity_band: SeverityBand;
  depth_m: number;
  speed_ms: number | null;
  hazard_index: number | null;
  hazard_index_basis: string;
  arrival_min: number | null;
  lead_time_min: number | null;
  distance_to_water_m: number | null;
  elevation_m: number | null;
  inundation_likelihood_pct: number | null;
  population: EstimatePopulation;
  population_exposed: PopRange & { share_of_settlement: number };
  population_displaced: PopRange & { share_of_exposed: number };
  facilities_exposed: string[];
  priority?: PriorityBlock;
  vulnerability: BasisBlock & {
    score: number;
    factors: Array<{ name: string; value: number; weight: number; note: string }>;
  };
  damage: BasisBlock & {
    total: MoneyRange;
    residential: MoneyRange;
    commercial: MoneyRange;
    infrastructure: MoneyRange;
    agriculture: MoneyRange;
  };
  savings: BasisBlock & {
    avoided: MoneyRange;
    effectiveness: number;
    people_protected: PopRange;
  };
  confidence: ConfidenceLevel;
}

export interface EstimateTotals {
  overall_risk: RiskBand;
  flooded_area_km2: number;
  settlements_assessed: number;
  settlements_inundated: number;
  settlements_at_risk: number;
  settlements_high_or_extreme: number;
  critical_assets_exposed: number;
  priority_counts?: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
  population_exposed: PopRange;
  population_displaced: PopRange;
  people_protected: PopRange;
  damage: MoneyBlock;
  damage_breakdown: {
    residential_inr: number;
    commercial_inr: number;
    infrastructure_inr: number;
    agriculture_inr: number;
  };
  avoided: MoneyBlock;
  residual_damage: MoneyRange;
  agriculture: MoneyRange & BasisBlock & { area_km2: number };
  peak_depth_m: number;
  earliest_arrival_min: number | null;
}

export interface ImpactEstimate {
  pipeline: string[];
  generated_at_utc: string;
  dam: EstimateDam;
  evidence_legend: Record<EvidenceClass, string>;
  engine: { name: string; cell_m: number; note: string };
  scenario: Record<string, unknown>;
  totals: EstimateTotals;
  confidence: EstimateConfidence;
  drivers: EstimateDriver[];
  assets?: EstimateAsset[];
  evacuation?: EvacuationBlock;
  decision?: DecisionSummary;
  settlements: EstimateSettlement[];
  assumptions: EstimateAssumption[];
  method: EstimateMethodStep[];
  limits: string[];
}

/** Full response of `POST /api/v1/impact/estimate`. */
export interface ImpactEstimateResponse {
  mode: string;
  dam_id: string;
  dam_name: string;
  terrain: Record<string, unknown>;
  case: 'best' | 'likely' | 'worst';
  grid_size: number;
  cell_m: number;
  bbox_wsen: [number, number, number, number];
  estimate: ImpactEstimate;
  ensemble: { runs: number; note: string } | null;
  asset_provenance: string;
  scenario_comparison?: {
    selected: 'best' | 'likely' | 'worst';
    cases: Record<string, Record<string, any> | { error: string }>;
    note: string;
  } | null;
}

// ── Viewer payload types (unchanged viewer contract) ─────────────────────────

export interface IncidentConsoleState {
  viewMode: '2d' | '3d';
  simRunId: string;
  currentTimeMinutes: number;
  cameraTarget: { lon: number; lat: number; heightM: number } | null;
}

export interface VillageData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  population: number;
  arrival_time_min: number;
  depth_m: number;
  velocity_ms: number;
  hazard_index: number;
  hazard_class: 'green' | 'yellow' | 'orange' | 'red';
  flooded: boolean;
}

export interface RoadData {
  id: string;
  name: string;
  coordinates: [number, number][];
  status: 'safe' | 'restricted' | 'impassable';
  depth_m: number;
  velocity_ms: number;
}

export interface FacilityData {
  id: string;
  name: string;
  kind: 'hospital' | 'school' | 'substation' | 'telecom_tower' | 'police_station';
  lon: number;
  lat: number;
}

export interface ShelterData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  capacity: number;
}

export interface DamData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  height_m: number;
  model_3d_url: string | null;
}

export interface ImpactData {
  dam: DamData;
  villages: VillageData[];
  roads: RoadData[];
  facilities: FacilityData[];
  shelters: ShelterData[];
  floodExtent: { center: [number, number]; radiusDeg: number } | null;
}
