/**
 * AquaShield 3D — Scenario Simulation Sandbox panel.
 *
 * Path: Dam → View 3D terrain / Run screening simulation → this panel.
 * Terrain stays locked as the sim domain (camera/nav untouched); the panel
 * owns scenario inputs, run controls, timeline, results and the run status
 * (running / engine output / failure with setup steps — never a faked step).
 *
 * Scientific boundary (shown in-UI, not just docs): simplified
 * terrain-constrained screening model — NOT hydrodynamics/CFD/HEC-RAS.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { ArrowLeft, Play, Pause, RotateCcw, FlaskConical, Layers, Sparkles, Download, Bot, ChevronDown, AlertTriangle, Globe, Loader2 } from 'lucide-react';
import { dangerIndex, dangerSentence, bandForDepth } from '../../utils/danger';
import { Area, AreaChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { sandboxApi } from '../../api/client';
import type { DamPoint } from '../../data/india-dams';
import type { FloodOverlay } from '../../viewers/local-3d/Local3DView';

interface SandboxPanelProps {
  dam: DamPoint;
  /** Run the likely case as soon as the panel mounts (Run simulation entry). */
  autoRun?: boolean;
  onFlood: (f: FloodOverlay | null) => void;
  /** Leave the simulation view (back to the globe). */
  onExit: () => void;
  /** Reports whether a run is in flight — the terrain slowly orbits while true. */
  onBusyChange?: (busy: boolean) => void;
}

function b64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Settlements (vs. facilities) — used for the plain-language exposure sentence. */
const SETTLEMENT_KINDS = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood']);

const DEFAULTS = {
  breach_width_m: 80,
  breach_depth_m: 20,
  breach_severity: 'major',
  initial_release_m3: 25_000_000,
  roughness: 0.05,
  rainfall_factor: 1.0,
  duration_min: 180,
};

