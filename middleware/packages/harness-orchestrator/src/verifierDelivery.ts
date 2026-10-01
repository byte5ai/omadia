import {
  applyAiDisclosure,
  composeVerifierBlockedText,
  NO_REPLY_SENTINEL,
} from '@omadia/channel-sdk';
import type { AiDisclosure, AnswerSource } from '@omadia/channel-sdk';
import { bindVerdictToClaims } from '@omadia/verifier';
import type { VerifierVerdict } from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatTurnResult,
  VerifierResultSummary,
} from './orchestrator.js';
import { PROMPT_MASK_BLOCKED_ANSWER, SECURITY_QUARANTINE_NOTICE } from './orchestrator.js';

/**
 * Delivery policy of the answer-verifier wrapper (`VerifierService`): what a
 * client receives of a turn, and when, given the verdict.
 *
 * `shadow` observes ({@link shadowVerifiedStream}): every event goes out as the
 * orchestrator produces it, and the verdict follows as one trailing `verifier`
 * event. Nothing is replaced; behind a Privacy Shield only the terminal `done`
 * waits, because the receipt it carries exists once the verifier is done.
 *
 * `enforce` is a delivery gate ({@link enforcedVerifiedStream}; the
 * non-streaming `VerifierService.chat` applies the same verdict rule):
 *  - While the verdict is pending only liveness, progress and usage events
 *    pass ({@link passesBeforeVerdict}). Everything that carries model or
 *    tool content is held: text deltas, tool calls and results, sub-agent
 *    tool traffic, nudges, turn annotations, canvas surface events and the
 *    terminal `done`. Surfaces a canvas composer synthesises from tool
 *    results downstream are held with the results they come from, and the
 *    composer holds its own skeleton until the verdict as well
 *    (`ChatAgent.holdsContentUntilVerdict`).
 *  - A verdict that confirmed the answer, or found nothing in it to check,
 *    releases the held events in order, with the summary on `done`
 *    ({@link verdictReleasesAnswer}). The answer's text goes out as one
 *    `text_delta` right before `done` — the text the verdict is about, never
 *    the deltas the model streamed ({@link releasedTurn}).
 *  - Any other verdict withholds the answer — it fails closed: a
 *    contradiction, claims the verifier could not confirm or did not cover,
 *    and a verifier that could not run all withhold. The client gets one
 *    `text_delta` with the notice and a `done` marked `answerSource:
 *    'verifier-blocked'` ({@link withheldDone}); none of the held events.
 *  - An answer the verifier may not see behind a Privacy Shield — one it
 *    rendered server-side, or a turn that handed over no privacy view
 *    (`verifierGate`, `verifierPrivacyGate.ts`) — never reaches the
 *    verifier, so it is withheld as well ({@link privacyShieldVerdict}).
 *  - Control-flow terminals are released without a verdict, the same way
 *    ({@link releasesWithoutVerification}); a bare NO_REPLY releases its
 *    `done` and nothing else ({@link isDeliberateSilence}).
 *  - A turn that fails (an `error` event, or no `done`) releases nothing it
 *    held; the `error` itself goes out.
 *  - A contradiction may buy one correction retry ({@link EnforcedRetry}):
 *    the service re-enters the turn over the first run's tool results (no
 *    tool runs twice, `toolReplayLedger.ts`), the retry is held the same way,
 *    and its verdict decides by the same rule. Nothing of the first turn is
 *    released once a retry ran; a retry that fails or is abandoned stays
 *    internal and the first turn is withheld.
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
  readonly answerSource?: AnswerSource;
  readonly pendingUserChoice?: unknown;
  readonly pendingMcpInput?: unknown;
  readonly pendingSlotCard?: unknown;
  readonly pendingOAuthConsent?: boolean;
  readonly degraded?: true;
  /** The turn's AI disclosure; a streamed `done` folds its block into
   *  `answer` on the first turn of a scope. */
  readonly aiDisclosure?: AiDisclosure;
}

/**
 * The agent's deliberate silence: `NO_REPLY` as the whole answer. Only this
 * strict form. An answer that merely ends with the sentinel on its own line —
 * which `isNoReply` also accepts, so channels that honour it stay silent —
 * still states whatever comes before the sentinel, and a stream consumer,
 * which does not honour it, shows all of it.
 */
export function isDeliberateSilence(answer: string): boolean {
  return answer.trim() === NO_REPLY_SENTINEL;
}

