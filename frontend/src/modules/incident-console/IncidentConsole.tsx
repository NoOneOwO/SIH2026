/**
 * AquaShield 3D — Incident Console
 *
 * God's Eye globe (Cesium) + per-dam true-3D terrain meshes (three.js).
 *
 * Two views, two actions — nothing else competes for the same outcome:
 *   - Sidebar pick        → globe dives to the dam, dam details panel opens.
 *   - "View 3D terrain"   → the dam's real-DEM mesh.
 *   - "Run screening simulation" → the mesh with the screening model panel,
 *     which runs the likely case immediately and reports honestly (running /
 *     output / failure / backend-not-running).
 *
 * Deep links that still have a job: `?dam=<id>` (share a dam view),
 * `?dam=<id>&lisflood=1&job=<id>` (share a completed hydraulic run — the dam
 * id is required, which is how Admin builds the link), `?globeCity=…`
 * (Evacuation Planner waypoint). `?sandbox=1`/`?direct=1`/`?demo=1` were
 * removed — they were alternate ways of starting the same action.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Users, Droplets, AlertTriangle, PanelLeftClose, PanelLeft, Globe, Search, Mountain, FlaskConical, MapPin, Loader2 } from 'lucide-react';
import { INDIA_DAMS, DamPoint } from '../../data/india-dams';
import { sandboxApi } from '../../api/client';
import Local3DView, { type FloodOverlay } from '../../viewers/local-3d/Local3DView';
import GodEye3D from '../../viewers/gods-eye/GodEye3D';
import SandboxPanel from './SandboxPanel';
import LisfloodPanel from '../../components/lisflood/LisfloodPanel';
import { FEATURES } from '../../config';

/** Great-circle distance in km (waypoint readouts). */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Dam screening index — a HEURISTIC headline for the dam registry, computed
 * only from two published dam facts (height and reservoir capacity).
 *
 * It is NOT a flood forecast and it carries NO population or damage numbers:
 * downstream exposure comes from the impact assessment, which samples the
 * simulated water at real mapped settlements. Keeping those concerns apart is
 * deliberate — this chip must never imply an impact figure the model did not
 * compute.
 */
function classifyHazard(dam: DamPoint) {
  const heightScore = Math.min(dam.height_m / 300, 1);
  const capacityScore = Math.min(dam.capacity_mcm / 15000, 1);
  const composite = heightScore * 0.6 + capacityScore * 0.4;

  if (composite > 0.7) return {
    level: 'EXTREME' as const, color: '#dc2626',
    description:
      'Tall dam with a very large reservoir. Breach consequences are classed high in this screening index — run an impact assessment for real exposure figures.',
  };
  if (composite > 0.45) return {
    level: 'HIGH' as const, color: '#ea580c',
    description:
      'Large dam/reservoir combination. This index only ranks dam size; downstream population and damage come from the impact assessment.',
  };
  if (composite > 0.2) return {
    level: 'MODERATE' as const, color: '#ca8a04',
    description:
      'Mid-sized structure in this index. Localized consequences are typical, but the index does not model any flood.',
  };
  return {
    level: 'LOW' as const, color: '#16a34a',
    description:
      'Smaller structure in this index. Limited downstream consequences are typical — still worth an impact assessment where people live downstream.',
  };
}

function formatType(type: string) {
  const map: Record<string, string> = {
    concrete_gravity: 'Concrete Gravity', concrete_arch: 'Concrete Arch',
    earthfill: 'Earthfill', rockfill: 'Rockfill', earthen: 'Earthen',
    masonry: 'Masonry', barrage: 'Barrage',
  };
  return map[type] || type;
}

/** How the terrain view was entered — decides whether a run starts on open. */
type TerrainMode = 'view' | 'run' | 'lisflood';

