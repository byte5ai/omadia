'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import { Button } from '@/app/_components/ui/Button';

import {
  deleteMemory,
  getMemory,
  getMemoryAudit,
  getMemoryExcerpts,
  updateMemory,
  updateMemoryExcerpt,
  type ExcerptSource,
  type MemorableAclAction,
  type MemorableAclAuditEntry,
  type MemorableKind,
  type MemorableKnowledgeNode,
  type PalaiaExcerptNode,
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
    'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
  insight:
    'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  preference:
    'bg-[color:var(--success)]/10 text-[color:var(--success)]',
  reference:
    'bg-[color:var(--bg-soft)] text-[color:var(--fg)]',
};

const ACTION_BADGE: Record<MemorableAclAction, string> = {
  create: 'bg-[color:var(--success)]/20 text-[color:var(--success)]',
  expand: 'bg-[color:var(--accent)]/20 text-[color:var(--accent)]',
  shrink: 'bg-[color:var(--warning)]/20 text-[color:var(--warning)]',
  delete: 'bg-[color:var(--danger)]/20 text-[color:var(--danger)]',
  edit: 'bg-[color:var(--accent)]/20 text-[color:var(--accent)]',
  edit_excerpt: 'bg-[color:var(--accent)]/20 text-[color:var(--accent)]',
};

const ACTION_LABELS: Record<MemorableAclAction, string> = {
  create: 'angelegt',
  expand: 'Owner ergänzt',
  shrink: 'Owner entfernt',
  delete: 'gelöscht',
  edit: 'bearbeitet',
  edit_excerpt: 'Excerpt bearbeitet',
};

const SOURCE_LABELS: Record<ExcerptSource, string> = {
  llm: 'LLM-extrahiert',
  hint: 'Hint-übernommen',
  fallback: 'Fallback',
};

