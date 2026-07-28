'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  conductorBuilderTurn,
  publishConductorWorkflow,
  resolveConductorText,
  type ConductorBuilderMessage,
  type ConductorGraphPatch,
  type ConductorTemplate,
  type ConductorTemplateProposal,
  type ConductorTemplateSlotMapping,
  type ConductorValidationError,
  type ConductorValidationResult,
} from '@/app/_lib/api';

// Conversational builder (US7). The user co-designs a Conductor workflow by chatting; each turn the
// builder agent returns a patched draft graph + a reply. The draft lives here (client-side), so the
// chat and the visual canvas are two windows on ONE graph: `onGraphChange` mirrors every turn into
// the canvas. Publish goes through the SAME versioned path the canvas uses — no second publish flow.

const EMPTY_GRAPH = { entryStepId: '', steps: [], transitions: [], triggers: [] };

interface ChatItem {
  role: 'user' | 'assistant';
  text: string;
  patches?: ConductorGraphPatch[];
  validation?: ConductorValidationResult;
  applyErrors?: string[];
  /** template suggestions for this turn (#478 F4) — rendered as proposal cards. */
  templateProposals?: ConductorTemplateProposal[];
}

/** Defensive re-cap of B4's server-side ≤3 guarantee. */
const MAX_PROPOSAL_CARDS = 3;

/** How many of the template's DECLARED slots the proposal prefills — undeclared
 *  prefill keys never count (parity with the form, which drops them on mount). */
function slotCoverage(
  tpl: ConductorTemplate,
  prefill: ConductorTemplateSlotMapping,
): { filled: number; total: number } {
  let filled = 0;
  let total = 0;
  for (const kind of ['agents', 'actions', 'roles', 'events', 'channels'] as const) {
    for (const slot of tpl.slots[kind] ?? []) {
      total += 1;
      const v = prefill[kind]?.[slot.key];
      if (typeof v === 'string' && v.trim().length > 0) filled += 1;
    }
  }
  for (const slot of tpl.slots.text ?? []) {
    total += 1;
    const v = prefill.text?.[slot.key];
    if (typeof v === 'string' && v.trim().length > 0) filled += 1;
  }
  return { filled, total };
}

interface DraftSummary {
  steps: number;
  trigger: string;
}

function summarize(graph: unknown): DraftSummary {
  const g = (graph ?? {}) as { steps?: unknown[]; triggers?: Array<{ kind?: string }> };
  const steps = Array.isArray(g.steps) ? g.steps.length : 0;
  const trigger = Array.isArray(g.triggers) && g.triggers[0]?.kind ? String(g.triggers[0].kind) : 'manual';
  return { steps, trigger };
}

