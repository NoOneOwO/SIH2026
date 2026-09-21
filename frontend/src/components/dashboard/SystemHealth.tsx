/**
 * AquaShield 3D — Data sources & readiness.
 *
 * Replaces the previous infrastructure "uptime" ledger, whose percentages were
 * hardcoded and therefore meaningless. Each row here reports something the
 * browser actually checked or something the app actually ran, with the result
 * verbatim — including "not checked yet".
 */

import { Database, ArrowRight } from 'lucide-react';

export type SourceStatus = 'online' | 'unavailable' | 'unknown';

export interface DataSourceRow {
  name: string;
  status: SourceStatus;
  /** Short factual detail — a real count, message or provenance label. */
  detail: string;
}

const STATUS_DOT: Record<SourceStatus, string> = {
  online: 'bg-cmd-green',
  unavailable: 'bg-cmd-red',
  unknown: 'bg-cmd-muted',
};

const STATUS_TEXT: Record<SourceStatus, string> = {
  online: 'text-cmd-green',
  unavailable: 'text-cmd-red',
  unknown: 'text-cmd-muted',
};

const STATUS_LABEL: Record<SourceStatus, string> = {
  online: 'Available',
  unavailable: 'Unavailable',
  unknown: 'Not checked',
};

export default function SystemHealth({
  sources,
  onRefresh,
}: {
  sources: DataSourceRow[];
  onRefresh?: () => void;
}) {
  return (
    <section className="cmd-card flex flex-col p-5" aria-label="Data sources and readiness">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
          <Database className="h-[18px] w-[18px] text-cmd-ink" strokeWidth={1.75} />
          Data sources &amp; readiness
        </h2>
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 text-xs font-medium text-cmd-teal hover:text-cmd-ink"
          >
            Re-check
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        )}
      </div>

      <ul className="flex flex-1 flex-col justify-center gap-3.5">
        {sources.map(({ name, status, detail }) => (
          <li key={name} className="flex items-start gap-3">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-cmd-ink">{name}</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-cmd-muted">{detail}</p>
            </div>
            <span className={`shrink-0 text-[11px] font-semibold ${STATUS_TEXT[status]}`}>
              {STATUS_LABEL[status]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
