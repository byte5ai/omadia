'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { ApiError } from '../../../_lib/api';
import {
  clearChannelBinding,
  setChannelBinding,
  type ChannelsListDto,
  type OperatorChannelDto,
} from '../../../_lib/channels';

interface Props {
  initial: ChannelsListDto;
}

/**
 * One-row-per-channel-key list. The directory side is read-only (comes
 * from each channel plugin's contribution); the binding side mutates
 * `channel_bindings` through the operator REST surface. The dropdown's
 * "(none)" option clears the binding so the channel falls through to the
 * platform fallback Agent.
 *
 * "Stale" rows are bindings whose key is not in any plugin directory —
 * the channel plugin no longer reports it (uninstalled, config drift).
 * The operator can clear them with one click.
 */
export function ChannelsDashboard({ initial }: Props): React.ReactElement {
  const t = useTranslations('operatorChannels');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function run(label: string, op: () => Promise<unknown>): void {
    setError(null);
    setBusy(label);
    op()
      .then(() => {
        startTransition(() => router.refresh());
      })
      .catch((err: unknown) => {
        setError(humanizeApiError(err));
      })
      .finally(() => setBusy(null));
  }

  const groups = groupByChannelType(initial.channels);

  if (initial.channels.length === 0) {
    return (
      <div className="space-y-4">
        {error && (
          <div className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}
        <div className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-8 text-sm text-neutral-600 dark:text-neutral-300">
          <p className="mb-2 font-medium">{t('emptyHeading')}</p>
          <p>{t('emptyExplain')}</p>
          {initial.directory_types.length > 0 && (
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              {t('emptyDirectoriesKnown', {
                types: initial.directory_types.join(', '),
              })}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('fallbackHint', {
          fallback: initial.fallback_slug ?? t('fallbackHintNone'),
        })}
      </p>
      {groups.map((group) => (
        <section
          key={group.type}
          className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
        >
          <header className="border-b border-neutral-200 dark:border-neutral-800 px-5 py-3">
            <h2 className="text-base font-semibold uppercase tracking-wide text-neutral-800 dark:text-neutral-100">
              {group.type}{' '}
              <span className="ml-1 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                ({group.channels.length})
              </span>
            </h2>
          </header>
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {group.channels.map((c) => (
              <li
                key={`${c.channel_type}:${c.channel_key}`}
                className="flex flex-wrap items-center gap-3 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-neutral-800 dark:text-neutral-100">
                      {c.label}
                    </span>
                    {c.hint && (
                      <span className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0 text-[11px] text-neutral-600 dark:text-neutral-300">
                        {c.hint}
                      </span>
                    )}
                    {c.stale && (
                      <span className="rounded bg-amber-100 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-800">
                        {t('staleBadge')}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                    <code className="font-mono">{c.channel_key}</code>
                    {c.origin_plugin_id && (
                      <span>
                        {t('originLabel')}{' '}
                        <code className="font-mono">{c.origin_plugin_id}</code>
                      </span>
                    )}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                  <span>{t('routesTo')}</span>
                  <select
                    value={c.bound_agent_slug ?? ''}
                    disabled={pending || !!busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      const key = `${c.channel_type}:${c.channel_key}`;
                      run(`bind:${key}`, () =>
                        v === ''
                          ? clearChannelBinding(c.channel_type, c.channel_key)
                          : setChannelBinding(c.channel_type, c.channel_key, v),
                      );
                    }}
                    className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
                  >
                    <option value="">
                      {t('routesToFallback', {
                        fallback: initial.fallback_slug ?? '—',
                      })}
                    </option>
                    {initial.agents.map((a) => (
                      <option key={a.slug} value={a.slug}>
                        {a.slug}
                      </option>
                    ))}
                  </select>
                </label>
                {c.stale && (
                  <button
                    type="button"
                    className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
                    disabled={pending || !!busy}
                    onClick={() => {
                      const key = `${c.channel_type}:${c.channel_key}`;
                      run(`clear:${key}`, () =>
                        clearChannelBinding(c.channel_type, c.channel_key),
                      );
                    }}
                  >
                    {t('clearStale')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface Grouped {
  readonly type: string;
  readonly channels: readonly OperatorChannelDto[];
}

function groupByChannelType(
  channels: readonly OperatorChannelDto[],
): Grouped[] {
  const m = new Map<string, OperatorChannelDto[]>();
  for (const c of channels) {
    const list = m.get(c.channel_type) ?? [];
    list.push(c);
    m.set(c.channel_type, list);
  }
  return Array.from(m.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => ({ type, channels: list }));
}

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = err.body ? JSON.parse(err.body) : null;
      const m =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message?: unknown }).message ?? '')
          : '';
      if (m) return `${m} (HTTP ${err.status})`;
    } catch {
      /* ignore */
    }
  }
  return err instanceof Error ? err.message : String(err);
}
