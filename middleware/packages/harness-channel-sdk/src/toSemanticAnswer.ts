import type { ChatTurnResult, RunTracePayload } from './chatAgent.js';
import type {
  AgentConsultation,
  OutgoingAttachment,
  OutgoingInteractive,
  SemanticAnswer,
  VerifierBadge,
} from './outgoing.js';

/**
 * #332 Layer 1 — plain-text fallback footer for connectors without rich-card
 * UI. Renders the harness-sourced `agentsConsulted` projection as a single
 * readable line, e.g. `🔎 Consulted: Strategist ✓ · 2 steps`. Returns
 * `undefined` when no sub-agent ran (caller appends nothing). Rich connectors
 * (web-ui, Teams) render their own UI from the structured field instead.
 */
export function agentsConsultedFooterText(
  answer: Pick<SemanticAnswer, 'agentsConsulted'>,
): string | undefined {
  const consulted = answer.agentsConsulted;
  if (!consulted || consulted.length === 0) return undefined;
  const parts = consulted.map((c) => {
    const mark = c.status === 'success' ? '✓' : '✗';
    const steps =
      typeof c.toolCalls === 'number' && c.toolCalls > 0
        ? ` · ${c.toolCalls} ${c.toolCalls === 1 ? 'step' : 'steps'}`
        : '';
    return `${c.label} ${mark}${steps}`;
  });
  return `🔎 Consulted: ${parts.join(' · ')}`;
}

/**
 * Humanize a run-trace `agentName` (which is the invoked tool name, e.g.
 * `ask_strategist` / `@omadia/agent-strategist`) into a footer label. Mirrors
 * the middleware-side `labelFromAgentId` (agents/resolveAgentForTool.ts) but
 * stays local — channel-sdk has no access to the dynamic agent runtime. Strips
 * an `ask_`/`consult_` verb prefix and any npm-scope / legacy-namespace, then
 * Title-Cases the remainder.
 */
function humanizeAgentLabel(agentName: string): string {
  const last = agentName.split(/[./]/).pop() ?? agentName;
  const deverbed = last.replace(/^(?:ask|consult|query|invoke|agent)[-_]/i, '');
  const titled = deverbed
    .split(/[-_]/)
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' ');
  return titled.length > 0 ? titled : agentName;
}

/**
 * #332 Layer 1 — curate a tamper-evident consulted-agents projection from a
 * run-trace's `agentInvocations`. Extracted (gap-closure) so BOTH the
 * non-streaming `toSemanticAnswer` conversion (Teams et al.) AND the
 * streaming `done` event construction (web-ui) build the identical
 * harness-sourced array — one derivation, not a client-reimplemented one, so
 * the tamper-evidence property (empty when no sub-agent really ran) holds on
 * every channel.
 */
export function deriveAgentsConsulted(
  runTrace: Pick<RunTracePayload, 'agentInvocations'> | undefined,
): AgentConsultation[] | undefined {
  return runTrace?.agentInvocations && runTrace.agentInvocations.length > 0
    ? runTrace.agentInvocations.map((inv) => ({
        ...(inv.agentId !== undefined ? { agentId: inv.agentId } : {}),
        label: humanizeAgentLabel(inv.agentName),
        status: inv.status,
        ...(typeof inv.durationMs === 'number'
          ? { durationMs: inv.durationMs }
          : {}),
        ...(inv.toolCalls ? { toolCalls: inv.toolCalls.length } : {}),
      }))
    : undefined;
}

/**
 * Convert the internal kernel-shaped `ChatTurnResult` to the channel-agnostic
 * `SemanticAnswer` contract. Observability-only fields (runTrace, toolCalls,
 * iterations) are dropped — connectors must not see them. Retrieval of
 * `runTrace` for verifier evidence / session logs goes via
 * `Orchestrator.runTurn()` which returns the full internal shape.
 *
 * Lifted from `middleware/src/services/orchestrator.ts` in S+10-2 — colocated
 * with `SemanticAnswer` (its sibling output contract) so channel adapters
 * and the orchestrator-plugin can both import from the same package without
 * pulling in kernel-internal symbols.
 */
