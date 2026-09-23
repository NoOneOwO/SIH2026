/**
 * AquaShield 3D — Report Generator
 * Customizable EAP/incident documents: parameters + officer's free text,
 * broadcast to officials/government, and an inbox for received documents.
 *
 * Simulation runs, preview numbers and generated files are all live backend
 * data — nothing on this page is canned.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { FileText, Download, Eye, Printer, Inbox, Megaphone } from 'lucide-react';
import { impactApi, reportsApi, simRunsApi } from '../../api/client';

interface InboxDoc {
  id: string;
  title: string;
  kind: string;
  body: string;
  dam_id?: string | null;
  from: string;
  created_at: number;
}

interface SimRunRow {
  id: string;
  scenario_id: string;
  job_status: string;
  finished_at?: string | null;
  created_at?: string | null;
}

interface PreviewVillage {
  village_name: string;
  arrival_time_min: number | null;
  depth_m: number;
}

export default function ReportGenerator() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<SimRunRow[]>([]);
  const [runsError, setRunsError] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState('');
  const [preview, setPreview] = useState<PreviewVillage[]>([]);
  const [previewNote, setPreviewNote] = useState('');
  const [docTitle, setDocTitle] = useState('Flash flood warning — downstream villages');
  const [docKind, setDocKind] = useState('EMERGENT HELP');
  const [officerNote, setOfficerNote] = useState(
    'We need emergent help: SDRF teams, boats and medical posts at Morbi Stadium shelter before T+60 min. Requesting district control room activation.',
  );
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [inbox, setInbox] = useState<InboxDoc[]>([]);
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  async function loadRuns() {
    setRunsError('');
    try {
      const res = await simRunsApi.list({ job_status: 'done' });
      const rows: SimRunRow[] = res.sim_runs ?? [];
      setRuns(rows);
      if (rows.length && !rows.some((r) => r.id === selectedRun)) {
        setSelectedRun(rows[0].id);
      } else if (!rows.length) {
        setSelectedRun('');
      }
    } catch (e: any) {
      setRunsError(e?.message ?? 'Could not load simulation runs');
      setRuns([]);
    }
  }

  async function loadInbox() {
    try {
      const res = await reportsApi.inbox();
      setInbox(res.documents ?? []);
    } catch {
      setInbox([]);
    }
  }

  useEffect(() => {
    loadRuns();
    loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live preview numbers: top-3 priority villages for the selected run.
  useEffect(() => {
    if (!selectedRun) {
      setPreview([]);
      setPreviewNote('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await impactApi.getPriorities(selectedRun);
        if (cancelled) return;
        const top: PreviewVillage[] = (res.priorities ?? []).slice(0, 3);
        setPreview(top);
        setPreviewNote(top.length ? '' : 'No villages in this run.');
      } catch (e: any) {
        if (cancelled) return;
        setPreview([]);
        setPreviewNote(
          String(e?.message ?? '').includes('422')
            ? 'This run has no result grids — re-run the simulation for live numbers.'
            : `Preview unavailable: ${e?.message ?? 'backend error'}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRun]);

  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function handleGenerate() {
    setGenerateMsg('');
    if (!selectedRun) {
      setGenerateMsg('No completed simulation run yet — enqueue and finish one first.');
      return;
    }
    setGenerating(true);
    try {
      const { blob, filename } = await reportsApi.downloadReport(selectedRun);
      saveBlob(blob, filename);
      setGenerateMsg(
        filename.endsWith('.html')
          ? `PDF engine unavailable — downloaded HTML report (${filename}) instead.`
          : `Report downloaded (${filename}).`,
      );
    } catch (e: any) {
      setGenerateMsg(`Generation failed: ${e?.message ?? 'backend error'}`);
    } finally {
      setGenerating(false);
    }
  }

  async function handleBroadcast() {
    setBroadcastMsg('');
    if (!docTitle.trim() || !officerNote.trim()) {
      setBroadcastMsg('Give the document a title and write the officer note first.');
      return;
    }
    setBroadcasting(true);
    try {
      const res = await reportsApi.broadcast({
        title: docTitle.trim(),
        kind: docKind,
        body: officerNote.trim(),
        dam_id: null,
      });
      setBroadcastMsg(`Broadcast ${res.id} sent to all officials + government channel.`);
      loadInbox();
    } catch (e: any) {
      setBroadcastMsg(`Broadcast failed: ${e.message}`);
    } finally {
      setBroadcasting(false);
    }
  }

  const inputCls =
    'w-full px-3 py-2 bg-cmd-panel2 border border-cmd-border rounded-lg text-sm text-cmd-ink placeholder:text-cmd-muted/50 focus:outline-none focus:border-cmd-teal/60';
  const ghostBtn =
    'flex items-center gap-2 px-4 py-2 rounded-lg border border-cmd-border text-cmd-muted hover:text-cmd-ink hover:border-cmd-teal/40 text-sm font-semibold transition-colors';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
        <div>
          <h1 className="text-2xl font-bold text-cmd-ink">{t('nav.reportGenerator')}</h1>
          <p className="text-cmd-muted mt-1 text-sm">Compose, broadcast and receive official EAP documents</p>
        </div>

        {/* Composer */}
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
            <FileText className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Compose Broadcast Document
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <label className="block text-xs font-medium text-cmd-muted">Document title
              <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} className={`${inputCls} mt-1`}
                placeholder="e.g. Flash flood warning — downstream villages" />
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Request kind
              <select value={docKind} onChange={(e) => setDocKind(e.target.value)} className={`${inputCls} mt-1`}>
                <option>EMERGENT HELP</option>
                <option>EVACUATION ORDER</option>
                <option>SITUATION REPORT</option>
                <option>RESOURCE REQUEST</option>
                <option>ALL CLEAR</option>
              </select>
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Simulation Run
              <select value={selectedRun} onChange={(e) => setSelectedRun(e.target.value)} className={`${inputCls} mt-1`}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 8)}… · done{r.finished_at ? ` · ${new Date(r.finished_at).toLocaleString()}` : ''}
                  </option>
                ))}
                {!runs.length && <option value="">No completed runs</option>}
              </select>
            </label>
          </div>
          {runsError && <p className="mb-3 text-xs text-cmd-amber">{runsError}</p>}
          <label className="block text-xs font-medium text-cmd-muted">Officer's note <span className="font-normal">(free text — included verbatim in the document)</span>
            <textarea value={officerNote} onChange={(e) => setOfficerNote(e.target.value)} rows={4}
              className={`${inputCls} mt-1 leading-relaxed`}
              placeholder="Type what you need: emergent help, teams, boats, shelters, road closures…" />
          </label>

          <div className="mt-4 flex flex-wrap gap-3">
            <button onClick={handleGenerate} disabled={generating || !selectedRun}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-sm font-bold transition-colors disabled:opacity-50">
              {generating ? 'Generating…' : <><FileText className="w-4 h-4" /> {t('report.generatePdf')}</>}
            </button>
            <button onClick={() => window.print()} className={ghostBtn}>
              <Printer className="w-4 h-4" /> Print page
            </button>
            <button onClick={handleBroadcast} disabled={broadcasting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cmd-amber/90 hover:bg-cmd-amber text-[#071018] text-sm font-bold transition-colors disabled:opacity-50"
              style={{ boxShadow: '0 0 24px -10px rgba(216,178,76,0.5)' }}>
              <Megaphone className="w-4 h-4" strokeWidth={2} /> {broadcasting ? 'Broadcasting…' : 'Broadcast to officials'}
            </button>
          </div>
          {generateMsg && <p className="mt-2.5 text-xs text-cmd-muted">{generateMsg}</p>}
          {broadcastMsg && <p className="mt-2.5 text-xs text-cmd-muted">{broadcastMsg}</p>}
        </div>

        {/* Live preview (numbers + officer text together) */}
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4 flex items-center gap-2">
            <Eye className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} /> Document Preview
          </h3>
          <div className="bg-cmd-bg border border-cmd-border rounded-xl p-6">
            <div className="max-w-2xl mx-auto">
              <div className="border border-cmd-red/40 bg-cmd-red/[0.07] rounded-lg p-3 mb-4">
                <p className="text-xs text-cmd-ink font-bold">[{docKind}] {docTitle || '(untitled)'}</p>
                <p className="text-xs text-cmd-muted mt-1">AquaShield 3D broadcast • {new Date().toLocaleString()}</p>
              </div>
              <div className="text-sm text-cmd-ink/90 whitespace-pre-wrap leading-relaxed">
                {officerNote || <span className="text-cmd-muted italic">Officer note appears here…</span>}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                {preview.map((v) => (
                  <div key={v.village_name} className="rounded-lg border border-cmd-border bg-cmd-panel p-2">
                    <p className="text-xs font-bold text-cmd-ink">{v.village_name}</p>
                    <p className="text-[11px] text-cmd-muted font-mono tabular-nums">
                      {v.arrival_time_min != null ? `T+${Math.round(v.arrival_time_min)} min` : 'dry'} • {v.depth_m.toFixed(1)} m
                    </p>
                  </div>
                ))}
                {!preview.length && (
                  <p className="col-span-3 text-[11px] text-cmd-muted italic">
                    {previewNote || 'Pick a completed run for live priority numbers.'}
                  </p>
                )}
              </div>
              <div className="mt-4 pt-3 border-t border-cmd-border text-xs text-cmd-muted italic">
                Planning prototype — operational use needs authorised data and formal EAP approval.
              </div>
            </div>
          </div>
        </div>

        {/* Inbox (received documents — empty until first broadcast) */}
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-1 flex items-center gap-2">
            <Inbox className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} />
            Received Documents
            <span className="ml-auto px-2 py-0.5 rounded-md bg-white/[0.06] text-cmd-muted text-[11px] font-bold tabular-nums">{inbox.length}</span>
          </h3>
          <p className="text-xs text-cmd-muted mb-4">Broadcasts from other officials land here.</p>
          {!inbox.length ? (
            <div className="rounded-xl border border-dashed border-cmd-border p-8 text-center">
              <Inbox className="w-6 h-6 text-cmd-muted mx-auto mb-2" strokeWidth={1.5} />
              <p className="text-[13px] font-semibold text-cmd-ink">Inbox empty</p>
              <p className="text-xs text-cmd-muted mt-1">No documents received yet. Broadcasts from other officials will appear here.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {inbox.map((d) => (
                <div key={d.id} className="rounded-xl border border-cmd-border p-3.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-0.5 rounded-md bg-cmd-amber/15 text-cmd-amber text-[10px] font-bold">{d.kind}</span>
                    <p className="text-sm font-bold text-cmd-ink flex-1 min-w-0 truncate">{d.title}</p>
                    <button onClick={() => setOpenDoc(openDoc === d.id ? null : d.id)}
                      className="text-[11px] font-bold text-cmd-teal hover:underline">
                      {openDoc === d.id ? 'Hide' : 'Read'}
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-cmd-muted">
                    From {d.from} • {new Date(d.created_at * 1000).toLocaleString()}
                  </p>
                  {openDoc === d.id && (
                    <p className="mt-2 text-[13px] text-cmd-ink/90 leading-relaxed whitespace-pre-wrap border-t border-cmd-border/60 pt-2">{d.body}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Completed runs with per-run downloads */}
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-4">Completed Simulation Runs</h3>
          {!runs.length ? (
            <p className="text-xs text-cmd-muted">
              {runsError || 'No completed runs yet. Enqueue a scenario run and it appears here with its report.'}
            </p>
          ) : (
            <div className="space-y-2.5">
              {runs.map((r) => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-xl border border-cmd-border hover:border-cmd-teal/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-cmd-teal" strokeWidth={1.75} />
                    <div>
                      <div className="text-sm font-medium text-cmd-ink font-mono">{r.id.slice(0, 8)}…</div>
                      <div className="text-xs text-cmd-muted tabular-nums">
                        scenario {String(r.scenario_id).slice(0, 8)}…
                        {r.finished_at ? ` · ${new Date(r.finished_at).toLocaleString()}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setSelectedRun(r.id)} className={`${ghostBtn} !py-1.5 !text-xs`}>
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const { blob, filename } = await reportsApi.downloadReport(r.id);
                          saveBlob(blob, filename);
                        } catch (e: any) {
                          setGenerateMsg(`Download failed: ${e?.message ?? 'backend error'}`);
                        }
                      }}
                      className={`${ghostBtn} !py-1.5 !text-xs`}>
                      <Download className="w-3 h-3" /> Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
