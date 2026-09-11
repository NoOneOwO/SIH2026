/**
 * DamSafe Twin — TypeScript Type Definitions
 * All shared domain types for the frontend.
 */

// ── Enums / Literals ──────────────────────────────────────────────────────────

export type UserRole = 'viewer' | 'operator' | 'analyst' | 'approver' | 'admin';
export type FailureMode = 'piping' | 'overtopping' | 'controlled_release';
export type ScenarioStatus = 'draft' | 'submitted' | 'approved' | 'locked';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export type HazardClass = 'green' | 'yellow' | 'orange' | 'red';
export type RoadStatusType = 'safe' | 'restricted' | 'impassable';
export type AlertSeverity = 'watch' | 'warning' | 'emergency';
export type QualityGrade = 'prototype' | 'planning_grade' | 'engineering_reviewed' | 'operationally_approved';
export type FacilityKind = 'hospital' | 'school' | 'substation' | 'telecom_tower' | 'police_station';
export type Language = 'en' | 'hi';

// ── Core Entities ─────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  role: UserRole;
  email?: string;
}

export interface Dam {
  id: string;
  name: string;
  dam_type?: string;
  height_m?: number;
  crest_length_m?: number;
  spillway_count?: number;
  reservoir_capacity_mcm?: number;
}

export interface Scenario {
  id: string;
  dam_id: string;
  failure_mode: FailureMode;
  variant: string;
  breach_params: Record<string, any>;
  dem_version_id?: string;
  roughness_map_id?: string;
  solver: string;
  solver_version: string;
  status: ScenarioStatus;
  approved_by?: string;
  approved_at?: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface SimRun {
  id: string;
  scenario_id: string;
  job_status: JobStatus;
  mass_balance_error?: number;
  within_tolerance?: boolean;
  result_layers: Record<string, string>;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
}

export interface Village {
  id: string;
  name: string;
  population?: number;
  district?: string;
  block?: string;
}

export interface Facility {
  id: string;
  name: string;
  kind: FacilityKind;
}

export interface Road {
  id: string;
  name: string;
  road_class?: string;
  osm_id?: number;
}

export interface Shelter {
  id: string;
  name: string;
  capacity?: number;
  shelter_type?: string;
}

// ── Impact Analysis ───────────────────────────────────────────────────────────

export interface EvacuationPriority {
  village_id: string;
  village_name: string;
  population?: number;
  depth_m: number;
  velocity_ms: number;
  hazard_index: number;
  hazard_class: HazardClass;
  arrival_time_min: number;
  priority_score: number;
}

export interface RoadPassability {
  road_id: string;
  road_name: string;
  status: RoadStatusType;
  depth_m: number;
  velocity_ms: number;
}

export interface HazardSummary {
  hazard_index: number;
  hazard_class: HazardClass;
  max_depth_m: number;
  max_velocity_ms: number;
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export interface AlertDraft {
  id: string;
  sim_run_id: string;
  scenario_id: string;
  content: string;
  language: Language;
  severity?: AlertSeverity;
  approved_by?: string;
  dispatched_at?: string;
  created_at?: string;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  actor_id?: string;
  action: string;
  entity: string;
  entity_id?: string;
  diff?: Record<string, any>;
  at: string;
}

// ── API Responses ─────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  total: number;
  limit: number;
  offset: number;
}

export interface ScenarioListResponse extends PaginatedResponse<Scenario> {
  scenarios: Scenario[];
}

export interface SimRunListResponse extends PaginatedResponse<SimRun> {
  sim_runs: SimRun[];
}

export interface AuditListResponse extends PaginatedResponse<AuditEntry> {
  entries: AuditEntry[];
}

// ── GeoJSON Helpers ───────────────────────────────────────────────────────────

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: {
    type: string;
    coordinates: number[] | number[][];
  };
  properties: Record<string, any>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}
