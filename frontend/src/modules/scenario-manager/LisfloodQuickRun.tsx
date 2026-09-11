/**
 * AquaShield 3D — LISFLOOD-FP quick run (Scenario Manager).
 * Select a dam, configure a real dam-break scenario, run the engine,
 * then open the modelled inundation in the Incident Console 3D view.
 */

import { useEffect, useState } from 'react';
import { Play, ExternalLink, Waves } from 'lucide-react';
import { lisfloodApi } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { INDIA_DAMS } from '../../data/india-dams';

export default function LisfloodQuickRun() {
  const { scopeDamId } = useAuth();
  const [damIds, setDamIds] = useState<string[]>(['d16']);
  const [damId, setDamId] = useState('d16');
  const [failureMode, setFailureMode] = useState('overtopping');
  const [reservoir, setReservoir] = useState('');
  const [width, setWidth] = useState(80);
  const [depth, setDepth] = useState(20);
  const [formation, setFormation] = useState(45);
  const [duration, setDuration] = useState(120);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/terrain/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m) {
          const ids = Object.keys(m);
          setDamIds(ids);
          setDamId(ids.includes('d16') ? 'd16' : ids[0] ?? 'd16');
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await lisfloodApi.status(jobId);
        if (cancelled) return true;
        setJob(st);
        if (st.status === 'done' || st.status === 'failed') {
          if (st.status === 'failed') setError(`SIMULATION FAILED — ${st.error ?? 'unknown reason'}`);
          return true;
        }
        return false;
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Polling failed');
        return true;
      }
    };
    const iv = setInterval(async () => {
      if (await tick()) clearInterval(iv);
    }, 2500);
    tick();
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [jobId]);

  async function run() {
    setError('');
    setJob(null);
    const body: any = {
      dam_id: damId,
      failure_mode: failureMode,
      breach_width_m: Number(width),
      breach_depth_m: Number(depth),
      breach_formation_time_min: Number(formation),
      duration_min: Number(duration),
    };
    if (reservoir !== '') body.reservoir_level_m = Number(reservoir);
    try {
      const accepted = await lisfloodApi.run(body);
      setJobId(accepted.job_id);
    } catch (e: any) {
      setError(e.message ?? 'Submission failed');
    }
  }

  const damName = (id: string) => INDIA_DAMS.find((d) => d.id === id)?.name ?? id;
  const running = job && (job.status === 'queued' || job.status === 'running');
  // Posted officials see only their dam; everyone else sees all terrains.
  const visibleIds = scopeDamId ? damIds.filter((id) => id === scopeDamId) : damIds;
  useEffect(() => {
    if (scopeDamId && damIds.includes(scopeDamId)) setDamId(scopeDamId);
  }, [scopeDamId, damIds]);
  const inputCls =
    'mt-1 w-full px-2.5 py-2 bg-cmd-panel2 border border-cmd-border rounded-lg text-xs text-cmd-ink focus:outline-none focus:border-cmd-teal/60';

  return (
    <div className="cmd-card p-5" style={{ boxShadow: '0 0 28px -10px rgba(101,191,169,0.28)' }}>
      <div className="flex items-center gap-2 mb-1">
        <Waves className="w-5 h-5 text-cmd-teal" strokeWidth={1.75} />
        <h3 className="text-[15px] font-semibold text-cmd-ink">LISFLOOD-FP Quick Run</h3>
        <span className="px-2 py-0.5 rounded-md bg-cmd-teal/15 text-cmd-teal text-[10px] font-bold tracking-wide">REAL ENGINE</span>
      </div>
      <p className="text-xs text-cmd-muted mb-4">
        Run a genuine dam-break simulation over the dam's terrain DEM. Demo/illustrative parameters only.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="block text-xs font-medium text-cmd-muted">Dam
          {scopeDamId && !visibleIds.length ? (
            <p className="mt-1 text-[11px] text-cmd-amber">Your posted dam ({scopeDamId}) has no simulation terrain yet.</p>
          ) : (
            <select value={damId} onChange={(e) => setDamId(e.target.value)} className={inputCls} disabled={!!scopeDamId}>
              {visibleIds.map((id) => (
                <option key={id} value={id}>{damName(id)} ({id})</option>
              ))}
            </select>
          )}
        </label>
        <label className="block text-xs font-medium text-cmd-muted">Failure mode
          <select value={failureMode} onChange={(e) => setFailureMode(e.target.value)} className={inputCls}>
            <option value="overtopping">Overtopping</option>
            <option value="piping">Piping</option>
            <option value="controlled_release">Controlled release</option>
          </select>
        </label>
        <label className="block text-xs font-medium text-cmd-muted">Reservoir level, m <span className="font-normal">(blank = default)</span>
          <input type="number" step="0.5" value={reservoir} onChange={(e) => setReservoir(e.target.value)}
            placeholder="illustrative" className={inputCls} />
        </label>
        <label className="block text-xs font-medium text-cmd-muted">Duration, min
          <input type="number" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="block text-xs font-medium text-cmd-muted">Breach width, m
          <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="block text-xs font-medium text-cmd-muted">Breach depth, m
          <input type="number" value={depth} onChange={(e) => setDepth(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="block text-xs font-medium text-cmd-muted">Formation, min
          <input type="number" value={formation} onChange={(e) => setFormation(Number(e.target.value))} className={inputCls} />
        </label>
        <div className="flex items-end">
          <button onClick={run} disabled={!!running}
            className="w-full px-3 py-2.5 bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
            <Play className="w-3.5 h-3.5" strokeWidth={2.25} /> {running ? 'RUNNING…' : 'RUN SIMULATION'}
          </button>
        </div>
      </div>
      {(job || error) && (
        <div className="mt-3 rounded-xl border border-cmd-border bg-cmd-panel2/60 p-3 text-xs">
          {job && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-cmd-muted">{jobId}</span>
              <span className="font-semibold text-cmd-ink">{String(job.stage ?? '').replace(/_/g, ' ')}</span>
              <span className="font-mono text-cmd-muted tabular-nums">{Number(job.progress ?? 0).toFixed(1)}%</span>
              {job.status === 'done' && job.stats && (
                <span className="font-mono text-cmd-muted tabular-nums">
                  max {Number(job.stats.max_depth_m).toFixed(2)} m • {job.stats.inundated_cells} cells • {job.stats.frames} frames
                </span>
              )}
              {job.status === 'done' && jobId && (
                <a href={`/incident?dam=${damId}&lisflood=1&job=${jobId}`}
                  className="ml-auto inline-flex items-center gap-1 font-bold text-cmd-teal hover:underline">
                  Open 3D result <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
          {error && <p className="mt-1 font-semibold text-cmd-red">⚠ {error}</p>}
        </div>
      )}
    </div>
  );
}

