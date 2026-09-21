/**
 * AquaShield 3D — Flood Impact Intelligence.
 *
 * One workspace that answers, in order:
 *   where is the danger → which towns are affected → how many people and how
 *   much value is exposed → what damage is likely → what early action could
 *   avoid → how confident are we and why.
 *
 * All numbers come from POST /api/v1/impact/estimate (real simulation output
 * fed through the documented hazard → exposure → vulnerability → impact →
 * economic-loss → avoided-loss chain). Nothing on this screen is invented:
 * when data is missing the UI says so instead of filling the gap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronDown, Coins, Database, Globe2, Layers, ListOrdered,
  MapPinned, PlayCircle, RefreshCw, ShieldCheck, Users,
} from 'lucide-react';
import { impactApi, sandboxApi } from '../../api/client';
import type { ImpactEstimateResponse } from '../../types/impact';
import GodEye3D from '../../viewers/gods-eye/GodEye3D';
import { OverviewView, ImpactView, ResponseView, DataView } from '../../components/impact/views';
import SettlementDetail from '../../components/impact/SettlementDetail';
import { ConfidenceBadge, CaveatStrip, EmptyState, RiskBadge, EvidenceTag, Section } from '../../components/impact/primitives';
import { formatCount, formatInr, formatRange } from '../../components/impact/format';
import { saveLastAssessment } from '../../utils/lastAssessment';

type Tab = 'overview' | 'map' | 'impact' | 'response' | 'data';

/**
 * What the assessment actually does — shown before a run so the user is never
 * staring at an empty workspace and knows what is about to be computed.
 * This is a description of the method, not a result.
 */
const CHAIN: Array<{ stage: string; text: string }> = [
  { stage: 'Hazard', text: 'Screening dam-break propagation on the local DEM — depth, extent and arrival time per cell.' },
  { stage: 'Exposure', text: 'Mapped settlements and critical facilities sampled against that water footprint.' },
  { stage: 'Vulnerability', text: 'Population from OpenStreetMap tags or settlement class; depth–damage factors per asset category.' },
  { stage: 'Impact', text: 'People exposed and potentially displaced, facilities in the water, areas isolated.' },
  { stage: 'Economic loss', text: 'Exposure × vulnerability × severity, reported as a range with planning-level unit rates.' },
  { stage: 'Avoided loss', text: 'What evacuation and protection could remove given the usable warning lead time.' },
];

const TABS: Array<{ key: Tab; label: string; icon: typeof Globe2 }> = [
  { key: 'overview', label: 'Overview', icon: ListOrdered },
  { key: 'map', label: 'Live map', icon: Globe2 },
  { key: 'impact', label: 'Impact', icon: Users },
  { key: 'response', label: 'Response', icon: ShieldCheck },
  { key: 'data', label: 'Data & confidence', icon: Database },
];

const CASES: Array<{ key: 'best' | 'likely' | 'worst'; label: string; hint: string }> = [
  { key: 'best', label: 'Best', hint: 'Partial breach, low rainfall — smallest plausible release' },
  { key: 'likely', label: 'Likely', hint: 'Major breach, design rainfall — the planning case' },
  { key: 'worst', label: 'Worst', hint: 'Full breach, heavy rainfall — conservative screening case' },
];

interface DamOption {
  dam_id: string;
  name: string;
  lat: number;
  lon: number;
}

