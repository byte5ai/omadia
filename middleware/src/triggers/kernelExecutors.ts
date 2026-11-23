/**
 * #2082 / #2085 — the kernel's step executors for trigger firings: the
 * store-backed pre-checks, data actions under the agent's grants, templated
 * posts and side-channel deliveries through the proactive gate, and the one
 * step that reaches a model, the agent's own turn.
 *
 * A trigger turn runs in the agent's envelope (its own chat agent, model
 * policy, grants) under two meters: model calls per firing (refused beyond
 * the trigger's limit) and actual cost (settled against the budget). It
 * offers no trigger tools: those need a person's turn context, so a trigger
 * cannot breed triggers.
 */

import { renderTableText, type ChatTurnInput, type SemanticAnswer } from '@omadia/channel-sdk';
import type { AgentSpeaker, AnswerEmitter } from '@omadia/plugin-api';
import { meterModelCalls, meterUsageCost } from '@omadia/usage-telemetry';
import {
  checkFlow,
  fieldClassesFromList,
  isAnswerWithheldText,
  readersWithin,
  runWithSeededDiscretion,
  UNKNOWN_READERS,
  violationSummary,
  type Readers,
} from '@omadia/orchestrator';

import { storeContextChecks, type ContextLivenessProbe } from './contextChecks.js';
import type { ConversationReaders } from './conversationReaders.js';
import { toTableData, type DataActionRunner } from './dataActions.js';
import { isHeadless } from './headless.js';
import type { ProactiveGate } from './proactiveGate.js';
import type { BatchOutcome, DeliveryOutcome, FiringStatus, StepExecutors, TurnOutcome } from './triggerChain.js';
import type { TriggerStore } from './triggerStore.js';
import { conversationIdOf, deliveryAddressOf } from './recipientGrants.js';
import type { Trigger } from './types.js';

/** The agent answers this, alone, when nothing is worth telling. */
export const NOTHING_TO_SAY = '[[nothing]]';

export interface AgentChat {
  chat(input: ChatTurnInput): Promise<SemanticAnswer>;
}

export interface KernelExecutorDeps {
  readonly store: TriggerStore;
  readonly dataActions: DataActionRunner;
  readonly gate: ProactiveGate;
  /** The agent's own chat agent, or undefined when it is not in service. */
  readonly agentChat: (agentSlug: string) => AgentChat | undefined;
  readonly liveness?: ContextLivenessProbe;
  /** A routine's turn runs through the routine runner (owner identity,
   *  output templates, run history). */
  readonly routineTurn?: (trigger: Trigger) => Promise<TurnOutcome>;
  /** Who a proactive message is from (#2045), or undefined when unknown. */
  readonly speakerOf?: (agentSlug: string) => AgentSpeaker | undefined;
  /** The agent's single emitter (#2045): a post passes it as `prose` (the
   *  identity guard; the agent wrote the template), a delivery as `data`. */
  readonly emitterOf?: (agentSlug: string) => AnswerEmitter | undefined;
  /** An Agent Builder schedule's turn ran (stamps the row). */
  readonly scheduleRan?: (trigger: Trigger) => Promise<void>;
  /** Is the schedule behind a headless trigger still enabled? A deleted or
   *  disabled schedule never runs a turn, even before its trigger is ended. */
  readonly scheduleLive?: (trigger: Trigger) => Promise<boolean>;
  /** A registered batch job's step (`batchJobs.ts`). */
  readonly batch?: (trigger: Trigger, job: string) => Promise<BatchOutcome>;
  /** Who reads a conversation now (criterion 24): the discretion check of a
   *  proactive message runs against the room at send time. Absent = an
   *  explicit target's readers are unknown (fail closed) and the trigger's
   *  own conversation keeps the readers its creating turn resolved. */
  readonly conversationReaders?: ConversationReaders;
}

/** The room a proactive message lands in, as the discretion check sees it. */
interface Room {
  readonly contextKey: string;
  readonly readers: Readers;
}


