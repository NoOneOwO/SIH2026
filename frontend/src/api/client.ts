/**
 * AquaShield 3D — API Client
 * Centralized HTTP client for all backend API calls.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export const TOKEN_KEY = 'damsafe_token';

/** Shown wherever an API call fails because no backend is answering. */
export const BACKEND_HELP =
  'No backend is answering at /api/v1. Start it, then retry:\n'
  + '  cd backend && uvicorn app.main:app --reload --port 8000';

/**
 * A call that failed because the backend is not there (nothing listening, so
 * the dev proxy answers 5xx or fetch rejects). Callers can catch this by name
 * to show setup steps instead of a generic error.
 */
export class BackendUnavailableError extends Error {
  constructor(detail: string) {
    super(`${BACKEND_HELP}\n\n(${detail})`);
    this.name = 'BackendUnavailableError';
  }
}

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

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (e: any) {
    throw new BackendUnavailableError(`${path}: ${e?.message ?? 'network error'}`);
  }

  if (!response.ok) {
    const errorBody = (await response.text().catch(() => '')) || 'no response body';
    // A dead proxied target surfaces as 5xx with an empty/HTML body; a real
    // backend error is reported as-is below the same status line.
    if (response.status >= 500) {
      throw new BackendUnavailableError(`${path}: HTTP ${response.status} ${errorBody.slice(0, 160)}`);
    }
    throw new Error(`API Error ${response.status}: ${errorBody.slice(0, 300)}`);
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
  cancel: (id: string) => apiFetch<any>(`/sim-runs/${id}`, { method: 'DELETE' }),
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
  /** Download the generated EAP file (PDF, or HTML fallback) as a blob. */
  downloadReport: async (simRunId: string): Promise<{ blob: Blob; filename: string }> => {
    const url = `${BASE_URL}/api/v1/reports/${simRunId}/pdf`;
    const headers: Record<string, string> = {};
    const token = storedToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    else if (import.meta.env.DEV) headers['Authorization'] = 'Bearer dev-token';
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (e: any) {
      throw new BackendUnavailableError(`/reports/${simRunId}/pdf: ${e?.message ?? 'network error'}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Report failed (HTTP ${response.status}): ${body}`);
    }
    const type = response.headers.get('content-type') || '';
    const ext = type.includes('pdf') ? 'pdf' : 'html';
    const cd = response.headers.get('content-disposition') || '';
    const m = /filename=([^;]+)/.exec(cd);
    const filename = (m?.[1]?.trim() || `damsafe-eap-report-${simRunId}.${ext}`);
    return { blob: await response.blob(), filename };
  },
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
  demoTehri: async () => {
    // Precomputed bundle: the dev server serves the generated cache file
    // directly, so the offline demo works with no backend and no API keys.
    // Falls back to the API endpoint when the static copy is not present
    // (e.g. a production build).
    try {
      const r = await fetch(`${BASE_URL}/demo/tehri_demo.json`);
      if (r.ok) {
        const bundle = await r.json();
        bundle.mode = bundle.mode ?? 'OFFLINE DEMO (precomputed — not a live calculation)';
        return bundle;
      }
    } catch {
      /* fall through to the API */
    }
    return apiFetch<any>('/sandbox/demo/tehri');
  },
  /** Standalone 3D terrain published for this dam (globe→sandbox bridge). */
  terrainStatus: (dam_id: string) =>
    apiFetch<any>(`/sandbox/terrain/${dam_id}/status`),
  /** Build + publish the standalone 3D terrain for any registry dam.
   * Real DEM fetch + GLB build takes ~10–25 s, hence the 90 s timeout. */
  captureTerrain: (dam_id: string) =>
    apiFetch<any>(`/sandbox/terrain/${dam_id}/capture`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
    }),
};

