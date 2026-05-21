'use client';

import { useCallback, useEffect, useState } from 'react';

import type { GraphNode } from './graphTypes';

interface AclAuditEntry {
  id: string;
  memoryExternalId: string;
  actorOmadiaUserId: string;
  actorChannelIdentityId?: string;
  action: 'create' | 'expand' | 'shrink' | 'delete';
  beforeOwners: string[];
  afterOwners: string[] | null;
  reason?: string;
  createdAt: string;
}

type Tab = 'owners' | 'audit';

interface Props {
  /** The MemorableKnowledge node being inspected. */
  memory: GraphNode;
  /** When the memory is deleted, the parent panel should drop it from
   *  the selection / refresh the graph. */
  onDeleted: () => void;
}

/**
 * Slice 3c — ACL surface attached to the MemorableKnowledge detail
 * view. Reads `props.acl_owners` for the owner list and lets the
 * authenticated session caller add/remove owners + delete the memory
 * + view the audit log. All mutations route through
 * `/bot-api/v1/memory/...` which the middleware gates by the session
 * cookie (`optionalAuth` populates req.session, the route then
 * 401s without one).
 */
export default function MemoryAclSection({
  memory,
  onDeleted,
}: Props): React.ReactElement {
  const memoryId = memory.id;
  const ownersFromProps = Array.isArray(memory.props['acl_owners'])
    ? (memory.props['acl_owners'] as string[])
    : [];

  const [tab, setTab] = useState<Tab>('owners');
  const [owners, setOwners] = useState<string[]>(ownersFromProps);
  const [addInput, setAddInput] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AclAuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    setOwners(ownersFromProps);
    // ownersFromProps is recomputed each render so we depend on its
    // serialised form to avoid a per-render reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(ownersFromProps)]);

  const loadAudit = useCallback(async () => {
    setAuditError(null);
    try {
      const res = await fetch(
        `/bot-api/v1/memory/${encodeURIComponent(memoryId)}/audit`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        setAuditError(body?.code ?? `HTTP ${res.status}`);
        setAudit([]);
        return;
      }
      const body = (await res.json()) as { items: AclAuditEntry[] };
      setAudit(body.items);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'fetch failed');
      setAudit([]);
    }
  }, [memoryId]);

  useEffect(() => {
    if (tab === 'audit' && audit === null) void loadAudit();
  }, [tab, audit, loadAudit]);

  const addOwner = useCallback(async () => {
    const id = addInput.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/bot-api/v1/memory/${encodeURIComponent(memoryId)}/owners`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            omadiaUserId: id,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        setError(body?.code ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { owners: string[] };
      setOwners(body.owners);
      setAddInput('');
      setReason('');
      setAudit(null); // force reload on next audit-tab visit
    } finally {
      setBusy(false);
    }
  }, [addInput, memoryId, reason]);

  const removeOwner = useCallback(
    async (userId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/bot-api/v1/memory/${encodeURIComponent(memoryId)}/owners/${encodeURIComponent(
            userId,
          )}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              reason.trim() ? { reason: reason.trim() } : {},
            ),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            code?: string;
          } | null;
          setError(body?.code ?? `HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as { owners: string[] };
        setOwners(body.owners);
        setReason('');
        setAudit(null);
      } finally {
        setBusy(false);
      }
    },
    [memoryId, reason],
  );

  const deleteMemory = useCallback(async () => {
    if (
      !window.confirm(
        'Memory wirklich löschen? Audit-Trail bleibt erhalten.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/bot-api/v1/memory/${encodeURIComponent(memoryId)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            reason.trim() ? { reason: reason.trim() } : {},
          ),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        setError(body?.code ?? `HTTP ${res.status}`);
        return;
      }
      onDeleted();
    } finally {
      setBusy(false);
    }
  }, [memoryId, onDeleted, reason]);

  return (
    <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
      <div className="mb-2 flex gap-1 text-[10px] font-semibold uppercase tracking-wide">
        <button
          type="button"
          onClick={() => setTab('owners')}
          className={`rounded px-2 py-0.5 ${
            tab === 'owners'
              ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
          }`}
        >
          Owners ({owners.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('audit')}
          className={`rounded px-2 py-0.5 ${
            tab === 'audit'
              ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
          }`}
        >
          Audit
        </button>
      </div>

      {tab === 'owners' && (
        <div className="flex flex-col gap-2">
          {owners.length === 0 ? (
            <div className="text-[11px] italic text-neutral-500">
              Keine Owner — Memory ist Admin-only invisible.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {owners.map((id) => (
                <li
                  key={id}
                  className="flex items-center gap-1 rounded border border-neutral-200 px-2 py-1 dark:border-neutral-700"
                >
                  <span className="grow truncate font-mono text-[10px]">
                    {id}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removeOwner(id)}
                    className="rounded border border-neutral-300 px-1 text-[10px] hover:border-red-400 hover:text-red-500 disabled:opacity-50 dark:border-neutral-700"
                    title="Owner entfernen"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1">
            <input
              type="text"
              placeholder="omadiaUserId (uuid) hinzufügen"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1 font-mono text-[10px] dark:border-neutral-700 dark:bg-neutral-800"
              disabled={busy}
            />
            <input
              type="text"
              placeholder="Grund (optional, im Audit-Log)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1 text-[10px] dark:border-neutral-700 dark:bg-neutral-800"
              disabled={busy}
            />
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => void addOwner()}
                disabled={busy || addInput.trim().length === 0}
                className="grow rounded border border-neutral-300 px-2 py-1 text-[11px] hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
              >
                + Owner hinzufügen
              </button>
              <button
                type="button"
                onClick={() => void deleteMemory()}
                disabled={busy}
                className="rounded border border-red-400 px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                title="Memory hart löschen (Audit-Trail bleibt)"
              >
                Delete
              </button>
            </div>
          </div>

          {error && (
            <div className="text-[11px] text-red-500">Fehler: {error}</div>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <div className="flex flex-col gap-2">
          {auditError && (
            <div className="text-[11px] text-red-500">
              Audit nicht lesbar: {auditError}
            </div>
          )}
          {audit === null && !auditError && (
            <div className="text-[11px] italic text-neutral-500">
              lädt Audit-Trail…
            </div>
          )}
          {audit?.length === 0 && !auditError && (
            <div className="text-[11px] italic text-neutral-500">
              Keine Audit-Einträge.
            </div>
          )}
          {audit && audit.length > 0 && (
            <ul className="flex flex-col gap-2">
              {audit.map((e) => (
                <li
                  key={e.id}
                  className="rounded border border-neutral-200 p-2 dark:border-neutral-700"
                >
                  <div className="flex items-center gap-2 text-[10px]">
                    <span
                      className={
                        e.action === 'create'
                          ? 'rounded bg-green-500/20 px-1 text-green-500'
                          : e.action === 'expand'
                            ? 'rounded bg-cyan-500/20 px-1 text-cyan-500'
                            : e.action === 'shrink'
                              ? 'rounded bg-amber-500/20 px-1 text-amber-500'
                              : 'rounded bg-red-500/20 px-1 text-red-500'
                      }
                    >
                      {e.action}
                    </span>
                    <span className="text-neutral-400">
                      {new Date(e.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-neutral-500">
                    actor: {e.actorOmadiaUserId}
                  </div>
                  <div className="font-mono text-[10px] text-neutral-500">
                    before: [{e.beforeOwners.join(', ') || '—'}]
                  </div>
                  <div className="font-mono text-[10px] text-neutral-500">
                    after:{' '}
                    {e.afterOwners === null
                      ? '(deleted)'
                      : `[${e.afterOwners.join(', ') || '—'}]`}
                  </div>
                  {e.reason && (
                    <div className="mt-1 text-[10px] italic text-neutral-600 dark:text-neutral-400">
                      „{e.reason}“
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
