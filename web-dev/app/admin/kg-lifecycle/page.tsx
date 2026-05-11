'use client';

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

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
 * Backed by `/bot-api/dev/graph/lifecycle/{stats,run-decay,run-gc,run-access-flush,last-runs}`.
 * Mounted only when DEV_ENDPOINTS_ENABLED is on the middleware side; the
 * page just renders an error banner if the routes 404.
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

const STAT_BASE = '/bot-api/dev/graph/lifecycle';

export default function KgLifecyclePage(): JSX.Element {
  const [stats, setStats] = useState<LifecycleStats | null>(null);
  const [lastRuns, setLastRuns] = useState<LastRuns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const [statsRes, runsRes] = await Promise.all([
        fetch(`${STAT_BASE}/stats`, { cache: 'no-store' }),
        fetch(`${STAT_BASE}/last-runs`, { cache: 'no-store' }),
      ]);
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
            Knowledge-Graph Lifecycle
          </h1>
          <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
            Palaia Phase 4 — Tier-Rotation, Decay, GC. Sweeps run on the
            cron schedule; the buttons below trigger them on demand.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm transition-colors hover:bg-[color:var(--border)]/30"
          onClick={() => void reload()}
        >
          Refresh
        </button>
      </header>

      {error ? (
        <div className="mb-6 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <section className="mb-8 grid gap-4 md:grid-cols-3">
        <ActionCard
          title="Run decay + rotation"
          description="Flush access tracker → recompute decay_score → rotate HOT→WARM→COLD → hard-delete done tasks past TTL."
          busy={busy === 'decay'}
          onClick={() => void trigger('decay')}
        />
        <ActionCard
          title="Run GC quotas"
          description="Per-scope eviction by type-weight × decay-score. Enforces hot_max_entries + max_total_chars."
          busy={busy === 'gc'}
          onClick={() => void trigger('gc')}
        />
        <ActionCard
          title="Run access flush only"
          description="Drain the access tracker into access_count + accessed_at without rotating. Debug-only."
          busy={busy === 'access-flush'}
          onClick={() => void trigger('access-flush')}
        />
      </section>

      <section className="mb-8 grid gap-6 md:grid-cols-3">
        <Card title="Tier breakdown">
          {stats ? (
            <ul className="space-y-1.5 text-sm">
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
              <li className="border-t border-[color:var(--border)] pt-1.5">
                <span className="text-[color:var(--fg-muted)]">Total Turns</span>:{' '}
                <strong>{stats.totalTurns}</strong>
              </li>
            </ul>
          ) : (
            <SkeletonRows />
          )}
        </Card>

        <Card title="Entry-type breakdown">
          {stats ? (
            <ul className="space-y-1.5 text-sm">
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

        <Card title="Decay-score distribution">
          {stats ? (
            <ul className="space-y-1.5 text-sm">
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
          Top scopes (by Turn count)
        </h2>
        <Card title="">
          {stats ? (
            stats.topScopesByCount.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">
                No scopes recorded yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-[color:var(--fg-muted)]">
                  <tr>
                    <th className="pb-2">Scope</th>
                    <th className="pb-2 text-right">Turns</th>
                    <th className="pb-2 text-right">Quota</th>
                    <th className="pb-2 text-right">Chars</th>
                    <th className="pb-2 text-right">Char-Quota</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topScopesByCount.map((row) => (
                    <tr
                      key={row.scope}
                      className="border-t border-[color:var(--border)]/50"
                    >
                      <td className="py-1.5 font-mono text-xs">{row.scope}</td>
                      <td className="py-1.5 text-right">{row.count}</td>
                      <td className="py-1.5 text-right">
                        <QuotaPill
                          value={row.count}
                          limit={stats.quotas?.hotMaxEntries}
                        />
                      </td>
                      <td className="py-1.5 text-right">
                        {row.chars.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right">
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
          Last sweep runs
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <LastRunCard
            title="Decay"
            at={lastRuns?.decay?.at}
            rows={
              lastRuns?.decay
                ? [
                    ['Updated', lastRuns.decay.stats.decayUpdated],
                    ['HOT → WARM', lastRuns.decay.stats.hotToWarm],
                    ['WARM → COLD', lastRuns.decay.stats.warmToCold],
                    ['Done tasks deleted', lastRuns.decay.stats.doneTasksDeleted],
                    ['Duration (ms)', lastRuns.decay.stats.durationMs],
                  ]
                : null
            }
          />
          <LastRunCard
            title="GC"
            at={lastRuns?.gc?.at}
            rows={
              lastRuns?.gc
                ? [
                    ['Scopes affected', lastRuns.gc.stats.scopesAffected],
                    ['Evicted by count', lastRuns.gc.stats.evictedByCount],
                    ['Evicted by chars', lastRuns.gc.stats.evictedByChars],
                    ['Duration (ms)', lastRuns.gc.stats.durationMs],
                  ]
                : null
            }
          />
          <LastRunCard
            title="Access flush"
            at={lastRuns?.accessFlush?.at}
            rows={
              lastRuns?.accessFlush
                ? [
                    ['Flushed', lastRuns.accessFlush.stats.flushed],
                    [
                      'Promoted COLD → WARM',
                      lastRuns.accessFlush.stats.promotedColdToWarm,
                    ],
                    ['Duration (ms)', lastRuns.accessFlush.stats.durationMs],
                  ]
                : null
            }
          />
        </div>
      </section>
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
      <button
        type="button"
        disabled={busy}
        className="self-start rounded-md border border-[color:var(--highlight)] bg-[color:var(--highlight)]/10 px-3 py-1.5 text-sm text-[color:var(--highlight)] transition-colors hover:bg-[color:var(--highlight)]/20 disabled:opacity-50"
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
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg)]/40 p-4">
      <h3 className="mb-1 font-medium text-[color:var(--fg-strong)]">
        {title}
      </h3>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
        {at ? new Date(at).toLocaleString() : 'never run in this process'}
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
      <div className="h-3 w-3/4 animate-pulse rounded bg-[color:var(--border)]" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-[color:var(--border)]" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-[color:var(--border)]" />
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
  if (limit === undefined || limit <= 0) {
    return (
      <span className="text-xs text-[color:var(--fg-muted)]">—</span>
    );
  }
  const ratio = value / limit;
  const tone =
    ratio > 1.0
      ? 'bg-red-500/20 text-red-400'
      : ratio > 0.8
        ? 'bg-amber-500/20 text-amber-400'
        : 'bg-emerald-500/20 text-emerald-400';
  const formatted = `${value.toLocaleString()}/${limit.toLocaleString()}`;
  const tooltip =
    ratio > 1.0
      ? `${(ratio * 100).toFixed(0)}% — wird beim nächsten GC-Sweep evicted`
      : `${(ratio * 100).toFixed(0)}% des Quota`;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}
      title={tooltip}
    >
      {formatted}
    </span>
  );
}
