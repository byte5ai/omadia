'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

import type { ChatSession } from '../../_lib/chatSessions';
import { agentForToolName, type AgentMeta } from '../../_lib/agentMapping';
import { cn } from '../../_lib/cn';
import { AgentDetailsModal } from './AgentDetailsModal';

interface AgentUsagePillsProps {
  session: ChatSession;
  className?: string;
}

/**
 * Per-session usage strip: one pill per agent that handled at least one
 * tool call, with a request count. Pills are now clickable — clicking one
 * opens AgentDetailsModal with the individual ToolEvents that contributed
 * to the count (input/output/duration/error, per call).
 *
 * Design: solid byte5 brand colours for the pill fill so contrast stays
 * correct in both light AND dark mode (the earlier tint-only variant
 * inherited the outer color-scheme and became hard to read on dark body).
 * Entrance animation uses framer-motion with byte5 easing + staggered
 * children so pills appear gently instead of flashing in.
 */
export function AgentUsagePills({
  session,
  className,
}: AgentUsagePillsProps): React.ReactElement | null {
  const t = useTranslations('agentUsagePills');
  const rows = useMemo(() => aggregate(session), [session]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  if (rows.length === 0) return null;

  const selected =
    rows.find((r) => r.agent.id === selectedAgentId)?.agent ?? null;
  const matchingToolNames = selected
    ? collectToolNames(rows, selected.id)
    : [];

  return (
    <>
      <motion.div
        className={cn(
          'flex flex-wrap items-center gap-1.5',
          className,
        )}
        aria-label={t('ariaLabel')}
        initial="hidden"
        animate="shown"
        variants={LIST_VARIANTS}
      >
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          {t('label')}
        </span>
        <AnimatePresence mode="popLayout">
          {rows.map(({ agent, count }) => (
            <motion.button
              key={agent.id}
              type="button"
              layout
              variants={PILL_VARIANTS}
              initial="hidden"
              animate="shown"
              exit="hidden"
              whileHover={{ y: -1 }}
              whileTap={{ y: 1 }}
              transition={TRANSITION_BASE}
              onClick={() => setSelectedAgentId(agent.id)}
              title={t('pillTitle', { id: agent.id })}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1',
                'text-[11px] font-semibold text-white',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]',
                TONE_CLASS[agent.tone],
              )}
            >
              <span>{agent.label}</span>
              <span
                className={cn(
                  'font-mono-num tabular-nums inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5',
                  'bg-white/25 text-white text-[10px] leading-[1.1rem]',
                )}
              >
                {count}
              </span>
            </motion.button>
          ))}
        </AnimatePresence>
      </motion.div>

      <AgentDetailsModal
        session={session}
        matchingToolNames={matchingToolNames}
        agent={selected}
        onClose={() => setSelectedAgentId(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface AggregateRow {
  agent: AgentMeta;
  /** The specific tool-names that contributed to this agent's count. */
  toolNames: Set<string>;
  count: number;
}

function aggregate(session: ChatSession): AggregateRow[] {
  const counts = new Map<string, AggregateRow>();
  for (const message of session.messages) {
    if (!message.tools) continue;
    for (const tool of message.tools) {
      // Prefer the server-resolved agent attached to the `tool_use` event —
      // the route resolves built-ins and Builder-uploaded agents uniformly.
      // Fall back to the legacy hardcoded table only for sessions persisted
      // before the route started decorating events (older localStorage data).
      const agent: AgentMeta | undefined = tool.agent ?? agentForToolName(tool.name);
      if (!agent) continue;
      const existing = counts.get(agent.id);
      if (existing) {
        existing.count += 1;
        existing.toolNames.add(tool.name);
      } else {
        counts.set(agent.id, {
          agent,
          count: 1,
          toolNames: new Set([tool.name]),
        });
      }
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}

function collectToolNames(rows: AggregateRow[], agentId: string): string[] {
  const row = rows.find((r) => r.agent.id === agentId);
  return row ? Array.from(row.toolNames) : [];
}

// ---------------------------------------------------------------------------
// byte5 brand solid fills — fixed hex so contrast stays correct in dark mode
// ---------------------------------------------------------------------------

const TONE_CLASS: Record<AgentMeta['tone'], string> = {
  cyan:    'bg-[#009FE3] hover:bg-[#0086C0] shadow-[0_6px_16px_rgba(0,159,227,0.25)]',
  navy:    'bg-[#004B73] hover:bg-[#003957] shadow-[0_6px_16px_rgba(0,75,115,0.22)]',
  magenta: 'bg-[#EA5172] hover:bg-[#D43A5C] shadow-[0_6px_16px_rgba(234,81,114,0.25)]',
  warning: 'bg-[#E0A82E] hover:bg-[#C6921F] shadow-[0_6px_16px_rgba(224,168,46,0.25)]',
};

// ---------------------------------------------------------------------------
// Motion — byte5 brand: gentle, never bouncy
// ---------------------------------------------------------------------------

const EASE_OUT: [number, number, number, number] = [0.22, 0.61, 0.36, 1];
const TRANSITION_BASE = { duration: 0.22, ease: EASE_OUT };

const LIST_VARIANTS = {
  hidden: { opacity: 0 },
  shown: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.05,
    },
  },
};

const PILL_VARIANTS = {
  hidden: { opacity: 0, y: 6, scale: 0.96 },
  shown: { opacity: 1, y: 0, scale: 1 },
};
