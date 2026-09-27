/**
 * AquaShield 3D — Dashboard (command-centre landing).
 *
 * Every number on this page is either fetched from the backend or taken from
 * the last assessment the user actually ran. Charts are built from the
 * platform's own recorded activity (/dashboard/stats: run ledger + curated
 * register), and the news rail lists real items from public disaster/news
 * feeds (/dashboard/news: GDACS + GDELT, fetched server-side). Where a value
 * is genuinely not available the card says so — nothing here is invented.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Globe2, Map, Route, FileText, Waves, ArrowRight, RefreshCw, ExternalLink,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie,
} from 'recharts';
import HeroPanel from '../../components/dashboard/HeroPanel';
import QuickAction, { type ActionTone } from '../../components/dashboard/QuickAction';
import SystemHealth, { type DataSourceRow } from '../../components/dashboard/SystemHealth';
import { alertsApi, damsApi, dashboardApi, sandboxApi, scenariosApi, simRunsApi } from '../../api/client';
import { RISK_HEX, formatCount, formatInr, formatRange, formatUtc } from '../../components/impact/format';
import { loadLastAssessment, type LastAssessment } from '../../utils/lastAssessment';

import { BASE_URL } from '../../api/base';

interface DashStats {
  generated_at_utc: string;
  totals: { recorded_runs: number; terrain_sites: number; register_dams: number; alerts: number };
  series: {
    sims_per_day: Array<{ day: string; runs: number }>;
    runs_per_dam: Array<{ dam: string; runs: number }>;
    severity_mix: Array<{ band: string; count: number }>;
    register_types: Array<{ type: string; count: number }>;
    alert_pipeline: Array<{ status: string; count: number }>;
  };
}

interface NewsItem {
  title: string;
  source: string;
  date: string;
  url: string | null;
  severity?: string;
}

interface NewsFeed {
  articles: NewsItem[];
  sources: string[];
  note: string;
}

/** Recharts palette matched to the command-centre theme (index.css tokens). */
const PIE_COLORS = ['#65BFA9', '#55C99A', '#D8B24C', '#D96B70', '#7C9EB8', '#B88A5C'];

const CHART_TIP = {
  contentStyle: {
    background: '#0B141B', border: '1px solid #263742', borderRadius: 8,
    fontSize: 12, padding: '6px 10px',
  },
  labelStyle: { color: '#E8EEF0', fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: '#91A2AD' },
  cursor: { fill: 'rgba(232,238,240,0.05)' },
} as const;

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

