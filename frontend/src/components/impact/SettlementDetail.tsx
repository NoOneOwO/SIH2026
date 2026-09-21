/**
 * AquaShield 3D — selected settlement detail.
 *
 * The drill-down the globe and the tables both open: what is the risk, who is
 * exposed, what could it cost, what could early action avoid, and why.
 * Every number shows its range, its evidence class and its reason.
 */

import { ArrowRight, Droplets, Clock, Users, Wrench, ShieldCheck } from 'lucide-react';
import type { EstimateSettlement, ConfidenceLevel, EvidenceClass } from '../../types/impact';
import {
  CONFIDENCE_TONE, STATUS_LABEL, formatCount, formatInr, formatInt, formatLeadTime, formatRange,
} from './format';
import { EvidenceTag, RiskBadge } from './primitives';

function Row({
  label,
  value,
  sub,
  basis,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  basis?: EvidenceClass;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-cmd-border/60 py-2 last:border-0">
      <span className="flex items-center gap-1.5 text-[11.5px] text-cmd-muted">
        {icon}
        {label}
      </span>
      <span className="text-right">
        <span className="block text-[13px] font-semibold tabular-nums text-cmd-ink">{value}</span>
        {basis && (
          <span className="mt-0.5 inline-block">
            <EvidenceTag basis={basis} />
          </span>
        )}
        {sub && <span className="mt-0.5 block text-[10.5px] leading-snug text-cmd-muted">{sub}</span>}
      </span>
    </div>
  );
}

