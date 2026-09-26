/**
 * AquaShield 3D — decision-support views for the Flood Impact workspace.
 *
 * Additive views over the estimate payload:
 *   DecisionCard    WHERE / WHEN / WHO / WHY narrative (cites computed numbers)
 *   PriorityView    Population-at-Risk table with expandable reasons
 *   AssetsView      critical-facility exposure table
 *   EvacuationView  candidate corridors, unsafe roads, bottlenecks, safe sectors
 *   ScenarioSpread  best/likely/worst totals side by side (uncertainty)
 *
 * Every band shown here is modelled; the labels say so.
 */

import { useState } from 'react';
import {
  AlertTriangle, ChevronDown, Clock, Compass, Footprints, MapPin, MinusCircle,
  Route, ShieldAlert, Sparkles, Users,
} from 'lucide-react';
import type {
  DecisionSummary, EstimateAsset, EvacCorridor, EvacuationBlock, ImpactEstimate,
  PriorityBand,
} from '../../types/impact';
import { formatCount, formatInr, formatInt, formatLeadTime } from './format';
import { CaveatStrip, EmptyState, Section } from './primitives';

// ── Priority band tone (single source for all priority chips) ───────────────

const PRIORITY_TONE: Record<PriorityBand | string, string> = {
  CRITICAL: 'bg-cmd-red/20 border-cmd-red/50 text-cmd-red',
  HIGH: 'bg-cmd-amber/20 border-cmd-amber/50 text-cmd-amber',
  MEDIUM: 'bg-cmd-teal/15 border-cmd-teal/40 text-cmd-teal',
  LOW: 'bg-cmd-green/15 border-cmd-green/40 text-cmd-green',
};

