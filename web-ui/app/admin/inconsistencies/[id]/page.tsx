'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  getInconsistencyDetail,
  resolveInconsistency,
  type InconsistencyDetailDto,
  type InconsistencyResolution,
  type MemorableKnowledgeNode,
} from '../../../_lib/api';

// Stable message-key suffix per resolution — labels/descriptions live under
// `adminInconsistencies.detail.resolutions.*` and are translated at render.
const RESOLUTION_KEY: Record<InconsistencyResolution, string> = {
  a_wins: 'aWins',
  b_wins: 'bWins',
  both: 'both',
  dismiss: 'dismiss',
};

export default function InconsistencyDetailPage(): React.ReactElement {
  const t = useTranslations('adminInconsistencies.detail');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = useMemo(() => decodeURIComponent(params?.id ?? ''), [params]);

  const [detail, setDetail] = useState<InconsistencyDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await getInconsistencyDetail(id);
      setDetail(d);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) queueMicrotask(() => void load());
  }, [id, load]);

  const resolve = useCallback(
    async (resolution: InconsistencyResolution): Promise<void> => {
      if (!detail) return;
      const destructive = resolution === 'a_wins' || resolution === 'b_wins';
      const target =
        resolution === 'a_wins'
          ? detail.mkB
          : resolution === 'b_wins'
            ? detail.mkA
            : null;
      const confirmText =
        destructive && target
          ? t('confirmDelete', { summary: target.props.summary.slice(0, 100) })
          : t('confirmResolve', {
              label: t(`resolutions.${RESOLUTION_KEY[resolution]}.label`),
            });
      if (!window.confirm(confirmText)) return;
      setBusy(true);
      setMutationError(null);
      try {
        await resolveInconsistency(id, {
          resolution,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
        router.push('/admin/inconsistencies');
      } catch (err) {
        setMutationError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [id, detail, reason, router, t],
  );

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin/inconsistencies"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin/inconsistencies
        </Link>
        <h1 className="mt-2 font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
      </header>

      {loading && (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}
      {loadError !== null && (
        <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          {t('error', { message: loadError })}
        </div>
      )}

      {detail !== null && (
        <>
          <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('detectorFindingTitle')}
            </h2>
            <p className="text-sm">{detail.props.summary}</p>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-[color:var(--fg-muted)]">Severity</dt>
              <dd className="font-mono">{detail.props.severity}</dd>
              <dt className="text-[color:var(--fg-muted)]">Status</dt>
              <dd className="font-mono">{detail.props.status}</dd>
              {detail.props.resolution && (
                <>
                  <dt className="text-[color:var(--fg-muted)]">Resolution</dt>
                  <dd className="font-mono">{detail.props.resolution}</dd>
                </>
              )}
            </dl>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <MemoryCard label="Memory A" mk={detail.mkA} />
            <MemoryCard label="Memory B" mk={detail.mkB} />
          </div>

          {detail.props.status === 'open' && (
            <section className="mt-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
              <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('resolutionTitle')}
              </h2>
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  {t('reasonLabel')}
                </span>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy}
                  maxLength={1000}
                  className="w-full rounded border border-[color:var(--border)] px-2 py-1 text-sm"
                />
              </label>
              {mutationError !== null && (
                <p className="mb-3 border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
                  {t('error', { message: mutationError })}
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {(['a_wins', 'b_wins', 'both', 'dismiss'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => void resolve(r)}
                    disabled={busy}
                    className={[
                      'rounded border px-3 py-2 text-left text-xs disabled:opacity-50',
                      r === 'a_wins' || r === 'b_wins'
                        ? 'border-[color:var(--danger-edge)] hover:bg-[color:var(--danger)]/8'
                        : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]',
                    ].join(' ')}
                  >
                    <div className="font-semibold">
                      {t(`resolutions.${RESOLUTION_KEY[r]}.label`)}
                    </div>
                    <div className="mt-1 text-[10px] text-[color:var(--fg-muted)]">
                      {t(`resolutions.${RESOLUTION_KEY[r]}.description`)}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function MemoryCard({
  label,
  mk,
}: {
  label: string;
  mk: MemorableKnowledgeNode | null;
}): React.ReactElement {
  const t = useTranslations('adminInconsistencies.detail');
  return (
    <article className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
      <header className="mb-3 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {label}
        </span>
        {mk && (
          <Link
            href={`/memories/${encodeURIComponent(mk.id)}`}
            className="text-[10px] text-[color:var(--fg-muted)] underline-offset-2 hover:underline"
          >
            {t('openMemory')}
          </Link>
        )}
      </header>
      {!mk && (
        <p className="text-xs italic text-[color:var(--fg-muted)]">
          {t('memoryUnavailable')}
        </p>
      )}
      {mk && (
        <>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {String(mk.props.kind)}
          </div>
          <p className="text-sm text-[color:var(--fg-strong)]">
            {mk.props.summary}
          </p>
          {typeof mk.props.rationale === 'string' && (
            <p className="mt-2 text-xs text-[color:var(--fg)]">
              {mk.props.rationale}
            </p>
          )}
        </>
      )}
    </article>
  );
}