/**
 * Turns `enforce` releases without a verdict. A choice card, an MCP input
 * form, a slot picker and an OAuth consent prompt ask the user for input; a
 * degraded turn's answer is the server-composed turn-incomplete notice; the
 * privacy refusal (`PROMPT_MASK_BLOCKED_ANSWER`) and the inbound screening
 * quarantine (`SECURITY_QUARANTINE_NOTICE`) are server-composed notices of a
 * turn whose model never ran; a bare NO_REPLY is the agent's deliberate
 * silence, which a withheld-answer notice would break.
 *
 * Only the last four are sure to state no fact. A card rides on whatever
 * answer its turn produced: the text the model wrote before a choice card or
 * an MCP input form ended the turn, and for a slot picker, an OAuth consent
 * prompt or a choice card the card-router pass attached, a complete answer —
 * which then goes out unchecked, without a verdict.
 *
 * A degraded turn whose answer Privacy Shield had already rendered
 * (`answerSource: 'privacy-render'`) is not exempt: it is a real answer, and
 * `enforce` withholds it without sending it to the verifier
 * ({@link privacyShieldVerdict}).
 */
export function releasesWithoutVerification(turn: ControlFlowTurn): boolean {
  return (
    Boolean(turn.pendingUserChoice) ||
    Boolean(turn.pendingMcpInput) ||
    Boolean(turn.pendingSlotCard) ||
    turn.pendingOAuthConsent === true ||
    (turn.degraded === true && turn.answerSource !== 'privacy-render') ||
    isServerNotice(turn) ||
    isDeliberateSilence(turn.answer)
  );
}

/** The privacy refusal or the screening quarantine as the whole answer — the
 *  disclosure block a stream folds into a first turn's `done` set aside. */
function isServerNotice(turn: ControlFlowTurn): boolean {
  const text = withoutFoldedDisclosure(turn.answer, turn.aiDisclosure);
  return text === PROMPT_MASK_BLOCKED_ANSWER || text === SECURITY_QUARANTINE_NOTICE;
}

/**
 * The verdict `enforce` records for an answer the verifier may not see
 * (`verifierGate`, `verifierPrivacyGate.ts`): one Privacy Shield v4 rendered
 * server-side (`answerSource: 'privacy-render'`), degraded or not — it holds
 * real values the turn's model never saw — or, behind a shield, a turn that
 * handed over no privacy view to verify through. The pipeline never gets it,
 * and `enforce` cannot confirm it, so it is withheld — it fails closed.
 */
export function privacyShieldVerdict(): VerifierVerdict {
  return { status: 'unavailable', reason: 'privacy_shield', claims: [], latencyMs: 0 };
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
 * `agentsConsulted`, `privacyReceipt`, `correlationId`), and so do a degraded
 * turn's failure markers (`degraded`, `committedTools` — tool names): the
 * turn still threw after a tool committed, and the operator health signal,
 * the API-key audit and the web chat's turn-incomplete row read them.
 * Everything that carried the withheld answer's content goes — attachments,
 * files, follow-ups, masked values, the delegated answer, cards, excerpts and
 * any field added later. The notice is in the turn's disclosure locale, then
 * the operator's, German by default; when the turn folded its AI disclosure
 * into `answer` (first turn of a scope), the notice carries the same block —
 * on `done.answer` only, never in the delta, like every disclosure.
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
      ...(done.degraded === true
        ? {
            degraded: true,
            ...(done.committedTools ? { committedTools: done.committedTools } : {}),
          }
        : {}),
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

/** The disclosure block `applyAiDisclosure` folded into `answer` on the first
 *  turn of a scope, when `answer` ends with it (the format is shared). */
function foldedDisclosureBlock(
  answer: string,
  disclosure: AiDisclosure | undefined,
): string | undefined {
  if (!disclosure) return undefined;
  const block = applyAiDisclosure('', { disclosure }).text;
  return block.length > 0 && answer.endsWith(block) ? block : undefined;
}

/** The notice, plus the disclosure block when the turn's own answer ended
 *  with it. */
function withTurnDisclosure(
  notice: string,
  turnAnswer: string,
  disclosure: AiDisclosure | undefined,
): string {
  return disclosure && foldedDisclosureBlock(turnAnswer, disclosure) !== undefined
    ? applyAiDisclosure(notice, { disclosure }).text
    : notice;
}

/** `answer` without the disclosure block the fold added: its own paragraph
 *  after the answer, or the whole answer when the answer itself was blank. */
