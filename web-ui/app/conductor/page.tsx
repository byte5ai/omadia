'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  assignRoleHolder,
  createConductorRole,
  emitConductorEvent,
  getConductorRun,
  listConductorRoles,
  listConductorWorkflows,
  listPendingAwaits,
  respondToAwait,
  startConductorRun,
  type ConductorAwait,
  type ConductorEmitResult,
  type ConductorRole,
  type ConductorRunResult,
  type ConductorWorkflow,
} from '@/app/_lib/api';

import { ConductorCanvas } from './_components/ConductorCanvas';

export default function ConductorPage(): React.JSX.Element {
  const t = useTranslations('conductor');

  const [workflows, setWorkflows] = useState<ConductorWorkflow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningSlug, setRunningSlug] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ConductorRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [awaits, setAwaits] = useState<ConductorAwait[]>([]);
  const [awaitBusy, setAwaitBusy] = useState<string | null>(null);
  const [eventId, setEventId] = useState('github.pull_request.merged');
  const [eventPayload, setEventPayload] = useState('{ "base": "main" }');
  const [emitting, setEmitting] = useState(false);
  const [emitResult, setEmitResult] = useState<ConductorEmitResult | null>(null);
  const [emitError, setEmitError] = useState<string | null>(null);
  const [roles, setRoles] = useState<ConductorRole[]>([]);
  const [newRoleKey, setNewRoleKey] = useState('');
  const [newRoleLabel, setNewRoleLabel] = useState('');
  const [holderInputs, setHolderInputs] = useState<Record<string, string>>({});
  // Swallows a double-fired click (synthetic input / accidental double-click) so one intent
  // never starts two runs or sends two responses.
  const lastAction = useRef(0);
  // Edit flow: clicking "Edit" on a workflow loads it into the designer canvas below and
  // scrolls there. The nonce changes per click so editing the same workflow twice reloads it.
  const [editRequest, setEditRequest] = useState<{ slug: string; nonce: number } | null>(null);
  const designerRef = useRef<HTMLElement>(null);

  const reload = useCallback(async () => {
    try {
      setLoadError(null);
      const [wfRes, awRes, roleRes] = await Promise.all([
        listConductorWorkflows(),
        listPendingAwaits(),
        listConductorRoles(),
      ]);
      setWorkflows(wfRes.workflows);
      setAwaits(awRes.awaits);
      setRoles(roleRes.roles);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const handleRespond = useCallback(
    async (awaitId: string, approved: boolean) => {
      const now = Date.now();
      if (now - lastAction.current < 600) return;
      lastAction.current = now;
      setAwaitBusy(awaitId);
      try {
        await respondToAwait(awaitId, { approved });
        await reload();
      } catch (err) {
        setRunError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setAwaitBusy(null);
      }
    },
    [reload],
  );

  const handleCreateRole = useCallback(async () => {
    if (!newRoleKey || !newRoleLabel) return;
    try {
      await createConductorRole(newRoleKey, newRoleLabel);
      setNewRoleKey('');
      setNewRoleLabel('');
      await reload();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : String(err));
    }
  }, [newRoleKey, newRoleLabel, reload]);

  const handleAssign = useCallback(
    async (key: string, action: 'add' | 'remove', holderId: string) => {
      if (!holderId) return;
      try {
        await assignRoleHolder(key, holderId, action);
        setHolderInputs((m) => ({ ...m, [key]: '' }));
        await reload();
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [reload],
  );

  const handleEdit = useCallback((wfSlug: string) => {
    setEditRequest({ slug: wfSlug, nonce: Date.now() });
    designerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRun = useCallback(
    async (wfSlug: string) => {
      const now = Date.now();
      if (now - lastAction.current < 600) return;
      lastAction.current = now;
      setRunningSlug(wfSlug);
      setRunError(null);
      setRunResult(null);
      try {
        const started = await startConductorRun(wfSlug, {});
        setRunResult(started);
        const runId = started.run.id;
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 2000));
          const latest = await getConductorRun(wfSlug, runId);
          setRunResult(latest);
          if (latest.run.status !== 'running') break;
        }
        await reload();
      } catch (err) {
        setRunError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setRunningSlug(null);
      }
    },
    [reload],
  );

  const handleEmit = useCallback(async () => {
    const now = Date.now();
    if (now - lastAction.current < 600) return;
    lastAction.current = now;
    setEmitting(true);
    setEmitError(null);
    setEmitResult(null);
    let payload: unknown;
    try {
      payload = eventPayload.trim() ? JSON.parse(eventPayload) : {};
    } catch {
      setEmitError('Payload is not valid JSON');
      setEmitting(false);
      return;
    }
    try {
      const res = await emitConductorEvent(eventId, payload);
      setEmitResult(res);
      await reload();
    } catch (err) {
      setEmitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setEmitting(false);
    }
  }, [eventId, eventPayload, reload]);

  const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">{t('intro')}</p>
      </header>

      {/* Workflows list with quick-run */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('workflowsHeading')}
          </h2>
          <Button variant="ghost" onClick={() => void reload()}>
            {t('refreshButton')}
          </Button>
        </div>
        {loadError && <p className="mb-3 text-[14px] text-[color:var(--danger,#e5484d)]">{loadError}</p>}
        {workflows.length === 0 ? (
          <p className="text-[14px] text-[color:var(--fg-muted)]">{t('noWorkflows')}</p>
        ) : (
          <ul className="grid gap-3">
            {workflows.map((wf) => (
              <li key={wf.id} className={`${card} flex items-center justify-between gap-4`}>
                <div>
                  <div className="text-[15px] font-medium text-[color:var(--fg-strong)]">{wf.name}</div>
                  <div className="font-mono text-[12px] text-[color:var(--fg-muted)]">
                    {wf.slug} · {t('statusLabel')}: {wf.status}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="secondary" disabled={runningSlug !== null} onClick={() => handleEdit(wf.slug)}>
                    {t('editButton')}
                  </Button>
                  <Button
                    variant="primary"
                    busy={runningSlug === wf.slug}
                    disabled={runningSlug !== null}
                    onClick={() => void handleRun(wf.slug)}
                  >
                    {runningSlug === wf.slug ? t('running') : t('runButton')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {runError && <p className="mt-3 text-[14px] text-[color:var(--danger,#e5484d)]">{runError}</p>}
        {runResult && (
          <div className={`${card} mt-4`}>
            <div className="mb-2 text-[14px] text-[color:var(--fg-strong)]">
              {t('lastRunHeading')} · {t('statusLabel')}: <span className="font-mono">{runResult.run.status}</span>
            </div>
            <pre className="overflow-x-auto rounded-md bg-black/20 p-3 text-[12px] text-[color:var(--fg-strong)]">
              {JSON.stringify(runResult.run.context, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* Roles & the baton (US6) */}
      <section className="mb-10">
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('rolesHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('rolesHint')}</p>
        <div className="grid gap-3">
          {roles.map((role) => (
            <div key={role.key} className={card}>
              <div className="text-[15px] text-[color:var(--fg-strong)]">
                {role.label} <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">{role.key}</span>
              </div>
              <div className="font-mono text-[12px] text-[color:var(--fg-muted)]">
                {t('holdersLabel')}: {role.holders.length ? role.holders.join(', ') : '—'}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]"
                  placeholder="holder@email"
                  value={holderInputs[role.key] ?? ''}
                  onChange={(e) => setHolderInputs((m) => ({ ...m, [role.key]: e.target.value }))}
                />
                <Button variant="primary" onClick={() => void handleAssign(role.key, 'add', holderInputs[role.key] ?? '')}>
                  {t('assignButton')}
                </Button>
                {role.holders.map((h) => (
                  <button
                    key={h}
                    className="rounded-md border border-[color:var(--border)] px-2 py-1 font-mono text-[11px] text-[color:var(--fg-muted)]"
                    onClick={() => void handleAssign(role.key, 'remove', h)}
                  >
                    ✕ {h}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className={`${card} flex flex-wrap items-end gap-2`}>
            <input
              className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 font-mono text-[13px] text-[color:var(--fg-strong)]"
              placeholder="approver.release"
              value={newRoleKey}
              onChange={(e) => setNewRoleKey(e.target.value)}
            />
            <input
              className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]"
              placeholder="Release approver"
              value={newRoleLabel}
              onChange={(e) => setNewRoleLabel(e.target.value)}
            />
            <Button variant="ghost" onClick={() => void handleCreateRole()}>
              {t('createRoleButton')}
            </Button>
          </div>
        </div>
      </section>

      {/* Emit a domain event (test the Conductor Surface) */}
      <section className="mb-10">
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('emitHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('emitHint')}</p>
        <div className={`${card} grid gap-3`}>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
              {t('eventIdLabel')}
              <input
                className="w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-[14px] text-[color:var(--fg-strong)]"
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
              {t('payloadLabel')}
              <input
                className="w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 font-mono text-[12px] text-[color:var(--fg-strong)]"
                value={eventPayload}
                onChange={(e) => setEventPayload(e.target.value)}
              />
            </label>
            <Button variant="primary" busy={emitting} disabled={emitting} onClick={() => void handleEmit()}>
              {t('emitButton')}
            </Button>
          </div>
          {emitError && <p className="text-[14px] text-[color:var(--danger,#e5484d)]">{emitError}</p>}
          {emitResult && (
            <p className="text-[13px] text-[color:var(--fg-muted)]">
              {t('emitResult', { matched: emitResult.matchedWorkflows, started: emitResult.startedRuns.length })}
            </p>
          )}
        </div>
      </section>

      {/* Pending human awaits (operator inbox) */}
      {awaits.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('awaitsHeading')}
          </h2>
          <ul className="grid gap-3">
            {awaits.map((aw) => (
              <li key={aw.id} className={`${card} flex items-center justify-between gap-4`}>
                <div>
                  <div className="text-[15px] text-[color:var(--fg-strong)]">{aw.message || aw.stepId}</div>
                  <div className="font-mono text-[12px] text-[color:var(--fg-muted)]">
                    {aw.principalKind}:{aw.principalRef}
                    {aw.principalKind === 'role'
                      ? ` → ${aw.resolvedHolders && aw.resolvedHolders.length ? aw.resolvedHolders.join(', ') : t('noHolder')}`
                      : ''}
                    {' · '}
                    {aw.channelType}
                    {aw.deadlineAt ? ` · deadline ${new Date(aw.deadlineAt).toLocaleString()}` : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" busy={awaitBusy === aw.id} disabled={awaitBusy !== null} onClick={() => void handleRespond(aw.id, true)}>
                    {t('approve')}
                  </Button>
                  <Button variant="ghost" busy={awaitBusy === aw.id} disabled={awaitBusy !== null} onClick={() => void handleRespond(aw.id, false)}>
                    {t('reject')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Visual designer */}
      <section ref={designerRef}>
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('designerHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('designerHint')}</p>
        <ConductorCanvas workflows={workflows} editRequest={editRequest} onSaved={() => void reload()} />
      </section>
    </main>
  );
}
