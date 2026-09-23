/**
 * AquaShield 3D — LISFLOOD-FP run panel (REAL hydraulic engine).
 * Command-centre dark theme. Owns scenario inputs, job polling with
 * engine-derived progress, result playback, impact ledger, debug ledger,
 * and a modelled-depth-over-time illustration (recharts).
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  X, Play, Pause, RotateCcw, Waves, Layers, Eye, EyeOff,
  Mountain, AlertTriangle, ChevronDown, FileText,
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { lisfloodApi } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import type { DamPoint } from '../../data/india-dams';
import type { FloodOverlay } from '../../viewers/local-3d/Local3DView';

interface LisfloodPanelProps {
  dam: DamPoint;
  onFlood: (f: FloodOverlay | null) => void;
  onClose: () => void;
  /** Shareable-link entry: load an existing job (e.g. ?job=abc123). */
  initialJobId?: string | null;
}

function b64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  preparing_terrain: 'Preparing terrain',
  staging_inputs: 'Generating scenario',
  routing_flood_wave: 'Routing flood wave',
  calculating_inundation: 'Calculating inundation',
  complete: 'Complete',
  failed: 'Simulation failed',
};

const DEFAULTS = {
  failure_mode: 'overtopping',
  reservoir_level_m: '',
  breach_width_m: 80,
  breach_depth_m: 20,
  breach_formation_time_min: 45,
  duration_min: 120,
  mannings_n: 0.035,
  domain_radius_km: 2.0,
  cell_size_m: 30,
};

const inputCls =
  'mt-1 w-full text-xs bg-cmd-panel border border-cmd-border rounded-lg px-2 py-1.5 text-cmd-ink placeholder:text-cmd-muted/50 focus:outline-none focus:border-cmd-teal/60';

/** Timeline playback rate: sim-minutes advanced per real second. Fixed; there
 *  is no speed control in this panel, so it must not pretend to be state. */
const PLAYBACK_SPEED = 6;

