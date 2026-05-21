'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  deleteMemory,
  getMemory,
  getMemoryAudit,
  updateMemory,
  type MemorableAclAction,
  type MemorableAclAuditEntry,
  type MemorableKind,
  type MemorableKnowledgeNode,
} from '../../_lib/api';

const KINDS: readonly MemorableKind[] = [
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

const ACTION_BADGE: Record<MemorableAclAction, string> = {
  create: 'bg-green-500/20 text-green-700 dark:text-green-300',
  expand: 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
  shrink: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
  delete: 'bg-red-500/20 text-red-700 dark:text-red-300',
  edit: 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
};

const ACTION_LABELS: Record<MemorableAclAction, string> = {
  create: 'angelegt',
  expand: 'Owner ergänzt',
  shrink: 'Owner entfernt',
  delete: 'gelöscht',
  edit: 'bearbeitet',
};

/**
 * Slice 5 — MemorableKnowledge detail view.
 *
 * Loads a single MK by external_id (the dynamic `[id]` segment), shows
 * the current kind / summary / rationale / metadata, and lets the
 * authenticated owner edit content inline. Save triggers
 * PATCH /api/v1/memory/:id; Discard triggers DELETE /api/v1/memory/:id
 * and bounces to `/memories`.
 *
 * Server-side ACL gating ensures non-owners hit a 404 here — the page
 * just surfaces the API's error code without trying to mask it.
 */
export default function MemoryDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const rawId = params?.id ?? '';
  const id = useMemo(() => decodeURIComponent(rawId), [rawId]);
  const router = useRouter();

  const [node, setNode] = useState<MemorableKnowledgeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<MemorableKind>('insight');
  const [summary, setSummary] = useState('');
  const [rationale, setRationale] = useState('');
  const [reason, setReason] = useState('');

  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [audit, setAudit] = useState<MemorableAclAuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const loadAudit = useCallback(async (): Promise<void> => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await getMemoryAudit(id);
      setAudit(res.items);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err));
      setAudit([]);
    } finally {
      setAuditLoading(false);
    }
  }, [id]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await getMemory(id);
      setNode(fetched);
      setKind(fetched.props.kind);
      setSummary(fetched.props.summary);
      setRationale(fetched.props.rationale ?? '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setNode(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    queueMicrotask(() => {
      void load();
      void loadAudit();
    });
  }, [id, load, loadAudit]);

  const save = useCallback(async (): Promise<void> => {
    if (!node) return;
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length === 0) {
      setMutationError('Zusammenfassung darf nicht leer sein.');
      return;
    }
    setBusy(true);
    setMutationError(null);
    try {
      const trimmedRationale = rationale.trim();
      const existingRationale = node.props.rationale ?? '';
      const patch: Parameters<typeof updateMemory>[1] = {};
      if (kind !== node.props.kind) patch.kind = kind;
      if (trimmedSummary !== node.props.summary) patch.summary = trimmedSummary;
      if (trimmedRationale !== existingRationale) {
        patch.rationale = trimmedRationale.length > 0 ? trimmedRationale : null;
      }
      if (Object.keys(patch).length === 0) {
        setEditing(false);
        setBusy(false);
        return;
      }
      if (reason.trim().length > 0) patch.reason = reason.trim();
      const updated = await updateMemory(id, patch);
      setNode(updated);
      setKind(updated.props.kind);
      setSummary(updated.props.summary);
      setRationale(updated.props.rationale ?? '');
      setReason('');
      setEditing(false);
      void loadAudit();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [id, node, kind, summary, rationale, reason, loadAudit]);

  const discard = useCallback(async (): Promise<void> => {
    if (!node) return;
    if (
      !window.confirm(
        'Memory wirklich löschen? Audit-Trail bleibt, aber das Item verschwindet aus /memories.',
      )
    ) {
      return;
    }
    setBusy(true);
    setMutationError(null);
    try {
      await deleteMemory(id, reason.trim() || undefined);
      router.push('/memories');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [id, node, reason, router]);

  const startEdit = useCallback((): void => {
    setMutationError(null);
    setEditing(true);
  }, []);

  const cancelEdit = useCallback((): void => {
    if (!node) return;
    setKind(node.props.kind);
    setSummary(node.props.summary);
    setRationale(node.props.rationale ?? '');
    setReason('');
    setMutationError(null);
    setEditing(false);
  }, [node]);

  return (
    <main className="flex h-full flex-col">
      <header className="border-b border-neutral-200 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-3">
          <Link
            href="/memories"
            className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            ← /memories
          </Link>
          <h1 className="text-lg font-medium">Memory</h1>
          <span className="font-mono text-[10px] text-neutral-500">{id}</span>
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto bg-neutral-50 px-6 py-4 dark:bg-neutral-950">
        {loading && (
          <div className="text-xs text-neutral-500">lädt…</div>
        )}
        {loadError !== null && (
          <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {loadError === 'memory.not_found'
              ? 'Memory nicht gefunden oder du bist kein Owner.'
              : `Fehler: ${loadError}`}
          </div>
        )}

        {!loading && node !== null && (
          <article className="mx-auto max-w-2xl rounded border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-3 flex items-center justify-between gap-3">
              {editing ? (
                <div className="flex flex-wrap gap-1.5">
                  {KINDS.map((k) => (
                    <label
                      key={k}
                      className={[
                        'cursor-pointer rounded border px-2 py-1 text-xs transition',
                        kind === k
                          ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                          : 'border-neutral-300 text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="kind"
                        value={k}
                        checked={kind === k}
                        onChange={() => setKind(k)}
                        disabled={busy}
                        className="sr-only"
                      />
                      {KIND_LABELS[k]}
                    </label>
                  ))}
                </div>
              ) : (
                <span
                  className={[
                    'rounded px-2 py-0.5 text-[10px] uppercase tracking-wider',
                    KIND_BADGE[node.props.kind],
                  ].join(' ')}
                >
                  {KIND_LABELS[node.props.kind]}
                </span>
              )}
              <time
                className="font-mono text-[10px] text-neutral-500"
                dateTime={node.props.created_at}
              >
                {new Date(node.props.created_at).toLocaleString('de-DE')}
              </time>
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
                Zusammenfassung
              </label>
              {editing ? (
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  disabled={busy}
                  maxLength={2000}
                  rows={3}
                  className="w-full resize-y rounded border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
              ) : (
                <p className="text-sm text-neutral-900 dark:text-neutral-100">
                  {node.props.summary}
                </p>
              )}
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
                Begründung
              </label>
              {editing ? (
                <textarea
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  disabled={busy}
                  maxLength={10000}
                  rows={3}
                  className="w-full resize-y rounded border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                  placeholder="(optional)"
                />
              ) : node.props.rationale !== undefined ? (
                <p className="text-xs text-neutral-700 dark:text-neutral-300">
                  {node.props.rationale}
                </p>
              ) : (
                <p className="text-xs text-neutral-400">— keine —</p>
              )}
            </div>

            {editing && (
              <div className="mb-4">
                <label className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
                  Grund für die Änderung (optional, im Audit-Log)
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy}
                  maxLength={1000}
                  className="w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
              </div>
            )}

            <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10px] text-neutral-500">
              <dt>created_by</dt>
              <dd className="text-neutral-700 dark:text-neutral-300">
                {node.props.created_by}
              </dd>
              <dt>owners</dt>
              <dd className="text-neutral-700 dark:text-neutral-300">
                {node.props.acl_owners.length}
              </dd>
              {typeof node.props.significance === 'number' && (
                <>
                  <dt>significance</dt>
                  <dd>{node.props.significance.toFixed(2)}</dd>
                </>
              )}
            </dl>

            {mutationError !== null && (
              <div className="mb-3 border-l-2 border-red-400 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                Fehler: {mutationError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={busy}
                    className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={busy || summary.trim().length === 0}
                    className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    {busy ? 'speichert…' : 'Speichern'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void discard()}
                    disabled={busy}
                    className="rounded border border-red-400 px-3 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
                  >
                    Löschen
                  </button>
                  <button
                    type="button"
                    onClick={startEdit}
                    disabled={busy}
                    className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    Bearbeiten
                  </button>
                </>
              )}
            </div>
          </article>
        )}

        {!loading && node !== null && (
          <section
            aria-label="Audit-Verlauf"
            className="mx-auto mt-4 max-w-2xl rounded border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <header className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                Verlauf
              </h2>
              <button
                type="button"
                onClick={() => void loadAudit()}
                disabled={auditLoading}
                className="text-[10px] text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline disabled:opacity-50 dark:hover:text-neutral-100"
              >
                {auditLoading ? 'lädt…' : 'aktualisieren'}
              </button>
            </header>

            {auditError !== null && (
              <div className="mb-2 border-l-2 border-red-400 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                Verlauf nicht lesbar: {auditError}
              </div>
            )}
            {audit !== null && audit.length === 0 && auditError === null && (
              <p className="text-xs italic text-neutral-500">
                Keine Audit-Einträge.
              </p>
            )}
            {audit !== null && audit.length > 0 && (
              <ol className="flex flex-col gap-2">
                {audit.map((e) => {
                  const ownersDelta =
                    e.afterOwners === null
                      ? null
                      : e.afterOwners.length - e.beforeOwners.length;
                  return (
                    <li
                      key={e.id}
                      className="rounded border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[10px]">
                        <span
                          className={[
                            'rounded px-1.5 py-0.5 uppercase tracking-wider',
                            ACTION_BADGE[e.action],
                          ].join(' ')}
                        >
                          {ACTION_LABELS[e.action]}
                        </span>
                        <time
                          dateTime={e.createdAt}
                          className="font-mono text-neutral-500"
                        >
                          {new Date(e.createdAt).toLocaleString('de-DE')}
                        </time>
                        {ownersDelta !== null && ownersDelta !== 0 && (
                          <span
                            className={
                              ownersDelta > 0
                                ? 'font-mono text-green-600 dark:text-green-400'
                                : 'font-mono text-amber-600 dark:text-amber-400'
                            }
                          >
                            owners {ownersDelta > 0 ? '+' : ''}
                            {ownersDelta}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-neutral-500">
                        actor: {e.actorOmadiaUserId}
                      </div>
                      {(e.action === 'expand' ||
                        e.action === 'shrink' ||
                        e.action === 'delete') && (
                        <div className="mt-1 grid grid-cols-[max-content_1fr] gap-x-2 font-mono text-[10px] text-neutral-500">
                          <span>before:</span>
                          <span className="text-neutral-700 dark:text-neutral-300">
                            [{e.beforeOwners.join(', ') || '—'}]
                          </span>
                          <span>after:</span>
                          <span className="text-neutral-700 dark:text-neutral-300">
                            {e.afterOwners === null
                              ? '(deleted)'
                              : `[${e.afterOwners.join(', ') || '—'}]`}
                          </span>
                        </div>
                      )}
                      {e.reason !== undefined && e.reason.length > 0 && (
                        <p className="mt-1 text-xs italic text-neutral-600 dark:text-neutral-400">
                          „{e.reason}“
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
