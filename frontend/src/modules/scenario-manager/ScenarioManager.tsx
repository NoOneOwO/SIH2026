/**
 * DamSafe Twin — Scenario Manager
 * Create, configure, submit, and approve dam-break scenarios.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import {
  Plus, Play, Info,
} from 'lucide-react';
import { scenariosApi, simRunsApi } from '../../api/client';
import LisfloodQuickRun from './LisfloodQuickRun';

export default function ScenarioManager() {
  const { t } = useTranslation();
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [form, setForm] = useState({
    failure_mode: 'overtopping',
    variant: 'expected',
    solver: 'educational_swe',
    breach_width_m: 150,
    breach_depth_m: 25,
    formation_time_hr: 0.5,
    description: '',
  });

  const scenarios = [
    {
      id: '40000000-0000-0000-0000-000000000001',
      failure_mode: 'overtopping',
      variant: 'expected',
      solver: 'educational_swe',
      solver_version: '1.0.0-mvp',
      status: 'approved',
      breach_params: { breach_width_m: 150, breach_depth_m: 25, formation_time_hr: 0.5 },
      approved_by: 'Demo Operator',
      approved_at: '2026-08-31T12:00:00Z',
    },
    {
      id: '40000000-0000-0000-0000-000000000002',
      failure_mode: 'piping',
      variant: 'conservative',
      solver: 'educational_swe',
      solver_version: '1.0.0-mvp',
      status: 'approved',
      breach_params: { breach_width_m: 80, breach_depth_m: 30, formation_time_hr: 1.0 },
      approved_by: 'Demo Operator',
      approved_at: '2026-08-31T12:00:00Z',
    },
  ];

  async function handleEnqueue(scenarioId: string) {
    try {
      const result = await simRunsApi.enqueue(scenarioId);
      alert(`Simulation enqueued! Run ID: ${result.sim_run_id}`);
    } catch (err) {
      alert('Failed to enqueue simulation');
    }
  }

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      draft: 'bg-white/[0.06] text-cmd-muted',
      submitted: 'bg-cmd-amber/15 text-cmd-amber',
      approved: 'bg-cmd-green/15 text-cmd-green',
      locked: 'bg-cmd-teal/15 text-cmd-teal',
    };
    return (
      <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wide ${styles[status] || ''}`}>
        {status}
      </span>
    );
  };

  const inputCls =
    'w-full px-3 py-2 bg-cmd-panel2 border border-cmd-border rounded-lg text-sm text-cmd-ink focus:outline-none focus:border-cmd-teal/60';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <LisfloodQuickRun />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.scenarioManager')}</h1>
          <p className="text-cmd-muted mt-1 text-sm">Create, configure, and manage dam-break scenarios</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-sm font-bold transition-colors"
        >
          <Plus className="w-4 h-4" strokeWidth={2.25} /> Create Scenario
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4">New Scenario</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Failure Mode</label>
              <select value={form.failure_mode} onChange={(e) => setForm({ ...form, failure_mode: e.target.value })} className={inputCls}>
                <option value="overtopping">Overtopping</option>
                <option value="piping">Piping</option>
                <option value="controlled_release">Controlled Release</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Variant</label>
              <select value={form.variant} onChange={(e) => setForm({ ...form, variant: e.target.value })} className={inputCls}>
                <option value="lower">Lower</option>
                <option value="expected">Expected</option>
                <option value="conservative">Conservative</option>
                <option value="fast">Fast</option>
                <option value="worst_credible">Worst Credible</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Breach Width (m)</label>
              <input type="number" value={form.breach_width_m} onChange={(e) => setForm({ ...form, breach_width_m: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Breach Depth (m)</label>
              <input type="number" value={form.breach_depth_m} onChange={(e) => setForm({ ...form, breach_depth_m: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Formation Time (hr)</label>
              <input type="number" step="0.1" value={form.formation_time_hr} onChange={(e) => setForm({ ...form, formation_time_hr: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Solver</label>
              <select value={form.solver} onChange={(e) => setForm({ ...form, solver: e.target.value })} className={inputCls}>
                <option value="educational_swe">Educational SWE (Research)</option>
                <option value="hecras">HEC-RAS</option>
                <option value="anuga">ANUGA</option>
              </select>
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-xs font-medium text-cmd-muted mb-1">Description</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
              className={inputCls} placeholder="Optional description for this scenario..." />
          </div>
          <div className="mt-4 flex gap-3">
            <button className="px-4 py-2 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-sm font-bold transition-colors" onClick={() => setShowCreate(false)}>
              Create Draft
            </button>
            <button className="px-4 py-2 rounded-lg border border-cmd-border text-cmd-muted hover:text-cmd-ink text-sm font-semibold transition-colors" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </div>
          <div className="mt-3 flex items-start gap-2 text-xs text-cmd-muted">
            <Info className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={1.75} />
            <span>Breach parameters are Froehlich-derived generators, not deterministic truth. They are treated as uncertain scenario parameters.</span>
          </div>
        </div>
      )}

      {/* Scenario List */}
      <div className="cmd-card p-5">
        <h3 className="text-[15px] font-semibold text-cmd-ink mb-4">Scenario Ensemble</h3>
        <div className="space-y-3">
          {scenarios.map((s) => (
            <div key={s.id} className="rounded-xl border border-cmd-border p-4 hover:border-cmd-teal/40 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="text-[15px] font-semibold text-cmd-ink">
                      {t(`scenario.${s.failure_mode}`)} — {s.variant}
                    </span>
                    {statusBadge(s.status)}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-[13px]">
                    <div><span className="text-cmd-muted">Breach Width: </span><span className="font-medium text-cmd-ink tabular-nums">{s.breach_params.breach_width_m} m</span></div>
                    <div><span className="text-cmd-muted">Breach Depth: </span><span className="font-medium text-cmd-ink tabular-nums">{s.breach_params.breach_depth_m} m</span></div>
                    <div><span className="text-cmd-muted">Formation Time: </span><span className="font-medium text-cmd-ink tabular-nums">{s.breach_params.formation_time_hr} hr</span></div>
                    <div><span className="text-cmd-muted">Solver: </span><span className="font-medium text-cmd-ink font-mono text-xs">{s.solver} v{s.solver_version}</span></div>
                  </div>
                </div>
                <button
                  onClick={() => handleEnqueue(s.id)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold transition-colors shrink-0"
                  title="Run simulation"
                >
                  <Play className="w-3.5 h-3.5" strokeWidth={2.25} /> Run
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </motion.div>
  );
}
