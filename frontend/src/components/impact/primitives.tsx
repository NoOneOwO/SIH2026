/**
 * AquaShield 3D — impact UI primitives.
 *
 * Small, boring, reusable pieces. Kept in one file so every impact screen
 * shares exactly one definition of a risk chip, a metric tile and an
 * evidence tag.
 */

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { BasisBlock, ConfidenceLevel, EstimateDriver, RiskBand } from '../../types/impact';
import { CONFIDENCE_TONE, RISK_BG, RISK_TEXT } from './format';

export function Section({
  title,
  icon,
  aside,
  children,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`cmd-card p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
          {icon}
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function RiskBadge({ risk, size = 'md' }: { risk: RiskBand; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border font-bold uppercase tracking-wide ${RISK_BG[risk]} ${RISK_TEXT[risk]} ${
        size === 'sm' ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-2 py-1 text-[11px]'
      }`}
    >
      {risk}
    </span>
  );
}

export function ConfidenceBadge({ level, score }: { level: ConfidenceLevel; score?: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-bold ${CONFIDENCE_TONE[level]}`}
      title="Confidence in the estimate, derived from input data quality — not a probability that the flood happens"
    >
      Confidence: {level}
      {score != null && <span className="font-mono font-normal opacity-80">{Math.round(score)}/100</span>}
    </span>
  );
}

/**
 * Evidence tag: observed / derived / modelled / assumed.
 * Deliberately visible on every block that carries a `basis` field.
 */
export function EvidenceTag({ basis }: { basis: BasisBlock['basis'] }) {
  const tone: Record<string, string> = {
    observed: 'border-cmd-green/40 text-cmd-green',
    derived: 'border-cmd-teal/40 text-cmd-teal',
    modelled: 'border-cmd-amber/40 text-cmd-amber',
    assumed: 'border-cmd-red/40 text-cmd-red',
  };
  return (
    <span className={`rounded border px-1.5 py-px text-[9.5px] font-bold uppercase ${tone[basis]}`}>
      {basis}
    </span>
  );
}

/** Metric tile: big value, optional range, optional evidence + reason line. */
export function Metric({
  label,
  value,
  sub,
  tone = 'text-cmd-ink',
  basis,
  note,
  icon,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: string;
  basis?: BasisBlock;
  note?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-cmd-border bg-cmd-panel2/50 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cmd-muted">
          {icon}
          {label}
        </p>
        {basis && <EvidenceTag basis={basis.basis} />}
      </div>
      <p className={`mt-1.5 text-xl font-bold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-cmd-muted">{sub}</p>}
      {note && <p className="mt-1.5 text-[10.5px] leading-snug text-cmd-muted/85">{note}</p>}
    </div>
  );
}

/** "Why?" block — the drivers behind a headline number, always visible. */
export function WhyList({ drivers, title = 'Why this result' }: { drivers: EstimateDriver[]; title?: string }) {
  if (!drivers.length) return null;
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-cmd-muted">{title}</p>
      <ul className="space-y-1.5">
        {drivers.map((d) => (
          <li key={d.factor} className="flex gap-2 text-[12px] leading-snug">
            <span className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${d.direction === 'up' ? 'bg-cmd-red' : 'bg-cmd-green'}`} />
            <span className="text-cmd-ink/90">
              <span className="font-semibold text-cmd-ink">{d.factor}</span>
              <span className="text-cmd-muted"> — {d.value}. {d.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Assumption/limit disclaimer strip. */
export function CaveatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-cmd-amber/25 bg-cmd-amber/[0.06] px-3.5 py-2.5">
      <Info className="mt-px h-4 w-4 shrink-0 text-cmd-amber" strokeWidth={1.75} />
      <p className="text-[11.5px] leading-relaxed text-cmd-muted">{children}</p>
    </div>
  );
}

export function EmptyState({ title, body, icon }: { title: string; body: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-cmd-border px-6 py-10 text-center">
      {icon}
      <p className="text-sm font-semibold text-cmd-ink">{title}</p>
      <p className="max-w-md text-[12px] leading-relaxed text-cmd-muted">{body}</p>
    </div>
  );
}
