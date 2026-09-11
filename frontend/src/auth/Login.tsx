/**
 * AquaShield 3D — official sign in.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { ShieldCheck, LogIn, KeyRound } from 'lucide-react';
import { useAuth } from './AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate('/dashboard', { replace: true });
    } catch (err: any) {
      setError(err.message ?? 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  async function devLogin() {
    setError('');
    setBusy(true);
    try {
      await login('admin@damsafe.local', 'ChangeMe123!');
      navigate('/admin', { replace: true });
    } catch (err: any) {
      setError(err.message ?? 'Dev login failed (seed admin password may have changed)');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full px-3.5 py-2.5 bg-cmd-panel border border-cmd-border rounded-lg text-sm text-cmd-ink placeholder:text-cmd-muted/50 focus:outline-none focus:border-cmd-teal/60';

  return (
    <div className="min-h-screen bg-cmd-bg text-cmd-ink flex items-center justify-center p-6 overflow-y-auto relative">
      {/* One-click testing login (seed admin) */}
      <button onClick={devLogin} disabled={busy} title="Sign in instantly as the seed admin (for testing)"
        className="absolute top-4 right-4 flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-cmd-amber/40 bg-cmd-amber/[0.08] text-cmd-amber text-xs font-bold hover:bg-cmd-amber/[0.15] transition-colors disabled:opacity-50">
        <KeyRound className="w-3.5 h-3.5" strokeWidth={2} /> Dev admin login
      </button>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-[420px] cmd-card p-7"
        style={{ boxShadow: '0 0 40px -14px rgba(101,191,169,0.35)' }}
      >
        <div className="flex items-center gap-3 mb-6">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-cmd-border bg-cmd-panel2">
            <ShieldCheck className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
          </span>
          <div>
            <p className="text-base font-semibold">Official sign in</p>
            <p className="text-xs text-cmd-muted">AquaShield 3D operations portal</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          <label className="block text-xs font-medium text-cmd-muted">Official email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@gov.in" className={`${inputCls} mt-1`} autoComplete="username" />
          </label>
          <label className="block text-xs font-medium text-cmd-muted">Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••" className={`${inputCls} mt-1`} autoComplete="current-password" />
          </label>
          {error && (
            <p className="text-xs text-cmd-red bg-cmd-red/[0.08] border border-cmd-red/30 rounded-lg px-3 py-2 break-words">{error}</p>
          )}
          <button type="submit" disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-sm font-bold transition-colors disabled:opacity-50">
            <LogIn className="w-4 h-4" strokeWidth={2.25} /> {busy ? 'Verifying…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-cmd-muted">
          Posted on a dam and need access?{' '}
          <Link to="/register" className="font-bold text-cmd-teal hover:underline">Register here</Link>
        </p>
        <p className="mt-2 text-center text-[11px] text-cmd-muted/70">
          <Link to="/" className="hover:text-cmd-ink">← Back to portal home</Link>
        </p>
      </motion.div>
    </div>
  );
}

