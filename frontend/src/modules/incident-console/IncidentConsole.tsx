/**
 * AquaShield 3D — Incident Console
 *
 * God's Eye globe (Cesium) + per-dam true-3D terrain meshes:
 *   - Sidebar dam pick → globe dives to the dam site
 *   - Per-row 3D badge / "View 3D Terrain" → Local3D dam mesh, which also
 *     hosts the sandbox + LISFLOOD water simulation overlays
 *   - Every dam is 3D/sandbox capable: dams without a published terrain GLB
 *     get one auto-captured on demand (real provider-chain DEM + Esri
 *     imagery → GLB, same conventions as the curated assets), so the
 *     globe's terrain bridges into the standalone sandbox everywhere.
 *
 * Dam sidebar with search + data panel overlays the map area.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Users, Droplets, AlertTriangle, PanelLeftClose, PanelLeft, Globe, Search, Mountain, FlaskConical, Box, MapPin, Loader2 } from 'lucide-react';
import { INDIA_DAMS, DamPoint } from '../../data/india-dams';
import { sandboxApi } from '../../api/client';
import Local3DView, { type FloodOverlay } from '../../viewers/local-3d/Local3DView';
import GodEye3D from '../../viewers/gods-eye/GodEye3D';
import SandboxPanel from './SandboxPanel';
import SandboxTransition from './SandboxTransition';
import LisfloodPanel from '../../components/lisflood/LisfloodPanel';
import { FEATURES } from '../../config';

// Local true-3D terrain models: discovered via /terrain/manifest.json
// (curated by 3d-assets/terrain-pipeline/curate.py — only dams with a
// clean real-DEM reconstruction are listed; everything else is globe).

/** Decode base64 float32 grids (sandbox/LISFLOOD payloads). */
function b64ToF32Console(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

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
    level: 'EXTREME' as const, color: '#dc2626', bgColor: '#fef2f2',
    description:
      'Tall dam with a very large reservoir. Breach consequences are classed high in this screening index — run an impact assessment for real exposure figures.',
  };
  if (composite > 0.45) return {
    level: 'HIGH' as const, color: '#ea580c', bgColor: '#fff7ed',
    description:
      'Large dam/reservoir combination. This index only ranks dam size; downstream population and damage come from the impact assessment.',
  };
  if (composite > 0.2) return {
    level: 'MODERATE' as const, color: '#ca8a04', bgColor: '#fefce8',
    description:
      'Mid-sized structure in this index. Localized consequences are typical, but the index does not model any flood.',
  };
  return {
    level: 'LOW' as const, color: '#16a34a', bgColor: '#f0fdf4',
    description:
      'Smaller structure in this index. Limited downstream consequences are typical — still worth an impact assessment where people live downstream.',
  };
}

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatType(type: string) {
  const map: Record<string, string> = {
    concrete_gravity: 'Concrete Gravity', concrete_arch: 'Concrete Arch',
    earthfill: 'Earthfill', rockfill: 'Rockfill', earthen: 'Earthen',
    masonry: 'Masonry', barrage: 'Barrage',
  };
  return map[type] || type;
}

