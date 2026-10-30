'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { McpAddServerModal, type McpAddServerResolution } from '@/app/_components/mcp/McpAddServerModal';
import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  conductorBuilderTurn,
  publishConductorWorkflow,
  resolveConductorText,
  type ConductorBuilderMessage,
  type ConductorGraphPatch,
  type ConductorMissingCapability,
  type ConductorPersonCandidate,
  type ConductorPersonSuggestion,
  type ConductorTemplate,
  type ConductorTemplateProposal,
  type ConductorTemplateSlotMapping,
  type ConductorValidationError,
  type ConductorValidationResult,
} from '@/app/_lib/api';
import { isSendKey } from '../../_lib/composerKeys';
import { MissingCapabilityCards, PersonSuggestionCards } from './ConductorChatCards';
import { clearChatDraft, loadChatDraft, saveChatDraft } from './chatDraftStore';
import { resetStepPrincipal, setStepActionId, setStepPrincipal, stepChannel } from './graphLocalEdits';

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
  /** refs no invoker can run — "connect it inline" cards. */
  missingCapabilities?: ConductorMissingCapability[];
  /** directory lookups for unresolved `user` principals — person cards. */
  personSuggestions?: ConductorPersonSuggestion[];
  /** local note after an operator click (connected tool / picked person); no LLM turn. */
  system?: boolean;
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
  // Inline MCP connect (missing-capability card → modal → tool id written into the step).
  const [connectFor, setConnectFor] = useState<{ item: ConductorMissingCapability; serverId?: string } | null>(null);
  const [connectedActions, setConnectedActions] = useState<Record<string, McpAddServerResolution>>({});
  // Person picks (card chip → routable ref + channel written into the step).
  // `previousChannel: null` = the step had no channel before the FIRST pick (so undo removes it).
  const [pickedPeople, setPickedPeople] = useState<Record<string, { candidate: ConductorPersonCandidate; previousChannel: string | null }>>({});
  // Browser-local draft (chatDraftStore): hydrate once on mount, persist on every change, so a
  // reload keeps transcript, graph and the connector/person picks. `hydrated` gates the writer
  // so the empty initial state never overwrites a stored draft before it was read.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const stored = loadChatDraft();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from localStorage
      setItems(stored.items as ChatItem[]);
      setGraph(stored.graph ?? EMPTY_GRAPH);
      setSlug(stored.slug);
      setName(stored.name);
      setConnectedActions(stored.connectedActions as Record<string, McpAddServerResolution>);
      setPickedPeople(stored.pickedPeople as Record<string, { candidate: ConductorPersonCandidate; previousChannel: string | null }>);
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    if (items.length === 0 && !slug && !name) {
      clearChatDraft();
      return;
    }
    saveChatDraft({ items, graph, slug, name, connectedActions, pickedPeople });
  }, [hydrated, items, graph, slug, name, connectedActions, pickedPeople]);
  const startNewDraft = useCallback(() => {
    setItems([]);
    setGraph(EMPTY_GRAPH);
    setSlug('');
    setName('');
    setConnectedActions({});
    setPickedPeople({});
    setConnectFor(null);
    setPublishMsg(null);
    setPublishErrors([]);
    clearChatDraft();
  }, []);

  const summary = useMemo(() => summarize(graph), [graph]);
  const lastValidation = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it?.validation) return it.validation;
    }
    return null;
  }, [items]);
  // Cards act on the CURRENT draft by step id, so only the latest builder turn's cards are
  // live — an older turn's step ids may no longer mean the same thing (or exist at all).
  const latestTurnIdx = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it?.role === 'assistant' && !it.system) return i;
    }
    return -1;
  }, [items]);
  const openMissing = useMemo(() => {
    const it = latestTurnIdx >= 0 ? items[latestTurnIdx] : undefined;
    return (it?.missingCapabilities ?? []).filter((m) => !connectedActions[m.stepId]).length;
  }, [items, latestTurnIdx, connectedActions]);

  const onConnected = useCallback(
    (item: ConductorMissingCapability, r: McpAddServerResolution) => {
      setGraph((g: unknown) => setStepActionId(g, item.stepId, r.actionId));
      setConnectedActions((m) => ({ ...m, [item.stepId]: r }));
      setItems((xs) => [...xs, { role: 'assistant', system: true, text: t('chatConnectedNote', { actionId: r.actionId, stepId: item.stepId }) }]);
      setConnectFor(null);
    },
    [t],
  );

  // "Change" re-opens the modal at the connected server's tool list; "Reset" restores the
  // builder's ref so the card offers "connect" again.
  const onChangeConnected = useCallback(
    (item: ConductorMissingCapability) => setConnectFor({ item, serverId: connectedActions[item.stepId]?.serverId }),
    [connectedActions],
  );
  const onResetConnected = useCallback((item: ConductorMissingCapability) => {
    setGraph((g: unknown) => setStepActionId(g, item.stepId, item.ref));
    setConnectedActions((m) => Object.fromEntries(Object.entries(m).filter(([stepId]) => stepId !== item.stepId)));
  }, []);
  const connectedActionIds = useMemo(
    () => Object.fromEntries(Object.entries(connectedActions).map(([stepId, r]) => [stepId, r.actionId])),
    [connectedActions],
  );

  const onPickPerson = useCallback(
    (suggestion: ConductorPersonSuggestion, candidate: ConductorPersonCandidate | null) => {
      if (candidate) {
        // Keep the channel from BEFORE the first pick — picking A then B must still undo to the original.
        const previousChannel = pickedPeople[suggestion.stepId]?.previousChannel ?? stepChannel(graph, suggestion.stepId) ?? null;
        setGraph((g: unknown) => setStepPrincipal(g, suggestion.stepId, candidate));
        setPickedPeople((m) => ({ ...m, [suggestion.stepId]: { candidate, previousChannel } }));
      } else {
        const previousChannel = pickedPeople[suggestion.stepId]?.previousChannel;
        setGraph((g: unknown) => resetStepPrincipal(g, suggestion.stepId, suggestion.query, previousChannel));
        setPickedPeople((m) => Object.fromEntries(Object.entries(m).filter(([stepId]) => stepId !== suggestion.stepId)));
      }
    },
    [graph, pickedPeople],
  );
  const appliedPeople = useMemo(
    () => Object.fromEntries(Object.entries(pickedPeople).map(([stepId, v]) => [stepId, v.candidate])),
    [pickedPeople],
  );

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    const now = Date.now();
    if (now - lastAction.current < 350) return;
    lastAction.current = now;

    setBusy(true);
    setError(null);
    // History = the transcript BEFORE this message (role + text only). Local notes (`system`)
    // are UI bookkeeping, not conversation — and they carry raw third-party tool names that
    // must not reach the prompt unsanitized.
    const history: ConductorBuilderMessage[] = items.filter((it) => !it.system).map((it) => ({ role: it.role, text: it.text }));
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
          missingCapabilities: res.missingCapabilities,
          personSuggestions: res.personSuggestions,
        },
      ]);
      // A new turn supersedes earlier cards' local state (step ids may have changed) — including
      // an open connect modal, whose resolution would otherwise write into the replaced draft.
      setConnectedActions({});
      setPickedPeople({});
      setConnectFor(null);
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
                {/* Cards go inert while a turn is in flight: the reply is built from the graph as
                    sent, so a pick made meanwhile would be silently overwritten by `res.graph`. */}
                {i === latestTurnIdx && it.missingCapabilities && it.missingCapabilities.length > 0 && (
                  <MissingCapabilityCards
                    items={it.missingCapabilities}
                    resolved={connectedActionIds}
                    onConnect={(item) => setConnectFor({ item })}
                    onChange={onChangeConnected}
                    onReset={onResetConnected}
                    disabled={busy}
                  />
                )}
                {i === latestTurnIdx && it.personSuggestions && it.personSuggestions.length > 0 && (
                  <PersonSuggestionCards
                    items={it.personSuggestions}
                    disabled={busy}
                    applied={appliedPeople}
                    onPick={(stepId, candidate) => {
                      const s = it.personSuggestions?.find((x) => x.stepId === stepId);
                      if (s) onPickPerson(s, candidate);
                    }}
                  />
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
              if (isSendKey(e)) {
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
            {openMissing > 0 ? ` · ${t('chatDraftMissing', { count: openMissing })}` : ''}
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
        <Button variant="ghost" disabled={items.length === 0 && summary.steps === 0} onClick={startNewDraft}>
          {t('chatNewDraft')}
        </Button>
        {items.length > 0 ? <p className="text-[11px] text-[color:var(--fg-muted)]">{t('chatDraftSaved')}</p> : null}
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
      {connectFor && (
        <McpAddServerModal
          initialQuery={connectFor.item.suggestedQuery}
          missingRef={connectFor.item.ref}
          {...(connectFor.serverId ? { initialServerId: connectFor.serverId } : {})}
          onResolve={(r) => onConnected(connectFor.item, r)}
          onClose={() => setConnectFor(null)}
        />
      )}
    </div>
  );
}