/** GDACS dates look like 2026-09-20T…, GDELT like 20260927T123000Z. */
const fmtNewsDate = (d: string) => {
  if (!d) return '';
  if (/^\d{8}/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d.slice(0, 10);
};

const SEVERITY_DOT: Record<string, string> = {
  RED: '#D96B70',
  ORANGE: '#D8B24C',
  GREEN: '#55C99A',
};

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [assessment, setAssessment] = useState<LastAssessment | null>(null);
  const [terrainSites, setTerrainSites] = useState<number | null>(null);
  const [backend, setBackend] = useState<'online' | 'unavailable' | 'unknown'>('unknown');
  const [stats, setStats] = useState<DashStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [news, setNews] = useState<NewsFeed | null>(null);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setAssessment(loadLastAssessment());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const total = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' && typeof r.value?.total === 'number' ? r.value.total : null;

    const [health, terrain, statsRes, newsRes] = await Promise.allSettled([
      fetch(`${BASE_URL}/health`).then((r) => r.ok),
      sandboxApi.dams(),
      dashboardApi.stats(),
      dashboardApi.news(),
    ]);
    setBackend(
      health.status === 'fulfilled' && health.value === true
        ? 'online'
        : health.status === 'rejected'
          ? 'unavailable'
          : 'unknown',
    );
    setTerrainSites(
      terrain.status === 'fulfilled' && typeof terrain.value?.total === 'number' ? terrain.value.total : null,
    );
    if (statsRes.status === 'fulfilled') {
      setStats(statsRes.value);
      setStatsError(null);
    } else {
      setStats(null);
      setStatsError(statsRes.reason?.message ?? 'unavailable');
    }
    if (newsRes.status === 'fulfilled') {
      setNews(newsRes.value);
      setNewsError(null);
    } else {
      setNews(null);
      setNewsError(newsRes.reason?.message ?? 'unreachable');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  const sources: DataSourceRow[] = useMemo(
    () => [
      {
        name: 'Backend API',
        status: backend,
        detail:
          backend === 'online'
            ? `${BASE_URL || window.location.origin}/api/v1 responded to a health check`
            : 'No health response — charts and news show a note instead of figures',
      },
      {
        name: 'Simulation terrain',
        status: terrainSites == null ? 'unknown' : terrainSites > 0 ? 'online' : 'unavailable',
        detail:
          terrainSites == null
            ? 'Terrain inventory not requested yet'
            : `${terrainSites} dam domains with a DEM ready for screening simulation`,
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
    [assessment, backend, terrainSites],
  );

  const simData = stats?.series.sims_per_day ?? [];
  const registerTypes = stats?.series.register_types ?? [];
  const totalRegisterDams = registerTypes.reduce((s, d) => s + d.count, 0);
  const newsItems = useMemo(() => (news?.articles ?? []).slice(0, 8), [news]);

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

        {/* Charts — platform's own recorded activity + curated register composition */}
        <section aria-label="Platform statistics" className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {/* Activity: recorded simulation runs, last 14 days */}
          <div className="cmd-card p-5 xl:col-span-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
                <Waves className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />
                Simulation activity — last 14 days
              </h2>
              <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-cmd-muted">
                Recorded runs • D-13 → today
              </span>
            </div>
            {statsError ? (
              <p className="py-10 text-center text-[12.5px] text-cmd-muted">
                Statistics unavailable right now — the backend did not answer. No placeholder figures are shown.
              </p>
            ) : !stats ? (
              <div className="flex h-[190px] items-center justify-center text-[12.5px] text-cmd-muted">Loading…</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={190}>
                  <BarChart data={simData} margin={{ top: 12, right: 4, left: -20, bottom: 0 }}>
                    <XAxis
                      dataKey="day"
                      tick={{ fill: '#91A2AD', fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: '#263742' }}
                      interval={2}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: '#91A2AD', fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={36}
                    />
                    <Tooltip {...CHART_TIP} />
                    <Bar dataKey="runs" name="Recorded runs" radius={[3, 3, 0, 0]} maxBarSize={26}>
                      {simData.map((d) => (
                        <Cell key={d.day} fill={d.runs > 0 ? '#65BFA9' : '#1E2E38'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <p className="mt-2 text-[11px] text-cmd-muted">
                  From the platform's own run ledger ({stats.totals.recorded_runs} recorded run
                  {stats.totals.recorded_runs === 1 ? '' : 's'} in total). Empty days stay empty — nothing is estimated.
                </p>
              </>
            )}
          </div>

          {/* Register composition donut */}
          <div className="cmd-card p-5">
            <h2 className="text-[15px] font-semibold text-cmd-ink">Dam register</h2>
            <p className="text-[11px] text-cmd-muted">Curated India dam register by type</p>
            {statsError ? (
              <p className="py-10 text-center text-[12.5px] text-cmd-muted">Statistics unavailable right now.</p>
            ) : !stats ? (
              <div className="flex h-[190px] items-center justify-center text-[12.5px] text-cmd-muted">Loading…</div>
            ) : (
              <>
                <div className="relative">
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie
                        data={registerTypes}
                        dataKey="count"
                        nameKey="type"
                        innerRadius={48}
                        outerRadius={68}
                        paddingAngle={3}
                        stroke="#101B23"
                        strokeWidth={2}
                      >
                        {registerTypes.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip {...CHART_TIP} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-xl font-bold tabular-nums text-cmd-ink">{totalRegisterDams}</span>
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-cmd-muted">dams</span>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                  {registerTypes.map((d, i) => (
                    <span key={d.type} className="flex items-center gap-1.5 text-[11px] text-cmd-muted">
                      <span className="h-2 w-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      {d.type} <span className="font-semibold text-cmd-ink">{d.count}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
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

        {/* Live dam & flood news — real public feeds, fetched server-side */}
        <section className="cmd-card p-5" aria-label="Dam and flood news from public feeds">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
              <Globe2 className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />
              Dam &amp; flood news
            </h2>
            {news && news.articles.length > 0 && (
              <span className="rounded-md border border-cmd-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-cmd-muted">
                {news.sources.join(' • ')}
              </span>
            )}
          </div>

          {newsError ? (
            <p className="text-[12.5px] text-cmd-muted">
              News feeds are unreachable right now — showing no items rather than invented ones. ({newsError})
            </p>
          ) : !news ? (
            <div className="flex items-center gap-2 py-4 text-[12.5px] text-cmd-muted">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Fetching live feeds…
            </div>
          ) : news.articles.length === 0 ? (
            <p className="text-[12.5px] text-cmd-muted">{news.note}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-x-8 gap-y-2.5 md:grid-cols-2">
                {newsItems.map((a, i) => (
                  <a
                    key={`${a.title}-${i}`}
                    href={a.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className={`group flex items-start gap-2.5 rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-white/[0.03] ${
                      a.url ? '' : 'cursor-default'
                    }`}
                  >
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ background: SEVERITY_DOT[(a.severity || '').toUpperCase()] ?? '#65BFA9' }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-cmd-ink group-hover:text-cmd-teal">
                        {a.title}
                      </span>
                      <span className="text-[10.5px] text-cmd-muted">
                        {a.source || 'public feed'} • {fmtNewsDate(a.date)}
                      </span>
                    </span>
                    {a.url && (
                      <ExternalLink
                        className="mt-1 h-3 w-3 shrink-0 text-cmd-muted opacity-0 transition-opacity group-hover:opacity-70"
                        strokeWidth={1.75}
                      />
                    )}
                  </a>
                ))}
              </div>
              <p className="mt-3 text-[10.5px] text-cmd-muted">{news.note}</p>
            </>
          )}
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
