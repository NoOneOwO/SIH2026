/**
 * AquaShield 3D — HeroPanel.
 * Wide command header: mission copy left, aerial dam imagery
 * with dark overlay + readiness status card right.
 *
 * Imagery: public-domain aerial dam photographs via Wikimedia Commons
 * (Mosul Dam aerial for hero). Dark overlay keeps text legible and
 * the panel flat if the image is unavailable.
 */

import { ShieldCheck } from 'lucide-react';

export default function HeroPanel() {
  return (
    <section className="cmd-card relative overflow-hidden">
      {/* Aerial backdrop (right-weighted) */}
      <div className="absolute inset-0" aria-hidden="true">
        <img
          src="/images/dam-hero.jpg"
          alt=""
          className="h-full w-full object-cover object-center"
          loading="eager"
        />
        {/* Dark overlay: full dim + left-weighted gradient into panel tone */}
        <div className="absolute inset-0 bg-[#071018]/55" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#101B23] via-[#101B23]/92 via-40% to-[#101B23]/10" />
        <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#101B23]/70 to-transparent" />
      </div>

      <div className="relative flex flex-col gap-6 p-6 md:p-8 lg:min-h-[248px] lg:flex-row lg:items-center lg:justify-between">
        {/* Mission copy */}
        <div className="max-w-xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cmd-teal">
            Simulate&nbsp;&nbsp;/&nbsp;&nbsp;Plan&nbsp;&nbsp;/&nbsp;&nbsp;Save Lives
          </p>
          <h1 className="mt-3 text-3xl font-bold leading-tight text-white md:text-4xl">
            AquaShield 3D
          </h1>
          <p className="mt-1 text-[15px] font-medium text-cmd-ink/90">
            Dam Break Emergency Action Plan Platform
          </p>
          <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-cmd-muted">
            AI-powered scenario analysis and 3D terrain modelling for faster,
            smarter, and safer disaster response.
          </p>
        </div>

        {/* Readiness status card */}
        <div className="flex items-center gap-3 self-start rounded-xl border border-white/10 bg-[#0B141B]/80 px-5 py-4 backdrop-blur-sm lg:self-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-cmd-teal/15">
            <ShieldCheck className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
          </span>
          <span className="text-[13.5px] font-medium leading-snug text-cmd-ink">
            Prepared Today.
            <br />
            Safer Tomorrow.
          </span>
        </div>
      </div>
    </section>
  );
}

