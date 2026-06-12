'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  getMergeCandidateDetail,
  resolveMergeCandidate,
  type MemorableKnowledgeNode,
  type MergeCandidateDetailDto,
  type MergeCandidateResolution,
} from '../../../_lib/api';

const RESOLUTION_LABEL: Record<MergeCandidateResolution, string> = {
  keep_a: 'A behalten → B löschen',
  keep_b: 'B behalten → A löschen',
  not_duplicate: 'Kein Duplikat (Detector hat überschossen)',
};

const RESOLUTION_DESCRIPTION: Record<MergeCandidateResolution, string> = {
  keep_a:
    'Markiert Memory A als kanonische Variante und löscht Memory B endgültig. Audit-Trail bleibt erhalten.',
  keep_b:
    'Markiert Memory B als kanonische Variante und löscht Memory A endgültig. Audit-Trail bleibt erhalten.',
  not_duplicate:
    'Markiert das Paar als „kein Duplikat". Beide Memories bleiben unverändert. Wird nicht erneut geprüft.',
};

export default function DuplicateDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = useMemo(() => decodeURIComponent(params?.id ?? ''), [params]);

  const [detail, setDetail] = useState<MergeCandidateDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await getMergeCandidateDetail(id);
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
    async (resolution: MergeCandidateResolution): Promise<void> => {
      if (!detail) return;
      const destructive = resolution === 'keep_a' || resolution === 'keep_b';
      const target =
        resolution === 'keep_a'
          ? detail.mkB
          : resolution === 'keep_b'
            ? detail.mkA
            : null;
      const confirmText =
        destructive && target
          ? `Memory wird endgültig gelöscht: "${target.props.summary.slice(0, 100)}". Fortfahren?`
          : `Duplikat-Status auf "${RESOLUTION_LABEL[resolution]}" setzen?`;
      if (!window.confirm(confirmText)) return;
      setBusy(true);
      setMutationError(null);
      try {
        await resolveMergeCandidate(id, {
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
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin/duplicates
        </Link>
        <h1 className="mt-2 font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Duplikat auflösen
        </h1>
      </header>

      {loading && <p className="text-xs text-[color:var(--fg-muted)]">lädt…</p>}
      {loadError !== null && (
        <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          Fehler: {loadError}
        </div>
      )}

      {detail !== null && (
        <>
          <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
              Detector-Befund
            </h2>
            <p className="text-sm">
              Cosine-Ähnlichkeit{' '}
              <span className="font-mono">{detail.props.cosine_sim.toFixed(3)}</span>{' '}
              — Memories sind fast identisch.
            </p>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
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
            <section className="mt-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
              <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                Auflösung
              </h2>
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  Begründung (optional, im Audit-Log)
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
                        ? 'border-[color:var(--danger-edge)] hover:bg-[color:var(--danger)]/8'
                        : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]',
                    ].join(' ')}
                  >
                    <div className="font-semibold">{RESOLUTION_LABEL[r]}</div>
                    <div className="mt-1 text-[10px] text-[color:var(--fg-muted)]">
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

function MemoryCard({
  label,
  mk,
}: {
  label: string;
  mk: MemorableKnowledgeNode | null;
}): React.ReactElement {
  return (
    <article className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
      <header className="mb-3 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {label}
        </span>
        {mk && (
          <Link
            href={`/memories/${encodeURIComponent(mk.id)}`}
            className="text-[10px] text-[color:var(--fg-muted)] underline-offset-2 hover:underline"
          >
            zur Memory →
          </Link>
        )}
      </header>
      {!mk && (
        <p className="text-xs italic text-[color:var(--fg-muted)]">
          Memory nicht zugänglich (gelöscht oder kein Owner).
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
