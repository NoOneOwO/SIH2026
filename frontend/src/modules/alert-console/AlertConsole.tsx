/**
 * AquaShield 3D — Alert Console
 * Draft → Approve → Dispatch workflow with human authorization gate.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import {
  AlertTriangle, Send, CheckCircle, Shield, FileText, Globe,
} from 'lucide-react';
import { alertsApi } from '../../api/client';

export default function AlertConsole() {
  const { t } = useTranslation();
  const [language, setLanguage] = useState<'en' | 'hi'>('en');
  const [severity, setSeverity] = useState<'watch' | 'warning' | 'emergency'>('warning');
  const [drafting, setDrafting] = useState(false);
  // Live demo threat: an in-progress dam-break emergency so the console
  // never reads empty during demonstrations. Acknowledge to stand it down.
  const [threat, setThreat] = useState<'active' | 'acknowledged' | 'stood-down'>('active');

  const sampleAlerts = [
    {
      id: 'alert-001',
      content: '⚠️ DAM BREAK WARNING — IMMEDIATE ACTION REQUIRED\n\nAffected villages (8 total):\n  • Morbi City (Pop: 210000) — Arrival: 45 min\n  • Tankara (Pop: 15000) — Arrival: 30 min\n  • Bhalbhal (Pop: 5000) — Arrival: 20 min\n\nEvacuate immediately. Move to designated safe zones.',
      language: 'en',
      severity: 'emergency',
      status: 'draft',
    },
    {
      id: 'alert-002',
      content: '⚠️ बांध टूटने की चेतावनी — तत्काल कार्रवाई आवश्यक\n\nप्रभावित गाँव (8 कुल):\n  • मोरबी शहर (जनसंख्या: 210000) — आगमन: 45 मिनट\n  • टंकारा (जनसंख्या: 15000) — आगमन: 30 मिनट\n\nतत्काल निकासी की व्यवस्था करें।',
      language: 'hi',
      severity: 'warning',
      status: 'approved',
    },
  ];

  const sevTone: Record<string, string> = {
    watch: 'border-cmd-amber/40 text-cmd-amber',
    warning: 'border-cmd-amber/40 text-cmd-amber',
    emergency: 'border-cmd-red/50 text-cmd-red',
  };

  const inputCls =
    'w-full px-3 py-2 bg-cmd-panel2 border border-cmd-border rounded-lg text-sm text-cmd-ink focus:outline-none focus:border-cmd-teal/60';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.alertConsole')}</h1>
          <p className="text-cmd-muted mt-1 text-sm">Alert lifecycle: Draft → Approve → Dispatch</p>
        </div>
        <button
          onClick={() => setDrafting(!drafting)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cmd-red/90 hover:bg-cmd-red text-white text-sm font-semibold transition-colors"
        >
          <AlertTriangle className="w-4 h-4" /> Draft Alert
        </button>
      </div>

      {/* Live threat banner (demo): an in-progress dam-break emergency */}
      {threat !== 'stood-down' && (
        <div className="cmd-card p-5 !border-cmd-red/50" style={{ boxShadow: '0 0 32px -12px rgba(217,107,112,0.5)' }}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cmd-red opacity-60" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-cmd-red" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-cmd-red">
                {threat === 'active' ? 'Active emergency — dam break in progress' : 'Emergency acknowledged — monitoring'}
              </p>
              <p className="mt-1 text-sm font-bold text-cmd-ink">
                Tehri Dam (Uttarakhand) — overtopping breach, downstream wave moving through the Bhagirathi gorge
              </p>
              <p className="mt-0.5 text-xs text-cmd-muted font-mono tabular-nums">
                Issued T+0 min • Morbi-style demo template • severity EMERGENCY • 3 priority villages in the wave path
              </p>
            </div>
            {threat === 'active' ? (
              <button onClick={() => setThreat('acknowledged')}
                className="px-4 py-2 rounded-lg bg-cmd-amber/90 hover:bg-cmd-amber text-[#071018] text-xs font-bold transition-colors shrink-0">
                Acknowledge
              </button>
            ) : (
              <button onClick={() => setThreat('stood-down')}
                className="px-4 py-2 rounded-lg border border-cmd-border text-cmd-muted hover:text-cmd-ink text-xs font-bold transition-colors shrink-0">
                Stand down
              </button>
            )}
          </div>
        </div>
      )}

      {/* Authorization Gate Warning */}
      <div className="rounded-xl border border-cmd-red/30 bg-cmd-red/[0.07] p-4 flex items-start gap-3">
        <Shield className="w-5 h-5 text-cmd-red mt-0.5 shrink-0" strokeWidth={1.75} />
        <div>
          <h4 className="text-sm font-semibold text-cmd-ink">{t('alert.approvalRequired')}</h4>
          <p className="text-xs text-cmd-muted mt-1">
            Alert dispatch requires human authorization. approved_by IS NOT NULL is enforced at the database level.
          </p>
        </div>
      </div>

      {/* Draft Form */}
      {drafting && (
        <div className="cmd-card p-6">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4">Draft New Alert</h3>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'hi')} className={inputCls}>
                <option value="en">English</option>
                <option value="hi">हिन्दी (Hindi)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Severity</label>
              <select value={severity} onChange={(e) => setSeverity(e.target.value as any)} className={inputCls}>
                <option value="watch">Watch</option>
                <option value="warning">Warning</option>
                <option value="emergency">Emergency</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-cmd-muted mb-1">Scenario</label>
              <select className={inputCls}>
                <option>Overtopping — Expected</option>
                <option>Piping — Conservative</option>
              </select>
            </div>
          </div>
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cmd-red/90 hover:bg-cmd-red text-white text-sm font-semibold transition-colors"
            onClick={() => setDrafting(false)}
          >
            <FileText className="w-4 h-4" /> Auto-Generate Alert Content
          </button>
        </div>
      )}

      {/* Alert List */}
      <div className="space-y-4">
        {sampleAlerts.map((alert, i) => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: i * 0.06 }}
            className={`cmd-card p-5 border-l-2 ${alert.severity === 'emergency' ? '!border-l-cmd-red' : '!border-l-cmd-amber'}`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <span className={`px-2 py-1 rounded-md border text-[11px] font-bold uppercase ${sevTone[alert.severity]}`}>
                  {alert.severity}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-cmd-muted">
                  <Globe className="w-3 h-3" />
                  {alert.language === 'en' ? 'English' : 'हिन्दी'}
                </span>
                <span className={`px-2 py-1 rounded-md text-[11px] font-semibold ${
                  alert.status === 'approved' ? 'bg-cmd-green/15 text-cmd-green' : 'bg-white/[0.06] text-cmd-muted'
                }`}>
                  {alert.status === 'approved' ? '✓ Approved' : '⏳ Draft'}
                </span>
              </div>
              {alert.status === 'draft' ? (
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cmd-green/90 hover:bg-cmd-green text-[#071018] text-xs font-bold transition-colors">
                  <CheckCircle className="w-3.5 h-3.5" /> Approve
                </button>
              ) : (
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cmd-red/90 hover:bg-cmd-red text-white text-xs font-bold transition-colors">
                  <Send className="w-3.5 h-3.5" /> Dispatch
                </button>
              )}
            </div>
            <pre className="text-[13px] leading-relaxed whitespace-pre-wrap font-sans text-cmd-ink/90">{alert.content}</pre>
          </motion.div>
        ))}
      </div>
      </div>
    </motion.div>
  );
}

