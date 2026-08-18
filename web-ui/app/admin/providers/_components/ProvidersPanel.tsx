'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ErrorHelp } from '@/app/_components/ErrorHelp';
import {
  compareProviders,
  ConnectionChip,
  errorCode,
  SaveError,
  StatusChip,
  type SaveStatus,
} from '@/app/admin/_components/providerCredential';
import {
  assignProvider,
  getProviders,
  patchSettings,
  verifyProvider,
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

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ProvidersResponse }
  // The thrown error itself, for the same reason `errors` below keeps it: a
  // pre-flattened string is already past the point where the code is readable.
  | { kind: 'error'; error: unknown };

export function ProvidersPanel({
  onSwitchToSubscriptions,
}: {
  /** Switch the parent LLM-access tab strip to the Subscriptions tab — the
   *  CLI provider logs in there, not via a vault key. */
  onSwitchToSubscriptions: () => void;
}): React.ReactElement {
  const t = useTranslations('adminProviders');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [status, setStatus] = useState<Record<string, SaveStatus>>({});
  // The thrown error itself, not a pre-flattened string: the component decides
  // what is headline and what is disclosed detail, not the state.
  const [errors, setErrors] = useState<Record<string, unknown>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await getProviders();
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({ kind: 'error', error: err });
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
        setErrors((e) => ({ ...e, [pluginId]: err }));
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
        // OM-09: this rendered `GET /v1/admin/providers failed: 500` — an
        // English sentence the client itself assembled — as the whole message,
        // in every locale. The catalogue answers `providers.read_failed` in the
        // operator's language; `loadError` says which read failed when the
        // server sent no code this page knows.
        <ErrorHelp
          code={errorCode(state.error)}
          rawDetail={state.error}
          fallback={t('loadError')}
        />
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
              {[...state.data.providers].sort(compareProviders).map((p) => (
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  // Either a per-field message from a 200 PATCH response (already a plain
  // string the server produced per key) or the thrown ApiError itself.
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [verifying, setVerifying] = useState(false);
  const envKey = providerKeyEnv(p.id);
  const inputId = `provider-key-${p.id}`;
  // OM-11 — the CLI this provider needs is not on this server. `undefined`
  // means a pre-OM-11 middleware that cannot tell us, so we assume present and
  // keep the previous behaviour rather than disabling an action that works.
  const cliMissing = p.toolLess && p.installed === false;

  /** Probe the stored key and refresh the row. Swallowing a failure here is
   *  deliberate: an unreachable probe leaves the status at `unverified`, which
   *  is exactly the honest outcome — it must never be reported as a bad key. */
  const runVerify = async (): Promise<void> => {
    setVerifying(true);
    try {
      await verifyProvider(p.id);
      await onReload();
    } catch {
      await onReload();
    } finally {
      setVerifying(false);
    }
  };

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
      // Probe the key the operator just pasted BEFORE reloading, so the row
      // never flashes a stale verdict — and so a typo is caught here rather
      // than surfacing later as an unexplained failure on every chat message.
      await runVerify();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err);
    }
  };

  const removeKey = async (): Promise<void> => {
    if (saveStatus === 'saving') return;
    if (!confirm(t('providers.removeKeyConfirm', { provider: p.label }))) return;
    setSaveStatus('saving');
    setSaveError(undefined);
    try {
      const res = await patchSettings([{ key: envKey, value: null }]);
      const fieldErr = res.errors.find((e) => e.key === envKey);
      if (fieldErr) {
        setSaveStatus('error');
        setSaveError(fieldErr.message);
        return;
      }
      setSaveStatus('saved');
      await onReload();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err);
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
          <ConnectionChip provider={p} />
          {/* Explicit re-probe. Only offered where there is a credential to
              probe — the CLI provider authenticates on the Subscriptions tab. */}
          {!p.toolLess && p.status !== 'no_key' && (
            // eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg)
            <button
              type="button"
              onClick={() => void runVerify()}
              disabled={verifying || saveStatus === 'saving'}
              className="text-[13px] font-medium text-[color:var(--accent)] disabled:opacity-50"
            >
              {verifying ? t('providers.testing') : t('providers.testKey')}
            </button>
          )}
          {p.toolLess ? (
            // Subscription CLI: connect/manage via the in-app login on the
            // Subscriptions tab, not a vault key — switch tabs in place.
            //
            // OM-11: this used to offer "Anmelden" unconditionally, because the
            // DTO carried only `connected`/`status` and no way to know whether
            // the CLI is even on this server. Clicking it landed the operator on
            // a tab that said "NICHT GEFUNDEN" with no action available. When
            // the binary is missing the action is now disabled AND says why —
            // an offer you cannot accept is worse than no offer.
            // `installed === undefined` (pre-OM-11 middleware) counts as
            // installed, preserving the old behaviour on older servers.
            cliMissing ? (
              <span className="flex items-center gap-2">
                {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare muted text, no border/bg) */}
                <button
                  type="button"
                  disabled
                  title={t('providers.cliNotInstalledReason')}
                  className="cursor-not-allowed text-[13px] font-medium text-[color:var(--fg-muted)] opacity-60"
                >
                  {t('providers.logIn')} →
                </button>
                <span className="text-[12px] text-[color:var(--fg-muted)]">
                  {t('providers.cliNotInstalledReason')}
                </span>
              </span>
            ) : (
              // eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg)
              <button
                type="button"
                onClick={onSwitchToSubscriptions}
                className="text-[13px] font-medium text-[color:var(--accent)]"
              >
                {(p.connected ? t('providers.manageCli') : t('providers.logIn'))} →
              </button>
            )
          ) : (
            !editing &&
            (p.connected ? (
              <span className="flex items-center gap-3">
                {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg) */}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={saveStatus === 'saving'}
                  className="text-[13px] font-medium text-[color:var(--accent)] disabled:opacity-50"
                >
                  {t('providers.changeKey')} →
                </button>
                {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare danger text, no border/bg) */}
                <button
                  type="button"
                  onClick={() => void removeKey()}
                  disabled={saveStatus === 'saving'}
                  className="text-[13px] font-medium text-[color:var(--danger)] disabled:opacity-50"
                >
                  {t('providers.removeKey')}
                </button>
                {saveStatus === 'saving' && <StatusChip status={saveStatus} />}
              </span>
            ) : (
              // eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg)
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-[13px] font-medium text-[color:var(--accent)]"
              >
                {t('providers.addKey')} →
              </button>
            ))
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
            <StatusChip status={saveStatus} />
          </div>
          <SaveError error={saveError} />
        </div>
      )}

      {/* The explanation for a rejected key — the single most useful text on
          this page when chat is failing.
          OM-09: it used to be `verifyError`, an English sentence built in the
          middleware, rendered verbatim in every locale. `verifyErrorCode`
          resolves against the localized catalogue instead; `verifyError` stays
          as the fallback for a payload from a pre-#604 middleware, which is
          the only thing such a server sends. */}
      {p.status === 'invalid' && (p.verifyErrorCode ?? p.verifyError) && (
        <div className="flex flex-col gap-1">
          <ErrorHelp
            code={p.verifyErrorCode ?? null}
            fallback={p.verifyError}
          />
          <a
            href="/help"
            className="text-[12px] underline underline-offset-2 text-[color:var(--accent)]"
          >
            {t('providers.helpLink')}
          </a>
        </div>
      )}

      {/* removeKey runs while `editing` is false, so surface its failures here —
          otherwise a destructive remove that errors gives the operator no feedback. */}
      {!p.toolLess && !editing && <SaveError error={saveError} />}
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
  status: SaveStatus;
  /** The thrown value from the last failed apply, resolved by <ErrorHelp>. */
  error?: unknown;
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
        <StatusChip status={status} />
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

      {/* OM-10: the copy is now present-tense, because `a.provider` is the
          ALREADY-PERSISTED provider and the select above applies immediately —
          there is no code path where the old conditional "if you switch to X"
          phrasing was true. NOTE: on stock config the built-in `anthropic`
          descriptor sets `requiresAvvDisclosure: false`, so this banner should
          not render for Anthropic at all; the tester reported seeing it, which
          means the render condition itself is worth reproducing separately.
          The gate is deliberately left unchanged here. */}
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
      {error !== undefined && (
        <ErrorHelp code={errorCode(error)} rawDetail={error} />
      )}
    </div>
  );
}