export default function SandboxPanel({ dam, autoRun, onFlood, onExit, onBusyChange }: SandboxPanelProps) {
  const [params, setParams] = useState({ ...DEFAULTS, breach_severity: 'major' as string });
  const [cases, setCases] = useState<any | null>(null);
  const [activeCase, setActiveCase] = useState<'best' | 'likely' | 'worst' | 'custom'>('likely');
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [run, setRun] = useState<any | null>(null);
  const [ensemble, setEnsemble] = useState<any | null>(null);
  const [overlayMode, setOverlayMode] = useState<'run' | 'ensemble'>('run');
  const [showDetails, setShowDetails] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const navigate = useNavigate();
  const [tMin, setTMin] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(8); // sim-minutes per second
  // True when the last failure was "nothing is listening on /api/v1".
  const [backendDown, setBackendDown] = useState(false);
  // Elapsed seconds for the honest "still computing" readout during a run.
  const [elapsed, setElapsed] = useState(0);
  // Flips true once playback reaches the end so results scroll into view.
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const justFinishedRef = useRef(false);
  const gridsRef = useRef<{ arrival: Float32Array; depth: Float32Array; rows: number; cols: number; key: string; bbox?: [number, number, number, number] } | null>(null);
  const maxT = run?.summary?.sim_minutes ?? 180;

  const fail = (e: any) => {
    const down = e?.name === 'BackendUnavailableError';
    setBackendDown(down);
    setError(down ? 'The screening model runs on the backend, which is not answering.' : String(e?.message ?? e));
  };

  // Terrain ambience: the mesh slowly orbits whenever a request is in flight.
  useEffect(() => {
    onBusyChange?.(!!busy);
  }, [busy, onBusyChange]);

  // Elapsed-seconds counter while the backend computes (honest: one request,
  // no fake stage progress — just how long it has actually been running).
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, [busy]);

  // Deterministic demo entry: loads the precomputed Tehri bundle (no backend,
  // no API keys). Offered only for Tehri, which is the dam it was built for.
  const demoAvailable = dam.id === 'd4';
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRun && !autoRanRef.current) {
      autoRanRef.current = true;
      void doRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const set = (k: string, v: number | string) => setParams((p) => ({ ...p, [k]: v }));

  // ── Decode + publish overlay ─────────────────────────────────────
  // bbox (backend `bbox_wsen`) travels with the grids so the God's Eye
  // globe can drape the same water on its terrain — no mesh required.
  const publish = (arrival: Float32Array, depth: Float32Array, rows: number, cols: number, key: string, t: number, bbox?: [number, number, number, number]) => {
    gridsRef.current = { arrival, depth, rows, cols, key, bbox };
    onFlood({ key, arrival, depth, rows, cols, tMin: t, visible: true, bboxWsen: bbox });
  };

  const showRun = (runData: any, t: number) => {
    const n = runData.grid;
    publish(b64ToF32(runData.grids.arrival_min_b64), b64ToF32(runData.grids.maxdepth_m_b64), n, n, `run-${runData.scenario.label}-${Date.now()}`, t, runData.bbox_wsen);
  };

  const showEnsemble = (ens: any, t: number) => {
    const n = ens.grid;
    publish(b64ToF32(ens.aggregate_grids.earliest_min_b64), b64ToF32(ens.aggregate_grids.maxdepth_m_b64), n, n, `ens-${Date.now()}`, t, ens.bbox_wsen);
  };

  // ── Timeline playback ────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setTMin((t) => {
        const next = t + speed / 10;
        if (next >= maxT) {
          setPlaying(false);
          return maxT;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, speed, maxT]);

  // When the propagation animation completes, bring the results into view.
  useEffect(() => {
    if (playing || !run) {
      justFinishedRef.current = false;
      return;
    }
    if (tMin >= maxT && !justFinishedRef.current) {
      justFinishedRef.current = true;
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [playing, tMin, maxT, run]);

  useEffect(() => {
    const g = gridsRef.current;
    if (!g) return;
    onFlood({ key: g.key, arrival: g.arrival, depth: g.depth, rows: g.rows, cols: g.cols, tMin, visible: true, bboxWsen: g.bbox });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tMin]);

  // ── Actions ──────────────────────────────────────────────────────
  const runCase = async (scenario: any) => {
    setBusy('run'); setError('');
    try {
      const res = await sandboxApi.run(dam.id, scenario, 96);
      setBackendDown(false);
      setRun(res);
      setEnsemble(null);
      setOverlayMode('run');
      setTMin(0);
      showRun(res, 0);
      setPlaying(true);
    } catch (e: any) { fail(e); } finally { setBusy(''); }
  };

  const doGenerate = async (thenRun = false) => {
    setBusy('gen'); setError('');
    try {
      const res = await sandboxApi.generate(dam.id, 7, 10);
      setBackendDown(false);
      setCases(res);
      setActiveCase('likely');
      if (thenRun) await runCase(res.likely);
    } catch (e: any) { fail(e); } finally { setBusy(''); }
  };

  const currentScenario = useMemo(() => {
    if (activeCase === 'custom' || !cases) {
      return { dam_id: dam.id, label: cases ? 'custom' : 'likely (default parameters)', reservoir_level_m: 0, breach_location: 'dam', timestep_s: 60, seed: 7, ...params };
    }
    return cases[activeCase];
  }, [activeCase, cases, dam.id, params]);

  /** Run the selected case. With no generated cases yet, generate + run the
   * likely case first so one click always produces engine output. */
  const doRun = async () => {
    if (!cases && activeCase !== 'custom') await doGenerate(true);
    else await runCase(currentScenario);
  };

  const doEnsemble = async () => {
    setBusy('ens'); setError('');
    try {
      const res = await sandboxApi.ensemble(dam.id, 10, 7, 64);
      setBackendDown(false);
      setEnsemble(res);
      setOverlayMode('ensemble');
      setTMin(0);
      showEnsemble(res, 0);
      setPlaying(true);
    } catch (e: any) { fail(e); } finally { setBusy(''); }
  };

  const doDemo = async () => {
    setBusy('demo'); setError('');
    try {
      const bundle = await sandboxApi.demoTehri();
      const demoRun = {
        scenario: bundle.scenario, grid: bundle.grid, summary: bundle.summary,
        assets: bundle.assets, asset_provenance: bundle.asset_provenance,
        explanation: bundle.explanation, grids: bundle.grids,
        bbox_wsen: bundle.bbox_wsen,
        demo_mode: bundle.mode,
      };
      setBackendDown(false);
      setActiveCase('worst');
      setRun(demoRun);
      setEnsemble(null);
      setOverlayMode('run');
      setTMin(0);
      showRun(demoRun, 0);
      setPlaying(true);
    } catch (e: any) { fail(e); } finally { setBusy(''); }
  };

  const doReset = () => {
    setPlaying(false);
    setTMin(0);
    gridsRef.current = null;
    onFlood(null);
    setRun(null);
    setEnsemble(null);
  };

  const assets = run?.assets ?? [];
  const shownSummary = overlayMode === 'ensemble' && ensemble ? null : run?.summary;
  const explanation = overlayMode === 'ensemble' && ensemble ? ensemble.explanation : run?.explanation;
  const runMode: string | null = overlayMode === 'ensemble' && ensemble ? (ensemble.mode ?? null) : (run?.mode ?? null);
  const terrain: any = overlayMode === 'ensemble' && ensemble ? ensemble.terrain : run?.terrain;
  const hydro: any = overlayMode === 'ensemble' && ensemble ? null : run?.hydrograph;
  const priorityZones = [...assets]
    .filter((a: any) => a.arrival_min != null)
    .sort((a: any, b: any) => (b.severity - a.severity) || (a.arrival_min - b.arrival_min))
    .slice(0, 5);

  /** Hand the whole run to the AI assistant — no dropdowns for the user. */
  const assistWithRun = () => {
    try {
      sessionStorage.setItem('damsafe-assist-context', JSON.stringify({
        dam_id: dam.id,
        dam_name: dam.name,
        kind: 'sandbox',
        label: run?.scenario?.label ?? activeCase,
        summary: run?.summary ?? null,
        impacts: (run?.assets ?? []).slice(0, 12),
      }));
    } catch { /* private mode — assistant opens without context */ }
    navigate('/assistant?ctx=1');
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="absolute right-3 top-3 bottom-3 w-[22rem] border border-cmd-border bg-[#0A1218]/95 backdrop-blur rounded-2xl z-30 flex flex-col"
      style={{ boxShadow: '0 0 32px -12px rgba(101,191,169,0.30)' }}
      onClick={(e) => e.stopPropagation()}>
      <div className="p-4 overflow-y-auto flex-1">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h3 className="text-sm font-bold text-cmd-ink flex items-center gap-1.5">
              <FlaskConical className="w-4 h-4 text-cmd-teal" /> Simulation Sandbox
            </h3>
            <p className="text-[11px] text-cmd-muted">{dam.name} — terrain locked as sim domain</p>
          </div>
          {/* This panel sits over the terrain viewer's own top-right chrome,
              so it carries the way back out. */}
          <button onClick={onExit} title="Close the simulation and go back to the globe"
            className="flex items-center gap-1 rounded-lg border border-cmd-border px-2 py-1 text-[10px] font-bold text-cmd-muted hover:text-cmd-ink hover:border-cmd-teal/40">
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} /> <Globe className="w-3.5 h-3.5" strokeWidth={1.75} /> Globe
          </button>
        </div>
        {runMode && (
          <p className={`text-[10px] font-bold rounded-lg px-2 py-1.5 mb-2 ${runMode.startsWith('REAL') ? 'text-cmd-green bg-cmd-green/[0.08] border border-cmd-green/25' : 'text-cmd-teal bg-cmd-teal/[0.08] border border-cmd-teal/25'}`}>
            {runMode.startsWith('REAL') ? '● REAL COMPUTED SIMULATION' : '● OFFLINE DEMO'} — {runMode}
          </p>
        )}
        {terrain && (
          <p className="text-[10px] text-cmd-muted bg-cmd-panel2/60 border border-cmd-border rounded-lg px-2 py-1.5 mb-2">
            Terrain: <b>{terrain.source}{terrain.dataset ? ` / ${terrain.dataset}` : ''}</b>
            {terrain.resolution_m ? ` • ${terrain.resolution_m} m` : ''}
            {terrain.fallback_used ? ` • fallback (${terrain.fallback_reason || 'auto'})` : ' • primary source'}
          </p>
        )}
        {(run as any)?.river_conditioning && (
          <p className="text-[10px] text-cmd-muted bg-cmd-panel2/60 border border-cmd-border rounded-lg px-2 py-1.5 mb-2">
            River conditioning: breach snapped to channel ({(run as any).river_conditioning.breach_acc_cells} upstream cells)
            {' '}• {(run as any).river_conditioning.channel_cells} channel cells • burn {(run as any).river_conditioning.burn_max_m} m
            {(run as any).river_conditioning.sill_carve_max_m > 0 ? ` • sill carve ${(run as any).river_conditioning.sill_carve_max_m} m` : ''}
            {' '}• {(run as any).river_conditioning.inflow_cells}-cell wave inflow
          </p>
        )}
        <p className="text-[10px] text-cmd-amber bg-cmd-amber/[0.08] border border-cmd-amber/25 rounded-lg px-2 py-1.5 mb-3">
          Screening model — terrain-constrained propagation, <b>not</b> hydrodynamics/CFD. Compare cases, don't treat outputs as predictions.
        </p>

        {/* ── Run status: idle / running / failed / done — never a faked step ── */}
        {busy && (
          <div className="flex items-center gap-2.5 rounded-xl border border-cmd-teal/30 bg-cmd-teal/[0.08] px-3 py-2.5 mb-3">
            <Loader2 className="w-4 h-4 text-cmd-teal animate-spin shrink-0" />
            <div className="min-w-0">
              <p className="text-[11px] font-bold text-cmd-ink">
                {busy === 'gen' ? 'Generating breach parameter cases…'
                  : busy === 'ens' ? 'Running 10 scenarios on the backend…'
                  : busy === 'demo' ? 'Loading the precomputed demo bundle…'
                  : 'Running the screening model on the backend…'}
              </p>
              <p className="text-[10px] text-cmd-muted">
                Breach hydrograph → terrain-constrained inundation → settlement sampling
                {elapsed > 0 && <span className="ml-2 font-mono font-bold text-cmd-ink/80">{elapsed}s elapsed</span>}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-cmd-red/30 bg-cmd-red/[0.08] px-3 py-2.5 mb-3">
            <p className="flex items-start gap-2 text-[11px] font-semibold text-cmd-ink">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-cmd-red" strokeWidth={2} />
              <span className="min-w-0 break-words">{error}</span>
            </p>
            {backendDown && (
              <>
                <pre className="mt-2 overflow-x-auto rounded-lg border border-cmd-border bg-black/40 px-2 py-1.5 text-[9.5px] leading-relaxed text-cmd-ink/90">cd backend && uvicorn app.main:app --reload --port 8000</pre>
                <p className="mt-1.5 text-[10px] text-cmd-muted">
                  {demoAvailable
                    ? 'No keys are needed once it is up. The precomputed Tehri demo below works without it.'
                    : 'No API keys are needed once it is up.'}
                </p>
                <div className="mt-2 flex gap-1.5">
                  <button onClick={() => void doGenerate(true)} className="rounded-lg border border-cmd-teal/50 px-2.5 py-1 text-[10.5px] font-bold text-cmd-teal hover:bg-cmd-tealdim">
                    Retry
                  </button>
                  {demoAvailable && (
                    <button onClick={doDemo} className="rounded-lg border border-cmd-green/50 px-2.5 py-1 text-[10.5px] font-bold text-cmd-green hover:bg-cmd-green/10">
                      Load offline demo
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {run && !busy && !error && (
          <p className="text-[10px] text-cmd-green bg-cmd-green/[0.08] border border-cmd-green/25 rounded-lg px-2 py-1.5 mb-3">
            <b>{run.demo_mode ? 'Offline demo loaded' : 'Engine output on the terrain'}</b>
            {' — '}{run.summary?.flooded_area_km2} km² modelled inundation, deepest {run.summary?.max_depth_anywhere_m} m,
            {' '}{run.summary?.timesteps ?? 0} checkpoints over T+{Math.round(run.summary?.sim_minutes ?? 0)} min.
            {run.demo_mode ? ` ${run.demo_mode}` : ''}
          </p>
        )}

        {/* Full computed decision-support results live in the impact workspace. */}
        {run && !busy && !error && (
          <button
            onClick={() => navigate(`/impact?dam=${encodeURIComponent(dam.id)}&case=${activeCase === 'custom' ? 'likely' : activeCase}`)}
            className="mb-3 w-full rounded-xl border border-cmd-teal/40 bg-cmd-teal/[0.08] px-3 py-2.5 text-left transition-colors hover:bg-cmd-teal/[0.14]"
          >
            <span className="block text-[12px] font-bold text-cmd-teal">Open the decision-support dashboard →</span>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-cmd-muted">
              Priority locations, asset exposure, evacuation candidates and the WHERE/WHEN/WHO/WHY summary for this dam.
            </span>
          </button>
        )}

        {/* ── Scenario inputs ── */}
        <p className="text-[10px] uppercase tracking-wider text-cmd-muted font-semibold mb-2">Breach scenario</p>
        <div className="grid grid-cols-2 gap-2 mb-2">
          {[
            { k: 'breach_width_m', label: 'Breach width (m)', min: 10, max: 2000 },
            { k: 'breach_depth_m', label: 'Breach depth (m)', min: 2, max: 500 },
            { k: 'initial_release_m3', label: 'Release (M m³)', min: 0.1, max: 5000, scale: 1e6 },
            { k: 'roughness', label: "Friction n", min: 0.005, max: 0.5, step: 0.005 },
            { k: 'rainfall_factor', label: 'Rainfall ×', min: 0, max: 5, step: 0.1 },
            { k: 'duration_min', label: 'Duration (min)', min: 15, max: 1440, step: 15 },
          ].map(({ k, label, min, max, step, scale }) => (
            <label key={k} className="bg-cmd-panel2/60 rounded-lg p-2 block">
              <span className="text-[10px] text-cmd-muted font-semibold">{label}</span>
              <input
                type="number" min={min} max={max} step={step ?? 1}
                value={scale ? (params as any)[k] / scale : (params as any)[k]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) set(k, scale ? v * scale : v);
                }}
                className="w-full text-sm font-bold text-cmd-ink bg-transparent focus:outline-none"
              />
            </label>
          ))}
        </div>
        <div className="flex gap-1.5 mb-3">
          {(['partial', 'major', 'full'] as const).map((s) => (
            <button key={s} onClick={() => { set('breach_severity', s); setActiveCase('custom'); }}
              className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-semibold ${params.breach_severity === s ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.06] text-cmd-ink/80'}`}>
              {s}
            </button>
          ))}
        </div>

        {/* ── Agent cases ── */}
        <div className="flex gap-1.5 mb-2">
          <button onClick={() => void doGenerate()} disabled={!!busy}
            className="flex-1 px-2 py-1.5 bg-white/[0.07] text-cmd-ink text-[11px] font-bold rounded-lg hover:bg-white/[0.12] disabled:opacity-50">
            {busy === 'gen' ? '…' : '✨ Generate best/likely/worst'}
          </button>
          {demoAvailable && (
            <button onClick={doDemo} disabled={!!busy} title="Precomputed Tehri bundle — no backend, no API keys"
              className="flex-1 px-2 py-1.5 bg-cmd-green/15 text-cmd-green text-[11px] font-bold rounded-lg hover:bg-cmd-green/25 disabled:opacity-50">
              {busy === 'demo' ? '…' : <span className="flex items-center justify-center gap-1"><Download className="w-3 h-3" /> Offline demo</span>}
            </button>
          )}
        </div>
        {cases && (
          <div className="flex gap-1.5 mb-3">
            {(['best', 'likely', 'worst'] as const).map((c) => (
              <button key={c} onClick={() => setActiveCase(c)}
                className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-bold capitalize ${activeCase === c ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.06] text-cmd-ink/80'}`}>
                {c}
              </button>
            ))}
            <button onClick={() => setActiveCase('custom')}
              className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-bold ${activeCase === 'custom' ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.06] text-cmd-ink/80'}`}>
              Custom
            </button>
          </div>
        )}

        {/* ── Run ── */}
        <div className="flex gap-1.5 mb-3">
          <button onClick={doRun} disabled={!!busy}
            className="flex-1 px-2 py-2 bg-cmd-teal/90 text-[#071018] text-xs font-bold rounded-lg hover:bg-cmd-teal disabled:opacity-50">
            {busy === 'run' ? 'Running…' : `▶ Run ${activeCase} case`}
          </button>
          <button onClick={doEnsemble} disabled={!!busy} title="10 scenarios, aggregated exposure"
            className="flex-1 px-2 py-2 bg-cmd-panel2 text-cmd-ink text-xs font-bold rounded-lg hover:bg-cmd-panel2 disabled:opacity-50">
            {busy === 'ens' ? 'Running…' : <span className="flex items-center justify-center gap-1"><Layers className="w-3.5 h-3.5" /> Ensemble ×10</span>}
          </button>
        </div>

        {/* ── Timeline ── */}
        {(run || ensemble) && (
          <div className="bg-cmd-panel2/60 rounded-lg p-2.5 mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <button onClick={() => setPlaying(!playing)} className="p-1.5 rounded-lg bg-cmd-teal/90 text-[#071018]">
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <button onClick={doReset} className="p-1.5 rounded-lg bg-white/[0.08] text-cmd-ink/80" title="Reset results">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <input type="range" min={0} max={maxT} step={1} value={tMin}
                onChange={(e) => { setPlaying(false); setTMin(Number(e.target.value)); }}
                className="flex-1 h-1.5 accent-[#65BFA9]" />
              <span className="text-[11px] font-mono font-bold text-cmd-ink/90 w-14 text-right">T+{Math.round(tMin)}m</span>
            </div>
            {/* Modelled timeline ticks: quick jumps every few sim-minutes.
                Timestamps come from the sim duration (maxT), not invented ones. */}
            {(() => {
              const step = maxT <= 30 ? 5 : maxT <= 90 ? 10 : 30;
              const ticks: number[] = [];
              for (let t = 0; t <= maxT; t += step) ticks.push(t);
              if (ticks[ticks.length - 1] < maxT) ticks.push(Math.round(maxT));
              return (
                <div className="mb-1.5 flex items-center gap-1">
                  {ticks.map((t) => (
                    <button key={t} onClick={() => { setPlaying(false); setTMin(t); }}
                      title={`Jump to T+${t} min (modelled)`}
                      className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold transition-colors ${
                        Math.abs(tMin - t) < step / 2 ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.06] text-cmd-muted hover:text-cmd-ink'
                      }`}>
                      T+{t}
                    </button>
                  ))}
                </div>
              );
 })()}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-cmd-muted">Speed:</span>
              {[2, 8, 30].map((s) => (
                <button key={s} onClick={() => setSpeed(s)}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold ${speed === s ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.08] text-cmd-ink/80'}`}>
                  {s}×
                </button>
              ))}
              {ensemble && (
                <span className="ml-auto flex gap-1">
                  <button onClick={() => { setOverlayMode('run'); if (run) showRun(run, tMin); }}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${overlayMode === 'run' ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.08] text-cmd-ink/80'}`}>Worst run</button>
                  <button onClick={() => { setOverlayMode('ensemble'); if (ensemble) showEnsemble(ensemble, tMin); }}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${overlayMode === 'ensemble' ? 'bg-cmd-teal/90 text-[#071018]' : 'bg-white/[0.08] text-cmd-ink/80'}`}>Ensemble</button>
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Results, plain language ── */}
        {shownSummary && (() => {
          const crit = Number(shownSummary.assets_critical ?? 0);
          const maxD = Number(shownSummary.max_depth_anywhere_m ?? 0);
          const band = shownSummary.severity_band ?? bandForDepth(maxD);
          const { score, label } = dangerIndex(band, crit);
          const firstArr = shownSummary.earliest_asset_arrival_min;
          // "Reached" = points the simulated water actually arrived at. The
          // summary's assets_evaluated counts every sampled point, wet or dry.
          const reachedPoints = (assets as any[]).filter((a) => a.arrival_min != null);
          const reached = reachedPoints.length;
          const isSettlement = (a: any) => SETTLEMENT_KINDS.has(String(a.kind ?? '').toLowerCase());
          const reachedSettlements = reachedPoints.filter(isSettlement).length;
          const sampledSettlements = (assets as any[]).filter(isSettlement).length;
          // Depth at a place water actually reached — the number that speaks to
          // people. `maxD` is the deepest single modelled cell, which in a
          // closed domain is usually narrow-gorge ponding near the breach and
          // can be orders of magnitude larger; reporting only that beside
          // "places reached: 4" reads as a contradiction (182 m vs 0.55 m).
          const deepestReached = reachedPoints.reduce(
            (m: number, a: any) => Math.max(m, Number(a.max_depth_m ?? 0)), 0);
          const gaugeColor = score >= 75 ? '#D96B70' : score >= 55 ? '#D8B24C' : '#55C99A';
          const RR = 30;
          const CC = 2 * Math.PI * RR;
          const timelineMax = Math.max(maxT, firstArr ?? 0, 1);
          return (
            <div className="mb-3 rounded-xl border border-cmd-border overflow-hidden" ref={resultsRef}>
              <div className="px-3 py-2.5 bg-cmd-panel2 flex items-center gap-3">
                <svg width="60" height="60" viewBox="0 0 72 72" className="shrink-0">
                  <circle cx="36" cy="36" r={RR} fill="none" stroke="#1E2E38" strokeWidth="8" />
                  <circle cx="36" cy="36" r={RR} fill="none" stroke={gaugeColor} strokeWidth="8"
                    strokeLinecap="round" strokeDasharray={`${(CC * score / 100).toFixed(1)} ${CC.toFixed(1)}`}
                    transform="rotate(-90 36 36)" />
                  <text x="36" y="41" textAnchor="middle" fill="#E8EEF0" fontSize="16" fontWeight="800">{score}</text>
                </svg>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-muted">Danger index</p>
                  <p className="text-sm font-extrabold text-cmd-ink">{label} <span className="font-normal text-cmd-muted">• {activeCase} case</span></p>
                  <p className="text-[11px] text-cmd-ink/85 leading-snug mt-0.5">
                    {dangerSentence(reachedSettlements, sampledSettlements, firstArr, reached ? deepestReached : null)}
                  </p>
                </div>
              </div>

              <div className="p-2.5 grid grid-cols-3 gap-1.5 text-center">
                {[
                  { l: 'Places reached', v: String(reached) },
                  { l: 'First water', v: firstArr != null ? `~${Math.round(firstArr)} min` : '—' },
                  { l: 'Deepest at a place', v: reached ? `${deepestReached.toFixed(2)} m` : '—' },
                ].map(({ l, v }) => (
                  <div key={l} className="bg-cmd-panel2/60 rounded-lg p-2">
                    <p className="text-[10px] text-cmd-muted font-semibold">{l}</p>
                    <p className="text-sm font-bold text-cmd-ink tabular-nums">{v}</p>
                  </div>
                ))}
              </div>

              {/* Arrival timeline: who gets water, and when */}
              {priorityZones.length > 0 && (
                <div className="px-3 pb-1">
                  <p className="text-[10px] font-bold text-cmd-muted mb-1.5">WHO GETS WATER FIRST</p>
                  <div className="relative h-9 rounded-lg bg-cmd-bg border border-cmd-border/60">
                    <div className="absolute left-2 right-2 top-1/2 h-0.5 -translate-y-1/2 bg-cmd-track rounded" />
                    {priorityZones.map((a: any, i: number) => {
                      const pct = Math.min(96, Math.max(4, (a.arrival_min / timelineMax) * 100));
                      return (
                        <div key={i} className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex flex-col items-center"
                          style={{ left: `calc(${(pct).toFixed(1)}% )` }} title={`${a.name} — T+${Math.round(a.arrival_min)} min, ${a.max_depth_m} m`}>
                          <span className="w-2.5 h-2.5 rounded-full border-2 border-[#0A1218]"
                            style={{ background: i < 2 ? '#D96B70' : '#D8B24C' }} />
                          <span className="mt-0.5 max-w-[64px] truncate text-[8.5px] font-bold text-cmd-ink/90">{a.name}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[9px] text-cmd-muted font-mono mt-0.5 tabular-nums">
                    <span>now</span><span>T+{Math.round(timelineMax)} min</span>
                  </div>
                </div>
              )}

              <div className="p-2.5 pt-1">
                <button onClick={assistWithRun}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold transition-colors"
                  style={{ boxShadow: '0 0 24px -10px rgba(101,191,169,0.5)' }}>
                  <Bot className="w-4 h-4" strokeWidth={2} />
                  Ask AI assistant about this run
                </button>
                <p className="mt-1 text-center text-[10px] text-cmd-muted">
                  Opens the assistant with this dam, danger index {score} and all results attached — just ask.
                </p>
              </div>

              <div className="px-2.5 pb-2.5">
                <button onClick={() => setShowDetails(!showDetails)}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-bold text-cmd-muted hover:text-cmd-teal">
                  Technical details
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDetails ? '' : '-rotate-90'}`} />
                </button>
                {showDetails && (
                  <div className="rounded-lg border border-cmd-border/60 p-2 space-y-2">
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { l: 'Peak discharge', v: shownSummary.peak_discharge_m3s != null ? `${Number(shownSummary.peak_discharge_m3s).toLocaleString()} m³/s` : '—' },
                        { l: 'Max flooded area', v: `${shownSummary.flooded_area_km2} km²` },
                        { l: 'Max water depth*', v: `${shownSummary.max_depth_anywhere_m} m` },
                        { l: 'First arrival', v: shownSummary.earliest_asset_arrival_min != null ? `T+${shownSummary.earliest_asset_arrival_min}m` : '—' },
                        { l: 'Assets sampled', v: `${reached} reached of ${shownSummary.assets_evaluated ?? assets.length}` },
                        { l: 'Critical assets', v: String(shownSummary.assets_critical) },
                      ].map(({ l, v }) => (
                        <div key={l} className="bg-cmd-panel2/60 rounded-lg p-2">
                          <p className="text-[10px] text-cmd-muted font-semibold">{l}</p>
                          <p className="text-sm font-bold text-cmd-ink tabular-nums">{v}</p>
                        </div>
                      ))}
                    </div>
                    {hydro && (
                      <p className="text-[10px] text-cmd-muted">
                        Hydrograph peak T+{hydro.time_to_peak_min}m • volume {Number(hydro.total_volume_m3).toLocaleString()} m³ • {shownSummary.timesteps ?? 0} timesteps.
                      </p>
                    )}
                    {hydro?.times_min && (
                      <div className="rounded-lg border border-cmd-border/60 bg-cmd-bg p-2">
                        <p className="text-[10px] font-bold text-cmd-muted mb-1">BREACH HYDROGRAPH (computed)</p>
                        <div style={{ width: '100%', height: 96 }}>
                          <ResponsiveContainer>
                            <AreaChart data={hydro.times_min.map((t: number, i: number) => ({ t, q: hydro.discharge_m3s[i] }))} margin={{ top: 2, right: 4, bottom: 0, left: -18 }}>
                              <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#91A2AD' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `T+${Math.round(v)}`} />
                              <YAxis tick={{ fontSize: 9, fill: '#91A2AD' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`} />
                              <Tooltip formatter={(v: any) => [`${Number(v).toLocaleString()} m³/s`, 'Q']} labelFormatter={(v: any) => `T+${v} min`}
                                contentStyle={{ background: '#14222B', border: '1px solid #263742', borderRadius: 8, fontSize: 11, color: '#E8EEF0' }} />
                              <Area type="monotone" dataKey="q" stroke="#65BFA9" strokeWidth={2} fill="#65BFA9" fillOpacity={0.18} isAnimationActive={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                    {run?.frames?.length > 1 && overlayMode === 'run' && (
                      <div className="rounded-lg border border-cmd-border/60 bg-cmd-bg p-2">
                        <p className="text-[10px] font-bold text-cmd-muted mb-1">FLOODED AREA OVER TIME (computed)</p>
                        <div style={{ width: '100%', height: 80 }}>
                          <ResponsiveContainer>
                            <LineChart data={run.frames.map((f: any) => ({ t: f.t_min, a: f.flooded_area_km2 }))} margin={{ top: 2, right: 4, bottom: 0, left: -14 }}>
                              <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#91A2AD' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `T+${Math.round(v)}`} />
                              <YAxis tick={{ fontSize: 9, fill: '#91A2AD' }} tickLine={false} axisLine={false} />
                              <Tooltip formatter={(v: any) => [`${v} km²`, 'Area']} labelFormatter={(v: any) => `T+${v} min`}
                                contentStyle={{ background: '#14222B', border: '1px solid #263742', borderRadius: 8, fontSize: 11, color: '#E8EEF0' }} />
                              <Line type="monotone" dataKey="a" stroke="#65BFA9" strokeWidth={2} dot={false} isAnimationActive={false} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                    <p className="text-[10px] text-cmd-muted">
                      *{maxD} m is the deepest single modelled cell outside the breach inflow zone — often backed-up
                      gorge water, not the depth where people are.
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── Priority action zones ── */}
        {priorityZones.length > 0 && (
          <div className="mb-3 rounded-xl border border-cmd-red/30 overflow-hidden">
            <p className="px-3 py-1.5 bg-cmd-red/[0.08] text-[11px] font-extrabold tracking-wide text-cmd-ink">PRIORITY ACTION ZONES</p>
            <div className="p-2">
              {priorityZones.map((a: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-[11px] py-1.5 border-b border-cmd-border/60 last:border-0">
                  <span className="w-5 h-5 rounded-full bg-cmd-red/90 text-white text-[10px] font-extrabold flex items-center justify-center shrink-0">{i + 1}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-bold text-cmd-ink/90">{a.name}</span>
                    <span className="block text-[10px] text-cmd-muted">
                      {a.source === 'modeled'
                        ? 'modelled sample point — not a real place'
                        : String(a.kind).replace(/_/g, ' ')}
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-mono font-bold text-cmd-ink/90">T+{Math.round(a.arrival_min)}m</span>
                    <span className="block font-mono text-cmd-muted">{a.max_depth_m}m</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {ensemble && (
          <div className="mb-3">
            <p className="text-[10px] uppercase tracking-wider text-cmd-muted font-semibold mb-1.5">Ensemble ×{ensemble.count} — case comparison (actual runs)</p>
            {(['best', 'likely', 'worst'] as const).map((c) => (
              <div key={c} className="flex items-center gap-2 text-[11px] py-1 border-b border-cmd-border/60">
                <span className="w-12 font-bold capitalize text-cmd-ink/80">{c}</span>
                <span className="font-mono">{ensemble.comparison[c].flooded_area_km2} km²</span>
                <span className="text-cmd-muted">crit: {ensemble.comparison[c].assets_critical}</span>
                <span className="ml-auto font-mono">peak {ensemble.comparison[c].max_depth_anywhere_m}m</span>
              </div>
            ))}
            <p className="text-[10px] text-cmd-muted mt-1">Exposure classes are scenario-based indicators, not statistical guarantees.</p>
          </div>
        )}

        {/* ── Assets (collapsed by default) ── */}
        {assets.length > 0 && (
          <div className="mb-3">
            <button onClick={() => setShowAssets(!showAssets)}
              className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-cmd-muted font-semibold hover:text-cmd-teal mb-1.5">
              Exposed assets ({assets.length}) — {run?.asset_provenance?.startsWith('modeled') || ensemble?.asset_provenance?.startsWith('modeled') ? 'modeled sample points' : 'OpenStreetMap'}
              <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showAssets ? '' : '-rotate-90'}`} />
            </button>
            {showAssets && assets.slice(0, 8).map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[11px] py-1 border-b border-cmd-border/60">
                <span className={`w-2 h-2 rounded-full shrink-0 ${a.severity >= 3 ? 'bg-cmd-red' : a.severity >= 1 ? 'bg-cmd-amber' : 'bg-cmd-muted'}`} />
                <span className="flex-1 truncate font-medium text-cmd-ink/90">{a.name}</span>
                <span className="text-cmd-muted">{a.kind}</span>
                <span className="font-mono font-bold">{a.arrival_min != null ? `T+${Math.round(a.arrival_min)}m` : 'dry'}</span>
                <span className="font-mono">{a.max_depth_m}m</span>
                {a.exposure_pct != null && <span className="font-mono text-cmd-teal">{a.exposure_pct}%</span>}
              </div>
            ))}
          </div>
        )}

        {/* ── AI insight ── */}
        {explanation && (
          <div className="bg-cmd-teal/[0.08] border border-cmd-teal/25 rounded-lg p-2.5">
            <p className="text-[11px] font-bold text-cmd-teal flex items-center gap-1 mb-1">
              <Sparkles className="w-3.5 h-3.5" /> Decision insight (rules-based, cites sim metrics)
            </p>
            <p className="text-[11px] text-cmd-ink/90 mb-1">{explanation.headline}</p>
            {explanation.bullets.map((b: string, i: number) => (
              <p key={i} className="text-[11px] text-cmd-ink/80 mb-1">• {b}</p>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

