'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  getAgentFastLane,
  parseOperatorAgentErrorCode,
  setAgentFastLane,
  type AgentFastLaneDto,
} from '../../../../_lib/agents';
import { humanizeApiError } from '../../_components/AgentsDashboard';

interface AgentFastLaneProps {
  readonly slug: string;
}

/**
 * #1876 — the agent's fast lane switch (spec 2042 §8 item 10). With it on,
 * simple data questions are answered without the full agent loop, under the
 * agent's identity and with its AI disclosure; a miss goes to the agent as
 * usual. A facilitator has no fast lane.
 */
export function AgentFastLane(props: AgentFastLaneProps): React.ReactElement {
  const t = useTranslations('operatorAgents.fastLane');
  const tErr = useTranslations('operatorAgents');
  const [state, setState] = useState<AgentFastLaneDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseOperatorAgentErrorCode(err);
      return code !== null
        ? tErr(`detailErrors.${code}`)
        : tErr('detailErrors.unknown', { detail: humanizeApiError(err) });
    },
    [tErr],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await getAgentFastLane(props.slug));
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    }
  }, [props.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (enabled: boolean): void => {
    setBusy(true);
    void setAgentFastLane(props.slug, enabled)
      .then(refresh)
      .catch((err: unknown) => setError(localizeError(err)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <h2 className="mb-1 text-lg font-medium">{t('heading')}</h2>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}
      {state === null && !error && <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>}
      {state !== null && !state.available && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('unavailable')}</p>
      )}
      {state !== null && state.available && (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={state.enabled}
            disabled={busy}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>
            <span className="font-medium text-[color:var(--fg-strong)]">{t('label')}</span>
            <span className="block text-xs text-[color:var(--fg-muted)]">
              {state.enabled ? t('onHint') : t('offHint')}
            </span>
          </span>
        </label>
      )}
    </section>
  );
}
