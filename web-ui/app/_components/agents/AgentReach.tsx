'use client';

import { ShieldAlert } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import type { AgentReachDto } from '../../_lib/agents';

/**
 * #2054 — spec 2042 §5.7: the reach of an agent, every connected system it
 * can read or write through its grants, read and write marked separately.
 * Computed by the middleware from the agent's plugin and MCP grants; this
 * only renders it.
 */

/** One line for the agent directory. */
export function AgentReachSummary({
  reach,
}: {
  reach: AgentReachDto | null | undefined;
}): React.ReactElement | null {
  const t = useTranslations('agentReach');
  if (reach === undefined) return null;
  if (reach === null) {
    return <span className="block text-xs text-[color:var(--fg-muted)]">{t('unavailable')}</span>;
  }
  const reads = reach.systems.filter((s) => s.read).length;
  const writes = reach.systems.filter((s) => s.write).length;
  return (
    <span
      data-testid="agent-reach-summary"
      className={`block text-xs ${reach.broad ? 'text-[color:var(--danger)]' : 'text-[color:var(--fg-muted)]'}`}
    >
      {reach.systems.length === 0
        ? t('summaryNone')
        : t('summary', {
            count: reach.systems.length,
            total: reach.connected_systems,
            reads,
            writes,
          })}
      {reach.broad ? ` · ${t('broadBadge')}` : ''}
    </span>
  );
}

/** The full list for the agent page and the expanded directory card. */
export function AgentReachPanel({
  reach,
}: {
  reach: AgentReachDto | null | undefined;
}): React.ReactElement {
  const t = useTranslations('agentReach');
  const format = useFormatter();
  return (
    <section
      data-testid="agent-reach"
      className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4"
    >
      <h2 className="mb-1 text-lg font-medium">{t('heading')}</h2>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>
      {reach === null || reach === undefined ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('unavailable')}</p>
      ) : (
        <>
          {reach.broad ? (
            <p
              role="note"
              className="mb-3 flex items-start gap-2 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 px-3 py-2 text-xs text-[color:var(--danger)]"
            >
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t('broadWarning')}
            </p>
          ) : null}
          {reach.systems.length === 0 ? (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {reach.systems.map((system) => {
                const viaPlugins = system.via.filter((v) => v !== 'grant');
                return (
                  <li
                    key={system.key}
                    className="flex flex-wrap items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-1.5 text-sm"
                  >
                    <span className="font-medium">{system.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-[color:var(--fg-muted)]">
                      {system.type === 'plugin' ? t('typePlugin') : t('typeMcp')}
                    </span>
                    {viaPlugins.length > 0 ? (
                      <span className="text-xs text-[color:var(--fg-muted)]">
                        {t('viaPlugins', { plugins: format.list(viaPlugins) })}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1.5 text-xs">
                      <AccessChip on={system.read} label={t('read')} />
                      <AccessChip on={system.write} label={t('write')} />
                    </span>
                    {!system.declared ? (
                      <span className="basis-full text-[11px] text-[color:var(--fg-muted)]">
                        {t('undeclared')}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {reach.credential_hosts && reach.credential_hosts.length > 0 ? (
            <div data-testid="agent-reach-credentials" className="mt-3">
              <h3 className="mb-1 text-sm font-medium">{t('credentialsHeading')}</h3>
              <ul className="space-y-1">
                {reach.credential_hosts.map((c) => (
                  <li key={c.credential_id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="type-mono-data text-xs text-[color:var(--fg-muted)]">
                      {c.host ?? t('credentialNoHost')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-[color:var(--fg-muted)]">
            {t('connected', { count: reach.connected_systems })}
          </p>
        </>
      )}
    </section>
  );
}

function AccessChip({ on, label }: { on: boolean; label: string }): React.ReactElement {
  return (
    <span
      className={`rounded px-1.5 py-0.5 ${
        on
          ? 'bg-[color:var(--accent)]/15 text-[color:var(--fg)]'
          : 'text-[color:var(--fg-muted)] line-through opacity-60'
      }`}
    >
      {label}
    </span>
  );
}
