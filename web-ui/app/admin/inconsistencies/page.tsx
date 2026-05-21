'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import {
  listInconsistencies,
  type InconsistencyDetailDto,
  type InconsistencySeverity,
  type InconsistencyStatus,
} from '../../_lib/api';

const SEVERITY_BADGE: Record<InconsistencySeverity, string> = {
  low: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200',
  medium: 'bg-amber-200 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  high: 'bg-red-200 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

const STATUS_BADGE: Record<InconsistencyStatus, string> = {
  open: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  resolved:
    'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  dismissed:
    'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300',
};

const SEVERITY_RANK: Record<InconsistencySeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export default function InconsistenciesListPage(): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<InconsistencyStatus | 'all'>(
    'open',
  );
  const [items, setItems] = useState<InconsistencyDetailDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await listInconsistencies(
        statusFilter === 'all' ? {} : { status: statusFilter },
      );
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const sorted = useMemo(() => {
    if (!items) return null;
    return [...items].sort(
      (a, b) =>
        SEVERITY_RANK[b.props.severity] - SEVERITY_RANK[a.props.severity],
    );
  }, [items]);

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Memory · Widersprüche
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Memories die semantisch verwandt sind aber inhaltlich widersprechen.
          Klick auf einen Eintrag öffnet die Side-by-side-Ansicht zum Auflösen.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={[
              'rounded border px-3 py-1 text-xs',
              statusFilter === s
                ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-700',
            ].join(' ')}
          >
            {s === 'all' ? 'alle' : s}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
        >
          {loading ? 'lädt…' : 'aktualisieren'}
        </button>
      </div>

      {error !== null && (
        <div className="mb-4 border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Fehler: {error}
        </div>
      )}

      {sorted !== null && sorted.length === 0 && error === null && (
        <p className="text-sm italic text-neutral-500">
          Keine Widersprüche in dieser Auswahl.
        </p>
      )}

      {sorted !== null && sorted.length > 0 && (
        <ul className="flex flex-col gap-3">
          {sorted.map((inc) => (
            <li key={inc.id}>
              <Link
                href={`/admin/inconsistencies/${encodeURIComponent(inc.id)}`}
                className="block rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 uppercase tracking-wider',
                      SEVERITY_BADGE[inc.props.severity],
                    ].join(' ')}
                  >
                    {inc.props.severity}
                  </span>
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 uppercase tracking-wider',
                      STATUS_BADGE[inc.props.status],
                    ].join(' ')}
                  >
                    {inc.props.status}
                  </span>
                  <time
                    className="font-mono text-neutral-500"
                    dateTime={inc.props.created_at}
                  >
                    {new Date(inc.props.created_at).toLocaleString('de-DE')}
                  </time>
                </div>
                <p className="text-sm text-neutral-900 dark:text-neutral-100">
                  {inc.props.summary}
                </p>
                <p className="mt-2 font-mono text-[10px] text-neutral-500">
                  {inc.mkA?.props.summary?.slice(0, 60) ?? '(MK A)'} ↔{' '}
                  {inc.mkB?.props.summary?.slice(0, 60) ?? '(MK B)'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
