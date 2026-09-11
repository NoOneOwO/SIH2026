/**
 * DamSafe Twin — official registration.
 * Collects identity + posting + dam assignment + verification document.
 * Accounts start `pending` until an admin verifies the document.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { ShieldCheck, UploadCloud, CheckCircle } from 'lucide-react';
import { authApi } from '../api/auth';
import { INDIA_DAMS } from '../data/india-dams';

export default function Register() {
  const navigate = useNavigate();
  const [damIds, setDamIds] = useState<string[]>([]);
  const [form, setForm] = useState({
    name: '', email: '', password: '', phone: '', designation: '', dam_id: 'd16',
  });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/terrain/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m) {
          const ids = Object.keys(m);
          setDamIds(ids);
          setForm((f) => ({ ...f, dam_id: ids.includes('d16') ? 'd16' : ids[0] ?? '' }));
        }
      })
      .catch(() => setDamIds(INDIA_DAMS.slice(0, 30).map((d) => d.id)));
  }, []);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const damName = (id: string) => INDIA_DAMS.find((d) => d.id === id)?.name ?? id;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!file) {
      setError('Attach your identity/posting document (PDF, JPG or PNG, ≤ 10 MB).');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('name', form.name);
      fd.append('email', form.email);
      fd.append('password', form.password);
      fd.append('phone', form.phone);
      fd.append('designation', form.designation);
      fd.append('dam_id', form.dam_id);
      fd.append('document', file);
      const res = await authApi.register(fd);
      setDone(res.message || 'Registration received — pending admin verification.');
      setTimeout(() => navigate('/login', { replace: true }), 2600);
    } catch (err: any) {
      setError(err.message ?? 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full px-3.5 py-2.5 bg-cmd-panel border border-cmd-border rounded-lg text-sm text-cmd-ink placeholder:text-cmd-muted/50 focus:outline-none focus:border-cmd-teal/60';

  return (
    <div className="min-h-screen bg-cmd-bg text-cmd-ink flex items-center justify-center p-6 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-[560px] cmd-card p-7 my-8"
        style={{ boxShadow: '0 0 40px -14px rgba(101,191,169,0.35)' }}
      >
        <div className="flex items-center gap-3 mb-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-cmd-border bg-cmd-panel2">
            <ShieldCheck className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
          </span>
          <div>
            <p className="text-base font-semibold">Official registration</p>
            <p className="text-xs text-cmd-muted">Verified access for posted dam officials</p>
          </div>
        </div>
        <p className="text-xs text-cmd-muted mb-5 leading-relaxed">
          Simulations you run are scoped to your posted dam. An administrator verifies
          your document before activation — usually within one working day.
        </p>

        {done ? (
          <div className="rounded-xl border border-cmd-green/30 bg-cmd-green/[0.08] p-4 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-cmd-green shrink-0 mt-0.5" strokeWidth={1.75} />
            <div>
              <p className="text-sm font-bold text-cmd-ink">Registration received</p>
              <p className="text-xs text-cmd-muted mt-1">{done} Redirecting to sign in…</p>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <label className="block text-xs font-medium text-cmd-muted">Full name *
              <input required value={form.name} onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. R. K. Sharma" className={`${inputCls} mt-1`} />
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Official email *
              <input required type="email" value={form.email} onChange={(e) => set('email', e.target.value)}
                placeholder="you@gov.in" className={`${inputCls} mt-1`} autoComplete="username" />
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Password (8+ chars) *
              <input required type="password" minLength={8} value={form.password} onChange={(e) => set('password', e.target.value)}
                placeholder="••••••••" className={`${inputCls} mt-1`} autoComplete="new-password" />
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Phone
              <input value={form.phone} onChange={(e) => set('phone', e.target.value)}
                placeholder="+91 …" className={`${inputCls} mt-1`} />
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Posting / designation *
              <input required value={form.designation} onChange={(e) => set('designation', e.target.value)}
                placeholder="e.g. Executive Engineer, Dam Safety" className={`${inputCls} mt-1`} />
            </label>
            <label className="block text-xs font-medium text-cmd-muted">Posted dam *
              <select value={form.dam_id} onChange={(e) => set('dam_id', e.target.value)} className={`${inputCls} mt-1`}>
                {damIds.map((id) => (
                  <option key={id} value={id}>{damName(id)} ({id})</option>
                ))}
              </select>
            </label>
            <label className="sm:col-span-2 block text-xs font-medium text-cmd-muted">
              Verification document * <span className="font-normal">(ID card / posting order — PDF, JPG, PNG ≤ 10 MB)</span>
              <span className={`mt-1 flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border border-dashed cursor-pointer transition-colors ${file ? 'border-cmd-teal/50 bg-cmd-teal/[0.06]' : 'border-cmd-border hover:border-cmd-teal/40'}`}>
                <UploadCloud className="w-4 h-4 text-cmd-teal shrink-0" strokeWidth={1.75} />
                <span className="truncate text-cmd-ink">{file ? file.name : 'Choose file…'}</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </span>
            </label>
            {error && (
              <p className="sm:col-span-2 text-xs text-cmd-red bg-cmd-red/[0.08] border border-cmd-red/30 rounded-lg px-3 py-2 break-words">{error}</p>
            )}
            <button type="submit" disabled={busy}
              className="sm:col-span-2 px-4 py-2.5 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-sm font-bold transition-colors disabled:opacity-50">
              {busy ? 'Submitting…' : 'Submit for verification'}
            </button>
          </form>
        )}

        <p className="mt-5 text-center text-xs text-cmd-muted">
          Already verified? <Link to="/login" className="font-bold text-cmd-teal hover:underline">Sign in</Link>
          {' · '}<Link to="/" className="hover:text-cmd-ink">Portal home</Link>
        </p>
      </motion.div>
    </div>
  );
}
