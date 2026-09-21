/**
 * AquaShield 3D — API Client
 * Centralized HTTP client for all backend API calls.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export const TOKEN_KEY = 'damsafe_token';

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}/api/v1${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  // A real login token always wins; otherwise fall back to the dev bypass.
  const token = storedToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (import.meta.env.DEV) {
    headers['Authorization'] = 'Bearer dev-token';
  }

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'No response body');
    throw new Error(`API Error ${response.status}: ${errorBody}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// ── Dams ──────────────────────────────────────────────────────────────────────

export const damsApi = {
  list: () => apiFetch<{ total: number; dams: any[] }>('/dams'),
  get: (id: string) => apiFetch<any>(`/dams/${id}`),
  create: (data: any) => apiFetch<any>('/dams', { method: 'POST', body: JSON.stringify(data) }),
};

// ── Scenarios ─────────────────────────────────────────────────────────────────

export const scenariosApi = {
  list: (params?: { dam_id?: string; status?: string; failure_mode?: string }) => {
    const query = new URLSearchParams();
    if (params?.dam_id) query.set('dam_id', params.dam_id);
    if (params?.status) query.set('status', params.status);
    if (params?.failure_mode) query.set('failure_mode', params.failure_mode);
    const qs = query.toString();
    return apiFetch<any>(`/scenarios${qs ? '?' + qs : ''}`);
  },
  get: (id: string) => apiFetch<any>(`/scenarios/${id}`),
  create: (data: any) => apiFetch<any>('/scenarios', { method: 'POST', body: JSON.stringify(data) }),
  submit: (id: string) => apiFetch<any>(`/scenarios/${id}/submit`, { method: 'POST' }),
  approve: (id: string) => apiFetch<any>(`/scenarios/${id}/approve`, { method: 'POST' }),
  lock: (id: string) => apiFetch<any>(`/scenarios/${id}/lock`, { method: 'POST' }),
  getResults: (id: string) => apiFetch<any>(`/scenarios/${id}/results`),
};

// ── Simulation Runs ───────────────────────────────────────────────────────────

export const simRunsApi = {
  list: (params?: { scenario_id?: string; job_status?: string }) => {
    const query = new URLSearchParams();
    if (params?.scenario_id) query.set('scenario_id', params.scenario_id);
    if (params?.job_status) query.set('job_status', params.job_status);
    const qs = query.toString();
    return apiFetch<any>(`/sim-runs${qs ? '?' + qs : ''}`);
  },
  getStatus: (id: string) => apiFetch<any>(`/sim-runs/${id}/status`),
  enqueue: (scenarioId: string) =>
    apiFetch<any>(`/sim-runs/${scenarioId}/enqueue`, { method: 'POST' }),
};

// ── Impact Analysis ───────────────────────────────────────────────────────────

export interface ImpactEstimateParams {
  dam_id: string;
  /** Scenario preset from the parameter agent — inputs only, never outcomes. */
  case?: 'best' | 'likely' | 'worst';
  grid_size?: number;
  /** Scenario runs used for the per-cell exposure frequency (0 = skip). */
  ensemble_count?: number;
  seed?: number;
}

export const impactApi = {
  getPriorities: (simRunId: string) => apiFetch<any>(`/impact/${simRunId}/priority`),
  getRoadStatus: (simRunId: string, t: number = 0) =>
    apiFetch<any>(`/impact/${simRunId}/roads?t=${t}`),
  getHazard: (simRunId: string) => apiFetch<any>(`/impact/${simRunId}/hazard`),
  getFacilities: (simRunId: string) => apiFetch<any>(`/impact/${simRunId}/facilities`),
  /**
   * Transparent impact estimate: which settlements are exposed, how many
   * people, what the damage could be and what early action could avoid.
   * Every figure returns with an evidence class and a confidence level.
   */
  estimate: (params: ImpactEstimateParams) =>
    apiFetch<any>('/impact/estimate', {
      method: 'POST', body: JSON.stringify(params),
    }),
};

// ── Alerts ────────────────────────────────────────────────────────────────────

