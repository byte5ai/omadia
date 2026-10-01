import {
  applyAiDisclosure,
  composeVerifierBlockedText,
  isNoReply,
} from '@omadia/channel-sdk';
import type { AiDisclosure } from '@omadia/channel-sdk';
import { bindVerdictToClaims } from '@omadia/verifier';
import type { VerifierVerdict } from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatTurnResult,
  VerifierResultSummary,
} from './orchestrator.js';

/**
 * Delivery policy of the answer-verifier wrapper (`VerifierService`): what a
 * client receives of a turn, and when, given the verdict.
 *
 * `shadow` observes ({@link shadowVerifiedStream}): every event goes out as the
 * orchestrator produces it, and the verdict follows as one trailing `verifier`
 * event. Nothing is held back or replaced.
 *
 * `enforce` is a delivery gate ({@link enforcedVerifiedStream}; the
 * non-streaming `VerifierService.chat` applies the same verdict rule):
 *  - While the verdict is pending only liveness, progress and usage events
 *    pass ({@link passesBeforeVerdict}). Everything that carries model or
 *    tool content is held: text deltas, tool calls and results, sub-agent
 *    tool traffic, nudges, turn annotations, canvas surface events and the
 *    terminal `done`. Surfaces a canvas composer synthesises from tool
 *    results downstream are held with the results they come from.
 *  - A verdict that confirmed the answer, or found nothing in it to check,
 *    releases the held events unchanged and in order, with the summary on
 *    `done` ({@link verdictReleasesAnswer}).
 *  - Any other verdict withholds the answer — it fails closed: a
 *    contradiction, claims the verifier could not confirm or did not cover,
 *    and a verifier that could not run all withhold. The client gets one
 *    `text_delta` with the notice and a `done` marked `answerSource:
 *    'verifier-blocked'` ({@link withheldDone}); none of the held events.
 *  - Control-flow terminals are released without a verdict
 *    ({@link releasesWithoutVerification}).
 *  - A turn that fails (an `error` event, or no `done`) releases nothing it
 *    held; the `error` itself goes out.
 */

type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

/**
 * Events an `enforce` turn passes while the verdict is pending. A closed
 * allowlist: an event type not named here — including any added later — is
 * held. None of these carries model or tool output: iteration and usage
 * counters, routing and persona decisions (model and skill names), tool
 * progress pulses (the keepalive of a long tool call), route heartbeats, and
 * `steer_applied`, which echoes the user's own steering message.
 * `sub_iteration` carries no output either but is held with the `tool_use`
 * it belongs to, so a released trace keeps it under its parent.
 */
const LIVE_BEFORE_VERDICT: ReadonlySet<string> = new Set<ChatStreamEvent['type']>([
  'iteration_start',
  'turn_routing',
  'turn_persona',
  'tool_progress',
  'heartbeat',
  'stream_token_chunk',
  'iteration_usage',
  'steer_applied',
]);

export function passesBeforeVerdict(event: ChatStreamEvent): boolean {
  return LIVE_BEFORE_VERDICT.has(event.type);
}

/** The control-flow fields of a terminal `done` or a turn result. */
export interface ControlFlowTurn {
  readonly answer: string;
  readonly pendingUserChoice?: unknown;
  readonly pendingMcpInput?: unknown;
  readonly pendingSlotCard?: unknown;
  readonly pendingOAuthConsent?: boolean;
  readonly degraded?: true;
}

/**
 * Turns `enforce` releases without a verdict: a choice card, an MCP input
 * form, a slot picker or an OAuth consent prompt asks the user for input
 * rather than stating facts; a degraded turn's answer is the server-composed
 * turn-incomplete notice; a NO_REPLY answer is the agent's deliberate silence,
 * which a withheld-answer notice would break.
 */
