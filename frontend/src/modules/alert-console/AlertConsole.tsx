/**
 * AquaShield 3D — Alert Console.
 *
 * Draft → approve → dispatch, wired to the real alerts API. This screen
 * previously showed a fabricated "active emergency" banner and two invented
 * alert drafts (Morbi populations that no model produced); both were removed.
 * A threat banner now appears only when a real assessment has been run in this
 * session, and it describes the *modelled scenario* — never a live emergency.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle, Globe, RefreshCw, Send, Shield, FileText, Waves } from 'lucide-react';
import { alertsApi, simRunsApi } from '../../api/client';
import { RISK_HEX, formatCount, formatInr, formatRange } from '../../components/impact/format';
import { loadLastAssessment } from '../../utils/lastAssessment';

interface AlertRow {
  id: string;
  content: string;
  language?: string;
  severity?: string;
  approved_by?: string | null;
  dispatched_at?: string | null;
  created_at?: string;
  sim_run_id?: string;
}

const SEV_TONE: Record<string, string> = {
  watch: 'border-cmd-amber/40 text-cmd-amber',
  warning: 'border-cmd-amber/40 text-cmd-amber',
  emergency: 'border-cmd-red/50 text-cmd-red',
};

function statusOf(a: AlertRow): 'dispatched' | 'approved' | 'draft' {
  if (a.dispatched_at) return 'dispatched';
  if (a.approved_by) return 'approved';
  return 'draft';
}

export default function AlertConsole() {
  const { t } = useTranslation();
  const [language, setLanguage] = useState<'en' | 'hi'>('en');
  const [severity, setSeverity] = useState<'watch' | 'warning' | 'emergency'>('warning');
  const [simRunId, setSimRunId] = useState('');
  const [doneRuns, setDoneRuns] = useState<
    Array<{ id: string; dam_name?: string; case?: string; run_kind?: string; finished_at?: string | null; created_at?: string | null }>
  >([]);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [assessment] = useState(() => loadLastAssessment());

  const flash = (msg: string, isError = false) => {
    if (isError) setError(msg);
    else setNotice(msg);
    window.setTimeout(() => (isError ? setError('') : setNotice('')), 5000);
  };

  const load = useCallback(async () => {
    setBusy((b) => b || 'load');
    try {
      const res = await alertsApi.list();
      setAlerts(Array.isArray(res?.alerts) ? res.alerts : []);
      setError('');
    } catch (e: any) {
      setAlerts(null);
      setError(`Could not load alerts: ${e?.message ?? e}`);
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => {
    void load();
    // Completed runs feed the draft picker — no UUID paste needed.
    (async () => {
      try {
        const res = await simRunsApi.list({ job_status: 'done' });
        const rows = res.sim_runs ?? [];
        setDoneRuns(rows);
        if (rows.length) setSimRunId((cur) => cur || rows[0].id);
      } catch {
        setDoneRuns([]);
      }
    })();
  }, [load]);

  const createDraft = async () => {
    if (!simRunId.trim()) {
      flash('No run selected — completed runs appear here after you run a simulation in the Sandbox or Impact screens.', true);
      return;
    }
    setBusy('draft');
    try {
      const res = await alertsApi.draft(simRunId.trim(), {
        language,
        severity,
        scenario_id: null,
        content: null,
      });
      flash(`Draft created${res?.id ? ` (${res.id})` : ''} — approve it before dispatch.`);
      await load();
    } catch (e: any) {
      flash(`Draft failed: ${e?.message ?? e}`, true);
    } finally {
      setBusy('');
    }
  };

  const approve = async (id: string) => {
    setBusy(id);
    try {
      await alertsApi.approve(id);
      flash('Alert approved — the human authorisation gate is satisfied.');
      await load();
    } catch (e: any) {
      flash(`Approve failed: ${e?.message ?? e}`, true);
    } finally {
      setBusy('');
    }
  };

  const dispatch = async (id: string) => {
    setBusy(id);
    try {
      await alertsApi.dispatch(id);
      flash('Alert dispatched.');
      await load();
    } catch (e: any) {
      flash(`Dispatch failed: ${e?.message ?? e}`, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto max-w-[1400px] space-y-5 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.alertConsole')}</h1>
            <p className="mt-1 text-sm text-cmd-muted">Alert lifecycle: Draft → Approve → Dispatch</p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-2 rounded-lg border border-cmd-border px-3 py-2 text-xs font-bold text-cmd-muted transition-colors hover:text-cmd-ink"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy === 'load' ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Situation card — real assessment, explicitly not a live emergency */}
        {assessment ? (
          <div className="cmd-card p-5">
            <div className="flex flex-wrap items-start gap-3">
              <Waves className="mt-0.5 h-4 w-4 shrink-0 text-cmd-teal" strokeWidth={1.9} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-cmd-muted">
                  Latest modelled assessment (this session) — not a live emergency
                </p>
                <p className="mt-1 text-sm font-bold text-cmd-ink">
                  {assessment.dam_name} — {assessment.case} case,{' '}
                  <span style={{ color: RISK_HEX[(assessment.overall_risk as keyof typeof RISK_HEX) ?? 'LOW'] }}>
                    {assessment.overall_risk} risk
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-cmd-muted tabular-nums">
                  {assessment.settlements_inundated} settlement(s) inundated •{' '}
                  {formatRange(assessment.population_exposed, formatCount)} people potentially exposed •{' '}
                  {formatInr(assessment.damage.low_inr)}–{formatInr(assessment.damage.high_inr)} potential damage •
                  confidence {assessment.confidence.level}
                </p>
              </div>
              <Link
                to="/impact"
                className="shrink-0 rounded-lg border border-cmd-border px-3 py-1.5 text-[11px] font-bold text-cmd-muted transition-colors hover:text-cmd-ink"
              >
                Review assessment
              </Link>
            </div>
          </div>
        ) : (
          <div className="cmd-card p-5">
            <p className="text-[12.5px] leading-relaxed text-cmd-muted">
              No assessment has been run in this session, so there is no threat picture to show. This console never
              displays a standing emergency: a warning banner appears only after a real assessment.{' '}
              <Link to="/impact" className="font-semibold text-cmd-teal hover:text-cmd-ink">
                Run an assessment
              </Link>{' '}
              first.
            </p>
          </div>
        )}

        {/* Authorisation gate */}
        <div className="flex items-start gap-3 rounded-xl border border-cmd-red/30 bg-cmd-red/[0.07] p-4">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-cmd-red" strokeWidth={1.75} />
          <div>
            <h4 className="text-sm font-semibold text-cmd-ink">{t('alert.approvalRequired')}</h4>
            <p className="mt-1 text-xs leading-relaxed text-cmd-muted">
              Dispatch requires human authorisation — the backend enforces <code>approved_by IS NOT NULL</code> at the
              database level, so an unapproved alert cannot be sent.
            </p>
          </div>
        </div>

        {(notice || error) && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12px] ${
              error ? 'border-cmd-red/35 bg-cmd-red/[0.07] text-cmd-red' : 'border-cmd-green/35 bg-cmd-green/[0.07] text-cmd-green'
            }`}
          >
            {error ? <AlertTriangle className="mt-px h-4 w-4 shrink-0" /> : <CheckCircle className="mt-px h-4 w-4 shrink-0" />}
            <span>{error || notice}</span>
          </div>
        )}

        {/* Draft form (real API call) */}
        <div className="cmd-card p-5">
          <h3 className="mb-1 text-[15px] font-semibold text-cmd-ink">Draft an alert</h3>
          <p className="mb-4 text-xs text-cmd-muted">
            The draft is generated by the backend from the simulation run you reference, so the wording and figures come
            from the run itself.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-cmd-muted">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as 'en' | 'hi')}
                className="w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-3 py-2 text-sm text-cmd-ink focus:border-cmd-teal/60 focus:outline-none"
              >
                <option value="en">English</option>
                <option value="hi">हिन्दी (Hindi)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-cmd-muted">Severity</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as typeof severity)}
                className="w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-3 py-2 text-sm text-cmd-ink focus:border-cmd-teal/60 focus:outline-none"
              >
                <option value="watch">Watch</option>
                <option value="warning">Warning</option>
                <option value="emergency">Emergency</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-cmd-muted">Simulation run</label>
              {doneRuns.length ? (
                <select
                  value={simRunId}
                  onChange={(e) => setSimRunId(e.target.value)}
                  className="w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-3 py-2 text-sm text-cmd-ink focus:border-cmd-teal/60 focus:outline-none"
                >
                  {doneRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.dam_name ?? 'Dam'}{r.case ? ` · ${r.case}` : ''} · {r.finished_at || r.created_at ? new Date(r.finished_at || r.created_at || '').toLocaleString() : r.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-lg border border-dashed border-cmd-border px-3 py-2.5 text-xs leading-relaxed text-cmd-muted">
                  No completed runs yet. Run a simulation first — it then appears here by name, no id needed.{' '}
                  <Link to="/impact" className="font-semibold text-cmd-teal hover:text-cmd-ink">
                    Open Impact screen
                  </Link>
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => void createDraft()}
            disabled={busy === 'draft'}
            className="mt-4 flex items-center gap-2 rounded-lg bg-cmd-red/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cmd-red disabled:opacity-50"
          >
            <FileText className="h-4 w-4" />
            {busy === 'draft' ? 'Drafting…' : 'Create draft from this run'}
          </button>
        </div>

        {/* Alert list (real records) */}
        <div className="space-y-4">
          {alerts === null && (
            <div className="cmd-card p-5 text-[12.5px] text-cmd-muted">
              {error ? 'Alerts unavailable while the API is unreachable.' : 'Loading alerts…'}
            </div>
          )}
          {alerts?.length === 0 && (
            <div className="rounded-xl border border-dashed border-cmd-border px-6 py-10 text-center">
              <p className="text-sm font-semibold text-cmd-ink">No alerts on record</p>
              <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-cmd-muted">
                Nothing has been drafted for this deployment yet. Drafts created above appear here with their real
                approval state.
              </p>
            </div>
          )}
          {alerts?.map((alert, i) => {
            const status = statusOf(alert);
            const sev = alert.severity ?? 'watch';
            return (
              <motion.div
                key={alert.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(i * 0.05, 0.3) }}
                className={`cmd-card border-l-2 p-5 ${sev === 'emergency' ? '!border-l-cmd-red' : '!border-l-cmd-amber'}`}
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className={`rounded-md border px-2 py-1 text-[11px] font-bold uppercase ${SEV_TONE[sev] ?? SEV_TONE.watch}`}>
                      {sev}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-cmd-muted">
                      <Globe className="h-3 w-3" />
                      {alert.language === 'hi' ? 'हिन्दी' : 'English'}
                    </span>
                    <span
                      className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
                        status === 'dispatched'
                          ? 'bg-cmd-teal/15 text-cmd-teal'
                          : status === 'approved'
                            ? 'bg-cmd-green/15 text-cmd-green'
                            : 'bg-white/[0.06] text-cmd-muted'
                      }`}
                    >
                      {status === 'dispatched' ? '✓ Dispatched' : status === 'approved' ? '✓ Approved' : '⏳ Draft'}
                    </span>
                  </div>
                  {status === 'draft' && (
                    <button
                      onClick={() => void approve(alert.id)}
                      disabled={busy === alert.id}
                      className="flex items-center gap-1.5 rounded-lg bg-cmd-green/90 px-3 py-1.5 text-xs font-bold text-[#071018] transition-colors hover:bg-cmd-green disabled:opacity-50"
                    >
                      <CheckCircle className="h-3.5 w-3.5" /> Approve
                    </button>
                  )}
                  {status === 'approved' && (
                    <button
                      onClick={() => void dispatch(alert.id)}
                      disabled={busy === alert.id}
                      className="flex items-center gap-1.5 rounded-lg bg-cmd-red/90 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-cmd-red disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" /> Dispatch
                    </button>
                  )}
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-cmd-ink/90">{alert.content}</pre>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
