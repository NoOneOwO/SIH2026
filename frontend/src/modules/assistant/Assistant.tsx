/**
 * AquaShield 3D — AI assistant tab.
 * Dam-aware chatbot (curated KB + optional LLM) and simulation explainer
 * (real result numbers → explanation + phased preparedness plan).
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Send, Bot, User, Sparkles, ChevronDown, Trash2 } from 'lucide-react';
import { INDIA_DAMS } from '../../data/india-dams';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
import { storedToken } from '../../api/client';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  source?: string;
}

async function assistantFetch<T>(path: string, body: any): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = storedToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  else if (import.meta.env.DEV) headers['Authorization'] = 'Bearer dev-token';
  const res = await fetch(`${BASE_URL}/api/v1/assistant${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Assistant error ${res.status}: ${await res.text()}`);
  return res.json();
}

const QUICK = [
  'Tell me everything about Tehri Dam',
  'Compare Bhakra and Sardar Sarovar',
  'Which dams generate the most power?',
  'What does severity band EXTREME mean?',
  'How do I run a breach simulation?',
];

export interface AssistContext {
  dam_id: string;
  dam_name: string;
  kind: 'sandbox' | 'lisflood' | 'impact';
  label: string;
  summary: any;
  impacts: any[];
}

export function readAssistContext(): AssistContext | null {
  try {
    const raw = sessionStorage.getItem('damsafe-assist-context');
    if (!raw) return null;
    const ctx = JSON.parse(raw);
    if (!ctx || !ctx.dam_id) return null;
    return ctx as AssistContext;
  } catch {
    return null;
  }
}

/** One-paragraph measured context attached to every chat message. */
export function contextText(ctx: AssistContext): string {
  // Impact-assessment context: totals + the priority-ordered settlement rows.
  if (ctx.kind === 'impact') {
    const t = ctx.summary ?? {};
    const top = (ctx.impacts ?? []).slice(0, 8);
    const lines = [
      `Active flood-impact assessment: ${ctx.dam_name} (${ctx.dam_id}), case '${ctx.label}'.`,
      `Overall risk ${t.overall_risk ?? '—'}; flooded area ${t.flooded_area_km2 ?? '—'} km²; `,
      `peak depth ${t.peak_depth_m ?? '—'} m; ${t.settlements_inundated ?? 0} settlements inundated, `,
      `${t.settlements_at_risk ?? 0} more at risk; population exposed ${t.population_exposed?.low ?? '—'}–${t.population_exposed?.high ?? '—'}; `,
      `damage estimate ₹${t.damage?.low_inr ?? '—'}–₹${t.damage?.high_inr ?? '—'}; ${t.critical_assets_exposed ?? 0} critical assets exposed.`,
    ];
    if (top.length) {
      lines.push(
        ' Highest-priority locations: ' +
          top
            .map(
              (s: any) =>
                `${s.name} (priority ${s.priority?.band ?? s.risk ?? '—'}, ${s.population_exposed?.mid ?? '—'} exposed` +
                (s.arrival_min != null ? `, arrival T+${Math.round(s.arrival_min)} min` : '') +
                (s.depth_m != null ? `, depth ${s.depth_m} m` : '') +
                ')',
            )
            .join('; ') +
          '.',
      );
    }
    return lines.join('');
  }
  const s = ctx.summary ?? {};
  const wet = (ctx.impacts ?? []).filter((i: any) => (i.arrival_min != null && i.max_depth_m > 0.05) || i.inundated);
  const first = wet
    .filter((i: any) => i.arrival_min != null)
    .sort((a: any, b: any) => a.arrival_min - b.arrival_min)[0];
  return [
    `Active ${ctx.kind} simulation: ${ctx.dam_name} (${ctx.dam_id}), case '${ctx.label}'.`,
    `Severity ${s.severity_band ?? '—'}; peak discharge ${s.peak_discharge_m3s ?? '—'} m³/s; `,
    `flooded ${s.flooded_area_km2 ?? '—'} km²; max depth ${s.max_depth_anywhere_m ?? '—'} m; `,
    `${wet.length} locations wet` + (first ? `; first: ${first.name} at T+${Math.round(first.arrival_min)} min (${first.max_depth_m} m)` : '') + '.',
  ].join('');
}

