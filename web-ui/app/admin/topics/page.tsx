'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { Button } from '@/app/_components/ui/Button';
import {
  listTopics,
  reclusterTopics,
  type TopicNodeDto,
  type TopicReclusterResultDto,
} from '../../_lib/api';

const RECLUSTER_CONFIRM_THRESHOLD = 30;

export default function TopicsListPage(): React.ReactElement {
  const [items, setItems] = useState<TopicNodeDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [similarity, setSimilarity] = useState<number>(0.6);
  const [minSize, setMinSize] = useState<number>(3);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<TopicReclusterResultDto | null>(
    null,
  );
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTopics();
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerRecluster = useCallback(async (): Promise<void> => {
    if (running) return;
    if (
      (items?.length ?? 0) > RECLUSTER_CONFIRM_THRESHOLD &&
      !window.confirm(
        `${String(items?.length ?? 0)} bestehende Topics werden gelöscht und neu gebaut. Fortfahren?`,
      )
    ) {
      return;
    }
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const result = await reclusterTopics({
        similarityThreshold: similarity,
        minClusterSize: minSize,
      });
      setRunResult(result);
      void load();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [items, load, minSize, running, similarity]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  return (
    <main className="mx-auto max-w-[1000px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Memory · Themen
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Cluster aller MemorableKnowledge nach Embedding-Ähnlichkeit. Re-Cluster
          ist destruktiv: alle bestehenden Topics werden ersetzt.
        </p>
      </header>

      <section
        aria-label="Re-Cluster"
        className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
      >
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--fg-strong)]">
          Re-Cluster
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              Cosine-Threshold (0.3-0.95)
            </span>
            <input
              type="number"
              step="0.05"
              min={0.3}
              max={0.95}
              value={similarity}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) setSimilarity(Math.min(0.95, Math.max(0.3, v)));
              }}
              className="w-full rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              Min Cluster-Größe (2-20)
            </span>
            <input
              type="number"
              min={2}
              max={20}
              value={minSize}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(v)) setMinSize(Math.min(20, Math.max(2, v)));
              }}
              className="w-full rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
            />
          </label>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void triggerRecluster()}
          disabled={running}
          busy={running}
          busyLabel="läuft"
          className="mt-3"
        >
          Re-Cluster starten
        </Button>
        {runError !== null && (
          <p className="mt-3 text-xs text-[color:var(--danger)]">
            Fehler: {runError}
          </p>
        )}
        {runResult !== null && (
          <div className="mt-3 rounded border border-[color:var(--border)] bg-black/5 p-3 text-xs">
            <p className="mb-2 font-medium">
              Ergebnis · {runResult.durationMs} ms
            </p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div>
                <dt className="text-[color:var(--fg-muted)]">scanned</dt>
                <dd className="font-mono">{runResult.totalMemoriesScanned}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">topics neu</dt>
                <dd className="font-mono">{runResult.topicsCreated}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">topics weg</dt>
                <dd className="font-mono">{runResult.topicsDeleted}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">ungeclustert</dt>
                <dd className="font-mono">{runResult.unclusteredMemories}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">Haiku-Calls</dt>
                <dd className="font-mono">{runResult.haikuCalls}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>

      {error !== null && (
        <div className="mb-4 border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          Fehler: {error}
        </div>
      )}

      {loading && <p className="text-xs text-[color:var(--fg-muted)]">lädt…</p>}

      {items !== null && items.length === 0 && error === null && (
        <p className="text-sm italic text-[color:var(--fg-muted)]">
          Keine Topics. Starte einen Re-Cluster oben.
        </p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((t) => (
            <li key={t.id}>
              <Link
                href={`/admin/topics/${encodeURIComponent(t.id)}`}
                className="block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
                  <span className="rounded bg-[color:var(--accent)]/10 px-2 py-0.5 font-mono uppercase tracking-wider text-[color:var(--accent)]">
                    {t.props.member_count} Memories
                  </span>
                  {t.props.naming_source === 'fallback' && (
                    <span className="rounded bg-[color:var(--warning)]/10 px-2 py-0.5 font-mono uppercase tracking-wider text-[color:var(--warning)]">
                      fallback-name
                    </span>
                  )}
                  <time
                    className="font-mono text-[color:var(--fg-muted)]"
                    dateTime={t.props.created_at}
                  >
                    {new Date(t.props.created_at).toLocaleString('de-DE')}
                  </time>
                </div>
                <h3 className="text-sm font-semibold text-[color:var(--fg-strong)]">
                  {t.props.name}
                </h3>
                <p className="mt-1 text-xs text-[color:var(--fg)]">
                  {t.props.description}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
