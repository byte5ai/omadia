'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  assignProvider,
  getProviders,
  patchSettings,
  ApiError,
  type AdminProvider,
  type ProviderAssignment,
  type ProvidersResponse,
} from '../../../_lib/api';

/**
 * The settings-catalog secret key that holds a provider's API key. Mirrors the
 * backend convention in `settingsCatalog.providerKeySettings`
 * (`<ID>_API_KEY`, non-alphanumerics → `_`) so the inline key field writes the
 * same vault entry the connection check (`adminProviders.isConnected`) reads —
 * e.g. `anthropic` → `ANTHROPIC_API_KEY`, `claude-cli` → `CLAUDE_CLI_API_KEY`.
 */
function providerKeyEnv(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/** Pull the backend's `message` out of an ApiError JSON body when present. */
function friendlyError(err: unknown): string {
  if (err instanceof ApiError && err.body) {
    try {
      const j = JSON.parse(err.body) as { message?: unknown };
      if (typeof j.message === 'string' && j.message.trim()) return j.message;
    } catch {
      /* fall through to the generic message */
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * LLM provider admin (S4). Two concerns on one page:
 *  1. Providers — which LLM providers exist, whether a key is connected in the
 *     vault, and what models each serves. The API key is entered inline here
 *     (PATCH /api/v1/admin/settings writes it into the vault); a tool-less CLI
 *     provider (the subscription CLI) is connected via in-app login on the
 *     Subscriptions tab instead.
 *  2. Assignments — pin each LLM-capable plugin to a provider + model. Saving
 *     POSTs /api/v1/admin/providers/assignment, which re-activates the plugin
 *     server-side so it takes effect live.
 *
 * Switching a plugin to a non-Anthropic provider routes that plugin's data to a
 * third party, so an AVV / data-flow disclosure is surfaced before the change is
 * saved (DSGVO Art. 28 — operator must have a processing agreement in place).
 */

type Status = 'idle' | 'saving' | 'saved' | 'error';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ProvidersResponse }
  | { kind: 'error'; message: string };

export function ProvidersPanel({
  onSwitchToSubscriptions,
}: {
  /** Switch the parent LLM-access tab strip to the Subscriptions tab — the
   *  CLI provider logs in there, not via a vault key. */
  onSwitchToSubscriptions: () => void;
}): React.ReactElement {
  const t = useTranslations('adminProviders');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await getProviders();
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Prefer the backend's explanatory message (e.g. "…the subscription CLI is
  // tool-less…") over the generic "POST … failed: 400".
  const apply = useCallback(
    async (pluginId: string, provider: string, model: string): Promise<void> => {
      setStatus((s) => ({ ...s, [pluginId]: 'saving' }));
      setErrors((e) => {
        const n = { ...e };
        delete n[pluginId];
        return n;
      });
      try {
        await assignProvider({ pluginId, provider, model });
        setState((prev) =>
          prev.kind === 'ready'
            ? {
                ...prev,
                data: {
                  ...prev.data,
                  assignments: prev.data.assignments.map((a) =>
                    a.pluginId === pluginId ? { ...a, provider, model } : a,
                  ),
                },
              }
            : prev,
        );
        setStatus((s) => ({ ...s, [pluginId]: 'saved' }));
      } catch (err) {
        setStatus((s) => ({ ...s, [pluginId]: 'error' }));
        setErrors((e) => ({
          ...e,
          [pluginId]: friendlyError(err),
        }));
      }
    },
    [],
  );

  return (
    <div>
      <p className="mb-8 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
        {t('intro')}
      </p>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">
          {t('loadError', { message: state.message })}
        </p>
      ) : (
        <div className="flex flex-col gap-10">
          {!state.data.vault_available && (
            <p className="rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-4 py-3 text-sm text-[color:var(--warning)]">
              {t('vaultUnavailable')}
            </p>
          )}

          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('providers.heading')}
            </h2>
            <ul className="flex flex-col gap-3">
              {state.data.providers.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  t={t}
                  onReload={load}
                  onSwitchToSubscriptions={onSwitchToSubscriptions}
                />
              ))}
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('assignments.heading')}
            </h2>
            <p className="mb-4 max-w-2xl text-[13px] leading-[1.55] text-[color:var(--fg-muted)]">
              {t('assignments.intro')}
            </p>
            <ul className="flex flex-col gap-3">
              {state.data.assignments.map((a) => (
                <li
                  key={a.pluginId}
                  className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
                >
                  <AssignmentRow
                    assignment={a}
                    providers={state.data.providers}
                    status={status[a.pluginId] ?? 'idle'}
                    error={errors[a.pluginId]}
                    onApply={apply}
                    t={t}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function ProviderRow({
  provider: p,
  t,
  onReload,
  onSwitchToSubscriptions,
}: {
  provider: AdminProvider;
  t: T;
  /** Re-fetch the providers list after a key save so `connected` flips. */
  onReload: () => Promise<void>;
  /** Send the CLI provider to the Subscriptions tab to log in. */
  onSwitchToSubscriptions: () => void;
}): React.ReactElement {
  // Inline API-key entry (replaces the old link out to the general Settings
  // page): reveal a password field, PATCH the provider's settings-catalog key,
  // then reload so the connection chip updates — all without leaving this tab.
  const [editing, setEditing] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [saveStatus, setSaveStatus] = useState<Status>('idle');
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const envKey = providerKeyEnv(p.id);
  const inputId = `provider-key-${p.id}`;

  const saveKey = async (): Promise<void> => {
    const value = keyValue.trim();
    if (value.length === 0) return;
    setSaveStatus('saving');
    setSaveError(undefined);
    try {
      const res = await patchSettings([{ key: envKey, value }]);
      const fieldErr = res.errors.find((e) => e.key === envKey);
      if (fieldErr) {
        setSaveStatus('error');
        setSaveError(fieldErr.message);
        return;
      }
      setSaveStatus('saved');
      setKeyValue('');
      setEditing(false);
      await onReload();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(friendlyError(err));
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
            {p.label}
          </span>
          <code className="text-[11px] text-[color:var(--fg-muted)]">{p.id}</code>
          <span className="text-[11px] text-[color:var(--fg-muted)]">
            {t('providers.modelCount', { count: p.models.length })}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <span
            className={[
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
              p.connected
                ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
                : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
            ].join(' ')}
          >
            {p.connected ? t('providers.connected') : t('providers.notConnected')}
          </span>
          {p.toolLess ? (
            // Subscription CLI: connect/manage via the in-app login on the
            // Subscriptions tab, not a vault key — switch tabs in place.
            <button
              type="button"
              onClick={onSwitchToSubscriptions}
              className="text-[13px] font-medium text-[color:var(--accent)]"
            >
              {(p.connected ? t('providers.manageCli') : t('providers.logIn'))} →
            </button>
          ) : (
            !p.connected &&
            !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-[13px] font-medium text-[color:var(--accent)]"
              >
                {t('providers.addKey')} →
              </button>
            )
          )}
        </span>
      </div>

      {!p.toolLess && editing && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={inputId}>
            {t('providers.keyInputLabel', { provider: p.label })}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={inputId}
              type="password"
              autoFocus
              value={keyValue}
              placeholder={t('providers.keyPlaceholder')}
              onChange={(e) => {
                setKeyValue(e.target.value);
                setSaveStatus('idle');
                setSaveError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey();
              }}
              className="flex-1 rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)] disabled:opacity-50 sm:min-w-[260px]"
            />
            <Button
              variant="primary"
              disabled={saveStatus === 'saving' || keyValue.trim().length === 0}
              onClick={() => void saveKey()}
            >
              {t('providers.saveKey')}
            </Button>
            <Button
              variant="secondary"
              disabled={saveStatus === 'saving'}
              onClick={() => {
                setEditing(false);
                setKeyValue('');
                setSaveStatus('idle');
                setSaveError(undefined);
              }}
            >
              {t('providers.cancel')}
            </Button>
            <StatusChip status={saveStatus} t={t} />
          </div>
          {saveError && (
            <p className="text-[12px] text-[color:var(--danger)]">{saveError}</p>
          )}
        </div>
      )}
    </li>
  );
}

const selectCls =
  'rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)] disabled:opacity-50';

function AssignmentRow({
  assignment: a,
  providers,
  status,
  error,
  onApply,
  t,
}: {
  assignment: ProviderAssignment;
  providers: AdminProvider[];
  status: Status;
  error?: string;
  onApply: (pluginId: string, provider: string, model: string) => void;
  t: T;
}): React.ReactElement {
  const selectedProvider =
    providers.find((p) => p.id === a.provider) ?? providers[0];
  const models = selectedProvider?.models ?? [];
  const disabled = !a.installed;
  // Data-driven: surface the AVV / Art. 28 third-party disclosure unless the
  // provider opts out via its policy (the server defaults unknown providers to
  // requiring it). Replaces the previous hard-coded `!== 'anthropic'` check.
  const showDisclosure = selectedProvider?.requiresAvvDisclosure ?? true;

  const onProvider = (providerId: string): void => {
    const next = providers.find((p) => p.id === providerId);
    // Default to the provider's first model when switching providers.
    const model = next?.models[0]?.modelId ?? '';
    if (model) onApply(a.pluginId, providerId, model);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
            {a.label}
          </span>
          <code className="text-[11px] text-[color:var(--fg-muted)]">
            {a.pluginId}
          </code>
          {!a.installed && (
            <span className="rounded-full bg-[color:var(--border)]/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('assignments.notInstalled')}
            </span>
          )}
        </div>
        <StatusChip status={status} t={t} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`prov-${a.pluginId}`}>
          {t('assignments.providerLabel')}
        </label>
        <select
          id={`prov-${a.pluginId}`}
          value={a.provider}
          disabled={disabled}
          onChange={(e) => onProvider(e.target.value)}
          className={`${selectCls} sm:max-w-[220px]`}
        >
          {providers.map((p) => {
            // A tool-less provider can't drive a tool plugin → offer but disable.
            const blocked = p.toolLess === true && a.requiresTools === true;
            return (
              <option key={p.id} value={p.id} disabled={blocked}>
                {p.label}
                {blocked
                  ? ` (${t('assignments.toolLessBlocked')})`
                  : p.connected
                    ? ''
                    : ` (${t('providers.notConnected')})`}
              </option>
            );
          })}
        </select>

        <label className="sr-only" htmlFor={`model-${a.pluginId}`}>
          {t('assignments.modelLabel')}
        </label>
        <select
          id={`model-${a.pluginId}`}
          value={a.model ?? ''}
          disabled={disabled || models.length === 0}
          onChange={(e) => onApply(a.pluginId, a.provider, e.target.value)}
          className={`${selectCls} sm:max-w-[280px]`}
        >
          {a.model === null && <option value="">{t('assignments.pickModel')}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.modelId}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {showDisclosure && (
        <p className="rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-[12px] leading-[1.5] text-[color:var(--warning)]">
          {t('assignments.avvDisclosure', { provider: selectedProvider?.label ?? a.provider })}
        </p>
      )}
      {selectedProvider?.euHosted && (
        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--border)]/10 px-3 py-2 text-[12px] leading-[1.5] text-[color:var(--fg-muted)]">
          {t('assignments.euHostedNote', {
            provider: selectedProvider?.label ?? a.provider,
          })}
        </p>
      )}
      {error && <p className="text-[12px] text-[color:var(--danger)]">{error}</p>}
    </div>
  );
}

function StatusChip({
  status,
  t,
}: {
  status: Status;
  t: T;
}): React.ReactElement | null {
  if (status === 'idle') return null;
  const map: Record<Exclude<Status, 'idle'>, { key: string; cls: string }> = {
    saving: { key: 'saving', cls: 'text-[color:var(--fg-muted)]' },
    saved: { key: 'saved', cls: 'text-[color:var(--success)]' },
    error: { key: 'errorChip', cls: 'text-[color:var(--danger)]' },
  };
  const { key, cls } = map[status];
  return <span className={`text-[11px] ${cls}`}>{t(`status.${key}`)}</span>;
}