export default function Assistant() {
  const [damId, setDamId] = useState('d4');
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: 'assistant', text: 'Namaste. I brief dams from a curated knowledge base and explain real simulation outputs with citations — I never invent hydraulic values. Pick a dam, or ask anything.', source: 'knowledge-base' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState('');
  const [explanation, setExplanation] = useState<any | null>(null);
  const [showPlan, setShowPlan] = useState(true);
  const [simCtx, setSimCtx] = useState<AssistContext | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Handoff from a simulation panel (?ctx=1): dam + full results, no dropdowns.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('ctx') !== '1') return;
    const ctx = readAssistContext();
    if (!ctx) return;
    setSimCtx(ctx);
    if (ctx.dam_id) setDamId(ctx.dam_id);
    window.history.replaceState(null, '', '/assistant');
    if (ctx.kind === 'impact') {
      // Impact assessment handoff: the full estimate context rides along with
      // every chat message (contextText); no /explain round trip needed.
      const t = ctx.summary ?? {};
      setMsgs((m) => [...m, {
        role: 'assistant' as const,
        text:
          `I have the full flood-impact assessment for ${ctx.dam_name} attached ` +
          `(case '${ctx.label}': risk ${t.overall_risk ?? '—'}, ${t.settlements_inundated ?? 0} settlements inundated, ` +
          `${t.population_exposed?.low ?? '—'}–${t.population_exposed?.high ?? '—'} people exposed). ` +
          'Ask me where to evacuate first, which towns are worst, or what the numbers mean.',
        source: 'impact-assessment',
      }]);
      return;
    }
    (async () => {
      setBusy(true);
      try {
        const res = await assistantFetch<any>('/explain', {
          kind: ctx.kind === 'lisflood' ? 'lisflood' : 'sandbox',
          job_id: (ctx as any).job_id,
          summary: ctx.kind === 'sandbox'
            ? {
                severity_band: ctx.summary?.severity_band,
                peak_discharge_m3s: ctx.summary?.peak_discharge_m3s,
                flooded_area_km2: ctx.summary?.flooded_area_km2,
                max_depth_anywhere_m: ctx.summary?.max_depth_anywhere_m,
                earliest_asset_arrival_min: ctx.summary?.earliest_asset_arrival_min,
                assets_evaluated: ctx.summary?.assets_evaluated,
                assets_critical: ctx.summary?.assets_critical,
                timesteps: ctx.summary?.timesteps,
              }
            : undefined,
          impacts: ctx.impacts,
        });
        setExplanation(res);
        setMsgs((m) => [...m, {
          role: 'assistant' as const,
          text: `Carrying your ${ctx.dam_name} ${ctx.label} run with me — danger at a glance:\n\n${res.headline}\n\nAsk me anything: arrivals, worst villages, what to do first.`,
          source: res.source,
        }]);
      } catch (e: any) {
        setMsgs((m) => [...m, { role: 'assistant' as const, text: `Context loaded (${ctx.dam_name}), but auto-explain failed: ${e.message}`, source: 'error' }]);
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, busy]);

  const damName = (id: string) => INDIA_DAMS.find((d) => d.id === id)?.name ?? id;

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const res = await assistantFetch<{ reply: string; source: string }>('/chat', {
        message,
        dam_id: simCtx?.dam_id ?? damId ?? null,
        context: simCtx ? contextText(simCtx) : undefined,
      });
      setMsgs((m) => [...m, { role: 'assistant', text: res.reply, source: res.source }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: `Request failed: ${e.message}`, source: 'error' }]);
    } finally {
      setBusy(false);
    }
  }

  async function explainJob() {
    const id = jobId.trim();
    if (!id || busy) return;
    setBusy(true);
    setExplanation(null);
    try {
      const res = await assistantFetch<any>('/explain', { kind: 'lisflood', job_id: id });
      setExplanation(res);
    } catch (e: any) {
      setExplanation({ headline: `Explanation failed: ${e.message}`, bullets: [], reinforcement_plan: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] p-4 md:p-6 grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Chat column */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
          className="lg:col-span-3 cmd-card p-5 flex flex-col min-h-[540px]"
        >
          <div className="flex items-center gap-2.5 mb-1">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cmd-teal/15">
              <Bot className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
            </span>
            <div className="flex-1">
              <p className="text-[15px] font-semibold text-cmd-ink">Dam Assistant</p>
              <p className="text-[11px] text-cmd-muted">Grounded in dam facts + your simulation results</p>
            </div>
            <button onClick={() => setMsgs([])} className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-ink hover:bg-white/[0.06]" title="Clear chat">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {simCtx ? (
            <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-cmd-teal/40 bg-cmd-teal/[0.07] px-3 py-2.5">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cmd-teal opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cmd-teal" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-cmd-ink truncate">
                  Discussing: {simCtx.dam_name} • {simCtx.label} case
                </p>
                <p className="text-[10px] text-cmd-muted truncate">Full results attached — just ask, no setup needed.</p>
              </div>
              <button onClick={() => setSimCtx(null)}
                className="text-[10px] font-bold text-cmd-muted hover:text-cmd-red shrink-0">
                Clear
              </button>
            </div>
          ) : (
            <label className="text-[11px] font-semibold text-cmd-muted mt-3 mb-1">Dam context</label>
          )}
          {!simCtx && (
            <select value={damId} onChange={(e) => setDamId(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-cmd-panel2 border border-cmd-border rounded-lg text-[13px] text-cmd-ink focus:outline-none focus:border-cmd-teal/60">
              <option value="">No specific dam</option>
              {INDIA_DAMS.slice().sort((a, b) => b.height_m - a.height_m).slice(0, 30).map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.state})</option>
              ))}
            </select>
          )}

          <div className="flex-1 min-h-[240px] max-h-[380px] overflow-y-auto space-y-3 my-3 pr-1">
            {msgs.map((m, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {m.role === 'assistant' && (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cmd-teal/15 mt-0.5">
                    <Sparkles className="h-3.5 w-3.5 text-cmd-teal" />
                  </span>
                )}
                <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-cmd-teal/90 text-[#071018] font-medium'
                    : 'border border-cmd-border bg-cmd-panel2/70 text-cmd-ink/90'
                }`}>
                  {m.text}
                  {m.role === 'assistant' && m.source && (
                    <p className="mt-1.5 text-[10px] opacity-60 font-mono">via {m.source}</p>
                  )}
                </div>
                {m.role === 'user' && (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] mt-0.5">
                    <User className="h-3.5 w-3.5 text-cmd-muted" />
                  </span>
                )}
              </motion.div>
            ))}
            {busy && (
              <div className="flex gap-2 items-center text-cmd-muted text-xs">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cmd-teal/15">
                  <Sparkles className="h-3.5 w-3.5 text-cmd-teal animate-pulse" />
                </span>
                Thinking with cited facts…
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {QUICK.map((q) => (
              <button key={q} onClick={() => send(q)}
                className="px-2.5 py-1 rounded-lg border border-cmd-border text-[11px] text-cmd-muted hover:text-cmd-teal hover:border-cmd-teal/40 transition-colors">
                {q}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              placeholder={simCtx ? `Ask about this ${simCtx.dam_name} run…` : damId ? `Ask about ${damName(damId)}…` : 'Ask about any dam…'}
              className="flex-1 px-3.5 py-2.5 bg-cmd-panel border border-cmd-border rounded-lg text-[13px] text-cmd-ink placeholder:text-cmd-muted/60 focus:outline-none focus:border-cmd-teal/60" />
            <button onClick={() => send()} disabled={busy || !input.trim()}
              className="p-2.5 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] transition-colors disabled:opacity-40" title="Send">
              <Send className="w-4 h-4" strokeWidth={2.25} />
            </button>
          </div>
        </motion.div>

        {/* Explainer column */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.08 }}
          className="lg:col-span-2 cmd-card p-5 h-fit"
        >
          <p className="text-[15px] font-semibold text-cmd-ink">Explain a simulation</p>
          <p className="text-[11px] text-cmd-muted mt-0.5 mb-3">Real numbers → plain-language briefing + phased plan</p>
          <div className="flex items-center gap-2">
            <input value={jobId} onChange={(e) => setJobId(e.target.value)}
              placeholder="LISFLOOD job id, e.g. 02f8436ffc8f"
              className="flex-1 px-3 py-2 bg-cmd-panel border border-cmd-border rounded-lg text-xs font-mono text-cmd-ink placeholder:text-cmd-muted/50 focus:outline-none focus:border-cmd-teal/60" />
            <button onClick={explainJob} disabled={busy || !jobId.trim()}
              className="px-3.5 py-2 rounded-lg bg-cmd-teal/90 hover:bg-cmd-teal text-[#071018] text-xs font-bold transition-colors disabled:opacity-40">
              Explain
            </button>
          </div>

          {explanation && (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-cmd-teal/30 bg-cmd-teal/[0.07] p-3.5">
                <p className="text-[13px] font-bold text-cmd-ink leading-snug">{explanation.headline}</p>
                <ul className="mt-2 space-y-1.5">
                  {(explanation.bullets ?? []).map((b: string, i: number) => (
                    <li key={i} className="text-xs text-cmd-ink/85 leading-relaxed">• {b}</li>
                  ))}
                </ul>
              </div>
              {(explanation.reinforcement_plan ?? []).length > 0 && (
                <div>
                  <button onClick={() => setShowPlan(!showPlan)} className="flex items-center gap-1.5 text-xs font-bold text-cmd-ink mb-2">
                    Preparedness plan <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPlan ? '' : '-rotate-90'}`} />
                  </button>
                  {showPlan && (
                    <div className="space-y-2">
                      {explanation.reinforcement_plan.map((p: any, i: number) => (
                        <div key={i} className="rounded-xl border border-cmd-border bg-cmd-panel2/50 p-3">
                          <p className="text-xs font-bold text-cmd-teal">{p.phase}</p>
                          <ul className="mt-1.5 space-y-1">
                            {p.actions.map((a: string, j: number) => (
                              <li key={j} className="text-[11.5px] text-cmd-ink/85 leading-relaxed">• {a}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {explanation.llm_brief && (
                <div className="rounded-xl border border-cmd-border p-3">
                  <p className="text-[11px] font-bold text-cmd-muted mb-1">LLM BRIEF</p>
                  <p className="text-xs text-cmd-ink/85 leading-relaxed whitespace-pre-wrap">{explanation.llm_brief}</p>
                </div>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

