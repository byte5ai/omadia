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

import { storeContextChecks, type ContextLivenessProbe } from './contextChecks.js';
import { toTableData, type DataActionRunner } from './dataActions.js';
import { isHeadless } from './headless.js';
import type { ProactiveGate } from './proactiveGate.js';
import type { BatchOutcome, DeliveryOutcome, FiringStatus, StepExecutors, TurnOutcome } from './triggerChain.js';
import type { TriggerStore } from './triggerStore.js';
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
      : `Your answer is sent as your message to the conversation this trigger was created in. If nothing is worth telling, answer exactly ${NOTHING_TO_SAY} and nothing is sent.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function createKernelExecutors(deps: KernelExecutorDeps): StepExecutors {
  const checks = storeContextChecks(deps.store, deps.liveness);
  // Every proactive message names its agent (#2045 INV-4), stamped here from
  // the trigger's owner, never from model output.
  const send = (trigger: Trigger, message: SemanticAnswer) => {
    const speaker = deps.speakerOf?.(trigger.agentSlug);
    return deps.gate.send(trigger, speaker ? { ...message, speaker } : message);
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
      const refused = await refusedByEmitter(trigger, (speaker) => ({ type: 'prose', speaker, text }));
      return refused ?? send(trigger, { text });
    },
    // The side channel (§5.13): the rows go from the tool to the people as
    // `data`, rendered into `text` for channels that show only text.
    async deliver(trigger, result, title) {
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
      const agent = deps.agentChat(trigger.agentSlug);
      if (!agent) return { delivered: false, costUsd: 0, modelCalls: 0, error: `agent '${trigger.agentSlug}' is not in service` };
      const input: ChatTurnInput = {
        userMessage: instruction,
        sessionScope: `trigger:${trigger.id}`,
        extraSystemHint: triggerTurnHint(trigger, status),
      };
      // A throwing turn still spent what it spent: measure around the catch.
      const metered = await meterUsageCost(() =>
        meterModelCalls(
          async () => {
            try {
              return { answer: await agent.chat(input) };
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
