/**
 * AquaShield 3D — SystemHealth.
 * Infrastructure status ledger: status dot, service name,
 * thin status bar, uptime percentage. Muted semantic colors.
 */

import { HeartPulse, ArrowRight } from 'lucide-react';

export interface HealthService {
  name: string;
  status: 'healthy' | 'idle' | 'degraded';
  uptime: string;
}

const STATUS_DOT: Record<HealthService['status'], string> = {
  healthy: 'bg-cmd-green',
  idle: 'bg-cmd-green',
  degraded: 'bg-cmd-amber',
};

function barFill(uptime: string, status: HealthService['status']): { width: string; className: string } {
  const pct = parseFloat(uptime.replace('%', '')) || 0;
  return {
    width: `${Math.min(100, Math.max(0, pct))}%`,
    className: status === 'degraded' ? 'bg-cmd-amber' : 'bg-cmd-green/80',
  };
}

export default function SystemHealth({ services }: { services: HealthService[] }) {
  return (
    <section className="cmd-card flex flex-col p-5" aria-label="System health">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
          <HeartPulse className="h-[18px] w-[18px] text-cmd-ink" strokeWidth={1.75} />
          System Health
        </h2>
        <span className="flex items-center gap-1.5 text-xs font-medium text-cmd-teal">
          View Details
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
      </div>

      <ul className="flex flex-1 flex-col justify-center gap-4">
        {services.map(({ name, status, uptime }) => {
          const bar = barFill(uptime, status);
          return (
            <li key={name} className="flex items-center gap-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
              <span className="w-44 shrink-0 truncate text-[13px] text-cmd-muted">{name}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-cmd-track">
                <span className={`block h-full rounded-full ${bar.className}`} style={{ width: bar.width }} />
              </span>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-cmd-muted">{uptime}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

