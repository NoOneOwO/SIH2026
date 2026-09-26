/**
 * AquaShield 3D — Admin: Dam Registry.
 *
 * Every registered dam as a row: identity, documentation, completeness,
 * condition badge, simulation availability. Click → full profile drawer with
 * documents (upload + view), extracted findings, the condition reasoning and
 * jump-off actions (Run sandbox / Flood impact).
 *
 * Condition badges are evidence-bookkeeping screens (official documents +
 * labelled OSINT), never structural safety verdicts.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, FileText, FlaskConical, Loader2, MapPinned, Plus, RefreshCw,
  ShieldCheck, Upload, X,
} from 'lucide-react';
import { damsApi } from '../../api/client';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

interface RegistryRow {
  dam_id: string;
  name: string;
  state: string | null;
  dam_type: string | null;
  river: string | null;
  height_m: number | null;
  year_built: number | null;
  documents: number;
  last_report_utc: string | null;
  recent_report_5y: boolean;
  completeness: { score: number; filled: number; total: number; missing: string[] };
  condition: 'LOW_CONCERN' | 'MODERATE_CONCERN' | 'HIGH_CONCERN' | 'INSUFFICIENT_DATA' | string;
  simulation_available: boolean;
}

interface ProfileDoc {
  id: string;
  original_name: string;
  doc_type_label: string;
  uploaded_at_utc: string;
  uploaded_by: string;
  word_count: number;
  extraction: string;
  reported_condition: string | null;
  issues: Array<{ topic: string; quote: string }>;
  recommendations: string[];
  incidents: string[];
  dates_found: string[];
}

interface ProfilePayload {
  dam_id: string;
  registry: Record<string, any>;
  profile: Record<string, any>;
  documents: ProfileDoc[];
  completeness: { score: number; filled: number; total: number; missing: string[] };
  osint: Array<{ year: number; source: string; summary: string }>;
}

function ConditionBadge({ category }: { category: string }) {
  const tone =
    category === 'HIGH_CONCERN' ? 'bg-cmd-red/15 text-cmd-red border-cmd-red/40'
    : category === 'MODERATE_CONCERN' ? 'bg-cmd-amber/15 text-cmd-amber border-cmd-amber/40'
    : category === 'LOW_CONCERN' ? 'bg-cmd-green/15 text-cmd-green border-cmd-green/40'
    : 'bg-white/[0.06] text-cmd-muted border-cmd-border';
  const label = category.replace(/_/g, ' ');
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${tone}`}
      title="Evidence-bookkeeping screen from official documents + labelled public information — not a structural safety verdict">
      {label}
    </span>
  );
}

function CompletenessBar({ score }: { score: number }) {
  const tone = score >= 70 ? 'bg-cmd-green/80' : score >= 40 ? 'bg-cmd-amber/80' : 'bg-cmd-red/70';
  return (
    <div className="flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-cmd-track">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(3, score)}%` }} />
      </span>
      <span className="text-[11px] font-bold tabular-nums text-cmd-ink/90">{score}%</span>
    </div>
  );
}

/** Upload + profile drawer for one dam. */
function DamDrawer({ row, onClose, onUploaded }: { row: RegistryRow; onClose: () => void; onUploaded: () => void }) {
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [condition, setCondition] = useState<any>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const H = { Authorization: import.meta.env.DEV ? 'Bearer dev-token' : (localStorage.getItem('damsafe_token') ? `Bearer ${localStorage.getItem('damsafe_token')}` : '') } as Record<string, string>;
      const [p, c] = await Promise.all([
        fetch(`${BASE_URL}/api/v1/dams/${row.dam_id}/profile`, { headers: H }).then((r) => r.json()),
        fetch(`${BASE_URL}/api/v1/dams/${row.dam_id}/condition`, { headers: H }).then((r) => r.json()),
      ]);
      setProfile(p);
      setCondition(c);
    } catch (e: any) {
      setError(e?.message ?? 'Load failed');
    }
  }, [row.dam_id]);

  useEffect(() => { void load(); }, [load]);

  async function upload(file: File) {
    setUploading(true);
    setError('');
    try {
      const token = localStorage.getItem('damsafe_token');
      const H: Record<string, string> = {};
      if (token) H['Authorization'] = `Bearer ${token}`;
      else if (import.meta.env.DEV) H['Authorization'] = 'Bearer dev-token';
      const body = new FormData();
      body.append('file', file);
      if (docType) body.append('doc_type', docType);
      const res = await fetch(`${BASE_URL}/api/v1/dams/${row.dam_id}/documents`, { method: 'POST', headers: H, body });
      if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
      await load();
      onUploaded();
    } catch (e: any) {
      setError(e?.message ?? 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function viewDoc(doc: ProfileDoc) {
    try {
      const token = localStorage.getItem('damsafe_token');
      const H: Record<string, string> = {};
      if (token) H['Authorization'] = `Bearer ${token}`;
      else if (import.meta.env.DEV) H['Authorization'] = 'Bearer dev-token';
      const res = await fetch(`${BASE_URL}/api/v1/dams/${row.dam_id}/documents/${doc.id}/file`, { headers: H });
      if (!res.ok) throw new Error(`Document fetch failed (${res.status})`);
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    } catch (e: any) {
      setError(e?.message ?? 'View failed');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-cmd-border bg-[#0A1218] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-cmd-ink">{row.name}</h2>
            <p className="text-xs text-cmd-muted">
              {row.state || '—'} • {row.dam_type?.replace(/_/g, ' ') || 'type unknown'} • {row.river || '—'}
              {row.year_built ? ` • built ${row.year_built}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-cmd-muted hover:bg-white/[0.06] hover:text-cmd-ink"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <ConditionBadge category={condition?.category ?? row.condition} />
          <CompletenessBar score={condition?.completeness?.score ?? row.completeness.score} />
          <span className="rounded border border-cmd-border px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-cmd-muted">
            {row.simulation_available ? 'simulation ready' : 'terrain not built'}
          </span>
        </div>
        {condition?.headline && (
          <p className="mt-3 rounded-lg border border-cmd-border/70 bg-cmd-panel2/60 px-3 py-2 text-[12px] leading-relaxed text-cmd-ink/90">
            {condition.headline}
          </p>
        )}
        {condition?.note && <p className="mt-1.5 text-[10.5px] leading-snug text-cmd-muted">{condition.note}</p>}

        {/* Evidence reasoning */}
        {condition?.reasons?.length > 0 && (
          <div className="mt-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-muted">Assessment evidence</p>
            <ul className="mt-2 space-y-1.5">
              {condition.reasons.map((r: any, i: number) => (
                <li key={i} className="flex items-start gap-2 text-[11.5px] leading-snug">
                  <span className={`mt-px shrink-0 rounded border px-1 py-px text-[8.5px] font-bold uppercase ${r.evidence === 'official' ? 'border-cmd-green/40 text-cmd-green' : 'border-cmd-amber/40 text-cmd-amber'}`}>
                    {r.evidence}
                  </span>
                  <span className="text-cmd-ink/85">{r.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Documents */}
        <div className="mt-5 border-t border-cmd-border pt-4">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-muted">Official documents ({profile?.documents.length ?? 0})</p>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-cmd-teal/50 px-2.5 py-1.5 text-[11px] font-bold text-cmd-teal hover:bg-cmd-tealdim">
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload
              <input type="file" accept=".pdf,.txt,.md,.jpg,.jpeg,.png" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            </label>
          </div>
          <select value={docType} onChange={(e) => setDocType(e.target.value)}
            className="mt-2 w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[11.5px] text-cmd-ink focus:outline-none">
            <option value="">Auto-detect document type…</option>
            {['safety_inspection', 'structural_inspection', 'eap', 'maintenance', 'condition', 'incident', 'government', 'technical', 'other'].map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
          {error && <p className="mt-2 text-[11px] font-semibold text-cmd-red">{error}</p>}
          <div className="mt-3 space-y-2">
            {(profile?.documents ?? []).map((d) => (
              <div key={d.id} className="rounded-lg border border-cmd-border/70 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-cmd-teal" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-cmd-ink">{d.original_name}</span>
                  <button onClick={() => void viewDoc(d)} className="rounded border border-cmd-border px-2 py-0.5 text-[10px] font-bold text-cmd-muted hover:text-cmd-teal">View</button>
                </div>
                <p className="mt-1 text-[10.5px] text-cmd-muted">
                  {d.doc_type_label} • uploaded {d.uploaded_at_utc.slice(0, 10)} by {d.uploaded_by} • {d.extraction}
                </p>
                {d.reported_condition && (
                  <p className="mt-1 text-[11px] text-cmd-ink/85">Reported condition: <b>{d.reported_condition}</b></p>
                )}
                {d.issues.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {d.issues.map((i, k) => (
                      <p key={k} className="rounded bg-cmd-amber/[0.07] px-2 py-1 text-[10.5px] leading-snug text-cmd-ink/85">
                        <b className="uppercase text-cmd-amber">{i.topic}</b> — “{i.quote}”
                      </p>
                    ))}
                  </div>
                )}
                {d.recommendations.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {d.recommendations.slice(0, 3).map((rec, k) => (
                      <li key={k} className="text-[10.5px] text-cmd-muted">• {rec}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {profile && profile.documents.length === 0 && (
              <p className="text-[11.5px] text-cmd-muted">No official document uploaded yet. Upload a safety inspection, EAP, condition or incident report.</p>
            )}
          </div>
          {/* OSINT layer */}
          {(profile?.osint?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-lg border border-cmd-amber/30 bg-cmd-amber/[0.05] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cmd-amber">Public / OSINT evidence</p>
              {(profile?.osint ?? []).map((n, i) => (
                <p key={i} className="mt-1.5 text-[11px] leading-relaxed text-cmd-ink/85">
                  <b>{n.year}</b> — {n.source}: {n.summary}
                </p>
              ))}
              <p className="mt-1.5 text-[10px] text-cmd-muted">Contextual public information — never presented as confirmed structural truth.</p>
            </div>
          )}
          {/* Jump-off actions */}
          <div className="mt-5 flex gap-2 border-t border-cmd-border pt-4">
            <a href={`/incident?dam=${encodeURIComponent(row.dam_id)}`}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-cmd-teal/50 px-3 py-2 text-[11.5px] font-bold text-cmd-teal hover:bg-cmd-tealdim">
              <FlaskConical className="h-3.5 w-3.5" /> Run sandbox
            </a>
            <a href={`/impact?dam=${encodeURIComponent(row.dam_id)}`}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-cmd-teal/50 px-3 py-2 text-[11.5px] font-bold text-cmd-teal hover:bg-cmd-tealdim">
              <MapPinned className="h-3.5 w-3.5" /> Flood impact
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Register-dam form (admin/analyst). */
function RegisterDamForm({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<any>({
    name: '', latitude: '', longitude: '', state: '', river: '', dam_type: 'earthen',
    height_m: '', crest_length_m: '', reservoir_capacity_mcm: '', year_built: '',
    owner_operator: '', river_basin: '', material_type: 'earthen',
    spillway_capacity_cumecs: '', max_water_level_m: '', full_reservoir_level_m: '',
    normal_operating_level_m: '', structural_notes: '', operating_notes: '',
  });
  const set = (k: string, v: string) => setForm((p: any) => ({ ...p, [k]: v }));

  async function submit() {
    setBusy(true); setError('');
    try {
      await damsApi.create({
        ...form,
        latitude: Number(form.latitude), longitude: Number(form.longitude),
        height_m: form.height_m ? Number(form.height_m) : undefined,
        crest_length_m: form.crest_length_m ? Number(form.crest_length_m) : undefined,
        reservoir_capacity_mcm: form.reservoir_capacity_mcm ? Number(form.reservoir_capacity_mcm) : undefined,
        year_built: form.year_built ? Number(form.year_built) : undefined,
        spillway_capacity_cumecs: form.spillway_capacity_cumecs ? Number(form.spillway_capacity_cumecs) : undefined,
        max_water_level_m: form.max_water_level_m ? Number(form.max_water_level_m) : undefined,
        full_reservoir_level_m: form.full_reservoir_level_m ? Number(form.full_reservoir_level_m) : undefined,
        normal_operating_level_m: form.normal_operating_level_m ? Number(form.normal_operating_level_m) : undefined,
      });
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  const F = ({ k, label, type = 'text', placeholder }: { k: string; label: string; type?: string; placeholder?: string }) => (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">{label}</span>
      <input type={type} value={form[k] ?? ''} placeholder={placeholder} onChange={(e) => set(k, e.target.value)}
        className="mt-0.5 w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[12px] text-cmd-ink focus:border-cmd-teal/60 focus:outline-none" />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-cmd-border bg-[#0A1218] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-cmd-ink">Register a dam</h2>
            <p className="text-xs text-cmd-muted">Material/type is recorded as context — it is never treated as a safety verdict.</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-cmd-muted hover:bg-white/[0.06] hover:text-cmd-ink"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <F k="name" label="Dam name *" />
          <F k="state" label="State" />
          <F k="latitude" label="Latitude *" type="number" placeholder="22.83" />
          <F k="longitude" label="Longitude *" type="number" placeholder="70.85" />
          <F k="river" label="River" />
          <F k="river_basin" label="River / basin" />
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">Material / type</span>
            <select value={form.material_type} onChange={(e) => set('material_type', e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[12px] text-cmd-ink focus:outline-none">
              {['earthen', 'earthfill', 'rockfill', 'concrete_gravity', 'concrete_arch', 'masonry', 'composite', 'other'].map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
          <F k="owner_operator" label="Owner / operator" />
          <F k="height_m" label="Height (m)" type="number" />
          <F k="crest_length_m" label="Crest length (m)" type="number" />
          <F k="reservoir_capacity_mcm" label="Reservoir capacity (MCM)" type="number" />
          <F k="spillway_capacity_cumecs" label="Spillway capacity (m³/s)" type="number" />
          <F k="max_water_level_m" label="Max water level (m)" type="number" />
          <F k="full_reservoir_level_m" label="Full reservoir level (m)" type="number" />
          <F k="normal_operating_level_m" label="Normal operating level (m)" type="number" />
          <F k="year_built" label="Construction year" type="number" />
          <label className="block sm:col-span-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">Structural notes</span>
            <textarea value={form.structural_notes} onChange={(e) => set('structural_notes', e.target.value)} rows={2}
              className="mt-0.5 w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[12px] text-cmd-ink focus:outline-none" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">Operating notes</span>
            <textarea value={form.operating_notes} onChange={(e) => set('operating_notes', e.target.value)} rows={2}
              className="mt-0.5 w-full rounded-lg border border-cmd-border bg-cmd-panel2 px-2.5 py-1.5 text-[12px] text-cmd-ink focus:outline-none" />
          </label>
        </div>
        {error && <p className="mt-3 text-[11.5px] font-semibold text-cmd-red">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-cmd-border px-4 py-2 text-[12px] font-bold text-cmd-muted hover:text-cmd-ink">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || !form.name || !form.latitude || !form.longitude}
            className="flex items-center gap-2 rounded-lg bg-cmd-teal/90 px-4 py-2 text-[12px] font-bold text-[#071018] hover:bg-cmd-teal disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Register dam
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DamRegistry() {
  const [rows, setRows] = useState<RegistryRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<RegistryRow | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await damsApi.registrySummary();
      setRows(res.dams);
    } catch (e: any) {
      setError(e?.message ?? 'Load failed');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = (rows ?? []).filter((r) =>
    !query || r.name.toLowerCase().includes(query.toLowerCase()) || (r.state ?? '').toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-cmd-ink">
            <MapPinned className="h-[18px] w-[18px] text-cmd-teal" strokeWidth={1.75} /> Dam registry
          </h3>
          <p className="text-xs text-cmd-muted">Every registered dam — documentation, completeness, condition screen, simulation availability.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dams…"
            className="w-44 rounded-lg border border-cmd-border bg-cmd-panel px-3 py-1.5 text-xs text-cmd-ink placeholder:text-cmd-muted/60 focus:outline-none focus:border-cmd-teal/60" />
          <button onClick={() => void load()} className="rounded-lg border border-cmd-border p-2 text-cmd-muted hover:text-cmd-ink" title="Reload">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setShowRegister(true)}
            className="flex items-center gap-1.5 rounded-lg bg-cmd-teal/90 px-3 py-2 text-[11.5px] font-bold text-[#071018] hover:bg-cmd-teal">
            <Plus className="h-3.5 w-3.5" /> Register dam
          </button>
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-2 rounded-lg border border-cmd-red/30 bg-cmd-red/[0.08] px-3 py-2 text-xs text-cmd-red">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-cmd-border">
        <table className="w-full min-w-[52rem]">
          <thead>
            <tr className="border-b border-cmd-border bg-cmd-panel/60">
              {['Dam', 'Type', 'Year', 'Documents', 'Last report', 'Data completeness', 'Condition screen', 'Simulation'].map((h) => (
                <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-cmd-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).length === 0 && !error && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-[12px] text-cmd-muted">Loading registry…</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.dam_id} onClick={() => setSelected(r)}
                className="cursor-pointer border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03]">
                <td className="px-3 py-2.5">
                  <p className="text-[13px] font-semibold text-cmd-ink">{r.name}</p>
                  <p className="text-[10.5px] text-cmd-muted">{r.state || '—'} • {r.river || '—'} <span className="font-mono">({r.dam_id})</span></p>
                </td>
                <td className="px-3 py-2.5 text-[12px] capitalize text-cmd-ink/85">{r.dam_type?.replace(/_/g, ' ') || '—'}</td>
                <td className="px-3 py-2.5 text-[12px] tabular-nums text-cmd-ink/85">{r.year_built ?? '—'}</td>
                <td className="px-3 py-2.5 text-[12px] font-bold tabular-nums text-cmd-ink/90">{r.documents}</td>
                <td className="px-3 py-2.5 text-[11.5px] tabular-nums text-cmd-muted">
                  {r.last_report_utc ? r.last_report_utc.slice(0, 10) : 'none'}
                </td>
                <td className="px-3 py-2.5"><CompletenessBar score={r.completeness.score} /></td>
                <td className="px-3 py-2.5"><ConditionBadge category={r.condition} /></td>
                <td className="px-3 py-2.5">
                  {r.simulation_available
                    ? <span className="text-[10.5px] font-bold uppercase text-cmd-green">ready</span>
                    : <span className="text-[10.5px] font-bold uppercase text-cmd-muted">not built</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10.5px] leading-snug text-cmd-muted">
        Condition badges are evidence screens over official documents and labelled public information — never structural
        safety verdicts. Click a row for the full profile, evidence reasoning and document upload.
      </p>

      {selected && <DamDrawer row={selected} onClose={() => setSelected(null)} onUploaded={() => void load()} />}
      {showRegister && <RegisterDamForm onClose={() => setShowRegister(false)} onDone={() => { setShowRegister(false); void load(); }} />}
    </div>
  );
}
