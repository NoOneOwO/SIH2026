/**
 * AquaShield 3D — Emergency Action Plan dashboard (planning / preparedness).
 *
 * The scenario table and the preparedness checklist are now driven by real
 * backend state and by the assessment the user actually ran. The previous
 * version listed two invented "approved" scenarios and ticked eight readiness
 * items unconditionally, which told the reader nothing true.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import {
  AlertTriangle, CheckCircle, Clock, FileText, Lock, Map, RefreshCw, Shield, Waves,
} from 'lucide-react';
import { alertsApi, damsApi, sandboxApi, scenariosApi } from '../../api/client';
import { formatUtc } from '../../components/impact/format';
import { loadLastAssessment } from '../../utils/lastAssessment';

interface ScenarioRow {
  id: string;
  dam_id?: string;
  failure_mode?: string;
  variant?: string;
  solver?: string;
  status?: string;
  approved_by?: string | null;
  updated_at?: string;
}

type Check = { label: string; status: 'ok' | 'attention' | 'unknown'; detail: string };

const LEVELS = [
  { level: 'Level 0', title: 'Preparedness', desc: 'Scenario creation → review → approval → EAP export', tone: 'border-cmd-green/40 text-cmd-green' },
  { level: 'Level 1', title: 'Abnormal', desc: 'Watch status, preload scenarios, verify contacts', tone: 'border-cmd-amber/40 text-cmd-amber' },
  { level: 'Level 2', title: 'Potential breach', desc: 'Select conservative scenario, rank settlements', tone: 'border-cmd-amber/40 text-cmd-amber' },
  { level: 'Level 3', title: 'Confirmed breach', desc: 'Lock parameters, minute-by-minute dashboard', tone: 'border-cmd-red/50 text-cmd-red' },
];

export default function EapDashboard() {
  const { t } = useTranslation();
  const [scenarios, setScenarios] = useState<ScenarioRow[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [scen, dams, terrain, alerts] = await Promise.allSettled([
      scenariosApi.list(),
      damsApi.list(),
      sandboxApi.dams(),
      alertsApi.list(),
    ]);

    const scenList: ScenarioRow[] = scen.status === 'fulfilled' && Array.isArray(scen.value?.scenarios)
      ? scen.value.scenarios
      : [];
    setScenarios(scen.status === 'fulfilled' ? scenList : null);

    const count = (r: PromiseSettledResult<any>, key: string) =>
      r.status === 'fulfilled' && typeof r.value?.[key] === 'number' ? r.value[key] : null;

    const damCount = count(dams, 'total');
    const terrainCount = count(terrain, 'total');
    const alertCount = count(alerts, 'total');
    const assessment = loadLastAssessment();
    const approved = scenList.filter((s) => s.status === 'approved').length;

    setChecks([
      {
        label: 'Backend API reachable',
        status: damCount == null && scen.status === 'rejected' ? 'attention' : 'ok',
        detail: damCount == null ? 'No dam register response — check the backend' : `${damCount} dams returned by /dams`,
      },
      {
        label: 'Terrain available for simulation',
        status: terrainCount == null ? 'unknown' : terrainCount > 0 ? 'ok' : 'attention',
        detail: terrainCount == null ? 'Terrain inventory not requested' : `${terrainCount} dam domains with a DEM`,
      },
      {
        label: 'Scenario register populated',
        status: scen.status === 'rejected' ? 'attention' : scenList.length > 0 ? 'ok' : 'attention',
        detail:
          scen.status === 'rejected'
            ? 'Scenario register unreachable'
            : `${scenList.length} scenario(s), ${approved} approved`,
      },
      {
        label: 'Flood impact assessment run',
        status: assessment ? 'ok' : 'attention',
        detail: assessment
          ? `${assessment.dam_name} • ${assessment.case} case • ${formatUtc(assessment.generated_at_utc)}`
          : 'None in this session — exposure and damage figures cannot be quoted without one',
      },
      {
        label: 'Alert records present',
        status: alertCount == null ? 'unknown' : alertCount > 0 ? 'ok' : 'attention',
        detail: alertCount == null ? 'Alert register unreachable' : `${alertCount} alert(s) on record`,
      },
      {
        label: 'Report availability',
        status: 'unknown',
        detail: 'Reports are generated per simulation run — open Report Generator with a run to produce one',
      },
    ]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const statusIcon = (status?: string) => {
    switch (status) {
      case 'draft': return <Clock className="h-4 w-4 text-cmd-muted" />;
      case 'submitted': return <Clock className="h-4 w-4 text-cmd-amber" />;
      case 'approved': return <CheckCircle className="h-4 w-4 text-cmd-green" />;
      case 'locked': return <Lock className="h-4 w-4 text-cmd-teal" />;
      default: return <AlertTriangle className="h-4 w-4 text-cmd-muted" />;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto max-w-[1400px] space-y-5 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.eapDashboard')}</h1>
            <p className="mt-1 text-sm text-cmd-muted">
              Emergency Action Plan — planning and preparedness, from live backend state
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-2 rounded-lg border border-cmd-border px-3 py-2 text-xs font-bold text-cmd-muted transition-colors hover:text-cmd-ink"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Re-check
          </button>
        </div>

        {/* Scenario register */}
        <div className="cmd-card p-5">
          <h3 className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
            <Map className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Scenario register
          </h3>
          <p className="mb-4 text-xs text-cmd-muted">
            Every scenario the backend has on record, with its real approval state. Nothing is listed here that the API
            did not return.
          </p>
          {scenarios === null ? (
            <p className="text-[12.5px] text-cmd-muted">Scenario register unavailable — the backend API did not respond.</p>
          ) : scenarios.length === 0 ? (
            <p className="text-[12.5px] text-cmd-muted">
              No scenarios stored yet. Create and approve one from the Scenario Manager before an EAP can reference it.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-cmd-border">
                    {['Failure mode', 'Variant', 'Solver', 'Status', 'Approved by', 'Updated'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-cmd-muted">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => (
                    <tr key={s.id} className="border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-md border border-cmd-border px-2 py-1 text-xs font-semibold text-cmd-ink/90">
                          {s.failure_mode ? t(`scenario.${s.failure_mode}`, { defaultValue: s.failure_mode }) : 'unspecified'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-cmd-ink/90">{s.variant ?? '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-cmd-muted">{s.solver ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-sm capitalize text-cmd-ink">
                          {statusIcon(s.status)}
                          {s.status ?? 'unknown'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-cmd-muted">{s.approved_by ?? '—'}</td>
                      <td className="px-4 py-3 text-xs tabular-nums text-cmd-muted">{s.updated_at ? formatUtc(s.updated_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Preparedness checklist — real checks only */}
        <div className="cmd-card p-5">
          <h3 className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
            <Shield className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Preparedness checks
          </h3>
          <p className="mb-4 text-xs text-cmd-muted">
            Each line reports something the browser actually verified in this session, with the observed result.
          </p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
            {checks.map(({ label, status, detail }) => (
              <div key={label} className="flex items-start gap-3">
                {status === 'ok' ? (
                  <CheckCircle className="mt-0.5 w-[18px] h-[18px] shrink-0 text-cmd-green" strokeWidth={1.75} />
                ) : status === 'attention' ? (
                  <AlertTriangle className="mt-0.5 w-[18px] h-[18px] shrink-0 text-cmd-amber" strokeWidth={1.75} />
                ) : (
                  <Clock className="mt-0.5 w-[18px] h-[18px] shrink-0 text-cmd-muted" strokeWidth={1.75} />
                )}
                <div className="min-w-0">
                  <p className="text-[13px] text-cmd-ink/90">{label}</p>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-cmd-muted">{detail}</p>
                </div>
              </div>
            ))}
            {checks.length === 0 && <p className="text-[12.5px] text-cmd-muted">Running checks…</p>}
          </div>
        </div>

        {/* Assessment cross-link */}
        <div className="cmd-card flex flex-wrap items-center gap-3 p-5">
          <Waves className="h-4 w-4 shrink-0 text-cmd-teal" strokeWidth={1.9} />
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-cmd-muted">
            Exposure, damage and avoidable-loss figures live in the Flood Impact workspace, where each number carries its
            evidence class, confidence level and the assumptions behind it.
          </p>
          <a
            href="/impact"
            className="shrink-0 rounded-lg bg-cmd-teal/90 px-3 py-1.5 text-[11.5px] font-bold text-[#071018] hover:bg-cmd-teal"
          >
            Open Flood Impact
          </a>
        </div>

        {/* Response workflow reference */}
        <div className="cmd-card p-5">
          <h3 className="mb-4 flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
            <FileText className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Response workflow levels
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {LEVELS.map(({ level, title, desc, tone }) => (
              <div key={level} className={`rounded-xl border border-cmd-border border-t-2 p-4 ${tone.split(' ')[0]}`}>
                <div className={`text-[11px] font-bold uppercase tracking-wider ${tone.split(' ')[1]}`}>{level}</div>
                <div className="mt-1 text-sm font-semibold text-cmd-ink">{title}</div>
                <div className="mt-1.5 text-xs leading-relaxed text-cmd-muted">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