/** Damage → avoided → residual, as three proportional bars. */
function SavingsFlow({ s }: { s: EstimateSettlement }) {
  const damage = s.damage.total.mid_inr;
  const avoided = s.savings.avoided.mid_inr;
  const residual = Math.max(0, damage - avoided);
  const max = Math.max(damage, 1);
  const rows = [
    { label: 'Damage without intervention', value: damage, width: (damage / max) * 100, tone: 'bg-cmd-red/70' },
    { label: 'Estimated avoided damage', value: avoided, width: (avoided / max) * 100, tone: 'bg-cmd-green/80' },
    { label: 'Residual damage with early action', value: residual, width: (residual / max) * 100, tone: 'bg-cmd-amber/70' },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-cmd-muted">{r.label}</span>
            <span className="font-semibold tabular-nums text-cmd-ink">{formatInr(r.value)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cmd-track">
            <div className={`h-full rounded-full ${r.tone}`} style={{ width: `${Math.max(2, r.width)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SettlementDetail({
  settlement: s,
  confidence,
  onClose,
}: {
  settlement: EstimateSettlement;
  confidence: { level: ConfidenceLevel; score: number };
  onClose?: () => void;
}) {
  // 3–5 contributing factors, built from the model's own driver set.
  const why = [
    `Peak modelled depth ${s.depth_m.toFixed(2)} m (${s.severity_band} band) at the settlement footprint.`,
    s.arrival_min != null
      ? `Water arrives about T+${Math.round(s.arrival_min)} min; ${formatLeadTime(s.lead_time_min)} usable lead time after a ${15} min mobilisation.`
      : 'Arrival time not resolved here (outside the routed water path or below the wetting threshold).',
    s.distance_to_water_m != null
      ? `Dry at the sampled footprint but ${s.distance_to_water_m.toLocaleString('en-IN')} m from modelled water — treated as at risk.`
      : 'Inside the modelled inundation footprint.',
    ...s.vulnerability.factors
      .slice()
      .sort((a, b) => b.value * b.weight - a.value * a.weight)
      .slice(0, 2)
      .map((f) => `${f.name} ${f.value.toFixed(2)} (weight ${f.weight.toFixed(2)}): ${f.note}.`),
  ].slice(0, 5);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-cmd-teal/35 bg-cmd-panel">
      <div className="flex items-start justify-between gap-3 border-b border-cmd-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold text-cmd-ink">{s.name}</p>
          <p className="mt-0.5 text-[11px] text-cmd-muted">
            {s.kind} • {s.lat.toFixed(4)}°N {s.lon.toFixed(4)}°E •{' '}
            {s.source === 'osm' ? 'mapped in OpenStreetMap' : `source: ${s.source}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <RiskBadge risk={s.risk} />
          <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${CONFIDENCE_TONE[confidence.level]}`}>
            Confidence: {confidence.level}
          </span>
          {onClose && (
            <button onClick={onClose} className="text-cmd-muted hover:text-cmd-ink" aria-label="Close settlement detail">
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-2 text-[11px] font-semibold text-cmd-muted">{STATUS_LABEL[s.status]}</p>

        <Row
          icon={<Users className="h-3.5 w-3.5" />}
          label="Population exposed"
          value={formatRange(s.population_exposed, formatCount)}
          basis={s.population_exposed.basis}
          sub={`${(s.population_exposed.share_of_settlement * 100).toFixed(0)}% of ${formatCount(
            s.population.value,
          )} residents • ${s.population.basis === 'observed' ? 'OSM population tag' : 'estimated from settlement class'}`}
        />
        <Row
          label="Potentially displaced"
          value={formatRange(s.population_displaced, formatCount)}
          basis={s.population_displaced.basis}
          sub={`${(s.population_displaced.share_of_exposed * 100).toFixed(0)}% of the exposed population`}
        />
        <Row
          icon={<Droplets className="h-3.5 w-3.5" />}
          label="Estimated flood depth"
          value={`${s.depth_m.toFixed(2)} m`}
          basis="modelled"
          sub={s.hazard_index != null ? `depth × √speed² = ${s.hazard_index.toFixed(2)} • ${s.speed_ms?.toFixed(2)} m/s` : s.hazard_index_basis}
        />
        <Row
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Estimated time to impact"
          value={s.arrival_min == null ? 'Not resolved' : `T+${Math.round(s.arrival_min)} min`}
          basis="modelled"
          sub={
            s.inundation_likelihood_pct != null
              ? `${s.inundation_likelihood_pct.toFixed(0)}% of ensemble scenarios inundate this cell`
              : 'Single-scenario run — no scenario frequency available'
          }
        />
        <Row
          label="Potential damage"
          value={`${formatInr(s.damage.total.low_inr)}–${formatInr(s.damage.total.high_inr)}`}
          basis={s.damage.basis}
          sub={`residential ${formatInr(s.damage.residential.low_inr)}–${formatInr(s.damage.residential.high_inr)} • commercial ${formatInr(
            s.damage.commercial.low_inr,
          )}–${formatInr(s.damage.commercial.high_inr)} • infrastructure ${formatInr(
            s.damage.infrastructure.low_inr,
          )}–${formatInr(s.damage.infrastructure.high_inr)}`}
        />
        <Row
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          label="Potential avoided damage"
          value={`${formatInr(s.savings.avoided.low_inr)}–${formatInr(s.savings.avoided.high_inr)}`}
          basis={s.savings.basis}
          sub={`early action at ${(s.savings.effectiveness * 100).toFixed(0)}% effectiveness • ${formatRange(
            s.savings.people_protected,
            formatCount,
          )} people potentially protected`}
        />
        {s.facilities_exposed.length > 0 && (
          <Row
            icon={<Wrench className="h-3.5 w-3.5" />}
            label="Mapped facilities exposed"
            value={String(s.facilities_exposed.length)}
            basis="observed"
            sub={s.facilities_exposed.join(', ').replace(/_/g, ' ')}
          />
        )}

        <div className="mt-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-cmd-muted">
            Estimated early-action effect
          </p>
          <SavingsFlow s={s} />
          <p className="mt-2 text-[10.5px] leading-snug text-cmd-muted/85">
            Estimated potential savings — not guaranteed savings. Early action reduces damage; it does not remove all of it.
          </p>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-cmd-muted">Why?</p>
          <ul className="space-y-1.5">
            {why.map((w, i) => (
              <li key={i} className="flex gap-2 text-[11.5px] leading-snug text-cmd-ink/90">
                <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-cmd-teal" strokeWidth={2} />
                {w}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 rounded-lg border border-cmd-border/70 bg-cmd-panel2/50 p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">Data behind this row</p>
          <ul className="mt-1.5 space-y-1 text-[10.5px] leading-snug text-cmd-muted">
            <li>{s.population.basis_note}</li>
            <li>{s.population_exposed.basis_note}</li>
            <li>{s.damage.basis_note}</li>
            <li>{s.savings.basis_note}</li>
          </ul>
          <p className="mt-1.5 text-[10.5px] text-cmd-muted/80">
            Population value: {formatInt(s.population.value)} ({s.population.basis})
          </p>
        </div>
      </div>
    </div>
  );
}