export default function ImpactIntelligence() {
  const [dams, setDams] = useState<DamOption[] | null>(null);
  const [damId, setDamId] = useState<string>('');
  const [caseKey, setCaseKey] = useState<'best' | 'likely' | 'worst'>('likely');
  const [data, setData] = useState<ImpactEstimateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept separate from `error`: a missing dam inventory is an environment
  // problem, not a failed assessment, and the two need different guidance.
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [inventoryNonce, setInventoryNonce] = useState(0);
  const autoRanRef = useRef(false);

  // ── Dam inventory: only dams that actually have terrain to simulate ──────
  useEffect(() => {
    let dead = false;
    setInventoryError(null);
    setDams(null);
    (async () => {
      try {
        const res = await sandboxApi.dams();
        if (dead) return;
        const list: DamOption[] = (res?.dams ?? [])
          .filter((d: any) => d?.dam_id && d?.lat != null && d?.lon != null)
          .map((d: any) => ({ dam_id: d.dam_id, name: d.name ?? d.dam_id, lat: d.lat, lon: d.lon }));
        setDams(list);
        if (list.length) {
          // Deep links (?dam=d52) win, then the preferred demo dam, then the first.
          const wanted = new URLSearchParams(window.location.search).get('dam');
          const linked = wanted ? list.find((d) => d.dam_id === wanted) : undefined;
          const preferred = linked ?? list.find((d) => d.dam_id === 'd4') ?? list[0];
          setDamId(preferred.dam_id);
        }
      } catch (e: any) {
        if (!dead) {
          setDams([]);
          const raw = String(e?.message ?? e);
          // A 5xx/network failure here almost always means the API is down, and
          // saying so is more useful than echoing the raw status code.
          setInventoryError(
            /API Error 5\d\d|Failed to fetch|NetworkError/i.test(raw)
              ? 'The backend API did not respond, so the dam inventory could not be read. Start the API (see backend/README.md), then retry.'
              : `Could not load the dam inventory: ${raw}`,
          );
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [inventoryNonce]);

  const run = useCallback(
    async (id: string, which: 'best' | 'likely' | 'worst') => {
      if (!id) return;
      setLoading(true);
      setError(null);
      setSelectedId(null);
      try {
        const res: ImpactEstimateResponse = await impactApi.estimate({
          dam_id: id,
          case: which,
          grid_size: 64,
          ensemble_count: 8,
        });
        setData(res);
        // Hand the computed summary to the dashboard (never a re-derived copy).
        saveLastAssessment({
          dam_id: res.dam_id,
          dam_name: res.dam_name,
          case: res.case,
          generated_at_utc: res.estimate.generated_at_utc,
          overall_risk: res.estimate.totals.overall_risk,
          population_exposed: res.estimate.totals.population_exposed,
          population_displaced: res.estimate.totals.population_displaced,
          damage: res.estimate.totals.damage,
          avoided: res.estimate.totals.avoided,
          confidence: { level: res.estimate.confidence.level, score: res.estimate.confidence.score },
          settlements_assessed: res.estimate.totals.settlements_assessed,
          settlements_inundated: res.estimate.totals.settlements_inundated,
          settlements_at_risk: res.estimate.totals.settlements_at_risk,
          critical_assets_exposed: res.estimate.totals.critical_assets_exposed,
          flooded_area_km2: res.estimate.totals.flooded_area_km2,
          engine: res.estimate.engine.name,
          asset_provenance: res.asset_provenance,
        });
      } catch (e: any) {
        setData(null);
        setError(
          `Assessment failed: ${e?.message ?? e}. The estimate is never substituted with placeholder data — ` +
            'check that the backend is reachable and that terrain is available for this dam.',
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // First assessment runs automatically so the user lands on a real situation.
  useEffect(() => {
    if (!damId || autoRanRef.current) return;
    autoRanRef.current = true;
    void run(damId, caseKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [damId]);

  const estimate = data?.estimate ?? null;
  const selected = useMemo(
    () => estimate?.settlements.find((s) => s.id === selectedId) ?? null,
    [estimate, selectedId],
  );

  const handleSelect = useCallback((id: string | null) => setSelectedId(id), []);

  const headline = estimate
    ? `${estimate.totals.settlements_inundated} settlement${
        estimate.totals.settlements_inundated === 1 ? '' : 's'
      } inundated, ${formatRange(estimate.totals.population_exposed, formatCount)} people potentially exposed, ${formatInr(
        estimate.totals.damage.low_inr,
      )}–${formatInr(estimate.totals.damage.high_inr)} potential damage.`
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-cmd-bg">
      {/* ── Control header: who, which scenario, run ─────────────────────── */}
      <header className="shrink-0 border-b border-cmd-border bg-cmd-panel/60 px-4 py-3">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-end gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[17px] font-bold text-cmd-ink">
              <MapPinned className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />
              Flood Impact Intelligence
            </h1>
            <p className="mt-0.5 text-[11.5px] text-cmd-muted">
              Where flooding is likely, which settlements are exposed, and what early action could avoid.
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-end gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">
              Assessment dam
              <select
                value={damId}
                onChange={(e) => {
                  setDamId(e.target.value);
                  void run(e.target.value, caseKey);
                }}
                disabled={loading}
                className="mt-1 block w-64 rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[12px] font-medium normal-case tracking-normal text-cmd-ink focus:border-cmd-teal/60 focus:outline-none disabled:opacity-60"
              >
                {dams === null && <option value="">Loading dams…</option>}
                {dams?.length === 0 && <option value="">No terrain-backed dams available</option>}
                {dams?.map((d) => (
                  <option key={d.dam_id} value={d.dam_id}>
                    {d.name} ({d.dam_id})
                  </option>
                ))}
              </select>
            </label>

            <div className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">
              Scenario
              <div className="mt-1 flex gap-1 rounded-lg border border-cmd-border bg-cmd-panel2 p-1">
                {CASES.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setCaseKey(c.key)}
                    title={c.hint}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                      caseKey === c.key ? 'bg-cmd-teal/90 text-[#071018]' : 'text-cmd-muted hover:text-cmd-ink'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => void run(damId, caseKey)}
              disabled={loading || !damId}
              className="flex items-center gap-2 rounded-lg bg-cmd-teal/90 px-4 py-2 text-[12px] font-bold text-[#071018] transition-colors hover:bg-cmd-teal disabled:opacity-50"
            >
              {loading ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Assessing…
                </>
              ) : (
                <>
                  <PlayCircle className="h-3.5 w-3.5" /> Run assessment
                </>
              )}
            </button>
          </div>
        </div>

        {/* Situation strip: the one-line answer, always visible */}
        <div className="mx-auto mt-3 flex max-w-[1700px] flex-wrap items-center gap-2.5">
          {estimate && (
            <>
              <RiskBadge risk={estimate.totals.overall_risk} />
              <p className="min-w-0 flex-1 text-[12.5px] font-medium text-cmd-ink/90">{headline}</p>
              <ConfidenceBadge level={estimate.confidence.level} score={estimate.confidence.score} />
            </>
          )}
          {!estimate && !loading && !inventoryError && (
            <p className="text-[12px] text-cmd-muted">
              No assessment loaded yet — the pipeline below runs once you press Run assessment.
            </p>
          )}
          {loading && (
            <p className="flex items-center gap-2 text-[12px] text-cmd-muted">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-cmd-teal" />
              Running the screening simulation, sampling mapped settlements and computing the impact chain…
            </p>
          )}
        </div>
      </header>

      {/* ── Tabs (primary → secondary → detailed, one layer at a time) ─────
           Only rendered once there is something to show, so the user never
           clicks through empty sections. */}
      <nav
        className={`shrink-0 border-b border-cmd-border bg-cmd-panel/30 px-4 ${estimate ? '' : 'hidden'}`}
        aria-label="Assessment sections"
      >
        <div className="mx-auto flex max-w-[1700px] gap-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={tab === key}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-semibold transition-colors ${
                tab === key
                  ? 'border-cmd-teal text-cmd-ink'
                  : 'border-transparent text-cmd-muted hover:text-cmd-ink'
              }`}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {inventoryError && (
          <div className="mx-auto max-w-[1700px] p-4">
            <div className="flex items-start gap-2.5 rounded-xl border border-cmd-amber/35 bg-cmd-amber/[0.07] px-3.5 py-3">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-cmd-amber" strokeWidth={1.9} />
              <div>
                <p className="text-[12.5px] font-semibold text-cmd-ink">Dam inventory unavailable</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-cmd-muted">{inventoryError}</p>
              </div>
              <button
                onClick={() => setInventoryNonce((n) => n + 1)}
                className="ml-auto shrink-0 rounded-lg border border-cmd-border px-3 py-1.5 text-[11px] font-bold text-cmd-muted hover:text-cmd-ink"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mx-auto max-w-[1700px] p-4">
            <div className="flex items-start gap-2.5 rounded-xl border border-cmd-red/35 bg-cmd-red/[0.07] px-3.5 py-3">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-cmd-red" strokeWidth={1.9} />
              <div>
                <p className="text-[12.5px] font-semibold text-cmd-ink">Estimate unavailable</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-cmd-muted">{error}</p>
              </div>
              <button
                onClick={() => void run(damId, caseKey)}
                disabled={!damId}
                className="ml-auto shrink-0 rounded-lg border border-cmd-border px-3 py-1.5 text-[11px] font-bold text-cmd-muted hover:text-cmd-ink disabled:opacity-40"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Even when the inventory cannot be read, explain the method rather than
            leaving the workspace blank. */}
        {!estimate && !error && (
          <div className="mx-auto max-w-[1700px] p-4">
            {loading ? (
              <EmptyState
                icon={<RefreshCw className="h-5 w-5 animate-spin text-cmd-teal" />}
                title="Running the screening assessment"
                body="Propagating the breach across the terrain grid, sampling mapped settlements, then walking the exposure → vulnerability → impact → loss chain. This takes a few seconds."
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <Section
                  title="How the estimate is built"
                  icon={<ListOrdered className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
                  className="xl:col-span-2"
                  aside={<span className="text-[11px] text-cmd-muted">Run the assessment to compute each stage</span>}
                >
                  <ol className="space-y-2.5">
                    {CHAIN.map((step, i) => (
                      <li key={step.stage} className="flex gap-2.5">
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cmd-teal/15 text-[9.5px] font-bold text-cmd-teal">
                          {i + 1}
                        </span>
                        <span className="text-[12px] leading-snug">
                          <span className="font-semibold uppercase tracking-wide text-cmd-ink">{step.stage}</span>
                          <span className="block text-cmd-muted">{step.text}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </Section>

                <div className="space-y-4">
                  <Section title="Before you run" icon={<Layers className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
                    <ul className="space-y-1.5 text-[12px] leading-relaxed text-cmd-muted">
                      <li>• Pick the dam whose failure you are planning for.</li>
                      <li>• Pick a scenario case — <span className="text-cmd-ink/90">Likely</span> is the planning case.</li>
                      <li>• Run the assessment; every figure returns with an evidence class and a confidence level.</li>
                    </ul>
                  </Section>
                  <CaveatStrip>
                    This screen never fills gaps with invented numbers. If terrain, settlement or population data is
                    missing for a location, the estimate says so rather than guessing.
                  </CaveatStrip>
                </div>
              </div>
            )}
          </div>
        )}

        {estimate && tab === 'map' ? (
          <div className="flex h-full">
            <div className="relative min-w-0 flex-1">
              <GodEye3D
                timeMinutes={0}
                impactData={null}
                cameraTarget={null}
                onCameraChange={() => {}}
                focusDam={{ lon: estimate.dam.lon ?? 0, lat: estimate.dam.lat ?? 0, name: estimate.dam.name }}
                estimate={estimate}
                selectedSettlementId={selectedId}
                onSelectSettlement={handleSelect}
              />
            </div>
            <aside className="flex w-[22rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-cmd-border bg-cmd-panel/40 p-3">
              {selected ? (
                <SettlementDetail settlement={selected} confidence={estimate.confidence} onClose={() => setSelectedId(null)} />
              ) : (
                <div className="rounded-xl border border-dashed border-cmd-border p-4">
                  <p className="text-[12px] font-semibold text-cmd-ink">Select a settlement</p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-cmd-muted">
                    Click a marker on the globe, or pick a location below, to see its risk, exposure, damage estimate and
                    the factors behind it.
                  </p>
                </div>
              )}
              <div className="rounded-xl border border-cmd-border bg-cmd-panel p-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-cmd-muted">
                  Highest exposure
                </p>
                <div className="space-y-1.5">
                  {estimate.settlements.slice(0, 8).map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedId(s.id)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                        selectedId === s.id
                          ? 'border-cmd-teal/50 bg-cmd-tealdim'
                          : 'border-transparent hover:border-cmd-border hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cmd-ink">{s.name}</span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-cmd-muted">
                        {formatRange(s.population_exposed, formatCount)}
                      </span>
                      <ChevronDown className="h-3 w-3 -rotate-90 shrink-0 text-cmd-muted" />
                    </button>
                  ))}
                  {estimate.settlements.length === 0 && (
                    <p className="text-[11.5px] text-cmd-muted">No mapped settlement inside the modelled footprint.</p>
                  )}
                </div>
              </div>
              <div className="rounded-xl border border-cmd-border bg-cmd-panel p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cmd-muted">Globe legend</p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-cmd-muted">
                  Settlement colour = risk band, size = exposed population. Translucent zones are the modelled inundation
                  footprint sampled at settlement resolution. Toggle layers in the globe's own legend.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <EvidenceTag basis="modelled" />
                  <span className="text-[10.5px] text-cmd-muted">All globe flood layers come from the simulation</span>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-[1700px] space-y-4 p-4">
              {estimate && tab === 'overview' && (
                <OverviewView estimate={estimate} onSelect={handleSelect} selectedId={selectedId} />
              )}
              {estimate && tab === 'impact' && (
                <ImpactView estimate={estimate} onSelect={handleSelect} selectedId={selectedId} />
              )}
              {estimate && tab === 'response' && <ResponseView estimate={estimate} />}
              {estimate && tab === 'data' && (
                <DataView
                  estimate={estimate}
                  extra={
                    <>
                      <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
                        <dt className="text-[11.5px] text-cmd-muted">Scenario case</dt>
                        <dd className="text-right text-[11.5px] text-cmd-ink/90">
                          {data?.case} — {CASES.find((c) => c.key === data?.case)?.hint}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
                        <dt className="text-[11.5px] text-cmd-muted">Critical-asset inventory</dt>
                        <dd className="text-right text-[11.5px] text-cmd-ink/90">{data?.asset_provenance}</dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
                        <dt className="text-[11.5px] text-cmd-muted">Scenario ensemble</dt>
                        <dd className="text-right text-[11.5px] text-cmd-ink/90">
                          {data?.ensemble ? `${data.ensemble.runs} runs` : 'not run (single case)'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
                        <dt className="text-[11.5px] text-cmd-muted">Terrain source</dt>
                        <dd className="text-right text-[11.5px] text-cmd-ink/90">
                          {String(
                            (data?.terrain as any)?.dataset ??
                              (data?.terrain as any)?.source ??
                              'terrain provenance unavailable',
                          )}
                        </dd>
                      </div>
                    </>
                  }
                />
              )}
              {estimate && tab === 'overview' && (
                <CaveatStrip>
                  Scenario assessment for the {data?.case} case. Depths, arrival times and damage are modelled estimates
                  from a screening propagation model, not observations or a certified forecast.
                </CaveatStrip>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
