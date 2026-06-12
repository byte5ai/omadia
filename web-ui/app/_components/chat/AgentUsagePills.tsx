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
          'flex flex-wrap items-center gap-2',
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
                'inline-flex items-center gap-2 rounded-full px-3 py-1',
                'text-[11px] font-semibold',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]',
                TONE_CLASS[agent.tone],
              )}
            >
              <span>{agent.label}</span>
              <span
                className={cn(
                  'font-mono-num tabular-nums inline-flex min-w-[1.25rem] justify-center rounded-full px-2',
                  'bg-[color:var(--accent)] text-[color:var(--accent-fg)] text-[10px] leading-[1.1rem]',
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
// Lume pill fill — single accent material (spec §2.5). Lume has one accent
// slot, so agents differentiate by label, not by hue. Every tone resolves to
// the same accent-subtle chip with an accent-tinted glow on hover; the chip
// follows the active palette + light/dark mode through the token layer.
// ---------------------------------------------------------------------------

const LUME_PILL =
  'bg-[color:var(--accent-subtle)] text-[color:var(--accent)] ' +
  'hover:shadow-[0_0_4px_var(--accent-glow-core),0_4px_12px_var(--accent-glow)]';

const TONE_CLASS: Record<AgentMeta['tone'], string> = {
  cyan: LUME_PILL,
  navy: LUME_PILL,
  magenta: LUME_PILL,
  warning: LUME_PILL,
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
