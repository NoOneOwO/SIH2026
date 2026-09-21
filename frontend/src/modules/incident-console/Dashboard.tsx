/**
 * AquaShield 3D — Dashboard (command-centre landing).
 *
 * Every number on this page is either fetched from the backend or taken from
 * the last assessment the user actually ran. Where a value is genuinely not
 * available the card shows an explicit "—"/"not available" instead of a
 * placeholder figure, and nothing here is decorated with invented sparklines.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Activity, Users, Map, Route, FileText, Waves, ArrowRight, RefreshCw,
} from 'lucide-react';
import HeroPanel from '../../components/dashboard/HeroPanel';
import StatCard, { type StatTone } from '../../components/dashboard/StatCard';
import QuickAction, { type ActionTone } from '../../components/dashboard/QuickAction';
import SystemHealth, { type DataSourceRow } from '../../components/dashboard/SystemHealth';
import { alertsApi, damsApi, sandboxApi, scenariosApi, simRunsApi } from '../../api/client';
import { INDIA_DAMS } from '../../data/india-dams';
import { RISK_HEX, formatCount, formatInr, formatRange, formatUtc } from '../../components/impact/format';
import { loadLastAssessment, type LastAssessment } from '../../utils/lastAssessment';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

interface Kpi {
  label: string;
  caption: string;
  value: string;
  tone: StatTone;
  icon: typeof Map;
  sub?: string;
}

const ACTIONS: Array<{
  title: string;
  description: string;
  path: string;
  icon: typeof Map;
  tone: ActionTone;
}> = [
  { title: 'Flood Impact', description: 'Where flooding is likely and who is exposed', path: '/impact', icon: Waves, tone: 'teal' },
  { title: 'Incident Console', description: 'Globe, terrain and simulation sandbox', path: '/incident', icon: Map, tone: 'slateblue' },
  { title: 'Evacuation Planner', description: 'Priority areas and lead times', path: '/evacuation', icon: Route, tone: 'green' },
  { title: 'Report Generator', description: 'Decision-support documents', path: '/reports', icon: FileText, tone: 'red' },
];

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [assessment, setAssessment] = useState<LastAssessment | null>(null);
  const [counts, setCounts] = useState<{
    dams: number | null;
    scenarios: number | null;
    simRuns: number | null;
    alerts: number | null;
    terrainSites: number | null;
  }>({ dams: null, scenarios: null, simRuns: null, alerts: null, terrainSites: null });
  const [backend, setBackend] = useState<'online' | 'unavailable' | 'unknown'>('unknown');
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setAssessment(loadLastAssessment());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const total = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' && typeof r.value?.total === 'number' ? r.value.total : null;

    const [health, damList, scen, runs, alerts, terrain] = await Promise.allSettled([
      fetch(`${BASE_URL}/health`).then((r) => r.ok),
      damsApi.list(),
      scenariosApi.list(),
      simRunsApi.list(),
      alertsApi.list(),
      sandboxApi.dams(),
    ]);
    setBackend(
      health.status === 'fulfilled' && health.value === true
        ? 'online'
        : health.status === 'rejected'
          ? 'unavailable'
          : 'unknown',
    );
    setCounts({
      dams: total(damList),
      scenarios: total(scen),
      simRuns: total(runs),
      alerts: total(alerts),
      terrainSites:
        terrain.status === 'fulfilled' && typeof terrain.value?.total === 'number' ? terrain.value.total : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  const fmt = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-IN'));

  const kpis: Kpi[] = useMemo(
    () => [
      {
        label: 'Dams in register',
        caption: counts.dams == null ? 'Registry only (backend unavailable)' : 'Loaded from the backend',
        value: fmt(counts.dams),
        sub: `${INDIA_DAMS.length} in the curated India register`,
        tone: 'teal',
        icon: Map,
      },
      {
        label: 'Terrain-backed sites',
        caption: 'Ready to simulate',
        value: fmt(counts.terrainSites),
        sub: 'Dams with a DEM domain on the server',
        tone: 'green',
        icon: Activity,
      },
      {
        label: 'Scenarios',
        caption: 'Approved or draft in the register',
        value: fmt(counts.scenarios),
        tone: 'slateblue',
        icon: Map,
      },
      {
        label: 'Simulation runs',
        caption: 'Recorded jobs',
        value: fmt(counts.simRuns),
        tone: 'amber',
        icon: Activity,
      },
      {
        label: 'Settlements assessed',
        caption: assessment ? `Latest assessment (${assessment.dam_name})` : 'No assessment run in this session',
        value: assessment ? assessment.settlements_assessed.toLocaleString('en-IN') : '—',
        sub: assessment
          ? `${assessment.settlements_inundated} inundated • ${assessment.settlements_at_risk} at risk`
          : 'Run an impact assessment to populate this',
        tone: 'orange',
        icon: Users,
      },
      {
        label: 'Alerts on record',
        caption: counts.alerts == null ? 'Backend unavailable' : 'Draft, approved and dispatched',
        value: fmt(counts.alerts),
        tone: 'red',
        icon: AlertTriangle,
      },
    ],
    [assessment, counts],
  );

  const sources: DataSourceRow[] = useMemo(
    () => [
      {
        name: 'Backend API',
        status: backend,
        detail:
          backend === 'online'
            ? `${BASE_URL || window.location.origin}/api/v1 responded to a health check`
            : 'No health response — figures shown as "—" until it is reachable',
      },
      {
        name: 'Simulation terrain',
        status: counts.terrainSites == null ? 'unknown' : counts.terrainSites > 0 ? 'online' : 'unavailable',
        detail:
          counts.terrainSites == null
            ? 'Terrain inventory not requested yet'
            : `${counts.terrainSites} dam domains with a DEM ready for screening simulation`,
      },
      {
        name: 'Flood impact assessment',
        status: assessment ? 'online' : 'unknown',
        detail: assessment
          ? `${assessment.dam_name} • ${assessment.case} case • engine ${assessment.engine} • last run ${formatUtc(
              assessment.generated_at_utc,
            )}`
          : 'No assessment run in this session — open Flood Impact to produce one',
      },
      {
        name: 'Critical-asset inventory',
        status: assessment ? 'online' : 'unknown',
        detail: assessment
          ? `Source: ${assessment.asset_provenance} (OpenStreetMap settlements, hospitals, bridges, power)`
          : 'Reported per assessment once one has run',
      },
    ],
    [assessment, backend, counts.terrainSites],
  );

  return (
    <div className="h-full overflow-y-auto bg-cmd-bg">
      <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
        <HeroPanel />

        {/* Situation banner — the latest real assessment, or an honest prompt */}
        <section className="cmd-card p-5" aria-label="Latest flood impact assessment">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
              <Waves className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />
              Latest flood impact assessment
            </h2>
            <div className="flex items-center gap-2">
              {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-cmd-muted" />}
              <button
                onClick={() => navigate('/impact')}
                className="flex items-center gap-1.5 rounded-lg bg-cmd-teal/90 px-3 py-1.5 text-[11.5px] font-bold text-[#071018] hover:bg-cmd-teal"
              >
                {assessment ? 'Open assessment' : 'Run an assessment'}
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          </div>

          {assessment ? (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-bold uppercase"
                  style={{
                    color: RISK_HEX[(assessment.overall_risk as keyof typeof RISK_HEX) ?? 'LOW'],
                    borderColor: `${RISK_HEX[(assessment.overall_risk as keyof typeof RISK_HEX) ?? 'LOW']}66`,
                  }}
                >
                  {assessment.overall_risk} risk
                </span>
                <p className="text-[13px] font-medium text-cmd-ink">
                  {assessment.dam_name} — {assessment.case} case
                </p>
                <span className="text-[11.5px] text-cmd-muted">
                  Confidence: {assessment.confidence.level} ({Math.round(assessment.confidence.score)}/100) • assessed{' '}
                  {formatUtc(assessment.generated_at_utc)}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    l: 'Places affected',
                    v: `${assessment.settlements_inundated} inundated`,
                    s: `${assessment.settlements_at_risk} at risk • ${assessment.flooded_area_km2.toFixed(2)} km² modelled water`,
                  },
                  {
                    l: 'Population exposed',
                    v: formatRange(assessment.population_exposed, formatCount),
                    s: `${formatRange(assessment.population_displaced, formatCount)} potentially displaced`,
                  },
                  {
                    l: 'Potential damage',
                    v: `${formatInr(assessment.damage.low_inr)}–${formatInr(assessment.damage.high_inr)}`,
                    s: `${assessment.critical_assets_exposed} mapped critical facilities exposed`,
                  },
                  {
                    l: 'Potential avoided damage',
                    v: `${formatInr(assessment.avoided.low_inr)}–${formatInr(assessment.avoided.high_inr)}`,
                    s: 'Estimated potential savings with early action — not guaranteed',
                  },
                ].map((k) => (
                  <div key={k.l} className="rounded-xl border border-cmd-border bg-cmd-panel2/50 p-3.5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cmd-muted">{k.l}</p>
                    <p className="mt-1.5 text-lg font-bold tabular-nums text-cmd-ink">{k.v}</p>
                    <p className="mt-0.5 text-[11px] text-cmd-muted">{k.s}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-cmd-muted">
              No assessment has been run in this session, so no exposure, damage or savings figures are shown here. Open{' '}
              <button onClick={() => navigate('/impact')} className="font-semibold text-cmd-teal hover:text-cmd-ink">
                Flood Impact
              </button>{' '}
              to run one against a real dam and scenario.
            </p>
          )}
        </section>

        {/* KPI row — registry facts and last-assessment counts only */}
        <section aria-label="Registry and assessment metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {kpis.map(({ label, caption, value, sub, tone, icon }) => (
            <StatCard key={label} icon={icon} value={value} label={label} caption={caption} sub={sub} tone={tone} />
          ))}
        </section>

        {/* Quick actions */}
        <section aria-label="Quick actions" className="cmd-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
              <Map className="h-[18px] w-[18px] text-cmd-ink" strokeWidth={1.75} />
              Quick actions
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {ACTIONS.map(({ title, description, path, icon, tone }) => (
              <QuickAction
                key={path}
                icon={icon}
                title={title}
                description={description}
                tone={tone}
                onClick={() => navigate(path)}
              />
            ))}
          </div>
        </section>

        {/* Data sources (real checks, no invented uptime) */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SystemHealth sources={sources} onRefresh={() => setNonce((n) => n + 1)} />
          <div className="cmd-card space-y-3 p-5">
            <h2 className="text-[15px] font-semibold text-cmd-ink">How to read this platform</h2>
            <ul className="space-y-2 text-[12.5px] leading-relaxed text-cmd-muted">
              <li>
                • Depth, arrival times and exposure are <span className="text-cmd-ink">modelled estimates</span> from a
                screening propagation model, not observations or a certified forecast.
              </li>
              <li>
                • Settlements and facilities come from <span className="text-cmd-ink">OpenStreetMap</span>; population is
                taken from the OSM tag when present, otherwise estimated from the settlement class.
              </li>
              <li>
                • Money figures use planning-level unit rates and are always shown as ranges with a confidence level.
              </li>
              <li>• "Potential avoided damage" is what early action could save — never guaranteed savings.</li>
            </ul>
            <button
              onClick={() => navigate('/impact')}
              className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-semibold text-cmd-teal hover:text-cmd-ink"
            >
              See the full assumption list in Flood Impact → Data &amp; confidence
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Disclaimer (existing copy preserved) */}
        <div className="rounded-xl border border-cmd-amber/25 bg-cmd-amber/[0.06] p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-cmd-amber" strokeWidth={1.75} />
            <div>
              <h4 className="text-[13px] font-semibold text-cmd-ink">{t('disclaimer.title')}</h4>
              <p className="mt-1 text-xs leading-relaxed text-cmd-muted">{t('disclaimer.text')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
