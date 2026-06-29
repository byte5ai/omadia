'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  listEnabledAgents,
  type EnabledAgentDto,
} from '../_lib/agents';

/**
 * Phase A — chat-header Agent picker.
 *
 * Before the first turn of a session: dropdown of enabled Agents,
 * fallback pre-selected. The selected slug feeds the first
 * `startTurn({agentSlug})` call; the server pins the snapshot and
 * subsequent turns reuse the pin.
 *
 * After the first turn (`pinnedSlug` prop set): read-only label
 * "Agent: <slug>" with a tooltip explaining how to change it.
 *
 * Empty-config UX (TA07): when the endpoint returns zero enabled
 * Agents AND no fallback, render a small CTA pointing the operator at
 * `/operator/agents` instead of an empty dropdown that 412s every turn.
 */

export interface AgentPickerProps {
  /** Slug already pinned to the session — turns the picker into a
   *  read-only label. */
  pinnedSlug?: string;
  /** Called when the user picks an Agent for the upcoming first turn. */
  onSelect: (slug: string | undefined) => void;
  /** Current selection (controlled). When `pinnedSlug` is set this is
   *  ignored. */
  selectedSlug?: string;
}

interface LoadState {
  loading: boolean;
  agents: EnabledAgentDto[];
  fallbackSlug: string | null;
  error: string | null;
}

export function AgentPicker(props: AgentPickerProps): React.ReactElement | null {
  const t = useTranslations('agentPicker');
  const [state, setState] = useState<LoadState>({
    loading: true,
    agents: [],
    fallbackSlug: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    listEnabledAgents()
      .then((data) => {
        if (cancelled) return;
        setState({
          loading: false,
          agents: data.agents,
          fallbackSlug: data.fallback_slug,
          error: null,
        });
        // Auto-select the fallback on first load when nothing else is
        // chosen yet AND we're not already pinned.
        if (
          !props.pinnedSlug &&
          !props.selectedSlug &&
          data.fallback_slug
        ) {
          props.onSelect(data.fallback_slug);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          agents: [],
          fallbackSlug: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pinnedSlug]);

  // While loading we don't yet know the orchestrator count — render nothing
  // so the picker doesn't flash for the common single-orchestrator case.
  if (state.loading) return null;

  if (state.error) {
    return (
      <span className="inline-flex text-xs text-[color:var(--danger)]" title={state.error}>
        {t('error')}
      </span>
    );
  }

  // Only surface the picker when the operator actually has a choice to make:
  // more than one orchestrator. A lone fallback (or none) is just noise, so
  // the picker — dropdown and read-only pinned label alike — stays hidden.
  // The fallback is still auto-selected in the effect above, so the first
  // turn binds correctly even with no UI.
  if (state.agents.length <= 1) return null;

  // Pinned → read-only label (only reached when more than one orchestrator
  // exists, i.e. the binding is a real choice worth showing).
  if (props.pinnedSlug) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-1 font-mono text-xs text-[color:var(--fg)]"
        title={t('pinnedTooltip')}
      >
        <span className="text-[color:var(--fg-muted)]">{t('label')}</span>
        <span className="font-semibold">{props.pinnedSlug}</span>
      </span>
    );
  }

  return (
    <label className="inline-flex items-center gap-2 text-xs">
      <span className="text-[color:var(--fg-muted)]">{t('label')}</span>
      <select
        className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1 font-mono text-xs"
        value={props.selectedSlug ?? state.fallbackSlug ?? ''}
        onChange={(e) =>
          props.onSelect(e.target.value === '' ? undefined : e.target.value)
        }
      >
        {state.agents.map((a) => (
          <option key={a.slug} value={a.slug}>
            {a.slug}
            {a.is_fallback ? ` ${t('fallbackMarker')}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
