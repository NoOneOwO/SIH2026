/**
 * DamSafe Twin — public landing (pre-auth).
 * Verifies the portal's purpose, then routes officials to login/register.
 */

import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { ShieldCheck, Waves, BrainCircuit, FileCheck, ChevronRight } from 'lucide-react';

export default function Landing() {
  return (
    <div className="min-h-screen bg-cmd-bg text-cmd-ink overflow-y-auto">
      {/* Top strip */}
      <header className="border-b border-cmd-border">
        <div className="mx-auto max-w-[1200px] px-6 h-16 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-cmd-border bg-cmd-panel2">
            <ShieldCheck className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
          </span>
          <div>
            <p className="text-[15px] font-semibold leading-tight">DamSafe Twin</p>
            <p className="text-[11px] text-cmd-muted">Dam Break Emergency Action Plan Platform</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/login" className="px-4 py-2 rounded-lg text-[13px] font-semibold text-cmd-muted hover:text-cmd-ink transition-colors">
              Sign in
            </Link>
            <Link to="/register" className="px-4 py-2 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-[13px] font-bold transition-colors">
              Register
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-cmd-border">
        <img src="/images/dam-hero.jpg" alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#071018] via-[#071018]/85 to-[#071018]/30" />
        <div className="relative mx-auto max-w-[1200px] px-6 py-20 md:py-28">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-cmd-teal">
              Simulate&nbsp;&nbsp;/&nbsp;&nbsp;Plan&nbsp;&nbsp;/&nbsp;&nbsp;Save Lives
            </p>
            <h1 className="mt-4 max-w-2xl text-4xl md:text-5xl font-bold leading-tight">
              Dam-break readiness, modelled on your dam's own terrain.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-cmd-muted">
              DamSafe Twin runs real LISFLOOD-FP hydraulic simulations over surveyed
              terrain, then turns depth and arrival grids into evacuation priorities,
              alerts and EAP reports — a decision-support prototype for dam officials.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link to="/register" className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-sm font-bold transition-colors">
                Register as dam official <ChevronRight className="h-4 w-4" strokeWidth={2.25} />
              </Link>
              <Link to="/login" className="px-5 py-2.5 rounded-lg border border-cmd-border text-sm font-semibold text-cmd-ink hover:border-cmd-teal/50 transition-colors">
                Official sign in
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Verification strip */}
      <section className="mx-auto max-w-[1200px] px-6 py-14">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { icon: FileCheck, title: 'Verified postings', text: 'Registration needs your posting, dam assignment and an identity document. An admin verifies every account before activation.' },
            { icon: Waves, title: 'Your dam, simulated', text: 'Water simulation runs on your posted dam. You can still view every other dam and ask the assistant about any of them.' },
            { icon: BrainCircuit, title: 'Assistant that cites numbers', text: 'The chatbot briefs dams from a curated knowledge base and explains real simulation outputs — never invented hydraulics.' },
          ].map(({ icon: Icon, title, text }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.08 }}
              className="cmd-card p-5"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-cmd-teal/15 mb-3">
                <Icon className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
              </span>
              <p className="text-[15px] font-semibold">{title}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-cmd-muted">{text}</p>
            </motion.div>
          ))}
        </div>
        <p className="mt-10 text-center text-xs text-cmd-muted">
          Restricted portal for dam officials and administrators. All activity is audit-logged.
        </p>
      </section>
    </div>
  );
}
