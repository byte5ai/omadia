'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import {
  getTopicDetail,
  type TopicDetailDto,
} from '../../../_lib/api';

export default function TopicDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const id = useMemo(() => decodeURIComponent(params?.id ?? ''), [params]);

  const [detail, setDetail] = useState<TopicDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const d = await getTopicDetail(id);
      setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) queueMicrotask(() => void load());
  }, [id, load]);

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin/topics"
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← /admin/topics
        </Link>
      </header>

      {loading && <p className="text-xs text-neutral-500">lädt…</p>}
      {error !== null && (
        <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Fehler: {error}
        </div>
      )}

      {detail !== null && (
        <>
          <h1 className="mb-2 font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
            {detail.props.name}
          </h1>
          <p className="mb-6 max-w-2xl text-sm text-[color:var(--fg-muted)]">
            {detail.props.description}
          </p>
          <div className="mb-6 flex flex-wrap gap-2 text-[10px]">
            <span className="rounded bg-violet-100 px-1.5 py-0.5 font-mono uppercase tracking-wider text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
              {detail.props.member_count} Memories
            </span>
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              {detail.props.naming_source}
            </span>
          </div>

          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            Mitglieder
          </h2>
          {detail.members.length === 0 && (
            <p className="text-sm italic text-neutral-500">
              Keine sichtbaren Mitglieder (oder ACL verbirgt sie).
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {detail.members.map((mk) => (
              <li key={mk.id}>
                <Link
                  href={`/memories/${encodeURIComponent(mk.id)}`}
                  className="block rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3 transition-colors hover:border-[color:var(--accent)]"
                >
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    {String(mk.props['kind'])}
                  </div>
                  <p className="text-sm text-neutral-900 dark:text-neutral-100">
                    {String(mk.props['summary'])}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