function withoutFoldedDisclosure(answer: string, disclosure: AiDisclosure | undefined): string {
  const block = foldedDisclosureBlock(answer, disclosure);
  if (block === undefined) return answer;
  if (answer === block) return '';
  const paragraph = `\n\n${block}`;
  return answer.endsWith(paragraph) ? answer.slice(0, -paragraph.length) : answer;
}

/**
 * A released turn as the client receives it: the held events in their
 * order, with the answer's text as one `text_delta` right before `done` in
 * place of the deltas the model streamed. The verdict is about
 * `done.answer`, and the streamed deltas can say more: the orchestrator
 * streams each model response live and may then discard it and run the model
 * again (an unmet sub-agent obligation, a file it announced but did not
 * build), so the discarded response is in the deltas but not in
 * `done.answer`. The delta leaves out the disclosure block a first turn folds
 * into `answer` — disclosures never go out as a delta. A held `done` other
 * than the terminal one is dropped. The events finishing the request
 * produced (`FinishedDone.events`) go out right before the text.
 */
function* releasedTurn(
  held: readonly ChatStreamEvent[],
  terminal: DoneEvent,
  released: FinishedDone,
): Generator<ChatStreamEvent> {
  for (const event of held) {
    if (event === terminal) {
      yield* released.events;
      const { done } = released;
      const text = withoutFoldedDisclosure(done.answer, done.aiDisclosure);
      if (text.length > 0) yield { type: 'text_delta', text };
      yield done;
    } else if (event.type !== 'text_delta' && event.type !== 'done') {
      yield event;
    }
  }
}

/** What `shadow` needs from the service for one streamed turn. */
export interface ShadowStreamHooks {
  /**
   * Called on the terminal `done`. True when the turn handed its privacy
   * finalisation over: `done` — which then carries the turn's receipt — is
   * held until {@link finish}, after the verifier.
   */
  holdDone(done: DoneEvent): boolean;
  /** The summary of the verdict on `done`; `undefined` when the answer is
   *  not verified (behind a Privacy Shield without a view to verify through). */
  verify(done: DoneEvent): Promise<VerifierResultSummary | undefined>;
  /** A held `done` as it goes out: the turn finalized, its receipt on it. */
  finish(done: DoneEvent): Promise<DoneEvent>;
}

/**
 * `shadow`: every event passes as produced; after the stream the last `done`
 * is verified and the summary follows as one `verifier` event. A turn that
 * ended in a choice card or degraded gets no verdict (nothing to check, and a
 * badge would sit on a failed turn). Behind a Privacy Shield the terminal
 * `done` is held: the inner stream is drained, the answer verified through
 * the turn's privacy view, the turn finalized, and `done` goes out with its
 * receipt, right before the `verifier` event. The streamed text is on screen
 * already; only completion waits.
 */
export async function* shadowVerifiedStream(
  base: AsyncIterable<ChatStreamEvent>,
  hooks: ShadowStreamHooks,
): AsyncGenerator<ChatStreamEvent> {
  let terminal: DoneEvent | undefined;
  let held = false;
  let skipVerification = false;
  for await (const event of base) {
    if (event.type === 'done') {
      terminal = event;
      if (event.pendingUserChoice || event.degraded) skipVerification = true;
      held = hooks.holdDone(event);
      if (held) continue;
    }
    yield event;
  }
  if (terminal === undefined) return;
  const summary = skipVerification ? undefined : await hooks.verify(terminal);
  if (held) yield await hooks.finish(terminal);
  if (summary !== undefined) yield { type: 'verifier', summary };
}

/** What `enforce` needs from the service for a terminal `done`. */
export interface EnforcedVerdict {
  readonly summary: VerifierResultSummary;
  readonly releases: boolean;
  /**
   * A correction re-entry to run instead of delivering this verdict. Its
   * stream is held exactly like the first turn's — liveness passes, nothing
   * else — and replaces the first turn when its verdict is delivered.
   */
  readonly retry?: EnforcedRetry;
}

/**
 * The stream's correction retry (`VerifierService`). It re-generates the
 * answer over the first run's tool results (`toolReplayLedger.ts`), so it
 * runs no tool twice; the release rule above decides what goes out.
 */
