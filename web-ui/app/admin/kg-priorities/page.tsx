'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Admin → Knowledge-Graph Priorities (palaia Phase 5 / OB-74 Slice 5).
 *
 * Operator table for the per-agent block/boost list consumed by the
 * `ContextRetriever.assembleForBudget` assembler. Each row:
 *   - agent ID (e.g. de.byte5.agent.calendar)
 *   - entry_external_id (turn ID or session ID)
 *   - action (block | boost)
 *   - weight (for boost; default 1.3)
 *   - reason (optional)
 *   - updated_at
 *
 * Backed by `/bot-api/dev/graph/priorities/{agentId}` (GET → list,
 * POST → upsert, DELETE → remove). Mounted only when DEV_ENDPOINTS_ENABLED
 * + agentPriorities@1 is published; otherwise the page shows an empty state.
 */

type AgentPriorityRecord = {
  agentId: string;
  entryExternalId: string;
  action: 'block' | 'boost';
  weight: number;
  reason: string | null;
  updatedAt: string;
};

const STAT_BASE = '/bot-api/dev/graph/priorities';
const DEFAULT_AGENT = 'orchestrator-default';

export default function KgPrioritiesPage(): React.ReactElement {
  const [agentId, setAgentId] = useState<string>(DEFAULT_AGENT);
  const [records, setRecords] = useState<AgentPriorityRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [draftEntry, setDraftEntry] = useState<string>('');
  const [draftAction, setDraftAction] = useState<'block' | 'boost'>('block');
  const [draftWeight, setDraftWeight] = useState<string>('1.3');
  const [draftReason, setDraftReason] = useState<string>('');

  const reload = useCallback(async () => {
    if (agentId.trim().length === 0) return;
    try {
      setError(null);
      const res = await fetch(
        `${STAT_BASE}/${encodeURIComponent(agentId.trim())}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        throw new Error(`${String(res.status)} ${res.statusText}`);
      }
      const body = (await res.json()) as { records: AgentPriorityRecord[] };
      setRecords(body.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleUpsert = useCallback(
    async (
      action: 'block' | 'boost',
      entryExternalId: string,
      weight: number,
      reason: string | null,
    ): Promise<void> => {
      const trimmed = entryExternalId.trim();
      if (trimmed.length === 0) {
        setError('entry_external_id required');
        return;
      }
      setBusy('upsert');
      try {
        setError(null);
        const res = await fetch(
          `${STAT_BASE}/${encodeURIComponent(agentId.trim())}/${encodeURIComponent(trimmed)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, weight, reason }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `${String(res.status)} ${res.statusText}`);
        }
        await reload();
        setDraftEntry('');
        setDraftReason('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [agentId, reload],
  );

  const handleRemove = useCallback(
    async (entryExternalId: string): Promise<void> => {
      setBusy(`remove:${entryExternalId}`);
      try {
        setError(null);
        const res = await fetch(
          `${STAT_BASE}/${encodeURIComponent(agentId.trim())}/${encodeURIComponent(entryExternalId)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          throw new Error(`${String(res.status)} ${res.statusText}`);
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [agentId, reload],
  );

  const sortedRecords = useMemo(
    () => [...records].sort((a, b) => a.entryExternalId.localeCompare(b.entryExternalId)),
    [records],
  );

  return (
    <main className="mx-auto max-w-[1200px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Knowledge-Graph Priorities
        </h1>
        <p className="mt-3 max-w-3xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Per-Agent Block/Boost-Liste für den Token-Budget-Assembler. Block
          droppt einen Turn aus dem Recall-Pool; Boost multipliziert den
          Score mit `weight` (Default 1.3). `manuallyAuthored=true` bringt
          zusätzlich einen unabhängigen ×1.3 Boost — beide kombinieren.
        </p>
      </header>

      <section className="mb-8 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
        <label className="block text-sm font-semibold text-[color:var(--fg-strong)]">
          Agent-ID
        </label>
        <div className="mt-2 flex gap-3">
          <input
            type="text"
            value={agentId}
            onChange={(e) => { setAgentId(e.target.value); }}
            placeholder="de.byte5.agent.calendar oder orchestrator-default"
            className="flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-sm text-[color:var(--fg-strong)]"
          />
          <button
            type="button"
            onClick={() => { void reload(); }}
            className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm font-medium text-[color:var(--fg-strong)] hover:bg-[color:var(--card)]"
          >
            Laden
          </button>
        </div>
      </section>

      {error !== null ? (
        <div className="mb-6 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      ) : null}

      <section className="mb-8 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
        <h2 className="text-lg font-semibold text-[color:var(--fg-strong)]">
          Neuer Eintrag
        </h2>
        <div className="mt-4 grid gap-3 lg:grid-cols-12">
          <input
            type="text"
            value={draftEntry}
            onChange={(e) => { setDraftEntry(e.target.value); }}
            placeholder="turn:scope:2026-05-08T08:00:00.000Z"
            className="lg:col-span-5 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-sm text-[color:var(--fg-strong)]"
          />
          <select
            value={draftAction}
            onChange={(e) => { setDraftAction(e.target.value as 'block' | 'boost'); }}
            className="lg:col-span-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-sm text-[color:var(--fg-strong)]"
          >
            <option value="block">block</option>
            <option value="boost">boost</option>
          </select>
          <input
            type="number"
            step="0.1"
            min="0"
            value={draftWeight}
            onChange={(e) => { setDraftWeight(e.target.value); }}
            className="lg:col-span-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-sm text-[color:var(--fg-strong)]"
            disabled={draftAction === 'block'}
            title={draftAction === 'block' ? 'weight ignoriert für block' : 'score multiplier'}
          />
          <input
            type="text"
            value={draftReason}
            onChange={(e) => { setDraftReason(e.target.value); }}
            placeholder="Reason (optional)"
            className="lg:col-span-3 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-sm text-[color:var(--fg-strong)]"
          />
          <button
            type="button"
            onClick={() => {
              const w = Number.parseFloat(draftWeight);
              void handleUpsert(
                draftAction,
                draftEntry,
                Number.isFinite(w) ? w : 1.3,
                draftReason.trim() === '' ? null : draftReason.trim(),
              );
            }}
            disabled={busy !== null}
            className="lg:col-span-1 rounded-md border border-[color:var(--border)] px-4 py-2 text-sm font-medium text-[color:var(--fg-strong)] hover:bg-[color:var(--card)] disabled:opacity-40"
          >
            {busy === 'upsert' ? '…' : 'Add'}
          </button>
        </div>
      </section>

      <section className="rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-[color:var(--border)] text-left text-[color:var(--fg-muted)]">
            <tr>
              <th className="px-4 py-3 font-semibold">Entry External ID</th>
              <th className="px-4 py-3 font-semibold">Action</th>
              <th className="px-4 py-3 font-semibold">Weight</th>
              <th className="px-4 py-3 font-semibold">Reason</th>
              <th className="px-4 py-3 font-semibold">Updated</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {sortedRecords.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-[color:var(--fg-muted)]"
                >
                  Keine Einträge für diesen Agent.
                </td>
              </tr>
            ) : (
              sortedRecords.map((r) => (
                <tr
                  key={r.entryExternalId}
                  className="border-b border-[color:var(--border)]/40"
                >
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--fg-strong)] break-all">
                    {r.entryExternalId}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        r.action === 'block'
                          ? 'rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400'
                          : 'rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400'
                      }
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[color:var(--fg-strong)]">
                    {r.action === 'boost' ? r.weight.toFixed(2) : '—'}
                  </td>
                  <td className="px-4 py-3 text-[color:var(--fg-muted)]">
                    {r.reason ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[color:var(--fg-muted)]">
                    {new Date(r.updatedAt).toLocaleString('de-DE')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => { void handleRemove(r.entryExternalId); }}
                      disabled={busy === `remove:${r.entryExternalId}`}
                      className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--fg-strong)] hover:bg-red-500/20 disabled:opacity-40"
                    >
                      {busy === `remove:${r.entryExternalId}` ? '…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
