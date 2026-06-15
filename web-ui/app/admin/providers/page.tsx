'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  assignProvider,
  getProviders,
  type AdminProvider,
  type ProviderAssignment,
  type ProvidersResponse,
} from '../../_lib/api';

/**
 * LLM provider admin (S4). Two concerns on one page:
 *  1. Providers — which LLM providers exist, whether a key is connected in the
 *     vault, and what models each serves. The key itself is entered on the
 *     Settings page (vault); this page only reports connection state and links
 *     there.
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

export default function AdminProvidersPage(): React.ReactElement {
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
          [pluginId]: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [],
  );

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

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
                <ProviderRow key={p.id} provider={p} t={t} />
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
    </main>
  );
}

type T = ReturnType<typeof useTranslations>;

function ProviderRow({
  provider: p,
  t,
}: {
  provider: AdminProvider;
  t: T;
}): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 px-4 py-4">
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
        {!p.connected && (
          <Link
            href="/admin/settings"
            className="text-[13px] font-medium text-[color:var(--accent)]"
          >
            {t('providers.addKey')} →
          </Link>
        )}
      </span>
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
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.connected ? '' : ` (${t('providers.notConnected')})`}
            </option>
          ))}
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
