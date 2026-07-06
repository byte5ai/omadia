'use client';

import { useTranslations } from 'next-intl';

import type { AgentConsultation } from '../../_lib/chatSessions';

interface AgentsConsultedFooterProps {
  agents: AgentConsultation[];
  className?: string;
}

/**
 * #332 Layer 1 (gap-closure) — compact, tamper-evident footer showing which
 * sub-agent(s) were actually consulted this turn. Harness-sourced from the
 * deterministic run-trace (`Message.agentsConsulted`), never from the
 * orchestrator's own prose — a fabricated "I asked X" with no real
 * invocation never reaches this component (the parent renders nothing when
 * `agentsConsulted` is empty/undefined).
 *
 * Mirrors the plain-text fallback (`🔎 Consulted: X ✓ · N steps`) that
 * channel-sdk provides for connectors without rich UI, but as chips so it
 * reads well inline with the rest of the message chrome.
 */
export function AgentsConsultedFooter({
  agents,
  className,
}: AgentsConsultedFooterProps): React.ReactElement | null {
  const t = useTranslations('directLine');
  if (agents.length === 0) return null;

  return (
    <div
      className={[
        'mt-2 flex flex-wrap items-center gap-1.5 text-[11px]',
        className ?? '',
      ].join(' ')}
    >
      <span className="text-[color:var(--fg-subtle)]">
        {t('consultedLabel')}
      </span>
      {agents.map((a, i) => (
        <span
          key={`${a.agentId ?? a.label}-${String(i)}`}
          className={[
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1',
            a.status === 'success'
              ? 'text-[color:var(--success)] ring-[color:var(--success)]/40'
              : 'text-[color:var(--danger)] ring-[color:var(--danger-edge)]',
          ].join(' ')}
        >
          <span className="font-medium">{a.label}</span>
          <span aria-hidden="true">{a.status === 'success' ? '✓' : '✗'}</span>
          {typeof a.toolCalls === 'number' && a.toolCalls > 0 && (
            <span className="text-[color:var(--fg-subtle)]">
              · {t('stepsCount', { count: a.toolCalls })}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