export function PriorityBadge({ band, score }: { band: PriorityBand | string; score?: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${PRIORITY_TONE[band] ?? PRIORITY_TONE.LOW}`}
      title="Population-at-Risk priority: deterministic score from exposure, depth, arrival, evacuation access and facilities — never a casualty estimate"
    >
      {band}
      {score != null && <span className="font-mono font-normal opacity-80">{Math.round(score)}</span>}
    </span>
  );
}

// ── Decision support narrative ──────────────────────────────────────────────

function NarrativeBlock({ title, lines, icon }: { title: string; lines: string[]; icon: React.ReactNode }) {
  if (!lines.length) return null;
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-muted">
        {icon}
        {title}
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {lines.map((l, i) => (
          <li key={i} className="text-[12.5px] leading-relaxed text-cmd-ink/90">• {l}</li>
        ))}
      </ul>
    </div>
  );
}

export function DecisionCard({ decision }: { decision: DecisionSummary }) {
  return (
    <Section
      title="AI decision support — where, when, who, why"
      icon={<Sparkles className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
      aside={<span className="rounded border border-cmd-amber/40 px-1.5 py-px text-[9.5px] font-bold uppercase text-cmd-amber">modelled</span>}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <NarrativeBlock title="WHERE is at risk" lines={decision.where} icon={<MapPin className="h-3.5 w-3.5" />} />
        <NarrativeBlock title="WHEN it arrives" lines={decision.when} icon={<Clock className="h-3.5 w-3.5" />} />
        <NarrativeBlock title="WHO to prioritize first" lines={decision.who} icon={<Users className="h-3.5 w-3.5" />} />
        <NarrativeBlock title="WHY these priorities" lines={decision.why} icon={<ShieldAlert className="h-3.5 w-3.5" />} />
      </div>
      <p className="mt-4 border-t border-cmd-border/60 pt-2.5 text-[10.5px] leading-snug text-cmd-muted">{decision.note}</p>
    </Section>
  );
}

// ── Population-at-Risk priority table ───────────────────────────────────────

function PriorityRow({ row, rank }: { row: ImpactEstimate['settlements'][number]; rank: number }) {
  const [open, setOpen] = useState(false);
  const p = row.priority;
  return (
    <div className="rounded-lg border border-cmd-border/70">
      <button onClick={() => setOpen(!open)} className="w-full px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]">
        <div className="flex items-center gap-2.5">
          <span className="w-4 shrink-0 text-[11px] font-bold tabular-nums text-cmd-muted">{rank}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-cmd-ink">{row.name}</span>
          {p && <PriorityBadge band={p.band} score={p.score} />}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-6 text-[11px] tabular-nums text-cmd-muted">
          <span>{row.distance_to_water_m === 0 || row.status === 'INUNDATED' ? '0 km (in footprint)' : `${((row.distance_to_water_m ?? 0) / 1000).toFixed(1)} km from water`}</span>
          <span>{row.arrival_min == null ? 'arrival not resolved' : `arrival T+${Math.round(row.arrival_min)} min`}</span>
          <span>{row.severity_band.toLowerCase()} severity · {row.depth_m.toFixed(2)} m</span>
          <span>{formatCount(row.population_exposed.mid)} exposed</span>
        </div>
      </button>
      {open && p && (
        <div className="border-t border-cmd-border/60 bg-cmd-panel2/40 px-3 py-2.5">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-muted">Why {p.band}</p>
          <ul className="mt-1.5 space-y-1">
            {p.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-cmd-ink/85">
                <MinusCircle className="mt-0.5 h-3 w-3 shrink-0 text-cmd-teal" strokeWidth={2} />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PriorityView({ estimate: e }: { estimate: ImpactEstimate }) {
  const t = e.totals;
  const ranked = [...e.settlements]
    .filter((s) => s.status !== 'SAFE' || (s.priority?.score ?? 0) > 0)
    .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0));
  const counts = t.priority_counts;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((band) => (
          <div key={band} className="rounded-xl border border-cmd-border bg-cmd-panel2/50 p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cmd-muted">{band} priority</p>
              <PriorityBadge band={band} />
            </div>
            <p className="mt-1.5 text-xl font-bold tabular-nums text-cmd-ink">{counts?.[band] ?? 0}</p>
            <p className="text-[10.5px] text-cmd-muted">settlements</p>
          </div>
        ))}
      </div>

      <Section
        title="Population at risk — act in this order"
        icon={<Users className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
        aside={<span className="text-[11px] text-cmd-muted">Click a row for the reasoning</span>}
      >
        {ranked.length === 0 ? (
          <EmptyState
            title="No settlement needs priority action"
            body="No mapped settlement fell inside or beside the modelled water for this scenario."
          />
        ) : (
          <div className="space-y-2">
            {ranked.map((s, i) => (
              <PriorityRow key={s.id} row={s} rank={i + 1} />
            ))}
          </div>
        )}
        <CaveatStrip>
          Priority bands are deterministic screening scores (exposure 40 · depth 20 · arrival 20 · evacuation access 10 ·
          facilities 10). They rank where to act first — they do not estimate casualties.
        </CaveatStrip>
      </Section>
    </div>
  );
}

// ── Critical asset exposure ─────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
  hospital: '🏥', school: '🏫', police_station: '👮', fire_station: '🚒',
  substation: '⚡', plant: '⚡', power: '⚡', bridge: '🌉', telecom_tower: '📡',
};

function AssetRow({ a }: { a: EstimateAsset }) {
  const tone =
    a.flood_risk === 'EXTREME' ? 'bg-cmd-red/20 border-cmd-red/50 text-cmd-red'
    : a.flood_risk === 'HIGH' ? 'bg-cmd-amber/20 border-cmd-amber/50 text-cmd-amber'
    : a.flood_risk === 'MODERATE' ? 'bg-cmd-amber/15 border-cmd-amber/40 text-cmd-amber'
    : 'bg-cmd-green/15 border-cmd-green/40 text-cmd-green';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-cmd-border/70 px-3 py-2.5">
      <span className="w-6 text-center text-base" aria-hidden>{KIND_ICON[a.kind] ?? '📍'}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-semibold text-cmd-ink">
          {a.name}
          {a.source !== 'osm' && <span className="ml-1.5 text-[10px] font-bold uppercase text-cmd-amber">modeled point</span>}
        </p>
        <p className="text-[10.5px] tabular-nums text-cmd-muted">
          {a.kind.replace(/_/g, ' ')}
          {a.distance_km != null && ` · ${a.distance_km.toFixed(1)} km from dam`}
          {` · ${a.arrival_min == null ? 'not reached' : `T+${Math.round(a.arrival_min)} min`} · ${a.depth_m.toFixed(2)} m`}
        </p>
      </div>
      <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase ${tone}`}>
        {a.status === 'DRY' ? 'dry' : a.flood_risk}
      </span>
    </div>
  );
}

