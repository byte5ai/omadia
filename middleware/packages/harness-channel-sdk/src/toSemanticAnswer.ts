import type { ChatTurnResult } from './chatAgent.js';
import type {
  OutgoingAttachment,
  OutgoingInteractive,
  SemanticAnswer,
  VerifierBadge,
} from './outgoing.js';

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
  const attachments: OutgoingAttachment[] | undefined = r.attachments
    ? r.attachments.map((a) => ({
        kind: 'image',
        url: a.url,
        altText: a.altText,
        producer: `diagram.${a.diagramKind}`,
        cacheHit: a.cacheHit,
      }))
    : undefined;

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

  return {
    text: r.answer,
    ...(verifier ? { verifier } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(r.followUpOptions && r.followUpOptions.length > 0
      ? { followUps: r.followUpOptions }
      : {}),
    ...(interactive ? { interactive } : {}),
    ...(r.pendingOAuthConsent ? { oauthConsentPending: true } : {}),
    ...(r.privacyReceipt ? { privacyReceipt: r.privacyReceipt } : {}),
  };
}
