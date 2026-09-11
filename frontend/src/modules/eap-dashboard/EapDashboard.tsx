/**
 * AquaShield 3D — EAP Dashboard
 * Planning/EAP mode: overview of all approved scenarios, EAP packages, and preparedness.
 */

import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Shield, CheckCircle, Clock, Lock, Map, AlertTriangle, FileText } from 'lucide-react';

export default function EapDashboard() {
  const { t } = useTranslation();

  const scenarios = [
    {
      id: '40000000-0000-0000-0000-000000000001',
      failureMode: 'overtopping',
      variant: 'expected',
      solver: 'educational_swe',
      status: 'approved',
      approvedBy: 'Demo Operator',
      approvedAt: '2026-08-31T12:00:00Z',
    },
    {
      id: '40000000-0000-0000-0000-000000000002',
      failureMode: 'piping',
      variant: 'conservative',
      solver: 'educational_swe',
      status: 'approved',
      approvedBy: 'Demo Operator',
      approvedAt: '2026-08-31T12:00:00Z',
    },
  ];

  const preparednessItems = [
    { label: 'Dam inventory loaded', status: true },
    { label: 'DEM preprocessing complete', status: true },
    { label: '≥2 breach scenarios precomputed', status: true },
    { label: 'Exposure data loaded (villages, roads, facilities)', status: true },
    { label: 'Evacuation priority lists generated', status: true },
    { label: 'PDF report template ready', status: true },
    { label: '3D digital twin configured', status: true },
    { label: 'Alert templates (EN + HI) ready', status: true },
  ];

  const statusIcon = (status: string) => {
    switch (status) {
      case 'draft': return <Clock className="w-4 h-4 text-cmd-muted" />;
      case 'submitted': return <Clock className="w-4 h-4 text-cmd-amber" />;
      case 'approved': return <CheckCircle className="w-4 h-4 text-cmd-green" />;
      case 'locked': return <Lock className="w-4 h-4 text-cmd-teal" />;
      default: return null;
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.eapDashboard')}</h1>
        <p className="text-cmd-muted mt-1 text-sm">Emergency Action Plan — Planning and preparedness overview</p>
      </div>

      {/* Scenario Ensemble */}
      <div className="cmd-card p-5">
        <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
          <Map className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
          Scenario Ensemble
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-cmd-border">
                {['Failure Mode', 'Variant', 'Solver', 'Status', 'Approved By'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-[11px] font-semibold text-cmd-muted uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.id} className="border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03]">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-semibold ${
                      s.failureMode === 'overtopping'
                        ? 'border-cmd-amber/40 text-cmd-amber'
                        : 'border-cmd-teal/40 text-cmd-teal'
                    }`}>
                      {t(`scenario.${s.failureMode}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-cmd-ink/90">{s.variant}</td>
                  <td className="px-4 py-3 text-sm text-cmd-muted font-mono text-xs">{s.solver}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-sm text-cmd-ink">
                      {statusIcon(s.status)}
                      <span className="capitalize">{s.status}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-cmd-muted">{s.approvedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Preparedness Checklist */}
      <div className="cmd-card p-5">
        <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
          <Shield className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
          Preparedness Checklist
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {preparednessItems.map(({ label, status }) => (
            <div key={label} className="flex items-center gap-3">
              {status ? (
                <CheckCircle className="w-[18px] h-[18px] text-cmd-green shrink-0" strokeWidth={1.75} />
              ) : (
                <AlertTriangle className="w-[18px] h-[18px] text-cmd-muted shrink-0" strokeWidth={1.75} />
              )}
              <span className={`text-[13px] ${status ? 'text-cmd-ink/90' : 'text-cmd-muted'}`}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Response Workflow Levels */}
      <div className="cmd-card p-5">
        <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
          <FileText className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
          Response Workflow Levels
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { level: 'Level 0', title: 'Preparedness', desc: 'Scenario creation → review → approval → EAP export', tone: 'border-cmd-green/40 text-cmd-green' },
            { level: 'Level 1', title: 'Abnormal', desc: 'Watch status, preload scenarios, verify contacts', tone: 'border-cmd-amber/40 text-cmd-amber' },
            { level: 'Level 2', title: 'Potential Breach', desc: 'Select conservative scenario, rank settlements', tone: 'border-cmd-amber/40 text-cmd-amber' },
            { level: 'Level 3', title: 'Confirmed Breach', desc: 'Lock parameters, minute-by-minute dashboard', tone: 'border-cmd-red/50 text-cmd-red' },
          ].map(({ level, title, desc, tone }) => (
            <div key={level} className={`p-4 rounded-xl border border-cmd-border border-t-2 ${tone.split(' ')[0]}`}>
              <div className={`text-[11px] font-bold uppercase tracking-wider ${tone.split(' ')[1]}`}>{level}</div>
              <div className="text-sm font-semibold text-cmd-ink mt-1">{title}</div>
              <div className="text-xs text-cmd-muted mt-1.5 leading-relaxed">{desc}</div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </motion.div>
  );
}

