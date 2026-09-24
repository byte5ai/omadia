'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/**
 * Phase A / TA08 — recovery banner for `agent_unavailable` (HTTP 503).
 *
 * Lands when the session's pinned Agent was deleted or disabled. Two
 * actions:
 *
 *   - Re-bind to fallback: POST /bot-api/chat/sessions/:id/re-snapshot
 *     (clears the pinned snapshot; next turn re-captures from the
 *     current registry — typically the fallback Agent).
 *   - Delete session: DELETE /bot-api/chat/sessions/:id (drops the
 *     session entirely).
 *
 * OM-76 — a SECOND cause reuses this banner: `no_agents_active`. There is no
 * orchestrator at all (fresh install, no LLM provider assigned). "Re-bind to
 * default" would rebind to the very thing that is missing and 503 again, so
 * that state hides both actions and links to LLM access instead.
 */

export interface AgentUnavailableBannerProps {
  sessionId: string;
  unavailableSlug: string;
  onRecovered: () => void;
  onDeleted: () => void;
  /** OM-76 — default `agent_unavailable` keeps the original two-action UI. */
  reason?: 'agent_unavailable' | 'no_agents_active';
}

export function AgentUnavailableBanner(
  props: AgentUnavailableBannerProps,
): React.ReactElement {
  const t = useTranslations('agentPicker');
  const [busy, setBusy] = useState<'re-snapshot' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // OM-76 — "there is no orchestrator": no re-bind, just a route to the fix.
  if (props.reason === 'no_agents_active') {
    return (
      <div className="mx-auto mt-4 max-w-4xl rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-4 text-sm text-[color:var(--warning)]">
        <p className="font-medium">{t('noAgentsTitle')}</p>
        <p className="mt-1 text-[color:var(--warning)]">{t('noAgentsBody')}</p>
        <div className="mt-3">
          <Link
            href="/admin/providers"
            className="inline-block rounded border border-[color:var(--warning)] bg-[color:var(--bg-elevated)] px-3 py-1 text-xs font-medium text-[color:var(--warning)] hover:bg-[color:var(--warning)]/10"
          >
            {t('actionOpenLlmAccess')}
          </Link>
        </div>
      </div>
    );
  }

  async function reSnapshot(): Promise<void> {
    setBusy('re-snapshot');
    setError(null);
    try {
      const res = await fetch(
        `/bot-api/chat/sessions/${encodeURIComponent(props.sessionId)}/re-snapshot`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
      props.onRecovered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteSession(): Promise<void> {
    setBusy('delete');
    setError(null);
    try {
      const res = await fetch(
        `/bot-api/chat/sessions/${encodeURIComponent(props.sessionId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
      props.onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto mt-4 max-w-4xl rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-4 text-sm text-[color:var(--warning)]">
      <p className="font-medium">{t('unavailableTitle')}</p>
      <p className="mt-1 text-[color:var(--warning)]">
        {t('unavailableBody', { slug: props.unavailableSlug })}
      </p>
      {error && (
        <p className="mt-2 text-[color:var(--danger)]">{error}</p>
      )}
      <div className="mt-3 flex gap-2">
        {/* eslint-disable-next-line no-restricted-syntax -- warning-outline action; §10 has no warning variant */}
        <button
          type="button"
          className="rounded border border-[color:var(--warning)] bg-[color:var(--bg-elevated)] px-3 py-1 text-xs font-medium text-[color:var(--warning)] hover:bg-[color:var(--warning)]/10 disabled:opacity-50"
          disabled={!!busy}
          onClick={() => void reSnapshot()}
        >
          {t('actionReSnapshot')}
        </button>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke filled danger (bg-elevated); §4.2 danger variant is transparent */}
        <button
          type="button"
          className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--bg-elevated)] px-3 py-1 text-xs font-medium text-[color:var(--danger)] hover:bg-[color:var(--danger)]/8 disabled:opacity-50"
          disabled={!!busy}
          onClick={() => void deleteSession()}
        >
          {t('actionDelete')}
        </button>
      </div>
    </div>
  );
}
