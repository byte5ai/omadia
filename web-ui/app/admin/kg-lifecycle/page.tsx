'use client';

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

/**
 * Admin → Knowledge-Graph Lifecycle (palaia Phase 4 / OB-73, Slice D).
 *
 * Operator dashboard for the decay + GC sweeps:
 *   - Tier histogram (HOT/WARM/COLD) + entry-type breakdown
 *   - Decay-score distribution (4 buckets)
 *   - Top scopes by Turn count + char volume
 *   - Buttons to manually trigger decay / GC / access-flush
 *   - Last-run summaries
 *
 * Backed by `/bot-api/v1/admin/kg-lifecycle/{stats,run-decay,run-gc,run-access-flush,last-runs}`.
 *
 * Issue #669 — these used to live under `/bot-api/dev/graph/lifecycle`, which
 * mounted only when the middleware ran with `DEV_ENDPOINTS_ENABLED=true`, an
 * unauthenticated surface. The routes are now authenticated operator admin
 * endpoints with no flag involved, so a 404 here means exactly one thing:
 * the middleware never published `graphLifecycle@1` (i.e. the knowledge graph
 * is not running on Postgres). The empty state says that and only that.
 */

type LifecycleStats = {
  totalTurns: number;
  byTier: { HOT: number; WARM: number; COLD: number };
  byEntryType: { memory: number; process: number; task: number };
  decayDistribution: {
    high: number;
    upperMid: number;
    lowerMid: number;
    cold: number;
  };
  topScopesByCount: Array<{ scope: string; count: number; chars: number }>;
  // OB-74 (Phase 5 / Track-B) — quota-bound limits surfaced for the
  // color-coded Quota / Char-Quota columns. Optional so the page renders
  // gracefully against pre-OB-74 middleware versions.
  quotas?: {
    hotMaxEntries: number;
    maxTotalChars: number;
  };
};

type DecaySweepStats = {
  decayUpdated: number;
  hotToWarm: number;
  warmToCold: number;
  doneTasksDeleted: number;
  durationMs: number;
};

type GcSweepStats = {
  scopesAffected: number;
  evictedByCount: number;
  evictedByChars: number;
  durationMs: number;
};

type AccessFlushStats = {
  flushed: number;
  promotedColdToWarm: number;
  durationMs: number;
};

type LastRuns = {
  decay: { at: string; stats: DecaySweepStats } | null;
  gc: { at: string; stats: GcSweepStats } | null;
  accessFlush: { at: string; stats: AccessFlushStats } | null;
};

const STAT_BASE = '/bot-api/v1/admin/kg-lifecycle';