export const alertsApi = {
  draft: (simRunId: string, data: any) =>
    apiFetch<any>(`/alerts/${simRunId}/draft`, { method: 'POST', body: JSON.stringify(data) }),
  approve: (alertId: string) => apiFetch<any>(`/alerts/${alertId}/approve`, { method: 'POST' }),
  dispatch: (alertId: string) => apiFetch<any>(`/alerts/${alertId}/dispatch`, { method: 'POST' }),
  list: (params?: { sim_run_id?: string }) => {
    const query = new URLSearchParams();
    if (params?.sim_run_id) query.set('sim_run_id', params.sim_run_id);
    const qs = query.toString();
    return apiFetch<any>(`/alerts/list${qs ? '?' + qs : ''}`);
  },
};

// ── Reports ───────────────────────────────────────────────────────────────────

export const reportsApi = {
  getPdfUrl: (simRunId: string) => `${BASE_URL}/api/v1/reports/${simRunId}/pdf`,
  getHtml: (simRunId: string) => apiFetch<any>(`/reports/${simRunId}/html`),
  broadcast: (data: { title: string; kind: string; body: string; dam_id?: string | null }) =>
    apiFetch<{ status: string; id: string }>(`/reports/broadcast`, {
      method: 'POST', body: JSON.stringify(data),
    }),
  inbox: () => apiFetch<{ total: number; documents: any[] }>(`/reports/inbox`),
};

// ── Audit ─────────────────────────────────────────────────────────────────────

export const auditApi = {
  list: (params?: { entity?: string; entity_id?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.entity) query.set('entity', params.entity);
    if (params?.entity_id) query.set('entity_id', params.entity_id);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return apiFetch<any>(`/audit${qs ? '?' + qs : ''}`);
  },
};

// ── GIS ───────────────────────────────────────────────────────────────────────

export const gisApi = {
  getDemVersions: (damId: string) => apiFetch<any>(`/gis/dem/${damId}`),
  getManningsN: () => apiFetch<any>('/gis/mannings-n'),
};

// ── LISFLOOD-FP (real hydraulic jobs) ─────────────────────────────────────

export interface LisfloodRunParams {
  dam_id: string;
  failure_mode: 'overtopping' | 'piping' | 'controlled_release';
  reservoir_level_m?: number | null;
  breach_width_m?: number;
  breach_depth_m?: number;
  breach_formation_time_min?: number;
  duration_min?: number;
  mannings_n?: number;
  domain_radius_km?: number;
  cell_size_m?: number;
}

export const lisfloodApi = {
  run: (data: LisfloodRunParams) =>
    apiFetch<{ job_id: string; status: string; poll: string }>('/lisflood/run', {
      method: 'POST', body: JSON.stringify(data),
    }),
  status: (jobId: string) => apiFetch<any>(`/lisflood/${jobId}`),
  metadata: (jobId: string) => apiFetch<any>(`/lisflood/${jobId}/metadata`),
  result: (jobId: string) => apiFetch<any>(`/lisflood/${jobId}/result`),
  logs: (jobId: string) => apiFetch<any>(`/lisflood/${jobId}/logs`),
};

// ── Simulation Sandbox (counterfactual breach engine; screening model) ────

export const sandboxApi = {
  dams: () => apiFetch<any>('/sandbox/dams'),
  generate: (dam_id: string, seed = 7, ensemble_count = 10) =>
    apiFetch<any>('/sandbox/scenarios/generate', {
      method: 'POST', body: JSON.stringify({ dam_id, seed, ensemble_count }),
    }),
  run: (dam_id: string, scenario: any, grid_size = 96, seed?: number) =>
    apiFetch<any>('/sandbox/run', {
      method: 'POST', body: JSON.stringify({ dam_id, scenario, grid_size, seed }),
    }),
  ensemble: (dam_id: string, count = 10, seed = 7, grid_size = 64) =>
    apiFetch<any>('/sandbox/ensemble', {
      method: 'POST', body: JSON.stringify({ dam_id, count, seed, grid_size }),
    }),
  demoTehri: () => apiFetch<any>('/sandbox/demo/tehri'),
};