export default function LisfloodPanel({ dam, onFlood, onClose, initialJobId }: LisfloodPanelProps) {
  const { scopeDamId } = useAuth();
  const scopedOut = !!scopeDamId && scopeDamId !== dam.id;
  const [params, setParams] = useState({ ...DEFAULTS, failure_mode: 'overtopping' as string });
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [job, setJob] = useState<any | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [meta, setMeta] = useState<any | null>(null);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState('');
  const [showDebug, setShowDebug] = useState(true);
  const [tMin, setTMin] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showWater, setShowWater] = useState(true);
  const [showTerrain, setShowTerrain] = useState(true);
  const [opacity, setOpacity] = useState(0.78);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const set = (k: string, v: number | string) => setParams((p) => ({ ...p, [k]: v }));
  const maxT = result?.frames_meta?.length
    ? result.frames_meta[result.frames_meta.length - 1].time_s / 60
    : (job?.sim_time_s ?? 0) / 60;

  async function doRun() {
    setError('');
    setLogs('');
    if (scopedOut) {
      setError(`Simulations are limited to your posted dam (${scopeDamId}). You can still view this dam and ask the AI assistant about it.`);
      return;
    }
    setResult(null);
    setMeta(null);
    setJob(null);
    setTMin(0);
    setPlaying(false);
    onFlood(null);
    const body: any = {
      dam_id: dam.id,
      failure_mode: params.failure_mode,
      breach_width_m: Number(params.breach_width_m),
      breach_depth_m: Number(params.breach_depth_m),
      breach_formation_time_min: Number(params.breach_formation_time_min),
      duration_min: Number(params.duration_min),
      mannings_n: Number(params.mannings_n),
      domain_radius_km: Number(params.domain_radius_km),
      cell_size_m: Number(params.cell_size_m),
    };
    if (params.reservoir_level_m !== '') body.reservoir_level_m = Number(params.reservoir_level_m);
    try {
      const accepted = await lisfloodApi.run(body);
      setJobId(accepted.job_id);
    } catch (e: any) {
      setError(e.message ?? 'Submission failed');
    }
  }

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await lisfloodApi.status(jobId);
        if (cancelled) return;
        setJob(st);
        if (st.status === 'done') {
          if (pollRef.current) clearInterval(pollRef.current);
          const [res, md] = await Promise.all([
            lisfloodApi.result(jobId),
            lisfloodApi.metadata(jobId).catch(() => null),
          ]);
          if (cancelled) return;
          setResult(res);
          setMeta(md);
          setTMin(0);
          setPlaying(true);
        } else if (st.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(`SIMULATION FAILED — ${st.error ?? 'unknown reason'}`);
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Polling failed');
        if (pollRef.current) clearInterval(pollRef.current);
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId]);

  useEffect(() => {
    if (!playing || !result) return;
    const iv = setInterval(() => {
      setTMin((t) => {
        const next = t + PLAYBACK_SPEED * 0.25;
        if (next >= maxT) {
          setPlaying(false);
          return maxT;
        }
        return next;
      });
    }, 250);
    return () => clearInterval(iv);
  }, [playing, result, maxT]);

  useEffect(() => {
    if (!result || !meta?.dem) return;
    try {
      const rows: number = result.grid.nrows;
      const cols: number = result.grid.ncols;
      const arrival = b64ToF32(result.grid.arrival_min_b64);
      const depth = b64ToF32(result.grid.max_depth_b64);
      let frames: Float32Array[] | undefined;
      let frameTimesMin: number[] | undefined;
      if (result.frames_b64 && result.frames_shape?.length === 3) {
        const flat = b64ToF32(result.frames_b64);
        const [nf, fr, fc] = result.frames_shape;
        frames = [];
        for (let k = 0; k < nf; k++) frames.push(flat.slice(k * fr * fc, (k + 1) * fr * fc));
        frameTimesMin = result.frames_meta.map((f: any) => f.time_s / 60);
      }
      onFlood({
        key: `lisflood-${result.job_id}`,
        arrival,
        depth,
        rows,
        cols,
        tMin,
        visible: showWater,
        geo: {
          west: meta.dem.west,
          north: meta.dem.north,
          cell: meta.dem.cell_m,
          damEasting: meta.breach.easting,
          damNorthing: meta.breach.northing,
        },
        frames,
        frameTimesMin,
        flowPath: result.flow_path ?? undefined,
        opacity,
        terrainVisible: showTerrain,
      });
    } catch (e: any) {
      setError(`Result decode failed: ${e.message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, meta, tMin, showWater, showTerrain, opacity]);

  async function loadLogs() {
    if (!jobId) return;
    try {
      const l = await lisfloodApi.logs(jobId);
      setLogs(`--- stdout ---\n${l['stdout.log']}\n\n--- stderr ---\n${l['stderr.log']}`);
    } catch (e: any) {
      setLogs(`Could not load logs: ${e.message}`);
    }
  }

  const running = job && (job.status === 'queued' || job.status === 'running');
  const progress = job?.progress ?? 0;
  const impacts: any[] = result?.impacts ?? [];
  const wetImpacts = impacts.filter((i) => i.inundated);
  const frameChart = (result?.frames_meta ?? []).map((f: any) => ({
    t: Math.round(f.time_s / 60),
    depth: Number(f.max_depth_m),
    wet: f.wet_cells,
  }));

  const num = (v: any, digits = 2) =>
    v === null || v === undefined ? '—' : Number(v).toFixed(digits);

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="absolute right-3 top-3 bottom-3 w-[380px] z-20 flex flex-col rounded-2xl border border-cmd-border bg-[#0A1218]/95 backdrop-blur overflow-hidden"
      style={{ boxShadow: '0 0 32px -12px rgba(101,191,169,0.35)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-cmd-border shrink-0">
        <Waves className="w-4 h-4 text-cmd-teal" strokeWidth={1.75} />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold text-cmd-ink truncate">LISFLOOD-FP Simulation</p>
          <p className="text-[10px] text-cmd-muted truncate">{dam.name} • decision-support prototype</p>
        </div>
        <span className="px-2 py-0.5 rounded-md bg-cmd-teal/15 text-cmd-teal text-[9px] font-bold tracking-wide">REAL ENGINE</span>
        <button onClick={() => { onFlood(null); onClose(); }} className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]" title="Close the simulation and go back to the globe">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Scenario form */}
        <section>
          <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">Create scenario</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 text-xs text-cmd-muted">Failure mode
              <select value={params.failure_mode} onChange={(e) => set('failure_mode', e.target.value)} className={inputCls}>
                <option value="overtopping">Overtopping</option>
                <option value="piping">Piping</option>
                <option value="controlled_release">Controlled release</option>
              </select>
            </label>
            <label className="col-span-2 text-xs text-cmd-muted">Reservoir level, m <span className="opacity-70">(blank = illustrative default)</span>
              <input type="number" step="0.5" value={params.reservoir_level_m}
                onChange={(e) => set('reservoir_level_m', e.target.value)}
                placeholder="e.g. 120.5" className={inputCls} />
            </label>
            {[
              ['breach_width_m', 'Breach width, m', '80'],
              ['breach_depth_m', 'Breach depth, m', '20'],
              ['breach_formation_time_min', 'Formation time, min', '45'],
              ['duration_min', 'Duration, min', '120'],
              ['mannings_n', "Manning's n", '0.035'],
              ['domain_radius_km', 'Domain radius, km', '2.0'],
            ].map(([k, label, ph]) => (
              <label key={k} className="text-xs text-cmd-muted">{label}
                <input type="number" step="any" value={(params as any)[k]}
                  onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder={ph} className={inputCls} />
              </label>
            ))}
            <label className="text-xs text-cmd-muted">Cell size, m
              <select value={params.cell_size_m} onChange={(e) => set('cell_size_m', Number(e.target.value))} className={inputCls}>
                <option value={30}>30 (detailed)</option>
                <option value={60}>60 (fast demo)</option>
                <option value={90}>90 (fastest)</option>
              </select>
            </label>
          </div>
          <button onClick={doRun} disabled={!!running || scopedOut}
            className="mt-3 w-full px-3 py-2.5 bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold rounded-lg transition-colors disabled:opacity-50">
            {running ? 'SIMULATION RUNNING…' : scopedOut ? `POSTED DAM: ${scopeDamId}` : '▶ RUN SIMULATION'}
          </button>
          <p className="mt-1.5 text-[10px] leading-relaxed text-cmd-muted">
            🎬 Cinematic camera engages while this panel is open — close it to release.
            Breach is static in v1 (instantaneous); formation time is stored.
          </p>
        </section>

        {/* Progress */}
        {(job || error) && (
          <section className="rounded-xl border border-cmd-border bg-cmd-panel p-3">
            <div className="flex items-center justify-between text-xs font-semibold text-cmd-ink">
              <span>{job ? (STAGE_LABELS[job.stage] ?? job.stage) : 'Error'}</span>
              {jobId && <span className="font-mono text-[10px] text-cmd-muted">{jobId}</span>}
            </div>
            {job && (
              <>
                <div className="mt-2 h-1.5 rounded-full bg-cmd-track overflow-hidden">
                  <div className="h-full bg-cmd-teal transition-all" style={{ width: `${Math.min(100, progress)}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-cmd-muted font-mono tabular-nums">
                  <span>{Number(progress).toFixed(1)}%</span>
                  {job.sim_time_reached_s != null && job.sim_time_s > 0 && (
                    <span>t = {(job.sim_time_reached_s / 60).toFixed(1)} / {(job.sim_time_s / 60).toFixed(0)} min</span>
                  )}
                </div>
              </>
            )}
            {error && (
              <div className="mt-2 text-[11px] text-cmd-red bg-cmd-red/[0.08] border border-cmd-red/30 rounded-lg p-2 break-words">
                <span className="font-bold">⚠ {error}</span>
                {jobId && (
                  <button onClick={loadLogs} className="ml-2 underline">view engine logs</button>
                )}
              </div>
            )}
          </section>
        )}

        {/* Playback */}
        {result && (
          <section className="rounded-xl border border-cmd-border bg-cmd-panel p-3">
            <div className="flex items-center gap-2 text-xs font-bold text-cmd-ink mb-2">
              <Play className="w-3.5 h-3.5 text-cmd-teal" strokeWidth={2} /> Modelled inundation
              <span className="ml-auto font-mono font-normal text-cmd-muted tabular-nums">T+{tMin.toFixed(1)} min</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPlaying(!playing)} className="p-1.5 rounded-lg bg-cmd-teal/90 text-[#071018]" title={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="w-3.5 h-3.5" strokeWidth={2.25} /> : <Play className="w-3.5 h-3.5" strokeWidth={2.25} />}
              </button>
              <button onClick={() => { setPlaying(false); setTMin(0); }} className="p-1.5 rounded-lg border border-cmd-border text-cmd-muted hover:text-cmd-ink" title="Restart">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setPlaying(false); setTMin(maxT); }} className="px-2 py-1.5 rounded-lg border border-cmd-border text-[10px] font-bold text-cmd-muted hover:text-cmd-ink" title="Maximum inundation">
                MAX
              </button>
              <input type="range" min={0} max={maxT} step={maxT / 200 || 1} value={tMin}
                onChange={(e) => { setPlaying(false); setTMin(Number(e.target.value)); }}
                className="flex-1 accent-[#65BFA9]" />
            </div>
            <div className="mt-2 flex items-center gap-3 text-[11px] text-cmd-muted">
              <button onClick={() => setShowWater(!showWater)} className="flex items-center gap-1 hover:text-cmd-ink">
                {showWater ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} Water
              </button>
              <button onClick={() => setShowTerrain(!showTerrain)} className="flex items-center gap-1 hover:text-cmd-ink">
                <Mountain className="w-3.5 h-3.5" /> Terrain
              </button>
              <label className="flex items-center gap-1.5 ml-auto">Opacity
                <input type="range" min={0.1} max={1} step={0.05} value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))} className="w-20 accent-[#65BFA9]" />
              </label>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              {[
                ['Max depth', `${num(result.stats.max_depth_m)} m`],
                ['Inundated', `${result.stats.inundated_cells} cells`],
                ['Area', `${num(result.stats.inundated_area_km2, 3)} km²`],
              ].map(([l, v]) => (
                <div key={l} className="bg-cmd-bg rounded-lg p-1.5 border border-cmd-border/60">
                  <p className="text-[9px] uppercase tracking-wide text-cmd-muted font-bold">{l}</p>
                  <p className="text-xs font-bold font-mono text-cmd-ink tabular-nums">{v}</p>
                </div>
              ))}
            </div>
            {/* Depth-over-time illustration */}
            {frameChart.length > 1 && (
              <div className="mt-2">
                <p className="text-[10px] uppercase tracking-wide text-cmd-muted font-bold mb-1">Peak depth over time</p>
                <div className="h-28">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={frameChart} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                      <XAxis dataKey="t" tick={{ fill: '#91A2AD', fontSize: 9 }} tickLine={false} axisLine={{ stroke: '#263742' }} tickFormatter={(v: any) => `T+${v}` } interval="preserveStartEnd" />
                      <YAxis tick={{ fill: '#91A2AD', fontSize: 9 }} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ background: '#14222B', border: '1px solid #263742', borderRadius: 8, fontSize: 11, color: '#E8EEF0' }}
                        formatter={(v: any) => [`${Number(v).toFixed(2)} m`, 'Peak depth']}
                        labelFormatter={(v: any) => `T+${v} min`}
                      />
                      <Area type="monotone" dataKey="depth" stroke="#65BFA9" strokeWidth={1.75} fill="#65BFA9" fillOpacity={0.18} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Debug ledger */}
        {result && meta && (
          <section className="rounded-xl border border-cmd-border overflow-hidden">
            <button onClick={() => setShowDebug(!showDebug)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-cmd-panel text-xs font-bold text-cmd-ink">
              <FileText className="w-3.5 h-3.5 text-cmd-teal" strokeWidth={1.75} /> Simulation debug
              <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showDebug ? '' : '-rotate-90'}`} />
            </button>
            {showDebug && (
              <dl className="px-3 py-2 grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-[10.5px] font-mono">
                {[
                  ['Simulation ID', result.job_id],
                  ['Engine status', `exit 0 • ${result.stats.frames} frames`],
                  ['Engine', result.engine.version],
                  ['DEM', String(meta.dem.path).split('/').slice(-2).join('/')],
                  ['DEM grid', `${meta.dem.nrows}×${meta.dem.ncols} • ${meta.dem.cell_m} m • ${meta.dem.dst_crs}`],
                  ['Duration', `${(meta.sim.duration_s / 60).toFixed(0)} min • save ${(meta.sim.save_s / 60).toFixed(0)} min`],
                  ['Outputs', (result.engine.outputs?.length ?? 0) + ' files'],
                  ['Max depth', `${num(result.stats.max_depth_m, 3)} m`],
                  ['Min depth', '0.000 m'],
                  ['Inundated', `${result.stats.inundated_cells} cells`],
                  ['Max speed', `${num(result.stats.max_speed_ms)} m/s`],
                  ['Mass Q/V err', `${result.stats.mass_q_error ?? '—'} / ${result.stats.mass_v_error ?? '—'}`],
                  ['Elapsed', `${job?.elapsed_s ?? job?.engine_s ?? '—'} s`],
                ].map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-cmd-muted">{k}</dt>
                    <dd className="break-all text-cmd-ink/90">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        )}

        {/* Impacts */}
        {result && (
          <section>
            <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-2">
              <Layers className="w-3 h-3 inline mr-1" />
              Affected locations ({wetImpacts.length} inundated)
            </p>
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
              {impacts.map((im: any, k: number) => (
                <div key={k} className={`rounded-lg border p-2 text-[11px] ${im.inundated ? 'border-cmd-red/40 bg-cmd-red/[0.06]' : 'border-cmd-border'}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-cmd-ink truncate flex-1">{im.name}</span>
                    <span className={`px-1.5 py-px rounded text-[9px] font-bold ${im.status === 'CRITICAL' ? 'bg-cmd-red text-white' : im.status === 'AT RISK' ? 'bg-cmd-amber text-[#071018]' : 'bg-white/[0.08] text-cmd-muted'}`}>
                      {im.status}
                    </span>
                  </div>
                  <p className="font-mono text-cmd-muted mt-0.5 tabular-nums">
                    {im.kind} • max {num(im.max_depth_m, 2)} m • arrival {im.arrival_min != null ? `${num(im.arrival_min, 0)} min` : '—'} • {im.source}
                  </p>
                </div>
              ))}
              {!impacts.length && <p className="text-[11px] text-cmd-muted">No exposure points in domain.</p>}
            </div>
          </section>
        )}

        {logs && (
          <section>
            <p className="text-[10px] uppercase tracking-[0.14em] text-cmd-muted font-bold mb-1">Engine logs</p>
            <pre className="text-[9.5px] font-mono bg-black/40 border border-cmd-border text-cmd-ink/80 rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap">{logs}</pre>
          </section>
        )}

        <p className="text-[10px] leading-relaxed text-cmd-muted flex gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px text-cmd-amber" strokeWidth={1.75} />
          Simulation for emergency planning support only — modelled inundation, not a validated engineering prediction.
        </p>
      </div>
    </motion.div>
  );
}

