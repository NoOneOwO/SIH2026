/**
 * AquaShield 3D — impact workspace views.
 *
 * Information hierarchy (primary → secondary → detailed):
 *   Overview  what is happening, how bad, how sure are we
 *   Impact    who and what is exposed, what it could cost
 *   Response  who to act on first, what early action could avoid
 *   Data      sources, confidence, assumptions, method, limits
 *
 * Nothing is displayed twice and no view shows everything at once.
 */

import {
  Activity, AlertTriangle, Building2, Clock, Coins, Droplets, Gauge, Info, Layers,
  ListOrdered, MapPin, Percent, ShieldCheck, Sprout, Users, Wrench,
} from 'lucide-react';
import type { ImpactEstimate, EstimateSettlement } from '../../types/impact';
import {
  RISK_HEX, STATUS_LABEL, formatCount, formatInr, formatInt, formatLeadTime, formatRange, formatUtc,
} from './format';
import { CaveatStrip, ConfidenceBadge, EmptyState, EvidenceTag, Metric, RiskBadge, Section, WhyList } from './primitives';

// ── shared bits ─────────────────────────────────────────────────────────────

function SettlementRow({
  s,
  rank,
  onSelect,
  selected,
}: {
  s: EstimateSettlement;
  rank?: number;
  onSelect?: (id: string) => void;
  selected?: boolean;
}) {
  return (
    <button
      onClick={() => onSelect?.(s.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected ? 'border-cmd-teal/50 bg-cmd-tealdim' : 'border-cmd-border/70 hover:border-cmd-teal/30 hover:bg-white/[0.03]'
      }`}
    >
      <div className="flex items-center gap-2.5">
        {rank != null && <span className="w-4 shrink-0 text-[11px] font-bold tabular-nums text-cmd-muted">{rank}</span>}
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: RISK_HEX[s.risk] }} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-cmd-ink">{s.name}</span>
        <RiskBadge risk={s.risk} size="sm" />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-6 text-[11px] text-cmd-muted">
        <span className="tabular-nums">{formatRange(s.population_exposed, formatCount)} people exposed</span>
        <span className="tabular-nums">{s.depth_m.toFixed(2)} m deep</span>
        <span className="tabular-nums">
          {s.arrival_min == null ? 'arrival not resolved' : `arrival T+${Math.round(s.arrival_min)} min`}
        </span>
        <span className="tabular-nums">{formatInr(s.damage.total.mid_inr)} est. damage</span>
      </div>
    </button>
  );
}

function BreakdownBar({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11.5px]">
        <span className="text-cmd-muted">{label}</span>
        <span className="font-semibold tabular-nums text-cmd-ink">
          {formatInr(value)} <span className="font-normal text-cmd-muted">({pct.toFixed(0)}%)</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cmd-track">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(1.5, pct)}%` }} />
      </div>
    </div>
  );
}

// ── OVERVIEW ────────────────────────────────────────────────────────────────