export interface EnforcedRetry {
  readonly stream: AsyncIterable<ChatStreamEvent>;
  /**
   * The verdict to deliver once the re-entry drained. `done` is the
   * re-entry's answer, or `undefined` when it produced none worth judging
   * (it failed, was abandoned, or ended in a control-flow terminal); then the
   * verdict is the first turn's and `useRetry` is false.
   */
  judge(done: DoneEvent | undefined): Promise<EnforcedVerdict & { readonly useRetry: boolean }>;
}

/** A terminal `done` with the request's record on it, and the events that
 *  recording produced — released with the answer, dropped with a withheld
 *  one. */
export interface FinishedDone {
  readonly done: DoneEvent;
  readonly events: readonly ChatStreamEvent[];
}

/**
 * Adds the request's record to the `done` that goes out (the receipt of
 * every pass, the persisted turn) once nothing else can change it — behind
 * a Privacy Shield after every pass was finalized, so the receipt also
 * covers the verifier's requests. `fromRetry` says which turn `done` came
 * from: the first one, or the correction retry whose verdict is delivered.
 */
export type FinishDone = (done: DoneEvent, fromRetry: boolean) => Promise<FinishedDone>;

interface HeldTurn {
  readonly held: ChatStreamEvent[];
  readonly terminal: DoneEvent | undefined;
  readonly failed: boolean;
}

/**
 * Drains one turn: liveness events pass, everything else is held. The first
 * turn's `error` goes out as it arrives; a re-entry's error — or exception —
 * stays internal, the first turn's outcome is delivered instead.
 */
async function* holdTurn(
  base: AsyncIterable<ChatStreamEvent>,
  reentry: boolean,
): AsyncGenerator<ChatStreamEvent, HeldTurn> {
  const held: ChatStreamEvent[] = [];
  let terminal: DoneEvent | undefined;
  let failed = false;
  try {
    // Drained to the end even after the terminal event, as before: the
    // orchestrator's generator finishes its own work only when it is drained.
    for await (const event of base) {
      if (passesBeforeVerdict(event)) {
        yield event;
      } else if (event.type === 'error') {
        failed = true;
        if (!reentry) yield event;
      } else if (!failed) {
        if (event.type === 'done') terminal = event;
        held.push(event);
      }
    }
  } catch (err) {
    if (!reentry) throw err;
    failed = true;
  }
  return { held, terminal, failed };
}

/** A re-entry's answer worth a verdict: not failed, and an ordinary answer. */
function judgeableAnswer(turn: HeldTurn): DoneEvent | undefined {
  const done = turn.terminal;
  if (turn.failed || done === undefined) return undefined;
  if (isDeliberateSilence(done.answer) || releasesWithoutVerification(done)) return undefined;
  return done;
}

const asIs: FinishDone = (done) => Promise.resolve({ done, events: [] });

/** `enforce`: the delivery gate described in the module comment. */
export async function* enforcedVerifiedStream(
  base: AsyncIterable<ChatStreamEvent>,
  verify: (done: DoneEvent) => Promise<EnforcedVerdict>,
  operatorLocale: string | undefined,
  finishDone: FinishDone = asIs,
): AsyncGenerator<ChatStreamEvent> {
  const first = yield* holdTurn(base, false);
  if (first.failed || first.terminal === undefined) return;
  let held = first.held;
  let terminal = first.terminal;
  let fromRetry = false;
  if (isDeliberateSilence(terminal.answer)) {
    // Silence carries nothing: not the text or tool traffic that led to it.
    yield (await finishDone(terminal, fromRetry)).done;
    return;
  }
  if (releasesWithoutVerification(terminal)) {
    yield* releasedTurn(held, terminal, await finishDone(terminal, fromRetry));
    return;
  }
  let outcome: EnforcedVerdict = await verify(terminal);
  if (outcome.retry) {
    const second = yield* holdTurn(outcome.retry.stream, true);
    const answer = judgeableAnswer(second);
    const judged = await outcome.retry.judge(answer);
    outcome = judged;
    if (judged.useRetry && answer !== undefined) {
      held = second.held;
      terminal = answer;
      fromRetry = true;
    }
  }
  const { summary, releases } = outcome;
  if (releases) {
    yield* releasedTurn(held, terminal, await finishDone({ ...terminal, verifier: summary }, fromRetry));
  } else {
    const finished = await finishDone(terminal, fromRetry);
    const withheld = withheldDone(finished.done, summary, operatorLocale);
    yield { type: 'text_delta', text: withheld.notice };
    yield withheld.done;
  }
  yield { type: 'verifier', summary };
}
