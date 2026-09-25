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
 * which hands control back to the environment variable and then the default —
 * but only after the current value loaded successfully (#1077). Until then
 * the field is empty because nothing is known, not because the operator
 * cleared it, so Save stays disabled and a "Load again" button is offered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ErrorHelp } from '../../../_components/ErrorHelp';
import { Button } from '../../../_components/ui/Button';
import {
  ApiError,
  getInstalledPlugin,
  updateInstalledPluginConfig,
} from '../../../_lib/api';

const ORCHESTRATOR_PLUGIN_ID = '@omadia/orchestrator';
const CONFIG_KEY = 'cli_turn_seconds';
/** Mirrors `DEFAULT_SPAWN_TIMEOUT_MS` in `cliChatAgent.ts` (600 s). */
const DEFAULT_TURN_SECONDS = 600;
const MIN_TURN_SECONDS = 30;
const MAX_TURN_SECONDS = 3600;
/** Digits only: rejects `240.5`, `1e3`, `-5` and `+240`, which `parseInt` misread. */
const WHOLE_NUMBER = /^\d+$/;

type Status =
  | { kind: 'loading' }
  | { kind: 'loadFailed'; code: string | null; detail: unknown }
  | { kind: 'idle' }
  | { kind: 'invalid' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'saveFailed'; code: string | null; detail: unknown };

/**
 * Show what the orchestrator actually applies. It parses the stored value with
 * `Number()` (`parseNumberOrDefault` in the orchestrator plugin), so a legacy
 * `'240.5'` is 240.5 s and `'1e3'` is 1000 s — not the 240 / 1 `parseInt`
 * displayed. A fractional value then fails the whole-number check on the next
 * save instead of being silently truncated.
 */
function readConfigured(config: Record<string, unknown>): string {
  const raw = config[CONFIG_KEY];
  if (raw === undefined || raw === null || raw === '') return '';
  const parsed = Number(String(raw));
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
}

function isValidTurnSeconds(trimmed: string): boolean {
  if (!WHOLE_NUMBER.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return parsed >= MIN_TURN_SECONDS && parsed <= MAX_TURN_SECONDS;
}

function failure(err: unknown): { code: string | null; detail: unknown } {
  return { code: err instanceof ApiError ? err.code : null, detail: err };
}

export function TurnBudgetField(): React.ReactElement {
  const t = useTranslations('adminSubscriptionClis');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const mounted = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const detail = await getInstalledPlugin(ORCHESTRATOR_PLUGIN_ID);
      if (!mounted.current) return;
      setValue(readConfigured(detail.config));
      setStatus({ kind: 'idle' });
    } catch (err) {
      if (!mounted.current) return;
      // The orchestrator not being installed is a legitimate state on a
      // fresh box. Either way the stored value is unknown, so saving stays
      // locked: an empty save here would PATCH `null` and wipe the setting.
      setStatus({ kind: 'loadFailed', ...failure(err) });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Fetch-on-mount: load() touches state only after the awaited fetch —
    // no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const reload = useCallback(() => {
    setStatus({ kind: 'loading' });
    void load();
  }, [load]);

  const locked = status.kind === 'loading' || status.kind === 'loadFailed';

  const save = useCallback(async () => {
    // Second guard behind the disabled button: never write without a
    // successfully loaded baseline.
    if (locked) return;
    const trimmed = value.trim();
    // A number input reports text it cannot parse (`+240`, `1.2.3`) as an
    // empty value with `validity.badInput` set. That is not the operator
    // clearing the field, and must not PATCH `null`.
    const unparseable = inputRef.current?.validity.badInput === true;
    if (unparseable || (trimmed !== '' && !isValidTurnSeconds(trimmed))) {
      setStatus({ kind: 'invalid' });
      return;
    }
    setStatus({ kind: 'saving' });
    try {
      // `null` clears the key — the PATCH contract's own convention — which is
      // what "back to environment / default" has to mean here.
      await updateInstalledPluginConfig(ORCHESTRATOR_PLUGIN_ID, {
        [CONFIG_KEY]: trimmed === '' ? null : trimmed,
      });
      if (mounted.current) setStatus({ kind: 'saved' });
    } catch (err) {
      if (mounted.current) setStatus({ kind: 'saveFailed', ...failure(err) });
    }
  }, [locked, value]);

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
          ref={inputRef}
          type="number"
          inputMode="numeric"
          min={MIN_TURN_SECONDS}
          max={MAX_TURN_SECONDS}
          step={1}
          value={value}
          disabled={locked}
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
          disabled={locked}
        >
          {t('turnBudget.save')}
        </Button>
        {status.kind === 'loadFailed' && (
          <Button variant="secondary" onClick={reload}>
            {t('turnBudget.reload')}
          </Button>
        )}
        {status.kind === 'saved' && (
          <span className="text-sm text-[color:var(--fg-muted)]">
            {t('turnBudget.saved')}
          </span>
        )}
      </div>
      {status.kind === 'invalid' && (
        <p className="mt-2 text-sm text-[color:var(--danger)]">
          {t('turnBudget.invalid', { min: MIN_TURN_SECONDS, max: MAX_TURN_SECONDS })}
        </p>
      )}
      {status.kind === 'loadFailed' && (
        <div className="mt-2">
          <ErrorHelp
            code={status.code}
            rawDetail={status.detail}
            fallback={t('turnBudget.loadFailed')}
          />
        </div>
      )}
      {status.kind === 'saveFailed' && (
        <div className="mt-2">
          <ErrorHelp
            code={status.code}
            rawDetail={status.detail}
            fallback={t('turnBudget.saveFailed')}
          />
        </div>
      )}
    </section>
  );
}
