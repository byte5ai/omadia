'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  assignRoleHolder,
  createConductorRole,
  emitConductorEvent,
  fetchConductorTemplates,
  getAuthMe,
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
  type ConductorTemplate,
  type ConductorWorkflow,
} from '@/app/_lib/api';

import { ConductorCanvas, type CanvasGraphRequest } from './_components/ConductorCanvas';
import { ConductorChatPane } from './_components/ConductorChatPane';
import { ConductorRunHistory, ConductorRunTrace } from './_components/ConductorRunTrace';
import { SaveAsTemplateDialog } from './_components/SaveAsTemplateDialog';
import { TemplateGallery } from './_components/TemplateGallery';
import { TemplateInstantiateForm } from './_components/TemplateInstantiateForm';

export default function ConductorPage(): React.JSX.Element {
  const t = useTranslations('conductor');

  const [workflows, setWorkflows] = useState<ConductorWorkflow[]>([]);
  const [templates, setTemplates] = useState<ConductorTemplate[]>([]);
  // Template instantiation flow (#429): "Use template" stores the selection; the
  // slot-mapping form below the gallery reads it. Cancel/create clear it.
  const [selectedTemplate, setSelectedTemplate] = useState<ConductorTemplate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningSlug, setRunningSlug] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ConductorRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [historySlug, setHistorySlug] = useState<string | null>(null);
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
  // The conversational builder's evolving draft, mirrored into the canvas below (US7 parity).
  const [chatGraphRequest, setChatGraphRequest] = useState<CanvasGraphRequest | null>(null);
  const designerRef = useRef<HTMLElement>(null);
  // Save-as-template (#478 F1): which workflow's dialog is open, the backend viewer
  // identity for the dialog's ownership pre-check (AuthUser.id = session sub), and
  // the post-publish notice (text-only success feedback, Lume state-color rule).
  const [saveTemplateSlug, setSaveTemplateSlug] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoadError(null);
      const [wfRes, awRes, roleRes, tplRes] = await Promise.all([
        listConductorWorkflows(),
        listPendingAwaits(),
        listConductorRoles(),
        fetchConductorTemplates(),
      ]);
      setWorkflows(wfRes.workflows);
      setAwaits(awRes.awaits);
      setRoles(roleRes.roles);
      setTemplates(tplRes.templates);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader
    void reload();
  }, [reload]);

  // Viewer identity for the save-as-template ownership pre-check. Best-effort:
  // without it the dialog still publishes fresh ids, it just cannot offer the
  // "Publish as v{n+1}" switch (owned ids then read as taken).
  useEffect(() => {
    let cancelled = false;
    getAuthMe()
      .then((me) => {
        if (!cancelled) setViewer(me.user.id);
      })
      .catch(() => {
        /* unauthenticated probes redirect via getJson; nothing to surface here */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

      {/* Workflow templates (#429) — curated starting points, above the workflows list.
          Hidden while the catalog is empty (or still loading): no empty-state noise. */}
      {templates.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('templatesHeading')}
          </h2>
          <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('templatesHint')}</p>
          {/* viewer + onCatalogChanged (#478 F2): the gallery's facets and manage/
              review actions need the viewer identity and a way to refetch the
              catalog after submit/approve/reject/delete. */}
          <TemplateGallery
            templates={templates}
            viewer={viewer}
            onUseTemplate={(tpl) => setSelectedTemplate(tpl)}
            onCatalogChanged={() => void reload()}
          />
          {selectedTemplate && (
            <div className="mt-4">
              <TemplateInstantiateForm
                // Re-key per template so slug/name/mapping state resets on re-selection.
                key={selectedTemplate.id}
                template={selectedTemplate}
                onCreated={() => {
                  // Same success feedback as the canvas publish path (onSaved): reload
                  // the lists so the new workflow appears immediately.
                  setSelectedTemplate(null);
                  void reload();
                }}
                onOpenInDesigner={(graph, target) => {
                  // Reuse the chat→canvas mechanism: the canvas hydrates via its
                  // loadGraphRequest prop; publishing then goes through its normal save
                  // flow. The form's slug/name ride along so Save is armed with the
                  // template instance identity, not a previously loaded workflow's —
                  // and its enable toggle rides along too, so Save keeps a default-off
                  // (possibly cron-scheduled) template disabled instead of enabling it.
                  setChatGraphRequest({
                    graph,
                    nonce: Date.now(),
                    slug: target.slug,
                    name: target.name,
                    enable: target.enable,
                  });
                  designerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                onCancel={() => setSelectedTemplate(null)}
              />
            </div>
          )}
        </section>
      )}

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
                  <Button
                    variant="ghost"
                    onClick={() => setHistorySlug((s) => (s === wf.slug ? null : wf.slug))}
                  >
                    {t('historyButton')}
                  </Button>
                  {/* Save as template (#478): works from the PUBLISHED version, so it
                      needs an active version — hidden for never-published workflows. */}
                  {wf.activeVersionId !== null && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTemplateNotice(null);
                        setSaveTemplateSlug((s) => (s === wf.slug ? null : wf.slug));
                      }}
                    >
                      {t('saveAsTemplateButton')}
                    </Button>
                  )}
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
        {/* Success feedback after a template publish — TEXT only (Lume state rule). */}
        {templateNotice && <p className="mt-3 text-[13px] text-[color:var(--success)]">{templateNotice}</p>}
        {saveTemplateSlug && (
          <div className="mt-4">
            <SaveAsTemplateDialog
              // Re-key per workflow so the draft and all field state reset on re-open.
              key={saveTemplateSlug}
              workflowSlug={saveTemplateSlug}
              templates={templates}
              viewer={viewer}
              onPublished={({ id, version }) => {
                setSaveTemplateSlug(null);
                setTemplateNotice(t('saveTemplatePublished', { id, version }));
                // Gallery refresh: the new/updated template appears immediately.
                void reload();
              }}
              onCancel={() => setSaveTemplateSlug(null)}
            />
          </div>
        )}
        {runError && <p className="mt-3 text-[14px] text-[color:var(--danger,#e5484d)]">{runError}</p>}
        {runResult && (
          <div className={`${card} mt-4`}>
            <div className="mb-3 text-[14px] font-semibold text-[color:var(--fg-strong)]">{t('lastRunHeading')}</div>
            <ConductorRunTrace result={runResult} />
          </div>
        )}
        {historySlug && <ConductorRunHistory slug={historySlug} onClose={() => setHistorySlug(null)} />}
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

      {/* Conversational builder (US7) */}
      <section className="mb-10">
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('chatHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('chatHint')}</p>
        <ConductorChatPane
          onShowInDesigner={(graph) => {
            setChatGraphRequest({ graph, nonce: Date.now() });
            designerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
      </section>

      {/* Visual designer — shares the conversational builder's draft (loadGraphRequest) */}
      <section ref={designerRef}>
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('designerHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('designerHint')}</p>
        <ConductorCanvas
          workflows={workflows}
          editRequest={editRequest}
          loadGraphRequest={chatGraphRequest}
          onSaved={() => void reload()}
        />
      </section>
    </main>
  );
}