export function AssetsView({ assets }: { assets: EstimateAsset[] }) {
  const exposed = assets.filter((a) => a.status === 'EXPOSED');
  const dry = assets.filter((a) => a.status === 'DRY');

  return (
    <Section
      title="Asset exposure — critical facilities in the modelled flood"
      icon={<ShieldAlert className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
      aside={<span className="text-[11px] text-cmd-muted">{exposed.length} exposed of {assets.length} mapped</span>}
    >
      {assets.length === 0 ? (
        <EmptyState
          title="No critical facilities mapped nearby"
          body="OpenStreetMap lists no hospitals, schools, police stations, power infrastructure or bridges inside the assessed domain for this dam."
        />
      ) : (
        <div className="space-y-2">
          {exposed.map((a) => <AssetRow key={a.id} a={a} />)}
          {dry.length > 0 && (
            <>
              <p className="pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-muted">
                Not reached by the modelled water ({dry.length})
              </p>
              {dry.map((a) => <AssetRow key={a.id} a={a} />)}
            </>
          )}
        </div>
      )}
    </Section>
  );
}

// ── Evacuation analysis ─────────────────────────────────────────────────────

function CorridorRow({ c }: { c: EvacCorridor }) {
  const tone =
    c.status === 'RECOMMENDED CANDIDATE' ? 'border-cmd-green/40 bg-cmd-green/[0.06]'
    : c.status === 'MARGINAL' ? 'border-cmd-amber/40 bg-cmd-amber/[0.06]'
    : 'border-cmd-red/40 bg-cmd-red/[0.06]';
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12.5px] font-semibold text-cmd-ink">{c.settlement_name}</span>
        <span className="text-cmd-muted">→</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-cmd-teal">
          {c.candidate_route ?? 'no usable mapped road'}
        </span>
        <PriorityBadge band={c.priority_band} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-[11px] tabular-nums text-cmd-muted">
        {c.usable_road_distance_km != null && <span>{c.usable_road_distance_km.toFixed(1)} km to road</span>}
        {c.travel_time_min != null && <span>~{Math.round(c.travel_time_min)} min travel (screening speed)</span>}
        {c.safe_direction && <span className="inline-flex items-center gap-1"><Compass className="h-3 w-3" />{c.safe_direction}</span>}
        <span className="font-bold">{c.status}</span>
      </div>
    </div>
  );
}