// ── Main component ──────────────────────────────────────────────────
export default function IncidentConsole() {
  const [selectedDam, setSelectedDam] = useState<DamPoint | null>(null);
  // focusedDam drives the 3D/map view; selectedDam drives the details panel.
  // Closing the panel clears selectedDam but leaves the 3D view in place.
  const [focusedDam, setFocusedDam] = useState<DamPoint | null>(null);
  const [forceMap, setForceMap] = useState(false); // user override: globe instead of local 3D
  const [sandboxOpen, setSandboxOpen] = useState(false);
  // Cinematic AI handoff: terrain keeps orbiting behind the transition card
  // until the sequence completes and the real sandbox panel opens.
  const [sandboxTransition, setSandboxTransition] = useState(false);
  const [flood, setFlood] = useState<FloodOverlay | null>(null);
  // LISFLOOD-FP panel (deep-link entry only — the standalone button was
  // removed; the sandbox flow is the primary simulation path).
  const [lisfloodOpen, setLisfloodOpen] = useState(false);
  // Sandbox engine activity (drives the floating "AI is predicting" label).
  const [sandboxBusy, setSandboxBusy] = useState(false);
  // Background-preloaded sandbox results (fired the moment Run Sandbox is hit).
  const [sandboxPreload, setSandboxPreload] = useState<{ cases: any; run: any } | null>(null);
  // Preload failure text — silent catches used to make it look like nothing happened.
  const [preloadError, setPreloadError] = useState('');
  // Water plays WHILE the thinking card shows: the moment preloaded results
  // land, paint them on the terrain and advance the timeline behind the card.
  const thinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const thinkingRef = useRef(false);
  const thinkTRef = useRef(0);
  // Globe-first flow: after the globe settles on a dam, offer the 3D view.
  const [globeReady3D, setGlobeReady3D] = useState(false);
  // Bumped per dam pick; God's Eye reflys even when the same dam repeats.
  const [focusNonce, setFocusNonce] = useState(0);
  // Focused downstream city (from Evacuation Planner): marker + distance card.
  const [cityFocus, setCityFocus] = useState<{
    name: string; lon: number; lat: number;
    damlon: number; damlat: number; depth: string; arr: string;
  } | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [modelManifest, setModelManifest] = useState<Record<string, { file: string; name: string }> | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  // Evacuation-planner city waypoint, flown by the God's Eye camera.
  const [cityTarget, setCityTarget] = useState<{ lon: number; lat: number; heightM: number } | null>(null);

  // Local-3D model manifest (curated + on-demand captured; keyed by dam id).
  const refreshManifest = useCallback(() =>
    fetch(`/terrain/manifest.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setModelManifest(m); return m; })
      .catch(() => null), []);
  useEffect(() => {
    fetch('/terrain/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) setModelManifest(m); })
      .catch(() => {});
  }, []);

  const resolveModelSlug = useCallback((dam: DamPoint): string | null => {
    if (modelManifest && modelManifest[dam.id]) return modelManifest[dam.id].file;
    return null;
  }, [modelManifest]);

  // Warm the 3D terrain in the HTTP cache so the later 3D view opens fast.
  const preloadTerrain = useCallback((dam: DamPoint) => {
    const entry = modelManifest?.[dam.id];
    if (!entry) return;
    const slug = entry.file;
    [`/terrain/${slug}.glb`, `/terrain/${slug}.metadata.json`, `/terrain/${slug}.transform.json`].forEach((u) => {
      fetch(u, { cache: 'force-cache' }).catch(() => {});
    });
  }, [modelManifest]);

  const handleDamClick = useCallback((dam: DamPoint) => {
    setSelectedDam(dam);
    setFocusedDam(dam);
    setFocusNonce((n) => n + 1); // re-clicking the same dam reflys the globe
    setCityFocus(null);
    setCityTarget(null);
    // Globe-first, always: a sidebar pick dives the God's Eye globe to the
    // dam site (via focusDam + focusNonce). The separate true-3D terrain
    // opens ONLY via the per-row 3D button (openTerrain3D), the floating
    // "View 3D Terrain" button, or a simulation deep link — never as a
    // side effect of picking a dam.
    setForceMap(true);
    setGlobeReady3D(false);
    setSandboxOpen(false);
    setSandboxTransition(false);
    setSandboxPreload(null);
    setPreloadError('');
    setLisfloodOpen(false);
    setFlood(null);
    preloadTerrain(dam);
    window.setTimeout(() => setGlobeReady3D(true), 3400);
  }, [preloadTerrain]);

  // Dedicated 3D-terrain entry: per-row "3D" badge in the dam index.
  const openTerrain3D = useCallback((dam: DamPoint) => {
    setSelectedDam(dam);
    setFocusedDam(dam);
    setCityFocus(null);
    setCityTarget(null);
    setForceMap(false);
    setGlobeReady3D(false);
    setSandboxOpen(false);
    setSandboxTransition(false);
    setSandboxPreload(null);
    setPreloadError('');
    setLisfloodOpen(false);
    setFlood(null);
    preloadTerrain(dam);
  }, [preloadTerrain]);

  // ── On-demand terrain capture: every dam becomes 3D/sandbox capable ──
  // Dams missing a GLB get one built server-side (real DEM + imagery) the
  // moment any 3D entry is used, then the flow continues exactly like a
  // curated dam. Status flows into the sidebar badge + details panel.
  const [capturingDam, setCapturingDam] = useState<string | null>(null);
  const [captureMsg, setCaptureMsg] = useState('');
  const captureInFlight = useRef<string | null>(null);

  const ensureTerrain = useCallback(async (dam: DamPoint): Promise<string | null> => {
    const existing = modelManifest?.[dam.id];
    if (existing) return existing.file;
    if (captureInFlight.current === dam.id) return null; // already running
    captureInFlight.current = dam.id;
    setCapturingDam(dam.id);
    setCaptureMsg(`Capturing real 3D terrain for ${dam.name}… (~15 s)`);
    try {
      await sandboxApi.captureTerrain(dam.id);
      const m = await refreshManifest();
      setCaptureMsg('');
      return m?.[dam.id]?.file ?? null;
    } catch (e: any) {
      const detail = String(e?.message ?? e);
      const friendly = /API Error 503/.test(detail)
        ? 'Terrain unavailable for this site (DEM providers unreachable) — try again later.'
        : /API Error 4/.test(detail) ? 'Terrain capture rejected by the API.'
        : 'Terrain capture failed — check the backend is running.';
      setCaptureMsg(friendly);
      window.setTimeout(() => { setCaptureMsg((c) => (c === friendly ? '' : c)); }, 8000);
      return null;
    } finally {
      captureInFlight.current = null;
      setCapturingDam(null);
    }
  }, [modelManifest, refreshManifest]);

  /** Open the 3D terrain for ANY dam — auto-captures when no GLB exists. */
  const openOrCaptureTerrain = useCallback(async (dam: DamPoint) => {
    const slug = await ensureTerrain(dam);
    if (slug) openTerrain3D(dam);
  }, [ensureTerrain, openTerrain3D]);

  // Fire-and-forget sandbox preload: generate + likely-case run start the
  // moment Run Sandbox is hit, while the handoff card shows AI thinking.
  const fireSandboxPreload = useCallback((dam: DamPoint) => {
    setSandboxPreload(null);
    setPreloadError('');
    (async () => {
      try {
        const gen: any = await sandboxApi.generate(dam.id, 7, 10);
        const likely = gen?.likely ?? gen?.cases?.likely ?? null;
        const scenario = likely ?? {
          dam_id: dam.id, label: 'likely', reservoir_level_m: 0,
          breach_location: 'dam', breach_width_m: 80, breach_depth_m: 20,
          breach_severity: 'major', initial_release_m3: 25_000_000,
          roughness: 0.05, rainfall_factor: 1.0,
          duration_min: 180, timestep_s: 60, seed: 7,
        };
        const run = await sandboxApi.run(dam.id, scenario, 96);
        setSandboxPreload({ cases: gen, run });
      } catch (e: any) {
        // Surfaced under the Run button — the panel's manual controls remain.
        setPreloadError(`Preload failed (${e?.message ?? 'network error'}) — generate it manually in the panel.`);
      }
    })();
  }, []);

  const handleRunSandbox = useCallback(() => {
    if (!focusedDam) return;
    setLisfloodOpen(false);
    setFlood(null);
    // Traditional path: the sandbox water renders on the dam's true-3D
    // mesh (Local3DView), which opens now with the transition handoff.
    setForceMap(false);
    fireSandboxPreload(focusedDam);
    setSandboxTransition(true);
  }, [focusedDam, fireSandboxPreload]);

  /** Run Sandbox for ANY dam — capture first if needed, then simulate. */
  const handleRunSandboxAny = useCallback(async (dam: DamPoint) => {
    setSelectedDam(null); // panel hands over to the sim view
    const slug = await ensureTerrain(dam);
    if (!slug) return;
    openTerrain3D(dam);
    // Let the 3D view mount before the preload/transition fire.
    await Promise.resolve();
    setForceMap(false);
    fireSandboxPreload(dam);
    setSandboxTransition(true);
  }, [ensureTerrain, openTerrain3D, fireSandboxPreload]);

  // Deep-link: /incident?dam=d4 auto-selects (also used for screenshots).
  // &sandbox=1 opens the sandbox on the globe; &demo=1 auto-loads the offline Tehri demo.
  // &lisflood=1 opens the LISFLOOD-FP panel on the mesh; &job=<id> loads a completed run.
  // &globeCity=<name>&clon=&clat=&damlon=&damlat=&depth=&arr= focuses a city.
  const [autoDemo, setAutoDemo] = useState(false);
  const [deepJobId, setDeepJobId] = useState<string | null>(null);
  const deepLinkedRef = useRef(false);
  // Declutter: the dam index slides away while a simulation panel owns the
  // viewport; the floating button brings it back.
  useEffect(() => {
    if (sandboxOpen || lisfloodOpen) setSidebarOpen(false);
  }, [sandboxOpen, lisfloodOpen]);

  // Thinking-playback: paint preloaded water while the handoff card shows.
  useEffect(() => {
    const run = sandboxPreload?.run;
    if (!run || !sandboxTransition || thinkingRef.current) return;
    thinkingRef.current = true;
    try {
      const n = run.grid;
      const arrival = b64ToF32Console(run.grids.arrival_min_b64);
      const depth = b64ToF32Console(run.grids.maxdepth_m_b64);
      const maxT = run.summary?.sim_minutes ?? 180;
      const key = `think-${Date.now()}`;
      const bbox = run.bbox_wsen as [number, number, number, number] | undefined;
      thinkTRef.current = 0;
      setFlood({ key, arrival, depth, rows: n, cols: n, tMin: 0, visible: true, bboxWsen: bbox });
      thinkTimerRef.current = setInterval(() => {
        thinkTRef.current = Math.min(maxT, thinkTRef.current + Math.max(1, maxT / 24));
        const t = thinkTRef.current;
        setFlood({ key, arrival, depth, rows: n, cols: n, tMin: t, visible: true, bboxWsen: bbox });
      }, 500);
    } catch {
      thinkingRef.current = false;
    }
    return () => {
      if (thinkTimerRef.current) clearInterval(thinkTimerRef.current);
      thinkTimerRef.current = null;
      thinkingRef.current = false;
    };
  }, [sandboxPreload, sandboxTransition]);
  useEffect(() => {
    if (deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('dam');
    if (!id) return;
    const dam = INDIA_DAMS.find((d) => d.id === id);
    if (!dam) return;
    handleDamClick(dam);
    // Both simulation panels render on the dam mesh.
    const direct = q.get('direct') === '1' || q.get('lisflood') === '1' || q.get('sandbox') === '1';
    if (direct) setForceMap(false);
    if (FEATURES.sandboxFlood && q.get('sandbox') === '1') {
      setSandboxOpen(true);
      setSelectedDam(null);
      if (q.get('demo') === '1') setAutoDemo(true);
    }
    if (FEATURES.lisflood && q.get('lisflood') === '1') {
      setLisfloodOpen(true);
      setSelectedDam(null);
      if (q.get('job')) setDeepJobId(q.get('job'));
    }
  }, [handleDamClick]);

  // City focus links (Evacuation Planner → globe): re-run on query change.
  // Flies the God's Eye camera to the waypoint; the distance card renders
  // at map level below.
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
    setForceMap(true);
    setCityFocus({
      name,
      lon: clon,
      lat: clat,
      damlon: Number(q.get('damlon')) || 70.85,
      damlat: Number(q.get('damlat')) || 22.83,
      depth: q.get('depth') || '—',
      arr: q.get('arr') || '—',
    });
    setCityTarget({ lon: clon, lat: clat, heightM: 9000 });
  }, [location.search]);

  const hazard = selectedDam ? classifyHazard(selectedDam) : null;

  const filteredDams = searchQuery
    ? INDIA_DAMS.filter(d =>
        d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.state.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.river.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : INDIA_DAMS.sort((a, b) => b.height_m - a.height_m);

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
              <button onClick={() => setSidebarOpen(false)} className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]">
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
            <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">Height Distribution</p>
            {[
              { label: 'Mega (>200m)', color: '#D96B70', count: INDIA_DAMS.filter(d => d.height_m > 200).length },
              { label: 'Large (150-200m)', color: '#D8B24C', count: INDIA_DAMS.filter(d => d.height_m >= 150 && d.height_m <= 200).length },
              { label: 'Medium (100-150m)', color: '#D8B24C', count: INDIA_DAMS.filter(d => d.height_m >= 100 && d.height_m < 150).length },
              { label: 'Standard (50-100m)', color: '#65BFA9', count: INDIA_DAMS.filter(d => d.height_m >= 50 && d.height_m < 100).length },
              { label: 'Small (<50m)', color: '#91A2AD', count: INDIA_DAMS.filter(d => d.height_m < 50).length },
            ].map(({ label, color, count }) => (
              <div key={label} className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-xs text-cmd-muted flex-1">{label}</span>
                <span className="text-xs font-bold text-cmd-ink tabular-nums">{count}</span>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {filteredDams.map((dam) => (
              <button key={dam.id} onClick={() => handleDamClick(dam)}
                className={`w-full flex items-center gap-2 text-left p-2 rounded-xl transition-colors mb-1 border ${
                  selectedDam?.id === dam.id
                    ? 'bg-cmd-tealdim border-cmd-teal/30'
                    : 'border-transparent hover:bg-white/[0.04] hover:border-cmd-border'
                }`}>
                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: classifyHazard(dam).color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-cmd-ink truncate flex items-center gap-1.5">
                    <span className="truncate">{dam.name}</span>
                    {capturingDam === dam.id ? (
                      <span
                        role="button"
                        tabIndex={0}
                        title="Capturing real 3D terrain (DEM + imagery)…"
                        className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-md bg-cmd-teal/15 text-cmd-teal text-[9px] font-bold shrink-0 cursor-wait"
                      >
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />3D
                      </span>
                    ) : (
                      <span
                        role="button"
                        tabIndex={0}
                        title={modelManifest?.[dam.id] ? 'Open 3D terrain' : 'Build 3D terrain from real DEM, then open it'}
                        onClick={(e) => { e.stopPropagation(); openOrCaptureTerrain(dam); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openOrCaptureTerrain(dam); } }}
                        className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-md bg-cmd-teal/15 text-cmd-teal text-[9px] font-bold shrink-0 cursor-pointer hover:bg-cmd-teal/30 transition-colors"
                      >
                        <Box className="w-2.5 h-2.5" />3D
                      </span>
                    )}
                  </p>
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
            className="absolute top-3 left-3 z-20 p-2 bg-[#0A1218]/90 border border-cmd-border rounded-lg hover:border-cmd-teal/40 transition-colors" title="Show dam list">
            <PanelLeft className="w-4 h-4 text-cmd-muted" />
          </button>
        )}

        <div className="absolute top-3 right-14 z-20">
          <div className="px-3 py-1.5 bg-[#0A1218]/90 border border-cmd-border text-cmd-ink text-[10px] font-bold rounded-full">
            <span className="text-cmd-green">●</span> 👁 God's Eye 3D Globe
          </div>
        </div>

        {/* Floating AI activity label while the sandbox engine is computing */}
        {FEATURES.sandboxFlood && sandboxOpen && sandboxBusy && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-4 py-2 rounded-full border border-cmd-teal/40 bg-[#0A1218]/92">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cmd-teal opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cmd-teal" />
            </span>
            <span className="text-[11px] font-bold text-cmd-ink tracking-wide">AI IS PREDICTING</span>
            <span className="text-[10px] text-cmd-muted">running the water simulation</span>
          </div>
        )}

        {focusedDam && resolveModelSlug(focusedDam) && !forceMap ? (
          <>
            <Local3DView
              dam={focusedDam}
              slug={resolveModelSlug(focusedDam)!}
              hazardColor={focusedDam.id === selectedDam?.id ? hazard?.color ?? '#2563eb' : classifyHazard(focusedDam).color}
              onShowMap={() => setForceMap(true)}
              onClose={() => { setFocusedDam(null); setSandboxOpen(false); setSandboxTransition(false); setLisfloodOpen(false); setFlood(null); }}
              flood={flood}
              autoOrbit={sandboxTransition}
              cinematic={FEATURES.lisflood && lisfloodOpen}
              spin={sandboxOpen || lisfloodOpen}
              spinSpeed={2.4}
            />
            {/* Sandbox water renders on the mesh the traditional way. */}
            {FEATURES.sandboxFlood && sandboxTransition && !sandboxOpen && (
              <SandboxTransition
                damName={focusedDam.name}
                ready={!!sandboxPreload}
                onDone={() => { setSandboxTransition(false); setSandboxOpen(true); setSelectedDam(null); }}
              />
            )}
            {FEATURES.sandboxFlood && sandboxOpen && (
              <SandboxPanel
                dam={focusedDam}
                autoDemo={autoDemo}
                onFlood={setFlood}
                onBusyChange={setSandboxBusy}
                initialCases={sandboxPreload?.cases}
                initialRun={sandboxPreload?.run}
                initialTMin={thinkTRef.current}
                onClose={() => { setSandboxOpen(false); setFlood(null); setAutoDemo(false); setSandboxBusy(false); setSandboxPreload(null); }}
              />
            )}
            {FEATURES.lisflood && lisfloodOpen && (
              <LisfloodPanel
                dam={focusedDam}
                onFlood={setFlood}
                onClose={() => { setLisfloodOpen(false); setFlood(null); }}
                initialJobId={deepJobId}
              />
            )}
          </>
        ) : (
          <GodEye3D
            timeMinutes={0}
            impactData={null}
            cameraTarget={cityTarget}
            onCameraChange={() => {}}
            focusNonce={focusNonce}
            focusDam={(focusedDam ?? selectedDam)
              ? {
                  lon: (focusedDam ?? selectedDam)!.lon,
                  lat: (focusedDam ?? selectedDam)!.lat,
                  name: (focusedDam ?? selectedDam)!.name,
                }
              : null}
          />
        )}
        {/* Simulation entry + 3D entry live at map level (visible over 3D and globe) */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
          {FEATURES.sandboxFlood && focusedDam && resolveModelSlug(focusedDam) && !sandboxOpen && !sandboxTransition && !lisfloodOpen && (globeReady3D || !forceMap) && (
            <button
              onClick={handleRunSandbox}
              className="flex items-center gap-2 px-5 py-2 bg-cmd-panel2 border border-cmd-border text-cmd-ink text-[11px] font-bold rounded-full hover:border-cmd-teal/50 transition-colors"
              title="Pre-compute the likely breach case, then open the 3D terrain with the water simulation"
            >
              <FlaskConical className="w-3.5 h-3.5 text-cmd-teal" strokeWidth={1.75} />
              Run Sandbox
            </button>
          )}
          {captureMsg && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0A1218]/92 border border-cmd-teal/40 text-cmd-ink text-[10px] font-semibold rounded-full max-w-md text-center">
              <Loader2 className="w-3 h-3 animate-spin text-cmd-teal shrink-0" />
              {captureMsg}
            </div>
          )}
          {preloadError && !sandboxOpen && !sandboxTransition && (
            <div className="px-3 py-1.5 bg-[#0A1218]/92 border border-cmd-red/50 text-cmd-red text-[10px] font-semibold rounded-full max-w-md text-center">
              {preloadError}
            </div>
          )}
        </div>
        {focusedDam && forceMap && globeReady3D && !sandboxOpen && !sandboxTransition && !lisfloodOpen && (
          <button
            onClick={() => {
              if (!focusedDam) return;
              if (resolveModelSlug(focusedDam)) setForceMap(false);
              else openOrCaptureTerrain(focusedDam);
            }}
            disabled={capturingDam === focusedDam.id}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-5 py-2.5 rounded-full bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold transition-colors disabled:opacity-70 disabled:cursor-wait"
            style={{ boxShadow: '0 0 28px -8px rgba(101,191,169,0.55)' }}
            title={resolveModelSlug(focusedDam) ? 'Open the preloaded 3D terrain' : 'Capture the real 3D terrain, then open it'}
          >
            {capturingDam === focusedDam.id ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Capturing 3D Terrain…</>
            ) : (
              <><Mountain className="w-4 h-4" strokeWidth={2} /> View 3D Terrain</>
            )}
          </button>
        )}
        {/* Focused city card (Evacuation Planner links) — outside the dam branch */}
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

      {/* Dam data panel */}
      {selectedDam && (
        <div className="absolute right-0 top-0 bottom-0 w-80 bg-[#0A1218]/95 backdrop-blur border-l border-cmd-border z-20 flex flex-col"
          onClick={(e) => e.stopPropagation()}>
          <div className="p-4 overflow-y-auto flex-1">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold text-cmd-ink">{selectedDam.name}</h3>
                <p className="text-sm text-cmd-muted">{selectedDam.state} • {selectedDam.river} River</p>
              </div>
              <button onClick={() => setSelectedDam(null)}
                className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]">
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

            <div className="border-t border-cmd-border pt-3 mt-3 space-y-2">
              <button onClick={() => { setForceMap(true); setFocusNonce((n) => n + 1); }}
                title="Dive the God's Eye globe to this dam"
                className="w-full px-3 py-2 bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold rounded-lg transition-colors">
                Zoom to Dam on 3D Globe
              </button>
              <button
                onClick={() => selectedDam && handleRunSandboxAny(selectedDam)}
                disabled={capturingDam === selectedDam.id}
                title={modelManifest?.[selectedDam.id]
                  ? 'Open the 3D terrain and run the water simulation'
                  : 'Capture the real 3D terrain, then run the water simulation'}
                className="w-full px-3 py-2 border border-cmd-teal/50 hover:bg-cmd-teal/10 text-cmd-teal text-xs font-bold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-2">
                {capturingDam === selectedDam.id ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Capturing 3D Terrain…</>
                ) : (
                  <><FlaskConical className="w-3.5 h-3.5" /> Run Sandbox on 3D Terrain</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