export function releasesWithoutVerification(turn: ControlFlowTurn): boolean {
  return (
    Boolean(turn.pendingUserChoice) ||
    Boolean(turn.pendingMcpInput) ||
    Boolean(turn.pendingSlotCard) ||
    turn.pendingOAuthConsent === true ||
    turn.degraded === true ||
    isNoReply({ text: turn.answer })
  );
}

/**
 * Whether `enforce` delivers the answer a verdict is about. Only two verdicts
 * release it: `approved` (no coverage gap, every claim checked and verified)
 * and `skipped` with `no_trigger` / `no_claims` (the answer holds no claim the
 * verifier checks). Everything else withholds it: `blocked`,
 * `approved_with_disclaimer` (a claim not confirmed, not checked or not
 * covered), `skipped` with `no_checkable_claims` / `incomplete_coverage`
 * (claims nobody checked), and `unavailable`. The verdict is bound to its
 * claims first, so a status the claims do not back cannot release anything.
 */
export function verdictReleasesAnswer(returned: VerifierVerdict): boolean {
  const { verdict } = bindVerdictToClaims(returned);
  switch (verdict.status) {
    case 'approved':
      return true;
    case 'skipped':
      return verdict.reason === 'no_trigger' || verdict.reason === 'no_claims';
    case 'approved_with_disclaimer':
    case 'blocked':
    case 'unavailable':
      return false;
  }
}

/**
 * The `done` that replaces a withheld answer, and the notice its single
 * `text_delta` carries. Built from an allowlist: the turn's identity and
 * telemetry stay (`toolCalls`, `iterations`, `runTrace`, `turnId`,
 * `receiptId`, `model`, `provenance`, `aiDisclosure`, `directLineSession`,
 * `agentsConsulted`, `privacyReceipt`, `correlationId`); everything that
 * carried the withheld answer's content goes — attachments, files,
 * follow-ups, masked values, the delegated answer, cards, excerpts and any
 * field added later. The notice is in the turn's disclosure locale, then the
 * operator's, German by default; when the turn folded its AI disclosure into
 * `answer` (first turn of a scope), the notice carries the same block — on
 * `done.answer` only, never in the delta, like every disclosure.
 */
export function withheldDone(
  done: DoneEvent,
  summary: VerifierResultSummary,
  operatorLocale: string | undefined,
): { notice: string; done: DoneEvent } {
  const notice = composeVerifierBlockedText(done.aiDisclosure?.locale ?? operatorLocale, summary);
  return {
    notice,
    done: {
      type: 'done',
      answer: withTurnDisclosure(notice, done.answer, done.aiDisclosure),
      toolCalls: done.toolCalls,
      iterations: done.iterations,
      ...(done.runTrace ? { runTrace: done.runTrace } : {}),
      ...(done.turnId ? { turnId: done.turnId } : {}),
      ...(done.receiptId ? { receiptId: done.receiptId } : {}),
      ...(done.model ? { model: done.model } : {}),
      ...(done.provenance ? { provenance: done.provenance } : {}),
      ...(done.aiDisclosure ? { aiDisclosure: done.aiDisclosure } : {}),
      ...(done.directLineSession ? { directLineSession: done.directLineSession } : {}),
      ...(done.agentsConsulted ? { agentsConsulted: done.agentsConsulted } : {}),
      ...(done.privacyReceipt ? { privacyReceipt: done.privacyReceipt } : {}),
      ...(done.correlationId ? { correlationId: done.correlationId } : {}),
      answerSource: 'verifier-blocked',
      answerIsError: true,
      verifier: summary,
    },
  };
}

/**
 * The non-streaming counterpart of {@link withheldDone}: the turn result
 * `VerifierService.chat` hands to `toSemanticAnswer` instead of a withheld
 * answer. Keeps identity and telemetry (`runTrace` also feeds the
 * consulted-agents footer), the AI disclosure (`toSemanticAnswer` folds it as
 * for any answer) and `memoryUsed` (so a channel can still offer a fresh
 * check without memory); drops every field that carried the answer.
 */