export default function KgLifecyclePage(): JSX.Element {
  const [stats, setStats] = useState<LifecycleStats | null>(null);
  const [lastRuns, setLastRuns] = useState<LastRuns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const tPage = useTranslations('adminKgLifecycle');
  const format = useFormatter();

  const reload = useCallback(async () => {
    try {
      setError(null);
      const [statsRes, runsRes] = await Promise.all([
        fetch(`${STAT_BASE}/stats`, { cache: 'no-store' }),
        fetch(`${STAT_BASE}/last-runs`, { cache: 'no-store' }),
      ]);
      // #669 — the routes are behind the operator session gate now, so an
      // expired cookie is a distinct outcome from an absent backend. Rendering
      // both as "needs the Postgres backend" is the misdiagnosis this page
      // already cost once.
      if (statsRes.status === 401 || statsRes.status === 403) {
        setSignedOut(true);
        setUnavailable(false);
        return;
      }
      setSignedOut(false);
      // The lifecycle router is mounted only when the KG/Postgres plugin has
      // published the `graphLifecycle` service. Without it Express falls
      // through to its default 404 — the feature is absent, not broken. Show
      // that plainly instead of a raw "stats: 404 Not Found".
      if (statsRes.status === 404 || runsRes.status === 404) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      if (!statsRes.ok) {
        throw new Error(
          `stats: ${String(statsRes.status)} ${statsRes.statusText}`,
        );
      }
      if (!runsRes.ok) {
        throw new Error(`runs: ${String(runsRes.status)} ${runsRes.statusText}`);
      }
      setStats((await statsRes.json()) as LifecycleStats);
      setLastRuns((await runsRes.json()) as LastRuns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: reload()'s only synchronous setState is setError(null),
    // a same-value no-op on mount; the data lands after the awaited fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const trigger = useCallback(
    async (kind: 'decay' | 'gc' | 'access-flush'): Promise<void> => {
      const path =
        kind === 'decay'
          ? 'run-decay'
          : kind === 'gc'
            ? 'run-gc'
            : 'run-access-flush';
      setBusy(kind);
      try {
        const res = await fetch(`${STAT_BASE}/${path}`, { method: 'POST' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${String(res.status)}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
        await reload();
      }
    },
    [reload],
  );

  return (
    <main className="mx-auto max-w-[1280px] px-6 py-8 text-[color:var(--ink)]">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-[color:var(--fg-strong)]">
            {tPage('title')}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
            {tPage('intro')}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void reload()}>
          {tPage('refresh')}
        </Button>
      </header>

      {signedOut ? (
        <div className="mb-6 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-4 py-3">
          <div className="text-sm font-semibold text-[color:var(--fg-strong)]">
            {tPage('signedOutTitle')}
          </div>
          <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
            {tPage('signedOutBody')}
          </p>
        </div>
      ) : null}

      {unavailable && !signedOut ? (
        <div className="mb-6 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-4 py-3">
          <div className="text-sm font-semibold text-[color:var(--fg-strong)]">
            {tPage('unavailableTitle')}
          </div>
          <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
            {tPage('unavailableBody')}
          </p>
        </div>
      ) : null}

      {error && !unavailable && !signedOut ? (
        <div className="mb-6 rounded-md border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-sm text-[color:var(--danger)]">
          {error}
        </div>
      ) : null}

      {unavailable || signedOut ? null : (
      <>
        <section className="mb-8 grid gap-4 md:grid-cols-3">
          <ActionCard
            title={tPage('actions.decayTitle')}
            description={tPage('actions.decayDescription')}
            busy={busy === 'decay'}
            onClick={() => void trigger('decay')}
          />
          <ActionCard
            title={tPage('actions.gcTitle')}
            description={tPage('actions.gcDescription')}
            busy={busy === 'gc'}
            onClick={() => void trigger('gc')}
          />
          <ActionCard
            title={tPage('actions.accessFlushTitle')}
            description={tPage('actions.accessFlushDescription')}
            busy={busy === 'access-flush'}
            onClick={() => void trigger('access-flush')}
          />
        </section>

        <section className="mb-8 grid gap-6 md:grid-cols-3">
          {/* #679 / I3 — the tier and entry-type NAMES below (HOT/WARM/COLD,
              memory/process/task) stay untranslated on purpose: they are the
              literal enum values the API returns and the SQL stores, so an
              operator matching this screen against a log or a query needs them
              to read identically. Only the chrome around them is catalogued. */}
          <Card title={tPage('cards.tierBreakdown')}>
            {stats ? (
              <ul className="space-y-2 text-sm">
                <li>
                  <span className="text-[color:var(--fg-muted)]">HOT</span>:{' '}
                  <strong>{stats.byTier.HOT}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">WARM</span>:{' '}
                  <strong>{stats.byTier.WARM}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">COLD</span>:{' '}
                  <strong>{stats.byTier.COLD}</strong>
                </li>
                <li className="border-t border-[color:var(--border)] pt-2">
                  <span className="text-[color:var(--fg-muted)]">{tPage('cards.totalTurns')}</span>:{' '}
                  <strong>{stats.totalTurns}</strong>
                </li>
              </ul>
            ) : (
              <SkeletonRows />
            )}
          </Card>

          <Card title={tPage('cards.entryTypeBreakdown')}>
            {stats ? (
              <ul className="space-y-2 text-sm">
                <li>
                  <span className="text-[color:var(--fg-muted)]">memory</span>:{' '}
                  <strong>{stats.byEntryType.memory}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">process</span>:{' '}
                  <strong>{stats.byEntryType.process}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">task</span>:{' '}
                  <strong>{stats.byEntryType.task}</strong>
                </li>
              </ul>
            ) : (
              <SkeletonRows />
            )}
          </Card>

          <Card title={tPage('cards.decayDistribution')}>
            {stats ? (
              <ul className="space-y-2 text-sm">
                <li>
                  <span className="text-[color:var(--fg-muted)]">≥ 0.8</span>:{' '}
                  <strong>{stats.decayDistribution.high}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">0.5 – 0.8</span>:{' '}
                  <strong>{stats.decayDistribution.upperMid}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">0.2 – 0.5</span>:{' '}
                  <strong>{stats.decayDistribution.lowerMid}</strong>
                </li>
                <li>
                  <span className="text-[color:var(--fg-muted)]">&lt; 0.2</span>:{' '}
                  <strong>{stats.decayDistribution.cold}</strong>
                </li>
              </ul>
            ) : (
              <SkeletonRows />
            )}
          </Card>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 font-display text-lg text-[color:var(--fg-strong)]">
            {tPage('topScopes.heading')}
          </h2>
          <Card title="">
            {stats ? (
              stats.topScopesByCount.length === 0 ? (
                <p className="text-sm text-[color:var(--fg-muted)]">
                  {tPage('topScopes.empty')}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-[color:var(--fg-muted)]">
                    <tr>
                      <th className="pb-2">{tPage('topScopes.colScope')}</th>
                      <th className="pb-2 text-right">{tPage('topScopes.colTurns')}</th>
                      <th className="pb-2 text-right">{tPage('topScopes.colQuota')}</th>
                      <th className="pb-2 text-right">{tPage('topScopes.colChars')}</th>
                      <th className="pb-2 text-right">{tPage('topScopes.colCharQuota')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.topScopesByCount.map((row) => (
                      <tr
                        key={row.scope}
                        className="border-t border-[color:var(--border)]/50"
                      >
                        <td className="py-2 font-mono text-xs">{row.scope}</td>
                        <td className="py-2 text-right">{row.count}</td>
                        <td className="py-2 text-right">
                          <QuotaPill
                            value={row.count}
                            limit={stats.quotas?.hotMaxEntries}
                          />
                        </td>
                        <td className="py-2 text-right">
                          {format.number(row.chars)}
                        </td>
                        <td className="py-2 text-right">
                          <QuotaPill
                            value={row.chars}
                            limit={stats.quotas?.maxTotalChars}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : (
              <SkeletonRows />
            )}
          </Card>
        </section>

        <section>
          <h2 className="mb-3 font-display text-lg text-[color:var(--fg-strong)]">
            {tPage('lastRuns.heading')}
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <LastRunCard
              title={tPage('lastRuns.decay')}
              at={lastRuns?.decay?.at}
              rows={
                lastRuns?.decay
                  ? [
                      [tPage('lastRuns.updated'), lastRuns.decay.stats.decayUpdated],
                      [tPage('lastRuns.hotToWarm'), lastRuns.decay.stats.hotToWarm],
                      [tPage('lastRuns.warmToCold'), lastRuns.decay.stats.warmToCold],
                      [tPage('lastRuns.doneTasksDeleted'), lastRuns.decay.stats.doneTasksDeleted],
                      [tPage('lastRuns.durationMs'), lastRuns.decay.stats.durationMs],
                    ]
                  : null
              }
            />
            <LastRunCard
              title={tPage('lastRuns.gc')}
              at={lastRuns?.gc?.at}
              rows={
                lastRuns?.gc
                  ? [
                      [tPage('lastRuns.scopesAffected'), lastRuns.gc.stats.scopesAffected],
                      [tPage('lastRuns.evictedByCount'), lastRuns.gc.stats.evictedByCount],
                      [tPage('lastRuns.evictedByChars'), lastRuns.gc.stats.evictedByChars],
                      [tPage('lastRuns.durationMs'), lastRuns.gc.stats.durationMs],
                    ]
                  : null
              }
            />
            <LastRunCard
              title={tPage('lastRuns.accessFlush')}
              at={lastRuns?.accessFlush?.at}
              rows={
                lastRuns?.accessFlush
                  ? [
                      [tPage('lastRuns.flushed'), lastRuns.accessFlush.stats.flushed],
                      [
                        tPage('lastRuns.promotedColdToWarm'),
                        lastRuns.accessFlush.stats.promotedColdToWarm,
                      ],
                      [tPage('lastRuns.durationMs'), lastRuns.accessFlush.stats.durationMs],
                    ]
                  : null
              }
            />
          </div>
        </section>
        </>
      )}
    </main>
  );
}

function ActionCard({
  title,
  description,
  busy,
  onClick,
}: {
  title: string;
  description: string;
  busy: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)]/40 p-4">
      <h3 className="mb-2 font-medium text-[color:var(--fg-strong)]">
        {title}
      </h3>
      <p className="mb-4 flex-1 text-sm text-[color:var(--fg-muted)]">
        {description}
      </p>
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke highlight-token action (border/bg/text all --highlight); no §4.2 variant maps to --highlight */}
      <button
        type="button"
        disabled={busy}
        className="self-start rounded-md border border-[color:var(--highlight)] bg-[color:var(--highlight)]/10 px-3 py-2 text-sm text-[color:var(--highlight)] transition-colors hover:bg-[color:var(--highlight)]/20 disabled:opacity-50"
        onClick={onClick}
      >
        {busy ? 'Running…' : 'Run now'}
      </button>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)]/40 p-4">
      {title ? (
        <h3 className="mb-3 font-medium text-[color:var(--fg-strong)]">
          {title}
        </h3>
      ) : null}
      {children}
    </div>
  );
}

function LastRunCard({
  title,
  at,
  rows,
}: {
  title: string;
  at?: string | undefined;
  rows: ReadonlyArray<readonly [string, number]> | null;
}): JSX.Element {
  const t = useTranslations('adminKgLifecycle');
  // `toLocaleString()` with no argument follows the BROWSER's locale, not the
  // app's — so a German operator on an English-configured machine read this
  // timestamp in a different language from the page around it. `useFormatter`
  // follows the active locale (`web-ui/CLAUDE.md` § no hardcoded locale
  // formatting).
  const format = useFormatter();
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)]/40 p-4">
      <h3 className="mb-1 font-medium text-[color:var(--fg-strong)]">
        {title}
      </h3>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
        {at
          ? format.dateTime(new Date(at), {
              dateStyle: 'medium',
              timeStyle: 'medium',
            })
          : t('lastRuns.neverRun')}
      </p>
      {rows ? (
        <ul className="space-y-1 text-sm">
          {rows.map(([label, value]) => (
            <li key={label} className="flex justify-between gap-3">
              <span className="text-[color:var(--fg-muted)]">{label}</span>
              <strong>{value}</strong>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SkeletonRows(): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="h-3 w-3/4 rounded lume-skeleton" />
      <div className="h-3 w-2/3 rounded lume-skeleton" />
      <div className="h-3 w-1/2 rounded lume-skeleton" />
    </div>
  );
}

/**
 * OB-74 (Track-B) — color-coded quota indicator. Shows `value/limit` with a
 * traffic-light:
 *   - green   ≤ 80% of limit
 *   - amber   80-100%
 *   - red     > 100% (will be evicted on next GC sweep)
 * No limit → renders the raw count without color (gracefully degraded).
 */
function QuotaPill({
  value,
  limit,
}: {
  value: number;
  limit?: number;
}): JSX.Element {
  const t = useTranslations('adminKgLifecycle');
  const format = useFormatter();
  if (limit === undefined || limit <= 0) {
    return (
      <span className="text-xs text-[color:var(--fg-muted)]">—</span>
    );
  }
  const ratio = value / limit;
  const tone =
    ratio > 1.0
      ? 'bg-[color:var(--danger)]/20 text-[color:var(--danger)]'
      : ratio > 0.8
        ? 'bg-[color:var(--warning)]/20 text-[color:var(--warning)]'
        : 'bg-[color:var(--success)]/20 text-[color:var(--success)]';
  const formatted = `${format.number(value)}/${format.number(limit)}`;
  const percent = (ratio * 100).toFixed(0);
  const tooltip =
    ratio > 1.0
      ? t('quotaOverTooltip', { percent })
      : t('quotaTooltip', { percent });
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
      title={tooltip}
    >
      {formatted}
    </span>
  );
}
