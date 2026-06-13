'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';

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
    'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
  insight:
    'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  preference:
    'bg-[color:var(--success)]/10 text-[color:var(--success)]',
  reference:
    'bg-[color:var(--bg-soft)] text-[color:var(--fg)]',
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
      <header className="border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-medium">Memories</h1>
            <p className="text-xs text-[color:var(--fg-muted)]">
              Kuratiertes Wissen — ACL-gefiltert auf dich als Owner.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-[color:var(--border)] px-2 py-1 text-xs hover:border-[color:var(--border-strong)]"
          >
            ↻ neu laden
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
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
                    ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                    : 'border-[color:var(--border)] text-[color:var(--fg)] hover:border-[color:var(--border-strong)]',
                ].join(' ')}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto bg-[color:var(--bg-soft)] px-6 py-4">
        {loading && (
          <div className="text-xs text-[color:var(--fg-muted)]">lädt…</div>
        )}
        {error !== null && (
          <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
            Fehler: {error}
          </div>
        )}
        {!loading && error === null && items.length === 0 && (
          <div className="text-xs text-[color:var(--fg-muted)]">
            {filter === 'all'
              ? 'Noch keine Memories. Erstelle eine via Chat oder POST /api/v1/memory.'
              : `Keine Memories vom Typ „${KIND_LABELS[filter]}". Filter zurücksetzen oder andere Art wählen.`}
          </div>
        )}
        {!loading && error === null && items.length > 0 && (
          <ul className="space-y-3">
            {items.map((mk) => (
              <li key={mk.id}>
                <Link
                  href={`/memories/${encodeURIComponent(mk.id)}`}
                  className="block rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-3 shadow-sm transition hover:border-[color:var(--border-strong)] hover:shadow"
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
                      className="font-mono text-[10px] text-[color:var(--fg-muted)]"
                      dateTime={mk.props.created_at}
                    >
                      {new Date(mk.props.created_at).toLocaleString('de-DE')}
                    </time>
                  </div>
                  <p className="mt-2 text-sm text-[color:var(--fg-strong)]">
                    {mk.props.summary}
                  </p>
                  {mk.props.rationale !== undefined && (
                    <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
                      {mk.props.rationale}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[color:var(--fg-muted)]">
                    <span className="font-mono">{mk.id}</span>
                    <span aria-hidden>·</span>
                    <span>{mk.props.acl_owners.length} Owner</span>
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
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