/** The system hint of a trigger turn: purpose and status, never data rows. */
export function triggerTurnHint(trigger: Trigger, status: FiringStatus): string {
  const checks = status.checks
    .map((c) => `${c.check}${c.rows !== undefined ? ` → ${String(c.rows)} row(s)${c.columns && c.columns.length > 0 ? ` [${c.columns.join(', ')}]` : ''}` : ''}`)
    .join('; ');
  return [
    `You are acting on your own trigger (no person asked in this turn). Purpose: ${trigger.purpose}.`,
    `It fired for ${status.occurrence.event ? 'an event' : 'its scheduled time'} (${status.occurrence.dueAt}); deadline ${trigger.until.toISOString()}.`,
    checks ? `Model-free checks before this turn: ${checks}.` : '',
    status.delivered.length > 0 ? `Already sent to the recipients in this firing: ${status.delivered.join(', ')}.` : '',
    status.occurrence.event ? `Event: ${JSON.stringify(status.occurrence.event).slice(0, 2000)}` : '',
    isHeadless(trigger)
      ? 'This is a standing order with no conversation: act through your tools. Your answer is recorded, not sent to anyone.'
      : `Your answer is sent as your message to ${trigger.target ? 'the other conversation this trigger targets (granted by an operator), whose members may differ from the conversation it was created in' : 'the conversation this trigger was created in'}. If nothing is worth telling, answer exactly ${NOTHING_TO_SAY} and nothing is sent.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Criterion 18 — the field rights a message may use in the room it lands in:
 * the ones stored at creation, only while that room is the creating
 * conversation and every reader now was a reader then. An explicit target or
 * a room that gained a reader gets none (fail closed).
 */
function roomFieldClasses(
  trigger: Trigger,
  discretion: { readonly readers: Readers; readonly fieldClasses?: readonly string[] },
  room: { readonly contextKey: string; readonly readers: Readers },
): readonly string[] | undefined {
  if (trigger.target) return undefined;
  return readersWithin(room.readers, discretion.readers) ? discretion.fieldClasses : undefined;
}

export function createKernelExecutors(deps: KernelExecutorDeps): StepExecutors {
  const checks = storeContextChecks(deps.store, deps.liveness);
  // Every proactive message names its agent (#2045 INV-4), stamped here from
  // the trigger's owner, never from model output.
  const send = (trigger: Trigger, message: SemanticAnswer) => {
    const speaker = deps.speakerOf?.(trigger.agentSlug);
    return deps.gate.send(trigger, speaker ? { ...message, speaker } : message);
  };
  /**
   * Criterion 24 — the room a message lands in, resolved at send time: an
   * explicit target's members now (unknown = fail closed); the trigger's own
   * conversation's members now where the channel can tell, else the readers
   * its creating turn resolved.
   */
  const roomOf = async (trigger: Trigger, stored: Room): Promise<Room> => {
    const address = deliveryAddressOf(trigger);
    if (address.target) {
      const { channel, conversationId } = address.target;
      const readers = deps.conversationReaders ? await deps.conversationReaders(channel, conversationId) : UNKNOWN_READERS;
      return { contextKey: `${channel}:${conversationId}`, readers };
    }
    const inConversation = trigger.contextKind === 'conversation' || trigger.contextKind === 'meeting';
    if (!deps.conversationReaders || !inConversation || !address.channel) return stored;
    const live = await deps.conversationReaders(address.channel, conversationIdOf(address.ref));
    return live.kind === 'unknown' ? stored : { contextKey: stored.contextKey, readers: live };
  };
  /** A message to another conversation needs the creating turn's discretion record. */
  const NO_RECORD: DeliveryOutcome = {
    delivered: false,
    reason: 'withheld by discretion: a message to another conversation needs the discretion record of the turn that set it',
  };
  /**
   * Spec 2042 §5.11 (INV-9) — a templated post or a delivery goes to its
   * room only when the readers there now may know everything the creating
   * turn had read (the template was written there). Refused as a whole,
   * never redacted. Undefined = it may go.
   */
  const refusedByDiscretion = async (trigger: Trigger): Promise<DeliveryOutcome | undefined> => {
    const discretion = trigger.discretion;
    if (!discretion) return trigger.target ? NO_RECORD : undefined;
    const room = await roomOf(trigger, discretion);
    const decision = checkFlow(discretion.labels, {
      kind: 'people',
      contextKey: room.contextKey,
      readers: room.readers,
      fieldClasses: fieldClassesFromList(roomFieldClasses(trigger, discretion, room)),
    });
    return decision.allowed
      ? undefined
      : { delivered: false, reason: `withheld by discretion: ${violationSummary(decision).join(', ')}` };
  };
  /** The emitter's verdict on a proactive output; undefined = publish it. */
  const refusedByEmitter = async (
    trigger: Trigger,
    emission: (speaker: AgentSpeaker) => Parameters<AnswerEmitter['emit']>[0],
  ): Promise<DeliveryOutcome | undefined> => {
    const emitter = deps.emitterOf?.(trigger.agentSlug);
    const speaker = deps.speakerOf?.(trigger.agentSlug);
    if (!emitter || !speaker) return undefined;
    const outcome = await emitter.emit(emission(speaker));
    return outcome.published ? undefined : { delivered: false, reason: `refused by the emitter: ${outcome.reason}` };
  };
  return {
    ...checks,
    runDataAction: (trigger, action) => deps.dataActions.run(trigger.agentSlug, action),
    async post(trigger, text) {
      const withheld = await refusedByDiscretion(trigger);
      if (withheld) return withheld;
      const refused = await refusedByEmitter(trigger, (speaker) => ({ type: 'prose', speaker, text }));
      return refused ?? send(trigger, { text });
    },
    // The side channel (§5.13): the rows go from the tool to the people as
    // `data`, rendered into `text` for channels that show only text.
    async deliver(trigger, result, title) {
      const withheld = await refusedByDiscretion(trigger);
      if (withheld) return withheld;
      const table = toTableData(result.rows, result.columns, title);
      const refused = await refusedByEmitter(trigger, (speaker) => ({ type: 'data', speaker, data: table }));
      return refused ?? send(trigger, { text: renderTableText(table), data: [table], textWithoutData: '' });
    },
    batch: (trigger, job) =>
      deps.batch
        ? deps.batch(trigger, job)
        : Promise.resolve({ due: 0, processed: 0, costUsd: 0, modelCalls: 0, error: 'batch jobs are not wired' }),
    async turn(trigger, instruction, status): Promise<TurnOutcome> {
      if (trigger.origin === 'routine' && deps.routineTurn) return deps.routineTurn(trigger);
      if (isHeadless(trigger) && deps.scheduleLive && !(await deps.scheduleLive(trigger))) {
        await deps.store.end(trigger.id, 'cancelled', { schedule: trigger.contextId, why: 'schedule disabled or deleted' });
        return { delivered: false, costUsd: 0, modelCalls: 0 };
      }
      if (trigger.target && !trigger.discretion) return { delivered: false, costUsd: 0, modelCalls: 0, error: NO_RECORD.reason };
      const agent = deps.agentChat(trigger.agentSlug);
      if (!agent) return { delivered: false, costUsd: 0, modelCalls: 0, error: `agent '${trigger.agentSlug}' is not in service` };
      const input: ChatTurnInput = {
        userMessage: instruction,
        sessionScope: `trigger:${trigger.id}`,
        extraSystemHint: triggerTurnHint(trigger, status),
      };
      // INV-9 — the turn starts with the labels of the turn that set its
      // trigger, and its answer is checked against the readers of the room it
      // goes to, as they are now (criterion 24). A headless turn answers nobody.
      const discretion = isHeadless(trigger) ? null : trigger.discretion;
      const room = discretion ? await roomOf(trigger, discretion) : undefined;
      const chat = (): Promise<SemanticAnswer> =>
        discretion && room
          ? runWithSeededDiscretion(
              {
                agentSlug: trigger.agentSlug,
                labels: discretion.labels,
                ...room,
                fieldClasses: roomFieldClasses(trigger, discretion, room) ?? [],
              },
              () => agent.chat(input),
            )
          : agent.chat(input);
      // A throwing turn still spent what it spent: measure around the catch.
      const metered = await meterUsageCost(() =>
        meterModelCalls(
          async () => {
            try {
              return { answer: await chat() };
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
          { limit: trigger.modelCallsPerFiring },
        ),
      );
      const costUsd = metered.costUsd;
      const modelCalls = metered.value.modelCalls;
      const result = metered.value.value;
      if ('error' in result) return { delivered: false, costUsd, modelCalls, error: result.error };
      if (isHeadless(trigger)) {
        // A schedule's effect is what its tools did; the turn completing is
        // the outcome. A refused model call still means it did not finish.
        if (metered.value.refused > 0) return { delivered: false, costUsd, modelCalls, error: 'the turn reached its model-call limit' };
        await deps.scheduleRan?.(trigger).catch(() => undefined);
        return { delivered: true, costUsd, modelCalls };
      }
      const text = result.answer.text.trim();
      if (text === '' || text.startsWith(NOTHING_TO_SAY)) return { delivered: false, costUsd, modelCalls };
      // Refused at the people egress: nobody asked, so nothing to decline.
      // Counts as a failure, so a trigger that keeps producing what its
      // conversation may not know is paused by its breaker.
      if (isAnswerWithheldText(text)) {
        return { delivered: false, costUsd, modelCalls, error: 'the answer was withheld by discretion' };
      }
      if (metered.value.refused > 0) {
        // A call the limit refused was swallowed on the way: the answer is
        // not what the agent would have said with its full turn.
        return { delivered: false, costUsd, modelCalls, error: 'the turn reached its model-call limit' };
      }
      const sent = await send(trigger, result.answer);
      return sent.delivered
        ? { delivered: true, costUsd, modelCalls }
        : { delivered: false, costUsd, modelCalls, error: `answer not delivered: ${sent.reason}` };
    },
  };
}