// `onShowInDesigner` pushes the CURRENT chat draft into the visual canvas on explicit user action
// (a button), NOT automatically every turn — an auto-push would silently clobber any manual canvas
// edits, since canvas edits don't flow back into this pane's draft. Explicit push matches the
// existing "Load"/"Edit" semantics (a load replaces the canvas). True two-way live sync is a follow-up.
export function ConductorChatPane({
  onShowInDesigner,
  templates,
  onUseTemplateProposal,
}: {
  onShowInDesigner?: (graph: unknown) => void;
  /** the page's template catalog (#478 F4) — resolves proposal ids to names/slots.
   *  A proposal whose id is missing here (stale catalog, revoked visibility since
   *  B4's server-side filter ran) degrades to plain text instead of a card. */
  templates?: ConductorTemplate[];
  /** "Use template" hand-off (#478 F4): the page opens the instantiate form for
   *  this template/version with the prefill as the initial mapping. Chat never
   *  auto-instantiates — creation stays a deliberate form action. */
  onUseTemplateProposal?: (proposal: ConductorTemplateProposal) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const locale = useLocale();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [graph, setGraph] = useState<unknown>(EMPTY_GRAPH);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishErrors, setPublishErrors] = useState<ConductorValidationError[]>([]);
  const lastAction = useRef(0);

  const summary = useMemo(() => summarize(graph), [graph]);
  const lastValidation = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it?.validation) return it.validation;
    }
    return null;
  }, [items]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    const now = Date.now();
    if (now - lastAction.current < 350) return;
    lastAction.current = now;

    setBusy(true);
    setError(null);
    // History = the transcript BEFORE this message (role + text only).
    const history: ConductorBuilderMessage[] = items.map((it) => ({ role: it.role, text: it.text }));
    setItems((xs) => [...xs, { role: 'user', text: message }]);
    setInput('');
    try {
      const res = await conductorBuilderTurn({ graph, message, history });
      setGraph(res.graph);
      setItems((xs) => [
        ...xs,
        {
          role: 'assistant',
          text: res.reply,
          patches: res.patches,
          validation: res.validation,
          applyErrors: res.applyErrors,
          templateProposals: res.templateProposals,
        },
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setInput(message); // restore the composer so a failed turn doesn't lose the user's text
    } finally {
      setBusy(false);
    }
  }, [input, busy, items, graph]);

  const publish = useCallback(async () => {
    if (!slug.trim() || !name.trim()) {
      setPublishMsg(t('chatNeedSlug'));
      return;
    }
    const now = Date.now();
    if (now - lastAction.current < 350) return;
    lastAction.current = now;
    setPublishing(true);
    setPublishMsg(null);
    setPublishErrors([]);
    try {
      await publishConductorWorkflow({ slug: slug.trim(), name: name.trim(), graph, enable: true });
      setPublishMsg(t('chatPublished', { slug: slug.trim() }));
    } catch (err) {
      if (err instanceof ApiError) {
        try {
          const body = JSON.parse(err.body) as { errors?: ConductorValidationError[] };
          if (Array.isArray(body.errors)) setPublishErrors(body.errors);
        } catch {
          /* not json */
        }
        setPublishMsg(err.message);
      } else setPublishMsg(String(err));
    } finally {
      setPublishing(false);
    }
  }, [slug, name, graph, t]);

  const inputCls =
    'w-full rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]';
  const lbl = 'grid gap-1 text-[12px] text-[color:var(--fg-muted)]';

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      {/* Transcript + composer */}
      <div className="grid gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3">
        <div className="grid max-h-[360px] gap-2 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-[13px] text-[color:var(--fg-muted)]">{t('chatEmpty')}</p>
          ) : (
            items.map((it, i) => (
              <div
                key={i}
                className={
                  it.role === 'user'
                    ? 'justify-self-end rounded-md bg-[color:var(--fg-strong)] px-3 py-2 text-[13px] text-[color:var(--card)]'
                    : 'justify-self-start rounded-md border border-[color:var(--border)] px-3 py-2 text-[13px] text-[color:var(--fg-strong)]'
                }
              >
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider opacity-70">
                  {it.role === 'user' ? t('chatYou') : t('chatAssistant')}
                </div>
                <div className="whitespace-pre-wrap">{it.text}</div>
                {it.patches && it.patches.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {it.patches.map((p, j) => (
                      <span key={j} className="rounded bg-black/20 px-1.5 py-0.5 font-mono text-[10px]">
                        {p.op}
                      </span>
                    ))}
                  </div>
                )}
                {it.validation && !it.validation.ok && (
                  <div className="mt-2 text-[11px] text-[color:var(--danger,#e5484d)]">
                    {t('chatValidationFailed')}{' '}
                    {it.validation.errors.map((e) => e.code).join(', ')}
                  </div>
                )}
                {it.applyErrors && it.applyErrors.length > 0 && (
                  <div className="mt-1 text-[11px] text-[color:var(--danger,#e5484d)]">
                    {t('chatApplyIssues')} {it.applyErrors.join('; ')}
                  </div>
                )}
                {/* Template proposals (#478 F4): compact cards under the reply. The
                    action HANDS OFF to the instantiate form — never auto-creates. */}
                {it.templateProposals && it.templateProposals.length > 0 && (
                  <div className="mt-2 grid gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
                      {t('chatProposalsHeading')}
                    </div>
                    {it.templateProposals.slice(0, MAX_PROPOSAL_CARDS).map((proposal) => {
                      const tpl = templates?.find((x) => x.id === proposal.templateId);
                      if (!tpl) {
                        // Server-filtered ids should always resolve; if one slips
                        // through anyway, degrade to plain text (no dead action).
                        return (
                          <p key={proposal.templateId} className="text-[12px] text-[color:var(--fg-muted)]">
                            {proposal.reason}
                          </p>
                        );
                      }
                      const coverage = slotCoverage(tpl, proposal.prefill);
                      return (
                        <div
                          key={proposal.templateId}
                          className="grid gap-1 rounded-md border border-[color:var(--border)] bg-[color:var(--card)]/40 px-3 py-2"
                        >
                          <div className="flex items-baseline gap-2">
                            <span className="text-[13px] font-medium text-[color:var(--fg-strong)]">
                              {resolveConductorText(tpl.name, locale)}
                            </span>
                            <span className="font-mono text-[11px] text-[color:var(--fg-muted)]">
                              {t('templateVersionTag', { version: proposal.version })}
                            </span>
                          </div>
                          <p className="text-[12px] text-[color:var(--fg-muted)]">{proposal.reason}</p>
                          {coverage.total > 0 && (
                            <p className="text-[11px] text-[color:var(--fg-muted)]">
                              {t('chatProposalCoverage', { filled: coverage.filled, total: coverage.total })}
                            </p>
                          )}
                          {onUseTemplateProposal && (
                            <div className="mt-1">
                              <Button variant="primary" size="sm" onClick={() => onUseTemplateProposal(proposal)}>
                                {t('templateUseButton')}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {error && <p className="text-[13px] text-[color:var(--danger,#e5484d)]">{error}</p>}

        <div className="flex items-end gap-2">
          <textarea
            className={`${inputCls} min-h-[44px] flex-1`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t('chatPlaceholder')}
          />
          <Button variant="primary" busy={busy} disabled={busy || !input.trim()} onClick={() => void send()}>
            {busy ? t('chatSending') : t('chatSend')}
          </Button>
        </div>
      </div>

      {/* Draft + publish */}
      <div className="grid content-start gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3">
        <div className="text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('chatDraftHeading')}
        </div>
        <p className="text-[13px] text-[color:var(--fg-muted)]">{t('chatDraftSummary', { steps: summary.steps, trigger: summary.trigger })}</p>
        {lastValidation && (
          <p className={`text-[12px] ${lastValidation.ok ? 'text-[color:var(--fg-muted)]' : 'text-[color:var(--danger,#e5484d)]'}`}>
            {lastValidation.ok ? t('chatValidationOk') : t('chatDraftInvalid')}
          </p>
        )}
        <label className={lbl}>
          {t('slugLabel')}
          <input className={inputCls} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="release-signoff" />
        </label>
        <label className={lbl}>
          {t('nameLabel')}
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Release sign-off" />
        </label>
        {onShowInDesigner && (
          <Button variant="ghost" disabled={summary.steps === 0} onClick={() => onShowInDesigner(graph)}>
            {t('chatShowInDesigner')}
          </Button>
        )}
        <Button variant="secondary" busy={publishing} disabled={publishing || summary.steps === 0} onClick={() => void publish()}>
          {publishing ? t('chatPublishing') : t('chatPublish')}
        </Button>
        {publishMsg && <p className="text-[12px] text-[color:var(--fg-muted)]">{publishMsg}</p>}
        {publishErrors.length > 0 && (
          <ul className="list-inside list-disc text-[12px] text-[color:var(--danger,#e5484d)]">
            {publishErrors.map((v, i) => (
              <li key={i}>
                <span className="font-mono">{v.code}</span>: {v.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
