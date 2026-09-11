/**
 * DamSafe Twin — StatCard.
 * Compact KPI card: tinted semantic icon, strong value, label,
 * understated sparkline, caption + directional arrow.
 */

import { ArrowUpRight } from 'lucide-react';

export type StatTone = 'green' | 'slateblue' | 'red' | 'amber' | 'teal' | 'orange';

const TONE_STYLES: Record<StatTone, { disc: string; icon: string; line: string }> = {
  green: { disc: 'bg-cmd-green/15', icon: 'text-cmd-green', line: '#55C99A' },
  slateblue: { disc: 'bg-cmd-slateblue/15', icon: 'text-cmd-slateblue', line: '#8FA8B8' },
  red: { disc: 'bg-cmd-red/15', icon: 'text-cmd-red', line: '#D96B70' },
  amber: { disc: 'bg-cmd-amber/15', icon: 'text-cmd-amber', line: '#D8B24C' },
  teal: { disc: 'bg-cmd-teal/15', icon: 'text-cmd-teal', line: '#65BFA9' },
  orange: { disc: 'bg-cmd-amber/15', icon: 'text-cmd-amber', line: '#D8B24C' },
};

interface StatCardProps {
  icon: typeof ArrowUpRight;
  value: number | string;
  label: string;
  caption: string;
  spark: number[];
  tone: StatTone;
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 64;
  const h = 24;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((v - min) / span) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0 opacity-80">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function StatCard({ icon: Icon, value, label, caption, spark, tone }: StatCardProps) {
  const s = TONE_STYLES[tone];
  return (
    <div className="cmd-card flex flex-col justify-between gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${s.disc}`}>
            <Icon className={`h-5 w-5 ${s.icon}`} strokeWidth={1.75} />
          </span>
          <span>
            <span className="block text-[26px] font-bold leading-none text-cmd-ink">{value}</span>
            <span className="mt-1.5 block text-[12.5px] leading-tight text-cmd-ink/90">{label}</span>
          </span>
        </div>
        <Sparkline data={spark} color={s.line} />
      </div>
      <div className="flex items-center justify-between border-t border-cmd-border/70 pt-2.5">
        <span className="text-[11.5px] text-cmd-muted">{caption}</span>
        <ArrowUpRight className="h-3.5 w-3.5 text-cmd-teal" strokeWidth={2} aria-hidden="true" />
      </div>
    </div>
  );
}
