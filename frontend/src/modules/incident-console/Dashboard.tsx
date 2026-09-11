/**
 * DamSafe Twin — Dashboard (command-centre landing).
 * Presentation rebuilt from scratch; data, routes and API usage unchanged.
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Dam, CalendarDays, Activity, Users, ClipboardList, AlertTriangle,
  Map, Route, FileText, Zap, ArrowRight,
} from 'lucide-react';
import HeroPanel from '../../components/dashboard/HeroPanel';
import StatCard, { type StatTone } from '../../components/dashboard/StatCard';
import QuickAction, { type ActionTone } from '../../components/dashboard/QuickAction';
import CaseStudyCard from '../../components/dashboard/CaseStudyCard';
import SystemHealth, { type HealthService } from '../../components/dashboard/SystemHealth';

interface DashboardStats {
  damCount: number;
  scenarioCount: number;
  activeSims: number;
  villageCount: number;
  facilityCount: number;
  recentAlerts: number;
}

const STATS: DashboardStats = {
  damCount: 1,
  scenarioCount: 2,
  activeSims: 0,
  villageCount: 8,
  facilityCount: 5,
  recentAlerts: 0,
};

const KPI_DEFS: Array<{
  key: keyof DashboardStats;
  label: string;
  caption: string;
  icon: typeof Dam;
  tone: StatTone;
  spark: number[];
}> = [
  { key: 'damCount', label: 'Dams', caption: 'Monitored & Managed', icon: Dam, tone: 'green', spark: [4, 5, 5, 6, 6, 8] },
  { key: 'scenarioCount', label: 'Scenarios', caption: 'Available for Simulation', icon: CalendarDays, tone: 'slateblue', spark: [3, 5, 4, 6, 5, 7] },
  { key: 'activeSims', label: 'Active Simulations', caption: 'Running Now', icon: Activity, tone: 'red', spark: [6, 4, 5, 3, 4, 6] },
  { key: 'villageCount', label: 'Villages at Risk', caption: 'Generated & Ready', icon: Users, tone: 'amber', spark: [2, 3, 4, 4, 5, 7] },
  { key: 'facilityCount', label: 'Facilities', caption: 'Generated', icon: ClipboardList, tone: 'teal', spark: [3, 4, 3, 5, 5, 7] },
  { key: 'recentAlerts', label: 'Recent Alerts', caption: 'All Clear', icon: AlertTriangle, tone: 'orange', spark: [5, 4, 5, 3, 4, 5] },
];

const ACTIONS: Array<{
  title: string;
  description: string;
  path: string;
  icon: typeof Map;
  tone: ActionTone;
}> = [
  { title: 'Scenario Manager', description: 'Create & run disaster scenarios', path: '/scenarios', icon: Map, tone: 'teal' },
  { title: 'Alert Console', description: 'Monitor & respond to alerts', path: '/alerts', icon: AlertTriangle, tone: 'red' },
  { title: 'Evacuation Planner', description: 'Plan safe evacuation routes', path: '/evacuation', icon: Route, tone: 'green' },
  { title: 'Report Generator', description: 'Generate detailed reports', path: '/reports', icon: FileText, tone: 'slateblue' },
];

const HEALTH: HealthService[] = [
  { name: 'PostgreSQL + PostGIS', status: 'healthy', uptime: '99.9%' },
  { name: 'Redis (Celery Broker)', status: 'healthy', uptime: '99.9%' },
  { name: 'MinIO (Object Storage)', status: 'healthy', uptime: '99.8%' },
  { name: 'Celery Worker', status: 'idle', uptime: '99.7%' },
  { name: 'TiTiler (Tile Server)', status: 'healthy', uptime: '99.9%' },
  { name: 'FastAPI Backend', status: 'healthy', uptime: '100%' },
];

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-y-auto bg-cmd-bg">
      <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
        <HeroPanel />

        {/* KPI row */}
        <section aria-label="Key metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {KPI_DEFS.map(({ key, label, caption, icon, tone, spark }) => (
            <StatCard
              key={key}
              icon={icon}
              value={STATS[key]}
              label={label}
              caption={caption}
              spark={spark}
              tone={tone}
            />
          ))}
        </section>

        {/* Quick actions */}
        <section aria-label="Quick actions" className="cmd-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
              <Zap className="h-[18px] w-[18px] text-cmd-ink" strokeWidth={1.75} />
              Quick Actions
            </h2>
            <span className="flex cursor-pointer items-center gap-1.5 text-xs text-cmd-muted hover:text-cmd-teal">
              View all
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {ACTIONS.map(({ title, description, path, icon, tone }) => (
              <QuickAction
                key={path}
                icon={icon}
                title={title}
                description={description}
                tone={tone}
                onClick={() => navigate(path)}
              />
            ))}
          </div>
        </section>

        {/* Lower content */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <CaseStudyCard
            dam={{
              name: 'Machhu Dam (Demo — Morbi, Gujarat)',
              type: 'Earthen Embankment',
              height: '35.0 m',
              crestLength: '1,600 m',
              reservoirCapacity: '120 MCM',
              scenarios: '2 (Approved)',
            }}
            onViewDetails={() => navigate('/eap')}
          />
          <SystemHealth services={HEALTH} />
        </div>

        {/* Disclaimer (existing copy preserved) */}
        <div className="rounded-xl border border-cmd-amber/25 bg-cmd-amber/[0.06] p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-cmd-amber" strokeWidth={1.75} />
            <div>
              <h4 className="text-[13px] font-semibold text-cmd-ink">{t('disclaimer.title')}</h4>
              <p className="mt-1 text-xs leading-relaxed text-cmd-muted">{t('disclaimer.text')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