export function EvacuationView({ evacuation: ev }: { evacuation: EvacuationBlock }) {
  if (ev.data_source === 'unavailable' || ev.data_source === 'not_computed') {
    return (
      <Section title="Evacuation routes" icon={<Route className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
        <div className="flex items-start gap-2.5 rounded-xl border border-cmd-amber/35 bg-cmd-amber/[0.07] px-3.5 py-3">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-cmd-amber" strokeWidth={1.9} />
          <div>
            <p className="text-[12.5px] font-semibold text-cmd-ink">Road data unavailable</p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-cmd-muted">{ev.note}</p>
          </div>
        </div>
      </Section>
    );
  }

  const corridors = ev.corridors;
  const bottlenecks = ev.bottlenecks;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { l: 'Candidate corridors', v: formatInt(corridors.filter((c) => c.status === 'RECOMMENDED CANDIDATE').length), i: <Route className="h-3.5 w-3.5" /> },
          { l: 'Unsafe road segments', v: formatInt(ev.unsafe_roads.length), i: <AlertTriangle className="h-3.5 w-3.5" /> },
          { l: 'Bridges at risk', v: formatInt(bottlenecks.length), i: <ShieldAlert className="h-3.5 w-3.5" /> },
          { l: 'Roads assessed', v: formatInt(ev.roads_total), i: <MapPin className="h-3.5 w-3.5" /> },
        ].map(({ l, v, i }) => (
          <div key={l} className="rounded-xl border border-cmd-border bg-cmd-panel2/50 p-3.5">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cmd-muted">{i}{l}</p>
            <p className="mt-1.5 text-xl font-bold tabular-nums text-cmd-ink">{v}</p>
          </div>
        ))}
      </div>

      <Section
        title="Candidate evacuation corridors"
        icon={<Route className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
        aside={<span className="text-[11px] text-cmd-muted">Candidates for ground verification — not certified routes</span>}
      >
        {corridors.length === 0 ? (
          <EmptyState
            title="No corridor analysis rows"
            body="No settlement needed evacuation in this scenario, so no candidate corridors were computed."
          />
        ) : (
          <div className="space-y-2">
            {corridors.map((c, i) => <CorridorRow key={i} c={c} />)}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="Flooded / unsafe major roads" icon={<AlertTriangle className="h-[18px] w-[18px] text-cmd-amber" strokeWidth={1.75} />}>
          {ev.unsafe_roads.length === 0 ? (
            <p className="text-[12px] text-cmd-muted">No mapped major road intersects the modelled flood footprint.</p>
          ) : (
            <div className="space-y-1.5">
              {ev.unsafe_roads.map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-lg border border-cmd-border/70 px-2.5 py-2">
                  {r.is_bridge && <span aria-hidden>🌉</span>}
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-cmd-ink">{r.name}</span>
                  <span className="text-[10.5px] tabular-nums text-cmd-muted">{r.max_depth_m.toFixed(2)} m</span>
                  <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase ${r.status === 'FLOODED' ? 'bg-cmd-red/20 text-cmd-red' : 'bg-cmd-amber/20 text-cmd-amber'}`}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Safe direction from the dam" icon={<Compass className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
          {ev.safe_zone.sectors.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-cmd-muted">{ev.safe_zone.note}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {ev.safe_zone.sectors.map((s) => (
                  <span key={s.sector} className="rounded-md border border-cmd-green/40 bg-cmd-green/10 px-2 py-1 text-[11px] font-bold text-cmd-green">
                    ↑ {s.sector}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-cmd-muted">{ev.safe_zone.note}</p>
            </>
          )}
          <CaveatStrip>
            Road classification uses modelled depth along OpenStreetMap geometries (≥{ev.thresholds.flooded_road_depth_m} m
            = flooded, ≥{ev.thresholds.restricted_road_depth_m} m = restricted). Travel times assume{' '}
            {ev.thresholds.travel_speed_kmh} km/h — a planning figure, not a traffic model.
          </CaveatStrip>
        </Section>
      </div>
    </div>
  );
}

// ── Scenario uncertainty spread ─────────────────────────────────────────────

export function ScenarioSpread({ comparison }: {
  comparison: NonNullable<import('../../types/impact').ImpactEstimateResponse['scenario_comparison']>;
}) {
  const cases = ['best', 'likely', 'worst'] as const;
  const label: Record<string, string> = { best: 'Best case', likely: 'Likely case', worst: 'Worst case' };

  return (
    <Section
      title="Scenario spread — same dam, three breach presets"
      icon={<Footprints className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
      aside={<span className="text-[11px] text-cmd-muted">Each column is a full independent screening run</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem]">
          <thead>
            <tr className="border-b border-cmd-border">
              <th className="px-2.5 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">Metric</th>
              {cases.map((c) => (
                <th key={c} className={`px-2.5 py-2 text-right text-[10px] font-semibold uppercase tracking-wider ${comparison.selected === c ? 'text-cmd-teal' : 'text-cmd-muted'}`}>
                  {label[c]}{comparison.selected === c ? ' ●' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {([
              ['Overall risk', (r: any) => r?.overall_risk ?? '—'],
              ['Flooded area', (r: any) => r?.flooded_area_km2 != null ? `${r.flooded_area_km2.toFixed(2)} km²` : '—'],
              ['Peak depth', (r: any) => r?.peak_depth_m != null ? `${r.peak_depth_m.toFixed(1)} m` : '—'],
              ['Earliest arrival', (r: any) => r?.earliest_arrival_min != null ? `T+${Math.round(r.earliest_arrival_min)} min` : '—'],
              ['Settlements inundated', (r: any) => r?.settlements_inundated ?? '—'],
              ['Population exposed', (r: any) => r?.population_exposed_mid != null ? formatCount(r.population_exposed_mid) : '—'],
              ['Damage (mid)', (r: any) => r?.damage_mid_inr != null ? formatInr(r.damage_mid_inr) : '—'],
              ['Critical assets exposed', (r: any) => r?.critical_assets_exposed ?? '—'],
            ] as Array<[string, (r: any) => string | number]>).map(([label2, get]) => (
              <tr key={label2} className="border-b border-cmd-border/60 last:border-0">
                <td className="px-2.5 py-2 text-[11.5px] text-cmd-muted">{label2}</td>
                {cases.map((c) => {
                  const row = comparison.cases[c];
                  const err = row && 'error' in row && !('overall_risk' in (row as any)) ? (row as any).error : null;
                  return (
                    <td key={c} className={`px-2.5 py-2 text-right text-[12px] font-semibold tabular-nums ${comparison.selected === c ? 'text-cmd-ink' : 'text-cmd-ink/70'}`}>
                      {err ? <span className="text-[10px] font-normal text-cmd-red" title={err}>run failed</span> : String(get(row) ?? '—')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CaveatStrip>
        {comparison.note} Dam-break prediction is inherently uncertain: use the spread to understand sensitivity, never a
        single column as the answer.
      </CaveatStrip>
    </Section>
  );
}

/** Compact strip used on the Overview tab. */
export function ScenarioPeek({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center justify-between rounded-xl border border-cmd-border bg-cmd-panel2/50 px-4 py-3 text-left transition-colors hover:border-cmd-teal/40"
    >
      <span>
        <span className="block text-[12.5px] font-semibold text-cmd-ink">Compare Best / Likely / Worst cases</span>
        <span className="mt-0.5 block text-[11px] text-cmd-muted">See how sensitive this dam is to the breach assumptions.</span>
      </span>
      <ChevronDown className="h-4 w-4 -rotate-90 text-cmd-muted" />
    </button>
  );
}
