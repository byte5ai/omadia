'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  getExcerptMergeDetail,
  resolveExcerptMergeCandidate,
  type ExcerptMergeDetailDto,
  type ExcerptMergeResolution,
} from '../../../../_lib/api';

const RESOLUTION_LABEL: Record<ExcerptMergeResolution, string> = {
  keep_a: 'A behalten → B löschen',
  keep_b: 'B behalten → A löschen',
  not_duplicate: 'Kein Duplikat (Detector hat überschossen)',
};

const RESOLUTION_DESCRIPTION: Record<ExcerptMergeResolution, string> = {
  keep_a:
    'Behält Excerpt A als kanonisches Zitat und löscht Excerpt B endgültig vom Parent-MK. Provenance-Audit-Row (delete_excerpt) bleibt im memory_acl_audit erhalten.',
  keep_b:
    'Behält Excerpt B als kanonisches Zitat und löscht Excerpt A endgültig.',
  not_duplicate:
    'Markiert das Paar als „kein Duplikat". Beide Excerpts bleiben unverändert. Wird nicht erneut geprüft.',
};

export default function ExcerptDuplicateDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = useMemo(() => decodeURIComponent(params?.id ?? ''), [params]);

  const [detail, setDetail] = useState<ExcerptMergeDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      setDetail(await getExcerptMergeDetail(id));
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
    async (resolution: ExcerptMergeResolution): Promise<void> => {
      if (!detail) return;
      const destructive = resolution === 'keep_a' || resolution === 'keep_b';
      const targetExcerpt =
        resolution === 'keep_a'
          ? detail.excerptB
          : resolution === 'keep_b'
            ? detail.excerptA
            : null;
      const confirmText =
        destructive && targetExcerpt
          ? `Excerpt wird endgültig gelöscht: "${targetExcerpt.props.text.slice(0, 100)}". Fortfahren?`
          : `Duplikat-Status auf "${RESOLUTION_LABEL[resolution]}" setzen?`;
      if (!window.confirm(confirmText)) return;
      setBusy(true);
      setMutationError(null);
      try {
        await resolveExcerptMergeCandidate(id, {
          resolution,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
        router.push('/admin/duplicates');
      } catch (err) {
        setMutationError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [id, detail, reason, router],
  );

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin/duplicates"
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← /admin/duplicates
        </Link>
        <h1 className="mt-2 font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Excerpt-Duplikat auflösen
        </h1>
      </header>

      {loading && <p className="text-xs text-neutral-500">lädt…</p>}
      {loadError !== null && (
        <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Fehler: {loadError}
        </div>
      )}

      {detail !== null && (
        <>
          <section className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Detector-Befund
            </h2>
            <p className="text-sm">
              Cosine-Ähnlichkeit{' '}
              <span className="font-mono">{detail.props.cosine_sim.toFixed(3)}</span>{' '}
              — Excerpts sind fast wörtlich identisch.
            </p>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-neutral-500">Status</dt>
              <dd className="font-mono">{detail.props.status}</dd>
              {detail.props.resolution && (
                <>
                  <dt className="text-neutral-500">Resolution</dt>
                  <dd className="font-mono">{detail.props.resolution}</dd>
                </>
              )}
            </dl>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <ExcerptCard
              label="Excerpt A"
              excerpt={detail.excerptA}
              parentMk={detail.mkA}
            />
            <ExcerptCard
              label="Excerpt B"
              excerpt={detail.excerptB}
              parentMk={detail.mkB}
            />
          </div>

          {detail.props.status === 'open' && (
            <section className="mt-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
              <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Auflösung
              </h2>
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
                  Begründung (optional, im Audit-Log)
                </span>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy}
                  maxLength={1000}
                  className="w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                />
              </label>
              {mutationError !== null && (
                <p className="mb-3 border-l-2 border-red-400 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                  Fehler: {mutationError}
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-1">
                {(['keep_a', 'keep_b', 'not_duplicate'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => void resolve(r)}
                    disabled={busy}
                    className={[
                      'rounded border px-3 py-2 text-left text-xs disabled:opacity-50',
                      r === 'keep_a' || r === 'keep_b'
                        ? 'border-red-400 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/30'
                        : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-700',
                    ].join(' ')}
                  >
                    <div className="font-semibold">{RESOLUTION_LABEL[r]}</div>
                    <div className="mt-1 text-[10px] text-neutral-500">
                      {RESOLUTION_DESCRIPTION[r]}
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

function ExcerptCard({
  label,
  excerpt,
  parentMk,
}: {
  label: string;
  excerpt: ExcerptMergeDetailDto['excerptA'];
  parentMk: ExcerptMergeDetailDto['mkA'];
}): React.ReactElement {
  return (
    <article className="rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
      <header className="mb-3 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          {label}
        </span>
        {parentMk && (
          <Link
            href={`/memories/${encodeURIComponent(parentMk.id)}`}
            className="text-[10px] text-neutral-500 underline-offset-2 hover:underline"
          >
            zur Parent-Memory →
          </Link>
        )}
      </header>
      {!excerpt && (
        <p className="text-xs italic text-neutral-500">
          Excerpt nicht zugänglich (gelöscht oder kein Owner).
        </p>
      )}
      {excerpt && (
        <>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            Position {excerpt.props.position} · {excerpt.props.source}
          </div>
          <p className="text-sm text-neutral-900 dark:text-neutral-100">
            „{excerpt.props.text}&ldquo;
          </p>
          {parentMk && (
            <p className="mt-3 text-[11px] text-neutral-500">
              Parent-Memory: {String(parentMk.props.summary)}
            </p>
          )}
        </>
      )}
    </article>
  );
}
