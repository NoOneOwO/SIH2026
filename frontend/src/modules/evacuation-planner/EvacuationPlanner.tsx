/**
 * AquaShield 3D — Evacuation Planner.
 *
 * Ranked evacuation priorities derived from the same transparent impact
 * estimate as the Flood Impact workspace (POST /impact/estimate): real mapped
 * settlements, modelled arrival times, exposed population ranges, and the
 * facilities that need protecting. Nothing here is a placeholder — when no
 * settlement is reachable the module says so.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { AlertTriangle, Clock, RefreshCw, ShieldCheck, Users, Wrench } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { impactApi, sandboxApi } from '../../api/client';
import type { ImpactEstimateResponse } from '../../types/impact';
import { RISK_HEX, formatCount, formatInr, formatRange } from '../../components/impact/format';
import { CaveatStrip, EmptyState, RiskBadge } from '../../components/impact/primitives';
import { loadLastAssessment } from '../../utils/lastAssessment';

interface DamOption {
  dam_id: string;
  name: string;
}

export default function EvacuationPlanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [dams, setDams] = useState<DamOption[]>([]);
  const [damId, setDamId] = useState('');
  const [caseKey, setCaseKey] = useState<'best' | 'likely' | 'worst'>('likely');
  const [data, setData] = useState<ImpactEstimateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'lead' | 'population' | 'arrival'>('lead');

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await sandboxApi.dams();
        if (dead) return;
        const list: DamOption[] = (res?.dams ?? []).map((d: any) => ({ dam_id: d.dam_id, name: d.name ?? d.dam_id }));
        setDams(list);
        const last = loadLastAssessment();
        if (list.length) {
          setDamId(list.find((d) => d.dam_id === last?.dam_id)?.dam_id ?? list[0].dam_id);
        }
      } catch {
        if (!dead) setError('Could not load the dam inventory. The backend API is not reachable.');
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  const run = useCallback(async (id: string, which: 'best' | 'likely' | 'worst') => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res: ImpactEstimateResponse = await impactApi.estimate({
        dam_id: id,
        case: which,
        grid_size: 64,
        ensemble_count: 8,
      });
      setData(res);
    } catch (e: any) {
      setData(null);
      setError(`Assessment failed: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (damId) void run(damId, caseKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [damId]);

  const estimate = data?.estimate ?? null;

  const priority = useMemo(() => {
    if (!estimate) return [];
    const list = estimate.settlements.filter((s) => s.status !== 'SAFE');
    return list.sort((a, b) => {
      if (sortBy === 'population') return b.population_displaced.mid - a.population_displaced.mid;
      if (sortBy === 'arrival') return (a.arrival_min ?? 1e9) - (b.arrival_min ?? 1e9);
      return (a.lead_time_min ?? 1e9) - (b.lead_time_min ?? 1e9);
    });
  }, [estimate, sortBy]);

  const chartData = useMemo(
    () =>
      [...priority]
        .filter((s) => s.arrival_min != null)
        .slice(0, 12)
        .map((s) => ({
          name: s.name.length > 14 ? `${s.name.slice(0, 13)}…` : s.name,
          arrival: s.arrival_min as number,
          lead: s.lead_time_min ?? 0,
          risk: s.risk,
          full: s,
        })),
    [priority],
  );

  const facilitiesToProtect = useMemo(() => {
    if (!estimate) return [];
    const counts = new Map<string, number>();
    estimate.settlements.forEach((s) =>
      s.facilities_exposed.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1)),
    );
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [estimate]);

  /** Jump to the globe: waypoint on the settlement + distance-from-dam card. */
  const focusOnGlobe = (s: NonNullable<typeof priority>[number]) => {
    const q = new URLSearchParams({
      globeCity: s.name,
      clon: String(s.lon),
      clat: String(s.lat),
      damlon: String(estimate?.dam.lon ?? ''),
      damlat: String(estimate?.dam.lat ?? ''),
      depth: `${s.depth_m.toFixed(2)} m`,
      arr: s.arrival_min == null ? 'not resolved' : `T+${Math.round(s.arrival_min)} min`,
    });
    navigate(`/incident?${q.toString()}`);
  };

  const totalToMove = priority.reduce(
    (acc, s) => ({
      low: acc.low + s.population_displaced.low,
      mid: acc.mid + s.population_displaced.mid,
      high: acc.high + s.population_displaced.high,
    }),
    { low: 0, mid: 0, high: 0 },
  );
  const firstArrival = priority.reduce<number | null>(
    (min, s) => (s.arrival_min == null ? min : min == null ? s.arrival_min : Math.min(min, s.arrival_min)),
    null,
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto max-w-[1400px] space-y-5 p-4 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.evacuationPlanner')}</h1>
            <p className="mt-1 text-sm text-cmd-muted">
              Priority areas, usable lead times and the assets that need protecting — from the modelled flood assessment.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">
              Dam
              <select
                value={damId}
                onChange={(e) => setDamId(e.target.value)}
                disabled={loading}
                className="mt-1 block w-56 rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[12px] normal-case tracking-normal text-cmd-ink focus:border-cmd-teal/60 focus:outline-none"
              >
                {dams.length === 0 && <option value="">No terrain-backed dams available</option>}
                {dams.map((d) => (
                  <option key={d.dam_id} value={d.dam_id}>
                    {d.name} ({d.dam_id})
                  </option>
                ))}
              </select>
            </label>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">
              Scenario
              <div className="mt-1 flex gap-1 rounded-lg border border-cmd-border bg-cmd-panel2 p-1">
                {(['best', 'likely', 'worst'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      setCaseKey(c);
                      void run(damId, c);
                    }}
                    disabled={loading}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-bold capitalize transition-colors ${
                      caseKey === c ? 'bg-cmd-teal/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-cmd-red/35 bg-cmd-red/[0.07] px-3.5 py-3">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-cmd-red" strokeWidth={1.9} />
            <p className="text-[12px] leading-relaxed text-cmd-muted">{error}</p>
          </div>
        )}

        {loading && !estimate && (
          <div className="cmd-card flex items-center gap-3 p-5 text-[12.5px] text-cmd-muted">
            <RefreshCw className="h-4 w-4 animate-spin text-cmd-teal" />
            Running the screening simulation for {dams.find((d) => d.dam_id === damId)?.name ?? damId}…
          </div>
        )}

        {estimate && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  label: 'People potentially needing relocation',
                  value: formatRange(totalToMove, formatCount),
                  sub: `${priority.length} settlements needing action`,
                  icon: <Users className="h-4 w-4 text-cmd-amber" strokeWidth={1.75} />,
                },
                {
                  label: 'First modelled arrival',
                  value: firstArrival == null ? 'Not resolved' : `T+${Math.round(firstArrival)} min`,
                  sub: 'Earliest water at a mapped settlement',
                  icon: <Clock className="h-4 w-4 text-cmd-red" strokeWidth={1.75} />,
                },
                {
                  label: 'Facilities to protect',
                  value: String(estimate.totals.critical_assets_exposed),
                  sub: facilitiesToProtect.map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' • ') || 'none mapped',
                  icon: <Wrench className="h-4 w-4 text-cmd-teal" strokeWidth={1.75} />,
                },
                {
                  label: 'Potential avoided damage',
                  value: `${formatInr(estimate.totals.avoided.low_inr)}–${formatInr(estimate.totals.avoided.high_inr)}`,
                  sub: `Confidence ${estimate.confidence.level} — estimated potential savings`,
                  icon: <ShieldCheck className="h-4 w-4 text-cmd-green" strokeWidth={1.75} />,
                },
              ].map((k) => (
                <div key={k.label} className="cmd-card p-4">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cmd-muted">
                    {k.icon}
                    {k.label}
                  </p>
                  <p className="mt-1.5 text-xl font-bold tabular-nums text-cmd-ink">{k.value}</p>
                  <p className="mt-0.5 text-[11px] text-cmd-muted">{k.sub}</p>
                </div>
              ))}
            </div>

            {chartData.length > 0 && (
              <div className="cmd-card p-5">
                <h3 className="mb-1 text-[15px] font-semibold text-cmd-ink">Modelled arrival time by settlement</h3>
                <p className="mb-3 text-xs text-cmd-muted">
                  Minutes from the breach until water reaches each settlement (modelled, screening model). Click a bar to
                  open it on the globe.
                </p>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                      <XAxis
                        dataKey="name"
                        tick={{ fill: '#91A2AD', fontSize: 10 }}
                        interval={0}
                        angle={-18}
                        dy={8}
                        height={46}
                        tickLine={false}
                        axisLine={{ stroke: '#263742' }}
                      />
                      <YAxis tick={{ fill: '#91A2AD', fontSize: 10 }} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ background: '#14222B', border: '1px solid #263742', borderRadius: 8, fontSize: 12, color: '#E8EEF0' }}
                        formatter={(v: any) => [`T+${Math.round(Number(v))} min`, 'Arrival']}
                      />
                      <Bar
                        dataKey="arrival"
                        radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                        onClick={(_, i) => {
                          const row = chartData[i];
                          if (row) focusOnGlobe(row.full);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        {chartData.map((d) => (
                          <Cell key={d.name} fill={RISK_HEX[d.risk]} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="cmd-card p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
                  <Users className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
                  Evacuation priority
                </h3>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="rounded-lg border border-cmd-border bg-cmd-panel2 px-3 py-1.5 text-xs text-cmd-ink focus:border-cmd-teal/60 focus:outline-none"
                >
                  <option value="lead">Sort by usable lead time</option>
                  <option value="arrival">Sort by arrival time</option>
                  <option value="population">Sort by people to move</option>
                </select>
              </div>

              {priority.length === 0 ? (
                <EmptyState
                  title="No settlement needs evacuation in this scenario"
                  body="Water does not reach a mapped settlement in the modelled run. Re-assess with a worse case before standing down."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[46rem]">
                    <thead>
                      <tr className="border-b border-cmd-border">
                        {['#', 'Settlement', 'Risk', 'Water arrives', 'Usable lead time', 'People to move', 'Damage to avoid'].map(
                          (h, i) => (
                            <th
                              key={h}
                              className={`px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-cmd-muted ${
                                i >= 3 ? 'text-right' : 'text-left'
                              }`}
                            >
                              {h}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {priority.map((s, i) => (
                        <tr
                          key={s.id}
                          onClick={() => focusOnGlobe(s)}
                          className="cursor-pointer border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03]"
                          title="Open on the globe"
                        >
                          <td className="px-3 py-3 text-[12px] font-bold tabular-nums text-cmd-muted">{i + 1}</td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full" style={{ background: RISK_HEX[s.risk] }} />
                              <span className="text-[12.5px] font-semibold text-cmd-ink">{s.name}</span>
                            </div>
                            <span className="text-[10.5px] text-cmd-muted">{s.kind} • {s.depth_m.toFixed(2)} m peak depth</span>
                          </td>
                          <td className="px-3 py-3">
                            <RiskBadge risk={s.risk} size="sm" />
                          </td>
                          <td className="px-3 py-3 text-right text-[12px] tabular-nums text-cmd-ink/90">
                            {s.arrival_min == null ? '—' : `T+${Math.round(s.arrival_min)} min`}
                          </td>
                          <td className="px-3 py-3 text-right text-[12px] tabular-nums">
                            <span className={s.lead_time_min != null && s.lead_time_min <= 30 ? 'font-bold text-cmd-red' : 'text-cmd-ink/90'}>
                              {s.lead_time_min == null ? '—' : `${Math.round(s.lead_time_min)} min`}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right text-[12px] tabular-nums text-cmd-ink/90">
                            {formatRange(s.population_displaced, formatCount)}
                          </td>
                          <td className="px-3 py-3 text-right text-[12px] font-semibold tabular-nums text-cmd-green">
                            {formatInr(s.savings.avoided.low_inr)}–{formatInr(s.savings.avoided.high_inr)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <CaveatStrip>
              Lead time already subtracts a {15} min mobilisation allowance (alert issue → people moving). Arrival times and
              exposures are modelled estimates from a screening propagation model, and population is estimated from the
              settlement class where OpenStreetMap carries no population tag — verify against local records before
              authorising an evacuation.
            </CaveatStrip>
          </>
        )}

        {!estimate && !loading && !error && (
          <EmptyState
            title="No assessment loaded"
            body="Pick a dam and scenario to compute the evacuation priorities. Terrain must be available for the dam you choose."
          />
        )}
      </div>
    </motion.div>
  );
}
