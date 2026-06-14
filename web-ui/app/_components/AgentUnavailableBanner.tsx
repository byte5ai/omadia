'use client';

import { useState } from 'react';
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
 */

export interface AgentUnavailableBannerProps {
  sessionId: string;
  unavailableSlug: string;
  onRecovered: () => void;
  onDeleted: () => void;
}

export function AgentUnavailableBanner(
  props: AgentUnavailableBannerProps,
): React.ReactElement {
  const t = useTranslations('agentPicker');
  const [busy, setBusy] = useState<'re-snapshot' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <button
          type="button"
          className="rounded border border-[color:var(--warning)] bg-[color:var(--bg-elevated)] px-3 py-1 text-xs font-medium text-[color:var(--warning)] hover:bg-[color:var(--warning)]/10 disabled:opacity-50"
          disabled={!!busy}
          onClick={() => void reSnapshot()}
        >
          {t('actionReSnapshot')}
        </button>
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
