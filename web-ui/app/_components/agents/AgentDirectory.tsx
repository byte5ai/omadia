'use client';

import { useTranslations } from 'next-intl';

import {
  isSeededAgentDescription,
  FACILITATOR_ARCHETYPE,
  STANDARD_ARCHETYPE,
} from '../../_lib/agents';
import {
  useAvailableAgents,
  type AgentDirectoryEntry,
  type AvailableAgents,
} from '../../_lib/availableAgents';
import { AgentAvatar } from './AgentAvatar';

/**
 * Agent directory (#2057, spec 2042 §5.3): every agent available to the person
 * in this channel, with name, avatar, short description, archetype and reach.
 *
 * It shows only what the list reports. A description or a reach the middleware
 * does not deliver (yet) is left out — nothing is invented. The list comes from
 * `useAvailableAgents`, the same seam the picker uses, so availability
 * (criterion 40) is filtered in one place. Pass `availableAgents` to render a
 * list the caller already holds.
 */

export interface AgentDirectoryProps {
  availableAgents?: AvailableAgents;
  /** Display names for archetype ids an archetype plugin delivers
   *  (`facilitator` → "Facilitator"); an unknown id is shown as it is. */
  archetypeLabels?: Readonly<Record<string, string>>;
}

function AgentCard(props: {
  agent: AgentDirectoryEntry;
  archetypeLabel: string;
}): React.ReactElement {
  const t = useTranslations('agentDirectory');
  const { agent } = props;
  const description = isSeededAgentDescription(agent.shortDescription)
    ? t('seededDescription')
    : agent.shortDescription;

  return (
    <li
      data-testid={`agent-card-${agent.slug}`}
      className="flex gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4"
    >
      <AgentAvatar name={agent.name} url={agent.avatarUrl} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-[color:var(--fg)]">
            {agent.name}
          </h3>
          {agent.isDefault && (
            <span className="rounded-full bg-[color:var(--bg-soft)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)]">
              {t('defaultBadge')}
            </span>
          )}
          <span className="rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)]">
            {props.archetypeLabel}
          </span>
        </div>
        {description && (
          <p className="mt-1 text-xs text-[color:var(--fg)]">{description}</p>
        )}
        {agent.reach && agent.reach.length > 0 && (
          <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
            <span className="font-medium">{t('reach')}</span>{' '}
            {agent.reach.join(', ')}
          </p>
        )}
      </div>
    </li>
  );
}

export function AgentDirectory(props: AgentDirectoryProps): React.ReactElement | null {
  const t = useTranslations('agentDirectory');
  const { loading, error, agents } = useAvailableAgents(props.availableAgents);

  const archetypeLabel = (id: string): string => {
    const custom = props.archetypeLabels?.[id];
    if (custom) return custom;
    if (id === STANDARD_ARCHETYPE) return t('archetypeStandard');
    if (id === FACILITATOR_ARCHETYPE) return t('archetypeFacilitator');
    return id;
  };

  if (loading) return null;
  if (error) {
    return (
      <p role="alert" className="text-sm text-[color:var(--danger)]" title={error}>
        {t('error')}
      </p>
    );
  }
  if (agents.length === 0) {
    return <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>;
  }

  return (
    <section aria-labelledby="agent-directory-heading">
      <h2
        id="agent-directory-heading"
        className="mb-3 text-lg font-medium text-[color:var(--fg)]"
      >
        {t('heading')}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {agents.map((agent) => (
          <AgentCard
            key={agent.slug}
            agent={agent}
            archetypeLabel={archetypeLabel(agent.archetype)}
          />
        ))}
      </ul>
    </section>
  );
}
