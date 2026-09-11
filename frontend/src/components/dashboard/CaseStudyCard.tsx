/**
 * DamSafe Twin — CaseStudyCard.
 * Demo dam dossier: reservoir thumbnail + key parameters.
 * Data preserved from the previous dashboard; presentation rebuilt.
 */

import { Dam, ArrowRight } from 'lucide-react';

export interface CaseStudyDam {
  name: string;
  type: string;
  height: string;
  crestLength: string;
  reservoirCapacity: string;
  scenarios: string;
}

interface CaseStudyCardProps {
  dam: CaseStudyDam;
  onViewDetails: () => void;
}

export default function CaseStudyCard({ dam, onViewDetails }: CaseStudyCardProps) {
  const rows: Array<[string, string]> = [
    ['Name', dam.name],
    ['Type', dam.type],
    ['Height', dam.height],
    ['Crest Length', dam.crestLength],
    ['Reservoir Capacity', dam.reservoirCapacity],
    ['Available Scenarios', dam.scenarios],
  ];

  return (
    <section className="cmd-card flex flex-col p-5" aria-label="Case study dam">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
          <Dam className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} />
          Case Study Dam
        </h2>
        <button
          onClick={onViewDetails}
          className="flex items-center gap-1.5 text-xs font-medium text-cmd-teal hover:text-cmd-ink"
        >
          View Details
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="shrink-0 overflow-hidden rounded-lg border border-cmd-border sm:w-56">
          <img
            src="/images/dam-thumb.jpg"
            alt="Aerial view of dam reservoir valley"
            className="h-40 w-full object-cover sm:h-full sm:min-h-[190px]"
            loading="lazy"
          />
        </div>
        <dl className="grid flex-1 grid-cols-[128px_1fr] content-start gap-x-4 gap-y-3 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-cmd-muted">{label}</dt>
              <dd className="font-medium text-cmd-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