export function toSemanticAnswer(r: ChatTurnResult): SemanticAnswer {
  // Inline images (diagrams) and downloadable files (office docs) flow into
  // one channel-agnostic attachment array. Diagrams keep their `image` kind;
  // file attachments carry `kind: 'file'` so connectors render a download.
  const imageAttachments: OutgoingAttachment[] = (r.attachments ?? []).map(
    (a) => ({
      kind: 'image',
      url: a.url,
      altText: a.altText,
      producer: `diagram.${a.diagramKind}`,
      cacheHit: a.cacheHit,
    }),
  );
  const fileAttachments: OutgoingAttachment[] = (r.fileAttachments ?? []).map(
    (f) => ({
      kind: 'file',
      url: f.url,
      altText: f.altText,
      mediaType: f.mediaType,
      ...(f.sizeBytes !== undefined ? { sizeBytes: f.sizeBytes } : {}),
      ...(f.producer ? { producer: f.producer } : {}),
    }),
  );
  const combined = [...imageAttachments, ...fileAttachments];
  const attachments: OutgoingAttachment[] | undefined =
    combined.length > 0 ? combined : undefined;

  let interactive: OutgoingInteractive | undefined;
  if (r.pendingUserChoice) {
    interactive = {
      kind: 'choice',
      question: r.pendingUserChoice.question,
      ...(r.pendingUserChoice.rationale
        ? { rationale: r.pendingUserChoice.rationale }
        : {}),
      options: r.pendingUserChoice.options.map((o) => ({
        label: o.label,
        value: o.value,
      })),
    };
  } else if (r.pendingSlotCard) {
    interactive = {
      kind: 'slots',
      question: r.pendingSlotCard.question,
      ...(r.pendingSlotCard.subjectHint
        ? { subjectHint: r.pendingSlotCard.subjectHint }
        : {}),
      slots: r.pendingSlotCard.slots.map((s) => ({
        slotId: s.slotId,
        start: s.start,
        end: s.end,
        timeZone: s.timeZone,
        label: s.label,
        confidence: s.confidence,
      })),
    };
  } else if (r.pendingRoutineList) {
    interactive = {
      kind: 'routine_list',
      filter: r.pendingRoutineList.filter,
      totals: r.pendingRoutineList.totals,
      routines: r.pendingRoutineList.routines,
    };
  }

  const verifier: VerifierBadge | undefined = r.verifier
    ? { status: r.verifier.badge }
    : undefined;

  // #332 Layer 1 — curate a tamper-evident consulted-agents footer from the
  // deterministic run-trace. This is the ONLY sub-agent signal Teams/Telegram
  // get; the raw `runTrace` stays dropped (see header). Built by the harness,
  // outside the LLM's output stream — a fabricated "I asked X" with no real
  // invocation yields an empty array here.
  const agentsConsulted = deriveAgentsConsulted(r.runTrace);

  return {
    text: r.answer,
    ...(verifier ? { verifier } : {}),
    ...(agentsConsulted && agentsConsulted.length > 0
      ? { agentsConsulted }
      : {}),
    ...(r.delegatedAnswer ? { delegatedAnswer: r.delegatedAnswer } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(r.followUpOptions && r.followUpOptions.length > 0
      ? { followUps: r.followUpOptions }
      : {}),
    ...(interactive ? { interactive } : {}),
    ...(r.pendingOAuthConsent ? { oauthConsentPending: true } : {}),
    ...(r.privacyReceipt ? { privacyReceipt: r.privacyReceipt } : {}),
    ...(r.maskedValues && r.maskedValues.length > 0
      ? { maskedValues: r.maskedValues }
      : {}),
    // Omadia UI: forward the canvas surface payload so converter-based channels
    // reach the initial primitive tree. Sidecar — ignored by non-canvas channels.
    ...(r.surface ? { surface: r.surface } : {}),
    // Cross-session recall probe — forward to connectors that render a recall
    // card (web-ui, Teams). Only when at least one leg surfaced something.
    ...(r.recalled &&
    (r.recalled.plans.length > 0 ||
      r.recalled.processes.length > 0 ||
      r.recalled.insights.length > 0)
      ? { recalled: r.recalled }
      : {}),
  };
}
