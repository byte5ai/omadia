'use client';

/**
 * OM-104 — "Zeitlimit pro Turn" for the subscription runtime.
 *
 * The CLI-owned turn used to die at a hard-coded 120 s while a single call to
 * omadia's own SEO sub-agent takes 69-75 s, so two tool calls guaranteed a
 * dead turn. W0 raised the default to 600 s and added an environment override;
 * an environment variable is not something a self-hoster running the desktop
 * build can reach. This is the same knob on the page where the subscription
 * lives.
 *
 * Persisted as the orchestrator plugin's `cli_turn_seconds` config value —
 * the same store every other orchestrator setting uses, so a change
 * reactivates the plugin and takes effect without a restart. Empty clears it,
 * which hands control back to the environment variable and then the default.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../../../_components/ui/Button';
import { getInstalledPlugin, updateInstalledPluginConfig } from '../../../_lib/api';

const ORCHESTRATOR_PLUGIN_ID = '@omadia/orchestrator';
const CONFIG_KEY = 'cli_turn_seconds';
/** Mirrors `DEFAULT_SPAWN_TIMEOUT_MS` in `cliChatAgent.ts` (600 s). */
const DEFAULT_TURN_SECONDS = 600;
const MIN_TURN_SECONDS = 30;
const MAX_TURN_SECONDS = 3600;

type Status =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

function readConfigured(config: Record<string, unknown>): string {
  const raw = config[CONFIG_KEY];
  if (raw === undefined || raw === null || raw === '') return '';
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : '';
}

export function TurnBudgetField(): React.ReactElement {
  const t = useTranslations('adminSubscriptionClis');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await getInstalledPlugin(ORCHESTRATOR_PLUGIN_ID);
        if (cancelled) return;
        setValue(readConfigured(detail.config));
        setStatus({ kind: 'idle' });
      } catch (err) {
        if (cancelled) return;
        // The orchestrator not being installed is a legitimate state on a
        // fresh box; surface it as a message rather than an empty field that
        // silently swallows every save.
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed !== '') {
      const parsed = Number.parseInt(trimmed, 10);
      if (
        !Number.isInteger(parsed) ||
        parsed < MIN_TURN_SECONDS ||
        parsed > MAX_TURN_SECONDS
      ) {
        setStatus({
          kind: 'error',
          message: t('turnBudget.invalid', {
            min: MIN_TURN_SECONDS,
            max: MAX_TURN_SECONDS,
          }),
        });
        return;
      }
    }
    setStatus({ kind: 'saving' });
    try {
      // `null` clears the key — the PATCH contract's own convention — which is
      // what "back to environment / default" has to mean here.
      await updateInstalledPluginConfig(ORCHESTRATOR_PLUGIN_ID, {
        [CONFIG_KEY]: trimmed === '' ? null : trimmed,
      });
      setStatus({ kind: 'saved' });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [t, value]);

  return (
    <section className="mt-8 rounded-lg border border-[color:var(--edge)] p-4">
      <h3 className="text-sm font-medium text-[color:var(--fg-strong)]">
        {t('turnBudget.label')}
      </h3>
      <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
        {t('turnBudget.help', { default: DEFAULT_TURN_SECONDS })}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="number"
          inputMode="numeric"
          min={MIN_TURN_SECONDS}
          max={MAX_TURN_SECONDS}
          value={value}
          disabled={status.kind === 'loading'}
          placeholder={String(DEFAULT_TURN_SECONDS)}
          aria-label={t('turnBudget.label')}
          onChange={(e) => {
            setValue(e.target.value);
            setStatus({ kind: 'idle' });
          }}
          className="w-32 rounded-md border border-[color:var(--edge)] bg-transparent px-3 py-2 text-sm"
        />
        <Button
          onClick={() => void save()}
          busy={status.kind === 'saving'}
          disabled={status.kind === 'loading'}
        >
          {t('turnBudget.save')}
        </Button>
        {status.kind === 'saved' && (
          <span className="text-sm text-[color:var(--fg-muted)]">
            {t('turnBudget.saved')}
          </span>
        )}
      </div>
      {status.kind === 'error' && (
        <p className="mt-2 text-sm text-[color:var(--danger)]">{status.message}</p>
      )}
    </section>
  );
}