const SOURCE_BADGE: Record<ExcerptSource, string> = {
  llm: 'bg-[color:var(--state-loading)] text-[color:var(--fg)]',
  hint: 'bg-[color:var(--warning)] text-[color:var(--warning)]',
  fallback:
    'bg-[color:var(--warning)] text-[color:var(--warning)]',
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

  const [excerpts, setExcerpts] = useState<PalaiaExcerptNode[] | null>(null);
  const [excerptsError, setExcerptsError] = useState<string | null>(null);
  const [editingExcerptPos, setEditingExcerptPos] = useState<number | null>(
    null,
  );
  const [excerptDraft, setExcerptDraft] = useState('');
  const [excerptDraftSource, setExcerptDraftSource] =
    useState<ExcerptSource>('llm');
  const [excerptBusy, setExcerptBusy] = useState(false);
  const [copiedPos, setCopiedPos] = useState<number | null>(null);

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

  const loadExcerpts = useCallback(async (): Promise<void> => {
    setExcerptsError(null);
    try {
      const res = await getMemoryExcerpts(id);
      setExcerpts(res.items);
    } catch (err) {
      setExcerptsError(err instanceof Error ? err.message : String(err));
      setExcerpts([]);
    }
  }, [id]);

  const startExcerptEdit = useCallback((excerpt: PalaiaExcerptNode): void => {
    setEditingExcerptPos(excerpt.props.position);
    setExcerptDraft(excerpt.props.text);
    setExcerptDraftSource(excerpt.props.source);
  }, []);

  const cancelExcerptEdit = useCallback((): void => {
    setEditingExcerptPos(null);
    setExcerptDraft('');
  }, []);

  const saveExcerptEdit = useCallback(async (): Promise<void> => {
    if (editingExcerptPos === null) return;
    const trimmed = excerptDraft.trim();
    if (trimmed.length === 0) return;
    setExcerptBusy(true);
    try {
      await updateMemoryExcerpt(id, editingExcerptPos, {
        text: trimmed,
        source: excerptDraftSource,
      });
      setEditingExcerptPos(null);
      setExcerptDraft('');
      await Promise.all([loadExcerpts(), loadAudit()]);
    } catch (err) {
      setExcerptsError(err instanceof Error ? err.message : String(err));
    } finally {
      setExcerptBusy(false);
    }
  }, [
    id,
    editingExcerptPos,
    excerptDraft,
    excerptDraftSource,
    loadExcerpts,
    loadAudit,
  ]);

  const copyExcerpt = useCallback(async (excerpt: PalaiaExcerptNode): Promise<void> => {
    try {
      await navigator.clipboard.writeText(excerpt.props.text);
      setCopiedPos(excerpt.props.position);
      window.setTimeout(() => {
        setCopiedPos((prev) => (prev === excerpt.props.position ? null : prev));
      }, 1500);
    } catch {
      // Clipboard rejection (insecure context, denied) — fall back to a
      // visible toast on the row by reusing copiedPos sentinel = -1.
      setCopiedPos(-1);
    }
  }, []);

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
      void loadExcerpts();
    });
  }, [id, load, loadAudit, loadExcerpts]);

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
      <header className="border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            href="/memories"
            className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            ← /memories
          </Link>
          <h1 className="text-lg font-medium">Memory</h1>
          <span className="font-mono text-[10px] text-[color:var(--fg-muted)]">{id}</span>
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto bg-[color:var(--bg-soft)] px-6 py-4">
        {loading && (
          <div className="text-xs text-[color:var(--fg-muted)]">lädt…</div>
        )}
        {loadError !== null && (
          <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
            {loadError === 'memory.not_found'
              ? 'Memory nicht gefunden oder du bist kein Owner.'
              : `Fehler: ${loadError}`}
          </div>
        )}

        {!loading && node !== null && (
          <article className="mx-auto max-w-2xl rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              {editing ? (
                <div className="flex flex-wrap gap-2">
                  {KINDS.map((k) => (
                    <label
                      key={k}
                      className={[
                        'cursor-pointer rounded border px-2 py-1 text-xs transition',
                        kind === k
                          ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                          : 'border-[color:var(--border)] text-[color:var(--fg)] hover:border-[color:var(--border-strong)]',
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
                className="font-mono text-[10px] text-[color:var(--fg-muted)]"
                dateTime={node.props.created_at}
              >
                {new Date(node.props.created_at).toLocaleString('de-DE')}
              </time>
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                Zusammenfassung
              </label>
              {editing ? (
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  disabled={busy}
                  maxLength={2000}
                  rows={3}
                  className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-2 text-sm focus:border-[color:var(--border-strong)] focus:outline-none"
                />
              ) : (
                <p className="text-sm text-[color:var(--fg-strong)]">
                  {node.props.summary}
                </p>
              )}
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                Begründung
              </label>
              {editing ? (
                <textarea
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  disabled={busy}
                  maxLength={10000}
                  rows={3}
                  className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-2 text-sm focus:border-[color:var(--border-strong)] focus:outline-none"
                  placeholder="(optional)"
                />
              ) : node.props.rationale !== undefined ? (
                <p className="text-xs text-[color:var(--fg)]">
                  {node.props.rationale}
                </p>
              ) : (
                <p className="text-xs text-[color:var(--fg-subtle)]">— keine —</p>
              )}
            </div>

            {editing && (
              <div className="mb-4">
                <label className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  Grund für die Änderung (optional, im Audit-Log)
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy}
                  maxLength={1000}
                  className="w-full rounded border border-[color:var(--border)] px-2 py-1 text-xs focus:border-[color:var(--border-strong)] focus:outline-none"
                />
              </div>
            )}

            <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10px] text-[color:var(--fg-muted)]">
              <dt>created_by</dt>
              <dd className="text-[color:var(--fg)]">
                {node.props.created_by}
              </dd>
              <dt>owners</dt>
              <dd className="text-[color:var(--fg)]">
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
              <div className="mb-3 border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
                Fehler: {mutationError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {editing ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={cancelEdit}
                    disabled={busy}
                  >
                    Abbrechen
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void save()}
                    disabled={busy || summary.trim().length === 0}
                    busy={busy}
                    busyLabel="speichert…"
                  >
                    Speichern
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void discard()}
                    disabled={busy}
                  >
                    Löschen
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={startEdit}
                    disabled={busy}
                  >
                    Bearbeiten
                  </Button>
                </>
              )}
            </div>
          </article>
        )}

        {!loading && node !== null && (
          <section
            aria-label="Quellen-Snippets"
            className="mx-auto mt-4 max-w-2xl rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-sm"
          >
            <header className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                  Quellen-Snippets
                </h2>
                <p className="mt-0.5 text-[10px] text-[color:var(--fg-muted)]">
                  Verbatim aus dem ursprünglichen Turn — Provenance-Anker für die Memory.
                </p>
              </div>
            </header>

            {excerptsError !== null && (
              <div className="mb-2 border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
                Snippets nicht lesbar: {excerptsError}
              </div>
            )}
            {excerpts !== null && excerpts.length === 0 && excerptsError === null && (
              <p className="text-xs italic text-[color:var(--fg-muted)]">
                Keine Quellen-Snippets — Memory wurde vor Slice 6.5 gespeichert oder
                der Extractor lieferte keine Excerpts.
              </p>
            )}
            {excerpts !== null && excerpts.length > 0 && (
              <ol className="flex flex-col gap-2">
                {excerpts.map((ex) => {
                  const isEditing = editingExcerptPos === ex.props.position;
                  const justCopied = copiedPos === ex.props.position;
                  return (
                    <li
                      key={ex.id}
                      className="rounded border border-[color:var(--border)] px-3 py-2"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[10px]">
                          <span className="font-mono text-[color:var(--fg-muted)]">
                            #{ex.props.position + 1}
                          </span>
                          <span
                            className={[
                              'rounded px-2 py-0.5 uppercase tracking-wider',
                              SOURCE_BADGE[ex.props.source],
                            ].join(' ')}
                          >
                            {SOURCE_LABELS[ex.props.source]}
                          </span>
                        </div>
                        {!isEditing && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void copyExcerpt(ex)}
                              className="px-2 py-0.5 text-[10px] text-[color:var(--fg-muted)]"
                              title="Snippet in die Zwischenablage kopieren"
                            >
                              {justCopied ? '✓ kopiert' : 'kopieren'}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => startExcerptEdit(ex)}
                              className="px-2 py-0.5 text-[10px] text-[color:var(--fg-muted)]"
                            >
                              bearbeiten
                            </Button>
                          </div>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            value={excerptDraft}
                            onChange={(e) => setExcerptDraft(e.target.value)}
                            disabled={excerptBusy}
                            maxLength={300}
                            rows={3}
                            className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-1 text-sm focus:border-[color:var(--border-strong)] focus:outline-none"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="text-[10px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                              Quelle:
                            </label>
                            {(['llm', 'hint', 'fallback'] as const).map((s) => (
                              <label
                                key={s}
                                className={[
                                  'cursor-pointer rounded border px-2 py-0.5 text-[10px]',
                                  excerptDraftSource === s
                                    ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                                    : 'border-[color:var(--border)] text-[color:var(--fg)]',
                                ].join(' ')}
                              >
                                <input
                                  type="radio"
                                  name={`excerpt-source-${String(ex.props.position)}`}
                                  value={s}
                                  checked={excerptDraftSource === s}
                                  onChange={() => setExcerptDraftSource(s)}
                                  disabled={excerptBusy}
                                  className="sr-only"
                                />
                                {SOURCE_LABELS[s]}
                              </label>
                            ))}
                            <div className="ml-auto flex gap-1">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={cancelExcerptEdit}
                                disabled={excerptBusy}
                                className="px-2 py-0.5 text-[10px]"
                              >
                                Abbrechen
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void saveExcerptEdit()}
                                disabled={
                                  excerptBusy || excerptDraft.trim().length === 0
                                }
                                busy={excerptBusy}
                                busyLabel="speichert…"
                                className="px-2 py-0.5 text-[10px]"
                              >
                                Speichern
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap text-sm text-[color:var(--fg)]">
                          {ex.props.text}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {copiedPos === -1 && (
              <p className="mt-2 text-[10px] italic text-[color:var(--warning)]">
                Kopieren fehlgeschlagen (Browser blockiert Clipboard).
              </p>
            )}
          </section>
        )}

        {!loading && node !== null && (
          <section
            aria-label="Audit-Verlauf"
            className="mx-auto mt-4 max-w-2xl rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4 shadow-sm"
          >
            <header className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                Verlauf
              </h2>
              <button
                type="button"
                onClick={() => void loadAudit()}
                disabled={auditLoading}
                className="text-[10px] text-[color:var(--fg-muted)] underline-offset-2 hover:text-[color:var(--fg-strong)] hover:underline disabled:opacity-50"
              >
                {auditLoading ? 'lädt…' : 'aktualisieren'}
              </button>
            </header>

            {auditError !== null && (
              <div className="mb-2 border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
                Verlauf nicht lesbar: {auditError}
              </div>
            )}
            {audit !== null && audit.length === 0 && auditError === null && (
              <p className="text-xs italic text-[color:var(--fg-muted)]">
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
                      className="rounded border border-[color:var(--border)] px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[10px]">
                        <span
                          className={[
                            'rounded px-2 py-0.5 uppercase tracking-wider',
                            ACTION_BADGE[e.action],
                          ].join(' ')}
                        >
                          {ACTION_LABELS[e.action]}
                        </span>
                        <time
                          dateTime={e.createdAt}
                          className="font-mono text-[color:var(--fg-muted)]"
                        >
                          {new Date(e.createdAt).toLocaleString('de-DE')}
                        </time>
                        {ownersDelta !== null && ownersDelta !== 0 && (
                          <span
                            className={
                              ownersDelta > 0
                                ? 'font-mono text-[color:var(--success)]'
                                : 'font-mono text-[color:var(--warning)]'
                            }
                          >
                            owners {ownersDelta > 0 ? '+' : ''}
                            {ownersDelta}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-[color:var(--fg-muted)]">
                        actor: {e.actorOmadiaUserId}
                      </div>
                      {(e.action === 'expand' ||
                        e.action === 'shrink' ||
                        e.action === 'delete') && (
                        <div className="mt-1 grid grid-cols-[max-content_1fr] gap-x-2 font-mono text-[10px] text-[color:var(--fg-muted)]">
                          <span>before:</span>
                          <span className="text-[color:var(--fg)]">
                            [{e.beforeOwners.join(', ') || '—'}]
                          </span>
                          <span>after:</span>
                          <span className="text-[color:var(--fg)]">
                            {e.afterOwners === null
                              ? '(deleted)'
                              : `[${e.afterOwners.join(', ') || '—'}]`}
                          </span>
                        </div>
                      )}
                      {e.reason !== undefined && e.reason.length > 0 && (
                        <p className="mt-1 text-xs italic text-[color:var(--fg-muted)]">
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
