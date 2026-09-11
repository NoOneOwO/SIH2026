/**
 * AquaShield 3D — QuickAction.
 * Operational tool entry: tinted icon tile, title, description,
 * chevron affordance. Flat panel, no gradient buttons.
 */

import { ChevronRight } from 'lucide-react';

export type ActionTone = 'teal' | 'red' | 'green' | 'slateblue';

const TONE_STYLES: Record<ActionTone, string> = {
  teal: 'bg-cmd-teal/15 text-cmd-teal',
  red: 'bg-cmd-red/15 text-cmd-red',
  green: 'bg-cmd-green/15 text-cmd-green',
  slateblue: 'bg-cmd-slateblue/15 text-cmd-slateblue',
};

interface QuickActionProps {
  icon: typeof ChevronRight;
  title: string;
  description: string;
  tone: ActionTone;
  onClick: () => void;
}

export default function QuickAction({ icon: Icon, title, description, tone, onClick }: QuickActionProps) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-xl border border-cmd-border bg-cmd-panel2/60 p-4 text-left transition-colors hover:border-cmd-teal/40 hover:bg-cmd-panel2"
    >
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${TONE_STYLES[tone]}`}>
        <Icon className="h-[22px] w-[22px]" strokeWidth={1.5} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-cmd-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-cmd-muted">{description}</span>
      </span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-cmd-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cmd-teal"
        strokeWidth={2}
      />
    </button>
  );
}

