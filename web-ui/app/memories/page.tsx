'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  listMemories,
  type MemorableKind,
  type MemorableKnowledgeNode,
} from '../_lib/api';

const KIND_FILTERS: Array<MemorableKind | 'all'> = [
  'all',
  'decision',
  'insight',
  'preference',
  'reference',
];

const KIND_LABELS: Record<MemorableKind, string> = {
  decision: 'Entscheidung',
  insight: 'Erkenntnis',
  preference: 'Präferenz',
  reference: 'Referenz',
};

const KIND_BADGE: Record<MemorableKind, string> = {
  decision:
    'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  insight:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  preference:
    'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  reference:
    'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300',
};

/**
 * Slice 3 polish — list of MemorableKnowledge nodes the session user
 * is INVOLVED in AND an ACL-owner of. Backend at /api/v1/memory enforces
 * the strict-ACL gate; this page just renders the result and adds a
 * kind-filter on top.
 *
 * The legacy /memory route (file-browser over the virtual-FS memories)
 * stays untouched — different concept, different data.
 */
export default function MemoriesPage(): React.ReactElement {
  const [items, setItems] = useState<MemorableKnowledgeNode[]>([]);
  const [filter, setFilter] = useState<MemorableKind | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const opts = filter === 'all' ? {} : { kind: filter };
      const res = await listMemories(opts);
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  return (
    <main className="flex h-full flex-col">
      <header className="border-b border-neutral-200 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-medium">Memories</h1>
            <p className="text-xs text-neutral-500">
              Kuratiertes Wissen — ACL-gefiltert auf dich als Owner.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-neutral-300 px-2 py-1 text-xs hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
          >
            ↻ neu laden
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {KIND_FILTERS.map((k) => {
            const active = filter === k;
            const label = k === 'all' ? 'alle' : KIND_LABELS[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={[
                  'rounded border px-2 py-1 text-xs transition',
                  active
                    ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                    : 'border-neutral-300 text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto bg-neutral-50 px-6 py-4 dark:bg-neutral-950">
        {loading && (
          <div className="text-xs text-neutral-500">lädt…</div>
        )}
        {error !== null && (
          <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            Fehler: {error}
          </div>
        )}
        {!loading && error === null && items.length === 0 && (
          <div className="text-xs text-neutral-500">
            {filter === 'all'
              ? 'Noch keine Memories. Erstelle eine via Chat oder POST /api/v1/memory.'
              : `Keine Memories vom Typ „${KIND_LABELS[filter]}". Filter zurücksetzen oder andere Art wählen.`}
          </div>
        )}
        {!loading && error === null && items.length > 0 && (
          <ul className="space-y-3">
            {items.map((mk) => (
              <li
                key={mk.id}
                className="rounded border border-neutral-200 bg-white px-4 py-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <span
                    className={[
                      'rounded px-2 py-0.5 text-[10px] uppercase tracking-wider',
                      KIND_BADGE[mk.props.kind],
                    ].join(' ')}
                  >
                    {KIND_LABELS[mk.props.kind]}
                  </span>
                  <time
                    className="font-mono text-[10px] text-neutral-500"
                    dateTime={mk.props.created_at}
                  >
                    {new Date(mk.props.created_at).toLocaleString('de-DE')}
                  </time>
                </div>
                <p className="mt-2 text-sm text-neutral-900 dark:text-neutral-100">
                  {mk.props.summary}
                </p>
                {mk.props.rationale !== undefined && (
                  <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                    {mk.props.rationale}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-500">
                  <span className="font-mono">{mk.id}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {mk.props.acl_owners.length}{' '}
                    {mk.props.acl_owners.length === 1 ? 'Owner' : 'Owner'}
                  </span>
                  {typeof mk.props.significance === 'number' && (
                    <>
                      <span aria-hidden>·</span>
                      <span>
                        significance {mk.props.significance.toFixed(2)}
                      </span>
                    </>
                  )}
                  <span aria-hidden>·</span>
                  <span className="font-mono">
                    created_by {mk.props.created_by}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