export function withheldTurnResult(
  result: ChatTurnResult,
  summary: VerifierResultSummary,
  operatorLocale: string | undefined,
): ChatTurnResult {
  return {
    answer: composeVerifierBlockedText(result.aiDisclosure?.locale ?? operatorLocale, summary),
    toolCalls: result.toolCalls,
    iterations: result.iterations,
    ...(result.runTrace ? { runTrace: result.runTrace } : {}),
    ...(result.turnId ? { turnId: result.turnId } : {}),
    ...(result.aiDisclosure ? { aiDisclosure: result.aiDisclosure } : {}),
    ...(result.directLineSession ? { directLineSession: result.directLineSession } : {}),
    ...(result.privacyReceipt ? { privacyReceipt: result.privacyReceipt } : {}),
    ...(result.memoryUsed ? { memoryUsed: true } : {}),
    answerSource: 'verifier-blocked',
    answerIsError: true,
    verifier: summary,
  };
}

/** The notice, plus the disclosure block when the turn's own answer ended
 *  with it — the block `applyAiDisclosure` folds, so the format is shared. */
function withTurnDisclosure(
  notice: string,
  turnAnswer: string,
  disclosure: AiDisclosure | undefined,
): string {
  if (!disclosure) return notice;
  const block = applyAiDisclosure('', { disclosure }).text;
  return block.length > 0 && turnAnswer.endsWith(block)
    ? applyAiDisclosure(notice, { disclosure }).text
    : notice;
}

/**
 * `shadow`: every event passes as produced; after the stream the last `done`
 * is verified and the summary follows as one `verifier` event. A turn that
 * ended in a choice card or degraded gets no verdict (nothing to check, and a
 * badge would sit on a failed turn).
 */
export async function* shadowVerifiedStream(
  base: AsyncIterable<ChatStreamEvent>,
  verify: (done: DoneEvent) => Promise<VerifierResultSummary>,
): AsyncGenerator<ChatStreamEvent> {
  let terminal: DoneEvent | undefined;
  let skipVerification = false;
  for await (const event of base) {
    yield event;
    if (event.type === 'done') {
      terminal = event;
      if (event.pendingUserChoice || event.degraded) skipVerification = true;
    }
  }
  if (terminal === undefined || skipVerification) return;
  yield { type: 'verifier', summary: await verify(terminal) };
}

/** What `enforce` needs from the service for a terminal `done`. */
export interface EnforcedVerdict {
  readonly summary: VerifierResultSummary;
  readonly releases: boolean;
}

/** `enforce`: the delivery gate described in the module comment. */
export async function* enforcedVerifiedStream(
  base: AsyncIterable<ChatStreamEvent>,
  verify: (done: DoneEvent) => Promise<EnforcedVerdict>,
  operatorLocale: string | undefined,
): AsyncGenerator<ChatStreamEvent> {
  const held: ChatStreamEvent[] = [];
  let terminal: DoneEvent | undefined;
  let failed = false;
  // Drained to the end even after the terminal event, as before: the
  // orchestrator's generator finishes its own work only when it is drained.
  for await (const event of base) {
    if (passesBeforeVerdict(event)) {
      yield event;
    } else if (event.type === 'error') {
      failed = true;
      yield event;
    } else if (!failed) {
      if (event.type === 'done') terminal = event;
      held.push(event);
    }
  }
  if (failed || terminal === undefined) return;
  if (releasesWithoutVerification(terminal)) {
    yield* held;
    return;
  }
  const { summary, releases } = await verify(terminal);
  if (releases) {
    for (const event of held) yield event === terminal ? { ...terminal, verifier: summary } : event;
  } else {
    const withheld = withheldDone(terminal, summary, operatorLocale);
    yield { type: 'text_delta', text: withheld.notice };
    yield withheld.done;
  }
  yield { type: 'verifier', summary };
}