// ── Main component ──────────────────────────────────────────────────
export default function IncidentConsole() {
  // Which dam is under focus (drives the globe dive and the terrain mesh).
  const [focusedDam, setFocusedDam] = useState<DamPoint | null>(null);
  // Dam whose details panel is open (globe view only).
  const [selectedDam, setSelectedDam] = useState<DamPoint | null>(null);
  // One view field instead of a set of booleans that had to be re-set by hand
  // in every handler.
  const [view, setView] = useState<'globe' | 'terrain'>('globe');
  const [autoRun, setAutoRun] = useState(false);
  const [lisfloodOpen, setLisfloodOpen] = useState(false);
  const [deepJobId, setDeepJobId] = useState<string | null>(null);
  const [flood, setFlood] = useState<FloodOverlay | null>(null);
  // Bumped per dam pick; God's Eye re-flies even when the same dam repeats.
  const [focusNonce, setFocusNonce] = useState(0);
  // Focused downstream city (from Evacuation Planner): marker + distance card.
  const [cityFocus, setCityFocus] = useState<{
    name: string; lon: number; lat: number;
    damlon: number; damlat: number; depth: string; arr: string;
  } | null>(null);
  const [cityTarget, setCityTarget] = useState<{ lon: number; lat: number; heightM: number } | null>(null);
  const [modelManifest, setModelManifest] = useState<Record<string, { file: string; name: string }> | null>(null);
  // While a simulation request is in flight the terrain slowly orbits — the
  // mesh stays alive instead of a static loading screen.
  const [simBusy, setSimBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

  // Local-3D model manifest (curated + on-demand captured; keyed by dam id).
  const refreshManifest = useCallback(() =>
    fetch(`/terrain/manifest.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setModelManifest(m); return m; })
      .catch(() => null), []);
  useEffect(() => { void refreshManifest(); }, [refreshManifest]);

  const resolveModelSlug = useCallback((dam: DamPoint): string | null =>
    modelManifest?.[dam.id]?.file ?? null, [modelManifest]);

  // Warm the 3D terrain in the HTTP cache so the terrain view opens fast.
  const preloadTerrain = useCallback((dam: DamPoint) => {
    const slug = modelManifest?.[dam.id]?.file;
    if (!slug) return;
    [`/terrain/${slug}.glb`, `/terrain/${slug}.metadata.json`, `/terrain/${slug}.transform.json`].forEach((u) => {
      fetch(u, { cache: 'force-cache' }).catch(() => {});
    });
  }, [modelManifest]);

  // ── On-demand terrain capture: every dam becomes 3D-capable ─────────
  // Dams missing a GLB get one built server-side (real DEM + imagery) the
  // moment the terrain is requested, then the flow continues normally.
  const [capturingDam, setCapturingDam] = useState<string | null>(null);
  const [captureMsg, setCaptureMsg] = useState('');
  // Shown in the details panel when a terrain request cannot proceed, so the
  // actions never fail as a silent no-op.
  const [terrainError, setTerrainError] = useState('');
  const captureInFlight = useRef<string | null>(null);

  const ensureTerrain = useCallback(async (dam: DamPoint): Promise<{ slug: string | null; error?: string }> => {
    // The manifest loads async and a deep link can beat it; wait for the first
    // load instead of wrongly assuming the dam has no published terrain.
    const manifest = modelManifest ?? (await refreshManifest());
    const existing = manifest?.[dam.id];
    if (existing) return { slug: existing.file };
    if (captureInFlight.current === dam.id) {
      return { slug: null, error: `A terrain build is already running for ${dam.name} — give it a moment.` };
    }
    captureInFlight.current = dam.id;
    setCapturingDam(dam.id);
    setCaptureMsg(`Building the 3D terrain for ${dam.name} from the real DEM… (~15 s)`);
    try {
      await sandboxApi.captureTerrain(dam.id);
      const m = await refreshManifest();
      const slug = m?.[dam.id]?.file ?? null;
      return slug
        ? { slug }
        : { slug: null, error: 'The terrain build finished but published no mesh for this dam.' };
    } catch (e: any) {
      const detail = String(e?.message ?? e);
      const error = e?.name === 'BackendUnavailableError'
        ? 'Terrain for this dam has to be built by the backend, which is not answering. Start it and retry.'
        : /API Error 503/.test(detail)
          ? 'Terrain unavailable for this site (DEM providers unreachable) — try again later.'
          : /API Error 4/.test(detail) ? 'Terrain capture rejected by the API.'
          : `Terrain capture failed — ${detail}`;
      return { slug: null, error };
    } finally {
      setCaptureMsg('');
      captureInFlight.current = null;
      setCapturingDam(null);
    }
  }, [modelManifest, refreshManifest]);

  /** Single way to reach a dam's terrain: capture on demand, then show it. */
  const enterTerrain = useCallback(async (dam: DamPoint, mode: TerrainMode, jobId?: string | null) => {
    setTerrainError('');
    const { slug, error } = await ensureTerrain(dam);
    if (!slug) {
      // Nothing changed on screen; say why instead of looking inert.
      setTerrainError(error ?? `Could not open the 3D terrain for ${dam.name}.`);
      return;
    }
    setFocusedDam(dam);
    setSelectedDam(null);           // the details panel must not cover the mesh
    setCityFocus(null);
    setCityTarget(null);
    setView('terrain');
    setFlood(null);
    setAutoRun(mode === 'run');
    setDeepJobId(jobId ?? null);
    setLisfloodOpen(mode === 'lisflood' && FEATURES.lisflood);
    preloadTerrain(dam);
  }, [ensureTerrain, preloadTerrain]);

  /**
   * Single way out of the simulation view: back to the globe.
   * Pass the dam to re-open its details panel, so leaving the terrain always
   * lands on the state that carries the "View 3D terrain" / "Run" actions
   * (`null` closes the panel as well).
   */
  const backToGlobe = useCallback((keepDam?: DamPoint | null) => {
    setView('globe');
    setFlood(null);
    setAutoRun(false);
    setLisfloodOpen(false);
    if (keepDam !== undefined) setSelectedDam(keepDam);
  }, []);

  /** Sidebar pick: dive the globe and open the dam details panel. */
  const selectDam = useCallback((dam: DamPoint) => {
    setSelectedDam(dam);
    setFocusedDam(dam);
    setFocusNonce((n) => n + 1);
    setCityFocus(null);
    setCityTarget(null);
    setView('globe');
    setAutoRun(false);
    setLisfloodOpen(false);
    setFlood(null);
    setTerrainError('');
    preloadTerrain(dam);
  }, [preloadTerrain]);

  // Deep links. Runs once; `?dam=` alone just shows the dam on the globe.
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    if (deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    const q = new URLSearchParams(window.location.search);
    const dam = INDIA_DAMS.find((d) => d.id === q.get('dam'));
    if (!dam) return;
    if (q.get('lisflood') === '1') {
      void enterTerrain(dam, 'lisflood', q.get('job'));
      return;
    }
    selectDam(dam);
  }, [enterTerrain, selectDam]);

  // City focus links (Evacuation Planner → globe): re-run on query change.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const name = q.get('globeCity');
    const clon = Number(q.get('clon'));
    const clat = Number(q.get('clat'));
    if (!name || !Number.isFinite(clon) || !Number.isFinite(clat)) {
      setCityFocus(null);
      setCityTarget(null);
      return;
    }
    setView('globe');
    setCityFocus({
      name, lon: clon, lat: clat,
      damlon: Number(q.get('damlon')) || 70.85,
      damlat: Number(q.get('damlat')) || 22.83,
      depth: q.get('depth') || '—',
      arr: q.get('arr') || '—',
    });
    setCityTarget({ lon: clon, lat: clat, heightM: 9000 });
  }, [location.search]);

  const hazard = selectedDam ? classifyHazard(selectedDam) : null;
  const terrainSlug = focusedDam ? resolveModelSlug(focusedDam) : null;
  const inTerrain = view === 'terrain' && !!focusedDam && !!terrainSlug;

  const filteredDams = searchQuery
    ? INDIA_DAMS.filter(d =>
        d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.state.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.river.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : [...INDIA_DAMS].sort((a, b) => b.height_m - a.height_m);

  return (
    <div className="flex h-full w-full relative overflow-hidden">
      {/* Dam sidebar */}
      {sidebarOpen && (
        <div className="w-72 bg-[#0A1218]/95 backdrop-blur border-r border-cmd-border flex flex-col shrink-0 z-10"
          onClick={(e) => e.stopPropagation()}>
          <div className="p-4 border-b border-cmd-border">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-cmd-teal" strokeWidth={1.75} />
                <h3 className="text-sm font-bold text-cmd-ink">India Dam Index</h3>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]" title="Hide dam list">
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-cmd-muted mb-3 tabular-nums">
              {INDIA_DAMS.length} dams • Satellite + 3D Terrain
            </p>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-cmd-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text" placeholder="Search dams..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-xs bg-cmd-panel border border-cmd-border rounded-lg text-cmd-ink placeholder:text-cmd-muted/60 focus:outline-none focus:border-cmd-teal/60"
              />
            </div>
          </div>

          <div className="px-4 py-3 border-b border-cmd-border">
            <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">Dams by height</p>
            {/* Height buckets only — the coloured dot on each dam row means
                the screening index, so this legend deliberately uses no dots
                of its own. */}
            {(() => {
              const buckets = [
                { label: 'Very tall (>200 m)', min: 200.001, max: Infinity },
                { label: 'Tall (100–200 m)', min: 100, max: 200 },
                { label: 'Medium (50–100 m)', min: 50, max: 99.999 },
                { label: 'Lower (<50 m)', min: 0, max: 49.999 },
              ].map((b) => ({ ...b, count: INDIA_DAMS.filter(d => d.height_m >= b.min && d.height_m <= b.max).length }));
              const most = Math.max(...buckets.map(b => b.count), 1);
              return buckets.map(({ label, count }) => (
                <div key={label} className="flex items-center gap-2 mb-1.5">
                  <span className="w-[92px] shrink-0 text-[11px] text-cmd-muted">{label}</span>
                  <span className="h-1.5 flex-1 rounded-full bg-cmd-track overflow-hidden">
                    <span className="block h-full rounded-full bg-cmd-teal/70" style={{ width: `${(count / most) * 100}%` }} />
                  </span>
                  <span className="w-5 text-right text-[11px] font-bold text-cmd-ink tabular-nums">{count}</span>
                </div>
              ));
            })()}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {filteredDams.map((dam) => (
              <button key={dam.id} onClick={() => selectDam(dam)}
                className={`w-full flex items-center gap-2 text-left p-2 rounded-xl transition-colors mb-1 border ${
                  (selectedDam ?? focusedDam)?.id === dam.id
                    ? 'bg-cmd-tealdim border-cmd-teal/30'
                    : 'border-transparent hover:bg-white/[0.04] hover:border-cmd-border'
                }`}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: classifyHazard(dam).color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-cmd-ink truncate">{dam.name}</p>
                  <p className="text-[10px] text-cmd-muted">{dam.state} • {dam.river}</p>
                </div>
                <span className="text-xs font-bold text-cmd-muted shrink-0 tabular-nums">{dam.height_m}m</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Map area */}
      <div className="flex-1 relative" style={{ boxShadow: 'inset 0 0 60px -30px rgba(101,191,169,0.25)' }}>
        {!sidebarOpen && (
          <button onClick={() => setSidebarOpen(true)}
            className={`absolute left-3 z-30 p-2 bg-[#0A1218]/90 border border-cmd-border rounded-lg hover:border-cmd-teal/40 transition-colors ${inTerrain ? 'top-16' : 'top-3'}`}
            title="Show dam list">
            <PanelLeft className="w-4 h-4 text-cmd-muted" />
          </button>
        )}

        {inTerrain ? (
          <>
            <Local3DView
              dam={focusedDam!}
              slug={terrainSlug!}
              hazardColor={classifyHazard(focusedDam!).color}
              onShowMap={() => backToGlobe(focusedDam)}
              onClose={() => { setFocusedDam(null); backToGlobe(null); }}
              flood={flood}
              cinematic={FEATURES.lisflood && lisfloodOpen}
              spin={simBusy}
              spinSpeed={1.6}
            />
            {/* Exactly one simulation panel on the mesh: the deep-link result
                viewer, or the screening model. */}
            {FEATURES.lisflood && lisfloodOpen ? (
              <LisfloodPanel
                dam={focusedDam!}
                onFlood={setFlood}
                onClose={() => backToGlobe(focusedDam)}
                initialJobId={deepJobId}
              />
            ) : FEATURES.sandboxFlood ? (
              <SandboxPanel
                dam={focusedDam!}
                autoRun={autoRun}
                onFlood={setFlood}
                onExit={() => backToGlobe(focusedDam)}
                onBusyChange={setSimBusy}
              />
            ) : null}
          </>
        ) : (
          <>
            <div className="absolute top-3 right-14 z-20">
              <div className="px-3 py-1.5 bg-[#0A1218]/90 border border-cmd-border text-cmd-ink text-[10px] font-bold rounded-full">
                <span className="text-cmd-green">●</span> 👁 God's Eye 3D Globe
              </div>
            </div>
            <GodEye3D
              timeMinutes={0}
              impactData={null}
              cameraTarget={cityTarget}
              onCameraChange={() => {}}
              focusNonce={focusNonce}
              focusDam={focusedDam ?? selectedDam
                ? {
                    lon: (focusedDam ?? selectedDam)!.lon,
                    lat: (focusedDam ?? selectedDam)!.lat,
                    name: (focusedDam ?? selectedDam)!.name,
                  }
                : null}
            />
          </>
        )}

        {captureMsg && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 bg-[#0A1218]/92 border border-cmd-teal/40 text-cmd-ink text-[10px] font-semibold rounded-full max-w-md text-center">
            <Loader2 className="w-3 h-3 animate-spin text-cmd-teal shrink-0" />
            {captureMsg}
          </div>
        )}

        {/* Focused city card (Evacuation Planner links) */}
        {cityFocus && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-cmd-teal/40 bg-[#0A1218]/92 backdrop-blur">
            <MapPin className="w-4 h-4 text-cmd-teal shrink-0" strokeWidth={2} />
            <div className="text-xs">
              <span className="font-bold text-cmd-ink">{cityFocus.name}</span>
              <span className="text-cmd-muted font-mono tabular-nums">
                {' '}• {haversineKm(cityFocus.damlat, cityFocus.damlon, cityFocus.lat, cityFocus.lon).toFixed(1)} km from dam
                {' '}• depth {cityFocus.depth} • arrival {cityFocus.arr}
              </span>
            </div>
            <button onClick={() => { setCityFocus(null); navigate('/incident', { replace: true }); }}
              className="p-1 rounded-md text-cmd-muted hover:text-cmd-ink" title="Clear waypoint">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Dam data panel — the single home for the two terrain actions. */}
      {selectedDam && view === 'globe' && (
        <div className="absolute right-0 top-0 bottom-0 w-80 bg-[#0A1218]/95 backdrop-blur border-l border-cmd-border z-20 flex flex-col"
          onClick={(e) => e.stopPropagation()}>
          <div className="p-4 overflow-y-auto flex-1">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold text-cmd-ink">{selectedDam.name}</h3>
                <p className="text-sm text-cmd-muted">{selectedDam.state} • {selectedDam.river} River</p>
              </div>
              <button onClick={() => setSelectedDam(null)}
                className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]" title="Close dam details">
                <X className="w-4 h-4" />
              </button>
            </div>

            {hazard && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-cmd-border bg-cmd-panel2 text-xs font-bold mb-3"
                style={{ color: hazard.color }}>
                <AlertTriangle className="w-3 h-3" /> {hazard.level} RISK
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5 mb-3">
              {[
                { label: 'Height', value: `${selectedDam.height_m} m` },
                { label: 'Capacity', value: `${selectedDam.capacity_mcm.toLocaleString()} MCM` },
                { label: 'Type', value: formatType(selectedDam.type) },
                { label: 'Year Built', value: selectedDam.year_built > 0 ? String(selectedDam.year_built) : `${Math.abs(selectedDam.year_built)} BC` },
                { label: 'Latitude', value: selectedDam.lat.toFixed(4) },
                { label: 'Longitude', value: selectedDam.lon.toFixed(4) },
              ].map(({ label, value }) => (
                <div key={label} className="bg-cmd-panel border border-cmd-border/70 rounded-lg p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-cmd-muted font-semibold">{label}</p>
                  <p className="text-sm font-bold text-cmd-ink tabular-nums">{value}</p>
                </div>
              ))}
            </div>

            {/* ── The two actions ── */}
            <div className="border-t border-cmd-border pt-3 mt-3 space-y-2">
              <button
                onClick={() => void enterTerrain(selectedDam, 'view')}
                disabled={capturingDam === selectedDam.id}
                title="Open this dam's 3D terrain (real DEM mesh)"
                className="w-full px-3 py-2 bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-2">
                {capturingDam === selectedDam.id ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Building 3D terrain…</>
                ) : (
                  <><Mountain className="w-3.5 h-3.5" strokeWidth={2} /> View 3D terrain</>
                )}
              </button>
              <button
                onClick={() => void enterTerrain(selectedDam, 'run')}
                disabled={capturingDam === selectedDam.id}
                title="Open the 3D terrain and run the screening breach simulation on it"
                className="w-full px-3 py-2 border border-cmd-teal/50 hover:bg-cmd-teal/10 text-cmd-teal text-xs font-bold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-2">
                <FlaskConical className="w-3.5 h-3.5" /> Run screening simulation
              </button>
              <p className="text-[10px] leading-snug text-cmd-muted">
                Both open the same terrain. The simulation needs the local backend running; its panel
                says so plainly and offers the precomputed demo when it is not.
              </p>
              {terrainError && (
                <p className="flex items-start gap-1.5 rounded-lg border border-cmd-red/30 bg-cmd-red/[0.08] px-2 py-1.5 text-[10.5px] font-semibold text-cmd-red">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" strokeWidth={2} />
                  <span className="min-w-0 break-words">{terrainError}</span>
                </p>
              )}
            </div>

            {hazard && (
              <div className="border-t border-cmd-border pt-3 mt-3">
                <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">Screening index</p>
                <div className="flex items-center gap-1.5">
                  <Droplets className="w-4 h-4 text-cmd-teal" strokeWidth={1.75} />
                  <div>
                    <p className="text-sm font-bold text-cmd-ink tabular-nums">
                      {(selectedDam.capacity_mcm * 0.001).toFixed(1)} km³
                    </p>
                    <p className="text-[10px] text-cmd-muted">Reservoir storage at full capacity</p>
                  </div>
                </div>
                <p className="text-xs text-cmd-muted mt-2 leading-relaxed">{hazard.description}</p>

                {/* Downstream exposure is a model output, so it is not guessed
                    here — it is computed where the water is actually simulated. */}
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-cmd-border/70 bg-cmd-panel2/60 px-2.5 py-2">
                  <Users className="w-4 h-4 mt-0.5 shrink-0 text-cmd-muted" strokeWidth={1.75} />
                  <div className="min-w-0">
                    <p className="text-[11.5px] font-semibold text-cmd-ink">Downstream population exposure is not shown here</p>
                    <p className="mt-0.5 text-[10.5px] leading-snug text-cmd-muted">
                      It requires a simulated breach sampled at mapped settlements. The Flood Impact
                      assessment computes it for this dam and reports a range with a confidence level.
                    </p>
                    <button
                      onClick={() => navigate(`/impact?dam=${encodeURIComponent(selectedDam.id)}`)}
                      className="mt-2 rounded-md border border-cmd-teal/40 px-2.5 py-1 text-[10.5px] font-bold text-cmd-teal hover:bg-cmd-tealdim"
                    >
                      Run impact assessment →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
