/**
 * AquaShield 3D — Sandbox handoff card.
 *
 * Compact, non-blocking status card docked bottom-left while the sandbox
 * engine pre-computes the likely case in the background. No backdrop blur,
 * no fullscreen veil — the terrain stays fully visible and interactive.
 * Runs long on purpose (~13 s): the "AI is thinking" phase covers real
 * generate + run calls fired the moment Run Sandbox was clicked.
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, Loader2, Waves, BrainCircuit } from 'lucide-react';

const STEPS = [
  { label: 'Loading dam terrain', detail: 'Copernicus DEM → cached simulation domain' },
  { label: 'AI is thinking — breach geometry', detail: 'Comparing best / likely / worst parameter sets' },
  { label: 'Preparing simulation domain', detail: 'Resampling elevation grid, filling NoData' },
  { label: 'AI is thinking — hydrograph', detail: 'Weir-growth discharge over formation time' },
  { label: 'Computing breach hydrograph', detail: 'Discharge series, peak and volume' },
  { label: 'AI is thinking — propagation', detail: 'Testing valley routes cell by cell' },
  { label: 'Running inundation model', detail: 'Terrain-constrained propagation, timestep by timestep' },
  { label: 'Calculating flood consequences', detail: 'Arrival, depth, assets & priority zones' },
];

const STEP_MS = 1500;

interface SandboxTransitionProps {
  damName: string;
  /** Preloaded results landed — finish early instead of playing all steps. */
  ready: boolean;
  onDone: () => void;
}

export default function SandboxTransition({ damName, ready, onDone }: SandboxTransitionProps) {
  const [active, setActive] = useState(0);
  const [minDone, setMinDone] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // Minimum card time so the handoff reads even on a cached fast run.
  useEffect(() => {
    const t = setTimeout(() => setMinDone(true), 3000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (active >= STEPS.length || (ready && minDone)) {
      const t = setTimeout(() => doneRef.current(), 700);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setActive((a) => a + 1), active === 0 ? 1000 : STEP_MS);
    return () => clearTimeout(t);
  }, [active, ready, minDone]);

  const progress = Math.min(100, Math.round((active / STEPS.length) * 100));
  const current = STEPS[Math.min(active, STEPS.length - 1)];
  const thinking = active < STEPS.length && current.label.startsWith('AI is thinking');

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="absolute left-3 bottom-3 z-30 w-[330px] pointer-events-none"
    >
      <div
        className="rounded-2xl border border-cmd-border bg-[#0A1218]/92 backdrop-blur-sm p-4"
        style={{ boxShadow: '0 8px 32px -8px rgba(0,0,0,0.6), 0 0 24px -10px rgba(101,191,169,0.35)' }}
      >
        <div className="flex items-center gap-2.5 mb-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cmd-teal/15 shrink-0">
            <Waves className="h-4 w-4 text-cmd-teal" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-cmd-ink truncate">AI Simulation Sandbox</p>
            <p className="text-[10px] text-cmd-muted truncate">{damName}</p>
          </div>
          <span className="text-[11px] font-bold text-cmd-teal tabular-nums shrink-0">{progress}%</span>
        </div>

        {/* Big thinking label while the engine works */}
        <div className={`flex items-center gap-2 rounded-lg px-2.5 py-2 mb-3 border ${
          thinking || active < STEPS.length
            ? 'border-cmd-teal/40 bg-cmd-teal/[0.08]'
            : 'border-cmd-green/40 bg-cmd-green/[0.08]'
        }`}>
          <span className="relative flex h-2 w-2 shrink-0">
            {active < STEPS.length ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cmd-teal opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cmd-teal" />
              </>
            ) : (
              <Check className="w-3.5 h-3.5 text-cmd-green" strokeWidth={2.5} />
            )}
          </span>
          <p className="text-[11px] font-bold tracking-wide text-cmd-ink">
            {active < STEPS.length ? 'AI IS THINKING' : 'READY'}
          </p>
          <BrainCircuit className="w-3.5 h-3.5 text-cmd-teal ml-auto shrink-0" strokeWidth={1.75} />
        </div>

        <div className="flex items-center gap-2.5 rounded-lg border border-cmd-border/70 bg-cmd-panel px-2.5 py-2 mb-3 min-h-[44px]">
          {active < STEPS.length ? (
            <Loader2 className="w-4 h-4 text-cmd-teal animate-spin shrink-0" />
          ) : (
            <Check className="w-4 h-4 text-cmd-green shrink-0" strokeWidth={2.5} />
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-cmd-ink truncate">
              {active < STEPS.length ? current.label : 'Likely case ready'}
            </p>
            {active < STEPS.length && (
              <p className="text-[10px] text-cmd-muted truncate">{current.detail}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.label}
              className={`h-1 flex-1 rounded-full ${i < active ? 'bg-cmd-teal' : i === active ? 'bg-cmd-teal/50' : 'bg-cmd-track'}`}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