export function OverviewView({
  estimate: e,
  onSelect,
  selectedId,
}: {
  estimate: ImpactEstimate;
  onSelect: (id: string) => void;
  selectedId?: string | null;
}) {
  const t = e.totals;
  const top = e.settlements.slice(0, 5);
  const wave = [
    `Estimated ${formatCount(t.population_exposed.low)}–${formatCount(t.population_exposed.high)} people potentially exposed`,
    `Potential economic damage ${formatInr(t.damage.low_inr)}–${formatInr(t.damage.high_inr)}`,
    `Potential avoided damage ${formatInr(t.avoided.low_inr)}–${formatInr(t.avoided.high_inr)}`,
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Overall risk (this scenario)"
          value={t.overall_risk}
          tone={t.overall_risk === 'EXTREME' ? 'text-cmd-red' : t.overall_risk === 'HIGH' ? 'text-cmd-amber' : 'text-cmd-green'}
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          sub={`${t.settlements_high_or_extreme} of ${t.settlements_assessed} assessed settlements at HIGH or above`}
          note={`Engine: ${e.engine.name} • ${Math.round(e.totals.flooded_area_km2 * 100) / 100} km² modelled inundation`}
        />
        <Metric
          label="Places affected"
          value={`${t.settlements_inundated} inundated`}
          icon={<MapPin className="h-3.5 w-3.5" />}
          sub={`${t.settlements_at_risk} at risk • ${t.settlements_assessed} assessed`}
          note={`${t.critical_assets_exposed} mapped critical facilit${t.critical_assets_exposed === 1 ? 'y' : 'ies'} in the water footprint`}
        />
        <Metric
          label="Population exposed"
          value={formatRange(t.population_exposed, formatCount)}
          tone="text-cmd-amber"
          icon={<Users className="h-3.5 w-3.5" />}
          basis={t.population_exposed}
          note={`${formatRange(t.population_displaced, formatCount)} of them potentially displaced`}
        />
        <Metric
          label="Economic impact"
          value={`${formatInr(t.damage.low_inr)}–${formatInr(t.damage.high_inr)}`}
          tone="text-cmd-red"
          icon={<Coins className="h-3.5 w-3.5" />}
          basis={t.damage}
          note={`Estimated potential savings ${formatInr(t.avoided.low_inr)}–${formatInr(t.avoided.high_inr)} with early action`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Section
          title="Highest-risk locations"
          icon={<ListOrdered className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
          className="xl:col-span-2"
          aside={<span className="text-[11px] text-cmd-muted">Ranked by exposed population</span>}
        >
          {top.length === 0 ? (
            <EmptyState
              title="No settlement inside the modelled footprint"
              body="No mapped settlement sits in or beside the modelled water for this scenario. Widen the case or check that OpenStreetMap has settlements mapped near this dam."
            />
          ) : (
            <div className="space-y-2">
              {top.map((s, i) => (
                <SettlementRow key={s.id} s={s} rank={i + 1} onSelect={onSelect} selected={selectedId === s.id} />
              ))}
              {e.settlements.length > 5 && (
                <p className="pt-1 text-[11px] text-cmd-muted">
                  Showing the top 5 of {e.settlements.length} assessed settlements — the Impact tab lists them all.
                </p>
              )}
            </div>
          )}
        </Section>

        <div className="space-y-4">
          <Section title="Situation summary" icon={<Activity className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
            <ul className="space-y-1.5">
              {wave.map((line) => (
                <li key={line} className="text-[12.5px] leading-relaxed text-cmd-ink/90">
                  • {line}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ConfidenceBadge level={e.confidence.level} score={e.confidence.score} />
              <EvidenceTag basis="modelled" />
            </div>
            <div className="mt-3">
              <WhyList drivers={e.drivers.slice(0, 4)} />
            </div>
          </Section>

          <CaveatStrip>
            {e.engine.note}. Damage and savings use planning-level unit rates. Estimated potential savings is what early
            action could avoid — it is not money already saved, and early action never removes all damage.
          </CaveatStrip>
        </div>
      </div>
    </div>
  );
}

// ── IMPACT ──────────────────────────────────────────────────────────────────

export function ImpactView({
  estimate: e,
  onSelect,
  selectedId,
}: {
  estimate: ImpactEstimate;
  onSelect: (id: string) => void;
  selectedId?: string | null;
}) {
  const t = e.totals;
  const b = t.damage_breakdown;
  const damageTotal = b.residential_inr + b.commercial_inr + b.infrastructure_inr + b.agriculture_inr;

  const facilityCounts = new Map<string, number>();
  e.settlements.forEach((s) => s.facilities_exposed.forEach((k) => facilityCounts.set(k, (facilityCounts.get(k) ?? 0) + 1)));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Population potentially exposed"
          value={formatRange(t.population_exposed, formatCount)}
          basis={t.population_exposed}
          icon={<Users className="h-3.5 w-3.5" />}
          note="Sum of the per-settlement ranges (each already carries its own uncertainty)"
        />
        <Metric
          label="Potentially displaced"
          value={formatRange(t.population_displaced, formatCount)}
          basis={t.population_displaced}
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          note="Residents expected to need temporary relocation rather than shelter in place"
        />
        <Metric
          label="Mapped facilities exposed"
          value={formatInt(t.critical_assets_exposed)}
          icon={<Wrench className="h-3.5 w-3.5" />}
          sub={facilityCounts.size ? [...facilityCounts.entries()].map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' • ') : 'none mapped in the footprint'}
        />
        <Metric
          label="Estimated agricultural area"
          value={`${t.agriculture.area_km2.toFixed(2)} km²`}
          icon={<Sprout className="h-3.5 w-3.5" />}
          basis={t.agriculture}
          note={`Assumed cropland/pasture share of the inundation footprint • ${formatInr(t.agriculture.mid_inr)} crop value at risk`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Section
          title="Economic damage by category"
          icon={<Coins className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
          className="xl:col-span-1"
          aside={<EvidenceTag basis={t.damage.basis} />}
        >
          <div className="space-y-3">
            <BreakdownBar label="Residential property & movable assets" value={b.residential_inr} total={damageTotal} tone="bg-cmd-red/70" />
            <BreakdownBar label="Commercial & industrial" value={b.commercial_inr} total={damageTotal} tone="bg-cmd-amber/70" />
            <BreakdownBar label="Infrastructure & facilities" value={b.infrastructure_inr} total={damageTotal} tone="bg-cmd-slateblue/70" />
            <BreakdownBar label="Agriculture" value={b.agriculture_inr} total={damageTotal} tone="bg-cmd-green/70" />
          </div>
          <div className="mt-4 rounded-lg border border-cmd-border/70 bg-cmd-panel2/50 p-2.5">
            <p className="text-[11px] text-cmd-muted">
              Expected damage = exposed value × depth-damage factor. Total estimate{' '}
              <span className="font-semibold text-cmd-ink">
                {formatInr(t.damage.low_inr)}–{formatInr(t.damage.high_inr)}
              </span>
              .
            </p>
            <p className="mt-1 text-[10.5px] leading-snug text-cmd-muted/85">{t.damage.basis_note}</p>
          </div>
        </Section>

        <Section
          title="Every assessed settlement"
          icon={<Building2 className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
          className="xl:col-span-2"
          aside={<span className="text-[11px] text-cmd-muted">{e.settlements.length} locations</span>}
        >
          {e.settlements.length === 0 ? (
            <EmptyState title="Nothing to assess" body="No mapped settlement fell inside the modelled water footprint or beside it." />
          ) : (
            <div className="max-h-[30rem] space-y-2 overflow-y-auto pr-1">
              {e.settlements.map((s, i) => (
                <SettlementRow key={s.id} s={s} rank={i + 1} onSelect={onSelect} selected={selectedId === s.id} />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ── RESPONSE ────────────────────────────────────────────────────────────────

export function ResponseView({ estimate: e }: { estimate: ImpactEstimate }) {
  const t = e.totals;
  // Response priority: earliest usable lead time first, then exposed population.
  const priority = [...e.settlements]
    .filter((s) => s.status !== 'SAFE')
    .sort((a, b) => {
      const la = a.lead_time_min ?? Number.POSITIVE_INFINITY;
      const lb = b.lead_time_min ?? Number.POSITIVE_INFINITY;
      if (la !== lb) return la - lb;
      return b.population_exposed.mid - a.population_exposed.mid;
    });
  const protectable = e.settlements.reduce((n, s) => n + s.facilities_exposed.length, 0);
  const avgEffectiveness = priority.length
    ? priority.reduce((n, s) => n + s.savings.effectiveness, 0) / priority.length
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Potential avoided damage"
          value={`${formatInr(t.avoided.low_inr)}–${formatInr(t.avoided.high_inr)}`}
          tone="text-cmd-green"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          basis={t.avoided}
          note={t.avoided.basis_note}
        />
        <Metric
          label="People potentially protected"
          value={formatRange(t.people_protected, formatCount)}
          tone="text-cmd-green"
          icon={<Users className="h-3.5 w-3.5" />}
          basis={t.people_protected}
          note="Exposed population × early-action effectiveness for the lead time available"
        />
        <Metric
          label="Residual damage after action"
          value={`${formatInr(t.residual_damage.low_inr)}–${formatInr(t.residual_damage.high_inr)}`}
          icon={<Droplets className="h-3.5 w-3.5" />}
          basis={t.damage}
          note="Damage still expected if the modelled early action is carried out"
        />
        <Metric
          label="Critical assets to protect"
          value={formatInt(protectable)}
          icon={<Wrench className="h-3.5 w-3.5" />}
          note="Mapped facilities inside the footprint — pumps, sandbags, isolation and relocation targets"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Section
          title="Priority areas — act on these first"
          icon={<Clock className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}
          className="xl:col-span-2"
          aside={<span className="text-[11px] text-cmd-muted">Sorted by usable lead time, then exposure</span>}
        >
          {priority.length === 0 ? (
            <EmptyState
              title="No settlement needs evacuation in this scenario"
              body="Water does not reach a mapped settlement in the modelled run. Keep monitoring and re-assess if the case worsens."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[38rem]">
                <thead>
                  <tr className="border-b border-cmd-border">
                    {['#', 'Settlement', 'Usable lead time', 'Status', 'People to move', 'Avoidable damage'].map((h, i) => (
                      <th
                        key={h}
                        className={`px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-cmd-muted ${
                          i >= 2 ? 'text-right' : 'text-left'
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {priority.map((s, i) => (
                    <tr key={s.id} className="border-b border-cmd-border/60 last:border-0">
                      <td className="px-2.5 py-2.5 text-[11px] font-bold tabular-nums text-cmd-muted">{i + 1}</td>
                      <td className="px-2.5 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ background: RISK_HEX[s.risk] }} />
                          <span className="text-[12.5px] font-semibold text-cmd-ink">{s.name}</span>
                        </div>
                        <span className="text-[10.5px] text-cmd-muted">{STATUS_LABEL[s.status]}</span>
                      </td>
                      <td className="px-2.5 py-2.5 text-right text-[12px] tabular-nums">
                        <span className={s.lead_time_min != null && s.lead_time_min <= 30 ? 'font-bold text-cmd-red' : 'text-cmd-ink/90'}>
                          {formatLeadTime(s.lead_time_min)}
                        </span>
                        <span className="block text-[10px] text-cmd-muted">
                          {s.arrival_min == null ? 'arrival not resolved' : `water at T+${Math.round(s.arrival_min)} min`}
                        </span>
                      </td>
                      <td className="px-2.5 py-2.5 text-right">
                        <RiskBadge risk={s.risk} size="sm" />
                      </td>
                      <td className="px-2.5 py-2.5 text-right text-[12px] tabular-nums text-cmd-ink/90">
                        {formatRange(s.population_displaced, formatCount)}
                      </td>
                      <td className="px-2.5 py-2.5 text-right text-[12px] font-semibold tabular-nums text-cmd-green">
                        {formatInr(s.savings.avoided.low_inr)}–{formatInr(s.savings.avoided.high_inr)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <div className="space-y-4">
          <Section title="Early-action effectiveness" icon={<Percent className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
            <div className="space-y-2.5">
              <div className="flex items-end justify-between">
                <span className="text-[12px] text-cmd-muted">Average effectiveness across priority areas</span>
                <span className="text-xl font-bold tabular-nums text-cmd-green">{(avgEffectiveness * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-cmd-track">
                <div className="h-full rounded-full bg-cmd-green/80" style={{ width: `${Math.max(2, avgEffectiveness * 100)}%` }} />
              </div>
              <p className="text-[11px] leading-relaxed text-cmd-muted">
                Effectiveness rises with usable warning lead time and applies to movable value; fixed infrastructure is
                credited only a fraction of the same curve. See the Data tab for the full assumption list.
              </p>
            </div>
          </Section>
          <CaveatStrip>
            Response figures are planning estimates. They assume alerts are issued and acted on within the documented
            mobilisation time, and that routes and shelters remain usable.
          </CaveatStrip>
        </div>
      </div>
    </div>
  );
}

// ── DATA & CONFIDENCE ───────────────────────────────────────────────────────

export function DataView({ estimate: e, extra }: { estimate: ImpactEstimate; extra?: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Section title="Confidence in this estimate" icon={<Gauge className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
          <div className="flex items-center gap-3">
            <span className="text-3xl font-bold tabular-nums text-cmd-ink">{Math.round(e.confidence.score)}</span>
            <div>
              <ConfidenceBadge level={e.confidence.level} />
              <p className="mt-1 text-[10.5px] leading-snug text-cmd-muted">{e.confidence.basis_note}</p>
            </div>
          </div>
          <ul className="mt-3 space-y-1.5">
            {e.confidence.factors.map((f) => (
              <li key={f.factor} className="flex items-start justify-between gap-3 text-[11.5px] leading-snug">
                <span className="text-cmd-muted">{f.factor}</span>
                <span className={`shrink-0 font-mono tabular-nums ${f.penalty > 0 ? 'text-cmd-amber' : 'text-cmd-green'}`}>
                  {f.penalty > 0 ? `−${f.penalty.toFixed(0)}` : `+${Math.abs(f.penalty).toFixed(0)}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Data sources & provenance" icon={<Layers className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />} className="xl:col-span-2">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {extra}
            <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
              <dt className="text-[11.5px] text-cmd-muted">Simulation engine</dt>
              <dd className="text-right text-[11.5px] text-cmd-ink/90">
                {e.engine.name} • {e.engine.cell_m.toFixed(0)} m cells
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
              <dt className="text-[11.5px] text-cmd-muted">Last updated (UTC)</dt>
              <dd className="text-right text-[11.5px] text-cmd-ink/90 tabular-nums">{formatUtc(e.generated_at_utc)}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
              <dt className="text-[11.5px] text-cmd-muted">Assessed area</dt>
              <dd className="text-right text-[11.5px] text-cmd-ink/90 tabular-nums">
                {e.totals.flooded_area_km2.toFixed(2)} km² modelled inundation
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-cmd-border/60 py-1.5">
              <dt className="text-[11.5px] text-cmd-muted">Settlements assessed</dt>
              <dd className="text-right text-[11.5px] text-cmd-ink/90 tabular-nums">
                {e.totals.settlements_assessed}, of which {e.totals.settlements_inundated} inundated
              </dd>
            </div>
          </dl>

          <div className="mt-4 rounded-lg border border-cmd-border/70 bg-cmd-panel2/50 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">How to read every number</p>
            <ul className="mt-1.5 space-y-1">
              {Object.entries(e.evidence_legend).map(([key, text]) => (
                <li key={key} className="flex items-start gap-2 text-[11px] leading-snug text-cmd-muted">
                  <EvidenceTag basis={key as 'observed'} />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section
          title="Model assumptions"
          icon={<Info className="h-[18px] w-[18px] text-cmd-amber" strokeWidth={1.75} />}
          aside={<span className="text-[11px] text-cmd-muted">{e.assumptions.length} parameters</span>}
        >
          <div className="max-h-[26rem] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-cmd-panel">
                <tr className="border-b border-cmd-border">
                  {['Stage', 'Parameter', 'Value', 'Class'].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {e.assumptions.map((a) => (
                  <tr key={`${a.stage}-${a.parameter}`} className="border-b border-cmd-border/60 last:border-0">
                    <td className="px-2 py-2 text-[11px] text-cmd-muted">{a.stage}</td>
                    <td className="px-2 py-2 text-[11.5px] font-medium text-cmd-ink">
                      {a.parameter}
                      <span className="mt-0.5 block text-[10.5px] font-normal text-cmd-muted">{a.note}</span>
                    </td>
                    <td className="px-2 py-2 text-[11px] tabular-nums text-cmd-ink/90">{a.value}</td>
                    <td className="px-2 py-2">
                      <EvidenceTag basis={a.basis} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <div className="space-y-4">
          <Section title="Calculation chain" icon={<Activity className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />}>
            <ol className="space-y-2">
              {e.method.map((m, i) => (
                <li key={m.stage + i} className="flex gap-2.5">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cmd-teal/15 text-[9.5px] font-bold text-cmd-teal">
                    {i + 1}
                  </span>
                  <span className="text-[11.5px] leading-snug">
                    <span className="font-semibold uppercase tracking-wide text-cmd-ink">{m.stage.replace(/_/g, ' ')}</span>
                    <span className="block text-cmd-muted">{m.formula}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Known limits" icon={<AlertTriangle className="h-[18px] w-[18px] text-cmd-amber" strokeWidth={1.75} />}>
            <ul className="space-y-1.5">
              {e.limits.map((l) => (
                <li key={l} className="text-[11.5px] leading-relaxed text-cmd-muted">
                  • {l}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
