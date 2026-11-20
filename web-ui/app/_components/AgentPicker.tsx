'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  useAvailableAgents,
  type AgentDirectoryEntry,
  type AvailableAgents,
} from '../_lib/availableAgents';
import { AgentAvatar } from './agents/AgentAvatar';

/**
 * Chat-header agent picker (#2057, spec 2042 §5.3 / §5.9).
 *
 * ALWAYS shown, by name and avatar, never by slug. The choice stays visible for
 * the whole conversation:
 *
 *   - before the first turn with more than one agent: a menu of the agents
 *     available to the person; the default agent is pre-selected and feeds the
 *     first `startTurn({agentSlug})`;
 *   - after the first turn (`pinnedSlug`): the pinned agent, read-only, with a
 *     tooltip explaining how to change it;
 *   - with exactly one agent: that agent, read-only, so the person still sees
 *     who they are talking to;
 *   - with none: a link that sends the operator to `/operator/agents`.
 *
 * The list comes from `useAvailableAgents`, which is the seam for the
 * per-channel availability filter (criterion 40). Pass `availableAgents` to
 * render a list the caller already holds.
 */

export interface AgentPickerProps {
  /** Slug already pinned to the session — makes the picker read-only. */
  pinnedSlug?: string;
  /** Called when the user picks an agent for the upcoming first turn. */
  onSelect: (slug: string | undefined) => void;
  /** Current selection (controlled). Ignored when `pinnedSlug` is set. */
  selectedSlug?: string;
  /** The agents available to this person in this channel. */
  availableAgents?: AvailableAgents;
}

const CHIP_CLASS =
  'inline-flex items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-1 text-xs text-[color:var(--fg)]';

/** The slug to show: pinned, else chosen, else the default, else the first. */
function currentSlugOf(
  props: AgentPickerProps,
  agents: readonly AgentDirectoryEntry[],
  defaultSlug: string | null,
): string | undefined {
  return (
    props.pinnedSlug ??
    props.selectedSlug ??
    defaultSlug ??
    agents[0]?.slug
  );
}

/** A pinned agent that is no longer in the list is still shown, by slug. */
function entryFor(
  slug: string,
  agents: readonly AgentDirectoryEntry[],
): AgentDirectoryEntry {
  return (
    agents.find((a) => a.slug === slug) ?? {
      slug,
      name: slug,
      avatarUrl: null,
      shortDescription: null,
      archetype: 'standard',
      reach: null,
      isDefault: false,
    }
  );
}

interface AgentMenuProps {
  agents: readonly AgentDirectoryEntry[];
  current: AgentDirectoryEntry;
  onSelect: (slug: string) => void;
}

function AgentMenu(props: AgentMenuProps): React.ReactElement {
  const t = useTranslations('agentPicker');
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (slug: string): void => {
    props.onSelect(slug);
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- combobox trigger that opens a listbox, not a §4.2 Button candidate */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${t('label')} ${props.current.name}`}
        onClick={() => setOpen(!open)}
        className={`${CHIP_CLASS} bg-[color:var(--bg-elevated)] hover:border-[color:var(--accent)]`}
      >
        <span className="text-[color:var(--fg-muted)]">{t('label')}</span>
        <AgentAvatar name={props.current.name} url={props.current.avatarUrl} />
        <span className="font-semibold">{props.current.name}</span>
        <span aria-hidden className="text-[color:var(--fg-subtle)]">
          ▾
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('label')}
          className="absolute left-0 top-full z-20 mt-1 min-w-56 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] py-1 shadow-lg"
        >
          {props.agents.map((agent) => (
            <li
              key={agent.slug}
              role="option"
              aria-selected={agent.slug === props.current.slug}
              tabIndex={0}
              onClick={() => choose(agent.slug)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  choose(agent.slug);
                }
              }}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[color:var(--bg-soft)] focus:bg-[color:var(--bg-soft)] aria-selected:font-semibold"
            >
              <AgentAvatar name={agent.name} url={agent.avatarUrl} />
              <span>{agent.name}</span>
              {agent.isDefault && (
                <span className="text-[color:var(--fg-subtle)]">
                  {t('defaultMarker')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AgentPicker(props: AgentPickerProps): React.ReactElement | null {
  const t = useTranslations('agentPicker');
  const { loading, error, agents, defaultSlug } = useAvailableAgents(
    props.availableAgents,
  );
  const { pinnedSlug, selectedSlug, onSelect } = props;

  // Bind the first turn: default agent, or the only agent there is.
  useEffect(() => {
    if (loading || pinnedSlug || selectedSlug) return;
    const initial = defaultSlug ?? (agents.length === 1 ? agents[0]?.slug : undefined);
    if (initial) onSelect(initial);
  }, [loading, agents, defaultSlug, pinnedSlug, selectedSlug, onSelect]);

  // Unknown while loading — render nothing so the picker does not flash.
  if (loading) return null;

  if (error) {
    return (
      <span className="inline-flex text-xs text-[color:var(--danger)]" title={error}>
        {t('error')}
      </span>
    );
  }

  const slug = currentSlugOf(props, agents, defaultSlug);
  if (agents.length === 0 && !pinnedSlug) {
    return (
      <Link
        href="/operator/agents"
        className="inline-flex text-xs text-[color:var(--accent)] underline"
      >
        {t('emptyCta')}
      </Link>
    );
  }
  if (!slug) return null;

  const current = entryFor(slug, agents);
  const isReadOnly = Boolean(pinnedSlug) || agents.length <= 1;
  if (isReadOnly) {
    return (
      <span
        className={CHIP_CLASS}
        title={pinnedSlug ? t('pinnedTooltip') : t('onlyAgentTooltip')}
      >
        <span className="text-[color:var(--fg-muted)]">{t('label')}</span>
        <AgentAvatar name={current.name} url={current.avatarUrl} />
        <span className="font-semibold">{current.name}</span>
      </span>
    );
  }

  return (
    <AgentMenu
      agents={agents}
      current={current}
      onSelect={(next) => onSelect(next)}
    />
  );
}
