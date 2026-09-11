/**
 * AquaShield 3D — admin console.
 * Verify officials (documents), manage roles, and review per-dam simulations.
 */

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ShieldCheck, Check, X, FileText, FlaskConical, ExternalLink } from 'lucide-react';
import { authApi, type AuthUser } from '../../api/auth';
import { useAuth } from '../../auth/AuthContext';
import { INDIA_DAMS } from '../../data/india-dams';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
import { storedToken } from '../../api/client';

interface SimEntry {
  job_id: string;
  dam_id: string;
  dam_name: string;
  status: string;
  stats: any;
  elapsed_s?: number;
  error?: string;
}

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
  const token = storedToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  else if (import.meta.env.DEV) headers['Authorization'] = 'Bearer dev-token';
  const res = await fetch(`${BASE_URL}/api/v1${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`Request failed ${res.status}: ${await res.text()}`);
  return res.json();
}

export default function Admin() {
  const { user, loading: authLoading, isAdmin } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [sims, setSims] = useState<SimEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function load() {
    setError('');
    try {
      const [u, s] = await Promise.all([
        authApi.users(),
        adminFetch<{ sims: SimEntry[] }>('/auth/sims'),
      ]);
      setUsers(u.users);
      setSims(s.sims);
    } catch (e: any) {
      setError(e.message ?? 'Load failed');
    }
  }

  useEffect(() => {
    if (!authLoading && isAdmin) load();
  }, [authLoading, isAdmin]);

  async function act(id: string, fn: () => Promise<any>) {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message ?? 'Action failed');
    } finally {
      setBusy('');
    }
  }

  async function viewDoc(filename: string) {
    try {
      const headers: Record<string, string> = {};
      const token = storedToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      else if (import.meta.env.DEV) headers['Authorization'] = 'Bearer dev-token';
      const res = await fetch(authApi.documentUrl(filename), { headers });
      if (!res.ok) throw new Error(`Document fetch failed (${res.status})`);
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e: any) {
      setError(e.message);
    }
  }

  const damName = (id?: string | null) => INDIA_DAMS.find((d) => d.id === id)?.name ?? (id || '—');
  const pending = users.filter((u) => u.status === 'pending');

  if (authLoading) {
    return (
      <div className="h-full flex items-center justify-center text-cmd-muted text-sm">Loading…</div>
    );
  }
  if (!user || !isAdmin) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-[560px] p-6">
          <div className="cmd-card p-8 text-center">
            <ShieldCheck className="h-8 w-8 text-cmd-amber mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-base font-bold text-cmd-ink">Restricted area</p>
            <p className="mt-1.5 text-[13px] text-cmd-muted leading-relaxed">
              {!user
                ? 'Sign in with an administrator account to review officials and simulations.'
                : `${user.name} is signed in as ${user.role} — administration needs the admin role.`}
            </p>
            {!user && (
              <a href="/login" className="mt-4 inline-block px-4 py-2 rounded-lg bg-cmd-teal/90 text-[#071018] text-sm font-bold">
                Go to sign in
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1200px] p-4 md:p-6 space-y-5">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
          className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-cmd-border bg-cmd-panel2">
            <ShieldCheck className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-cmd-ink">Administration</h1>
            <p className="text-cmd-muted text-sm">Official verification • dam access • simulations</p>
          </div>
          <span className="ml-auto px-2.5 py-1 rounded-md bg-cmd-amber/15 text-cmd-amber text-[11px] font-bold tabular-nums">
            {pending.length} pending verification
          </span>
        </motion.div>

        {error && (
          <p className="text-xs text-cmd-red bg-cmd-red/[0.08] border border-cmd-red/30 rounded-lg px-3 py-2 break-words">{error}</p>
        )}

        {/* Verification queue */}
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-1">Verification queue</h3>
          <p className="text-xs text-cmd-muted mb-4">Review posting + document, then approve with a role.</p>
          {!users.length && <p className="text-[13px] text-cmd-muted">No accounts yet.</p>}
          <div className="space-y-2.5">
            {users.map((u) => (
              <div key={u.id} className={`rounded-xl border p-3.5 flex flex-wrap items-center gap-3 ${u.status === 'pending' ? 'border-cmd-amber/40 bg-cmd-amber/[0.05]' : 'border-cmd-border'}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-cmd-ink truncate">{u.name} <span className="font-normal text-cmd-muted">• {u.email}</span></p>
                  <p className="text-xs text-cmd-muted mt-0.5">
                    {u.designation || '—'} • {u.phone || 'no phone'} • Posted: <b className="text-cmd-ink/90">{damName(u.dam_id)} ({u.dam_id || '—'})</b>
                  </p>
                </div>
                <span className={`px-2 py-1 rounded-md text-[11px] font-bold uppercase ${u.status === 'approved' ? 'bg-cmd-green/15 text-cmd-green' : u.status === 'rejected' ? 'bg-cmd-red/15 text-cmd-red' : 'bg-cmd-amber/15 text-cmd-amber'}`}>
                  {u.status} • {u.role}
                </span>
                {u.document && (
                  <button onClick={() => viewDoc(u.document!)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-cmd-border text-cmd-muted hover:text-cmd-teal hover:border-cmd-teal/40 text-xs font-semibold">
                    <FileText className="w-3.5 h-3.5" /> Document
                  </button>
                )}
                {u.status === 'pending' && (
                  <>
                    <button disabled={busy === u.id} onClick={() => act(u.id, () => authApi.approve(u.id, 'official'))}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cmd-green/90 hover:bg-cmd-green text-[#071018] text-xs font-bold disabled:opacity-50">
                      <Check className="w-3.5 h-3.5" strokeWidth={2.5} /> Approve
                    </button>
                    <button disabled={busy === u.id} onClick={() => act(u.id, () => authApi.reject(u.id))}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cmd-red/90 hover:bg-cmd-red text-white text-xs font-bold disabled:opacity-50">
                      <X className="w-3.5 h-3.5" strokeWidth={2.5} /> Reject
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Simulations ledger */}
        <div className="cmd-card p-5">
          <h3 className="text-[15px] font-semibold text-cmd-ink mb-1 flex items-center gap-2">
            <FlaskConical className="w-[18px] h-[18px] text-cmd-teal" strokeWidth={1.75} /> Simulations by dam
          </h3>
          <p className="text-xs text-cmd-muted mb-4">Every LISFLOOD-FP job staged on this host, newest first.</p>
          {!sims.length && <p className="text-[13px] text-cmd-muted">No simulations yet.</p>}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-cmd-border">
                  {['Job', 'Dam', 'Status', 'Max depth', 'Cells', 'Elapsed'].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5 text-[11px] font-semibold text-cmd-muted uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sims.map((s) => (
                  <tr key={s.job_id} className="border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03]">
                    <td className="px-3 py-2.5 font-mono text-xs text-cmd-teal">
                      <a href={`/incident?dam=${s.dam_id}&lisflood=1&job=${s.job_id}`} className="hover:underline inline-flex items-center gap-1">
                        {s.job_id} <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-cmd-ink">{s.dam_name} <span className="text-cmd-muted font-mono text-xs">({s.dam_id})</span></td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold uppercase ${s.status === 'done' ? 'bg-cmd-green/15 text-cmd-green' : s.status === 'failed' ? 'bg-cmd-red/15 text-cmd-red' : 'bg-cmd-amber/15 text-cmd-amber'}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-cmd-ink tabular-nums">{s.stats?.max_depth_m != null ? `${Number(s.stats.max_depth_m).toFixed(2)} m` : '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-cmd-ink tabular-nums">{s.stats?.inundated_cells ?? '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-cmd-muted tabular-nums">{s.elapsed_s != null ? `${s.elapsed_s}s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

