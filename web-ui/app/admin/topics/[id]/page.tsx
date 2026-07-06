'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { useTranslations } from 'next-intl';

import {
  getTopicDetail,
  type TopicDetailDto,
} from '../../../_lib/api';

export default function TopicDetailPage(): React.ReactElement {
  const t = useTranslations('adminTopics');
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
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin/topics"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin/topics
        </Link>
      </header>

      {loading && <p className="text-xs text-[color:var(--fg-muted)]">{t('loading')}</p>}
      {error !== null && (
        <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          {t('error', { message: error })}
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
            <span className="rounded bg-[color:var(--accent)]/10 px-2 py-0.5 font-mono uppercase tracking-wider text-[color:var(--accent)]">
              {t('memberCount', { count: detail.props.member_count })}
            </span>
            <span className="rounded bg-[color:var(--bg-soft)] px-2 py-0.5 font-mono uppercase tracking-wider text-[color:var(--fg)]">
              {detail.props.naming_source}
            </span>
          </div>

          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('detail.membersHeading')}
          </h2>
          {detail.members.length === 0 && (
            <p className="text-sm italic text-[color:var(--fg-muted)]">
              {t('detail.emptyMembers')}
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {detail.members.map((mk) => (
              <li key={mk.id}>
                <Link
                  href={`/memories/${encodeURIComponent(mk.id)}`}
                  className="block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3 transition-colors hover:border-[color:var(--accent)]"
                >
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {String(mk.props['kind'])}
                  </div>
                  <p className="text-sm text-[color:var(--fg-strong)]">
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
