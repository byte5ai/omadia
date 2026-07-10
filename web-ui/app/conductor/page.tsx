'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  fetchConductorTemplates,
  getAuthMe,
  getConductorRun,
  listConductorRoles,
  listConductorWorkflows,
  listPendingAwaits,
  respondToAwait,
  startConductorRun,
  type ConductorAwait,
  type ConductorRole,
  type ConductorRunResult,
  type ConductorTemplate,
  type ConductorTemplateProposal,
  type ConductorTemplateSlotMapping,
  type ConductorWorkflow,
} from '@/app/_lib/api';

import { ConductorCanvas, type CanvasGraphRequest } from './_components/ConductorCanvas';
import { ConductorChatPane } from './_components/ConductorChatPane';
import { ConductorEmitSection } from './_components/ConductorEmitSection';
import { ConductorRolesSection } from './_components/ConductorRolesSection';
import { ConductorRunHistory, ConductorRunTrace } from './_components/ConductorRunTrace';
import { SaveAsTemplateDialog } from './_components/SaveAsTemplateDialog';
import { TemplateGallery } from './_components/TemplateGallery';
import { TemplateInstantiateForm } from './_components/TemplateInstantiateForm';
import { TemplateUpdateHint } from './_components/TemplateUpdateHint';

export default function ConductorPage(): React.JSX.Element {
  const t = useTranslations('conductor');

  const [workflows, setWorkflows] = useState<ConductorWorkflow[]>([]);
  const [templates, setTemplates] = useState<ConductorTemplate[]>([]);
  // Template instantiation flow (#429): "Use template" stores the selection; the
  // slot-mapping form below the gallery reads it. Cancel/create clear it. The
  // update flow (#478) additionally pins an explicit manifest version — set only
  // by "Re-instantiate from v{latest}", cleared on every ordinary selection.
  const [selectedTemplate, setSelectedTemplate] = useState<ConductorTemplate | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined);
  // Chat proposal hand-off (#478 F4): "Use template" on a proposal card seeds the
  // instantiate form with the proposal's prefill. The nonce re-keys the form so
  // accepting the same proposal twice re-applies the prefill; ordinary selections
  // and the update flow clear it (they start from an empty mapping).
  const [instantiatePrefill, setInstantiatePrefill] = useState<{
    mapping: ConductorTemplateSlotMapping;
    nonce: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningSlug, setRunningSlug] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ConductorRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [historySlug, setHistorySlug] = useState<string | null>(null);
  const [awaits, setAwaits] = useState<ConductorAwait[]>([]);
  const [awaitBusy, setAwaitBusy] = useState<string | null>(null);
  const [roles, setRoles] = useState<ConductorRole[]>([]);
  // Swallows a double-fired click (synthetic input / accidental double-click) so one intent
  // never starts two runs or sends two responses.
  const lastAction = useRef(0);
  // The swallow window as a callable, shared with the extracted emit section:
  // false = this click arrived within 600ms of the last action, drop it.
  const guardAction = useCallback(() => {
    const now = Date.now();
    if (now - lastAction.current < 600) return false;
    lastAction.current = now;
    return true;
  }, []);
  // Edit flow: clicking "Edit" on a workflow loads it into the designer canvas below and
  // scrolls there. The nonce changes per click so editing the same workflow twice reloads it.
  const [editRequest, setEditRequest] = useState<{ slug: string; nonce: number } | null>(null);
  // The conversational builder's evolving draft, mirrored into the canvas below (US7 parity).
  const [chatGraphRequest, setChatGraphRequest] = useState<CanvasGraphRequest | null>(null);
  const designerRef = useRef<HTMLElement>(null);
  // Scroll target for the update flow's jump back to the templates section (#478).
  const templatesRef = useRef<HTMLElement>(null);
  // Save-as-template (#478 F1): which workflow's dialog is open, the backend viewer
  // identity for the dialog's ownership pre-check (AuthUser.id = session sub), and
  // the post-publish notice (text-only success feedback, Lume state-color rule).
  const [saveTemplateSlug, setSaveTemplateSlug] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  // Distinguishes "viewer unknown because getAuthMe is still in flight" from
  // "resolved without a viewer": the save-as-template dialog must not read an
  // owned id as taken while the identity probe is merely pending (#478 F1).
  const [viewerPending, setViewerPending] = useState(true);
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

  const handleEdit = useCallback((wfSlug: string) => {
    setEditRequest({ slug: wfSlug, nonce: Date.now() });
    designerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Opt-in template update path (#478): open the instantiate form pinned to the
  // template's latest version. Deliberate re-instantiation — a NEW workflow under
  // a new slug; the existing instance keeps its copy (copy-not-reference). The
  // catalog list already serves the latest manifest, so the pinned version and
  // the manifest the form renders from always agree.
  const handleReinstantiate = useCallback(
    (templateId: string, version: number) => {
      const tpl = templates.find((x) => x.id === templateId);
      if (!tpl) return;
      setInstantiatePrefill(null);
      setSelectedVersion(version);
      setSelectedTemplate(tpl);
      templatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [templates],
  );

  // Chat proposal hand-off (#478 F4) — same pattern as the chat→canvas
  // setChatGraphRequest hand-off: the chat pane stays presentation-only and the
  // page routes the request into the existing instantiate-form state. The form
  // opens pinned to the PROPOSED version (the catalog-served one B4 stamped),
  // seeded with the proposal's prefill; creation stays the operator's deliberate
  // form action. A proposal whose template left the catalog since the turn is a
  // no-op here (the chat pane already degrades it to plain text).
  const handleUseTemplateProposal = useCallback(
    (proposal: ConductorTemplateProposal) => {
      const tpl = templates.find((x) => x.id === proposal.templateId);
      if (!tpl) return;
      setInstantiatePrefill({ mapping: proposal.prefill, nonce: Date.now() });
      setSelectedVersion(proposal.version);
      setSelectedTemplate(tpl);
      templatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [templates],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader
    void reload();
  }, [reload]);

  // Viewer identity for the save-as-template ownership pre-check. Best-effort:
  // without it the dialog still publishes fresh ids, it just cannot offer the
  // "Publish as v{n+1}" switch. While the probe is in flight, viewerPending
  // keeps owned ids in a gated pending state instead of a false "taken".
  useEffect(() => {
    let cancelled = false;
    getAuthMe()
      .then((me) => {
        if (!cancelled) setViewer(me.user.id);
      })
      .catch(() => {
        /* unauthenticated probes redirect via getJson; nothing to surface here */
      })
      .finally(() => {
        if (!cancelled) setViewerPending(false);
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
        <section ref={templatesRef} className="mb-10">
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
            onUseTemplate={(tpl) => {
              // Ordinary selection instantiates the latest version — clear any pin
              // a previous "Re-instantiate from v{n}" left behind, and any prefill
              // a previous chat proposal seeded.
              setInstantiatePrefill(null);
              setSelectedVersion(undefined);
              setSelectedTemplate(tpl);
            }}
            onCatalogChanged={() => void reload()}
          />
          {selectedTemplate && (
            <div className="mt-4">
              <TemplateInstantiateForm
                // Re-key per template AND pinned version AND prefill nonce so
                // slug/name/mapping state resets on re-selection, on the update
                // flow's version switch, and on every chat-proposal hand-off.
                key={`${selectedTemplate.id}@${String(selectedVersion ?? 'latest')}@${String(instantiatePrefill?.nonce ?? 'none')}`}
                template={selectedTemplate}
                version={selectedVersion}
                initialMapping={instantiatePrefill?.mapping}
                onCreated={() => {
                  // Same success feedback as the canvas publish path (onSaved): reload
                  // the lists so the new workflow appears immediately.
                  setSelectedTemplate(null);
                  setSelectedVersion(undefined);
                  setInstantiatePrefill(null);
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
                onCancel={() => {
                  setSelectedTemplate(null);
                  setSelectedVersion(undefined);
                  setInstantiatePrefill(null);
                }}
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
                  {/* Template provenance update hint (#478): opt-in re-instantiation
                      from the latest version; this workflow stays untouched. */}
                  {wf.template ? <TemplateUpdateHint hint={wf.template} onReinstantiate={handleReinstantiate} /> : null}
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
              viewerPending={viewerPending}
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

      {/* Roles & the baton (US6) — mutations refetch the lists; failures land in
          the load-error slot above, exactly as before the split. */}
      <ConductorRolesSection roles={roles} onChanged={() => void reload()} onError={setLoadError} />

      {/* Emit a domain event (test the Conductor Surface) — shares the page's
          double-fire guard so one intent never triggers two actions. */}
      <ConductorEmitSection guardAction={guardAction} onEmitted={() => void reload()} />

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
          // Template proposal cards (#478 F4): the catalog resolves proposal ids to
          // names/slots; "Use template" routes into the instantiate form above.
          templates={templates}
          onUseTemplateProposal={handleUseTemplateProposal}
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
