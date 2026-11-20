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

import type { ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';
import { meterModelCalls, meterUsageCost } from '@omadia/usage-telemetry';

import { storeContextChecks, type ContextLivenessProbe } from './contextChecks.js';
import type { DataActionRunner } from './dataActions.js';
import { renderDataTable, type ProactiveGate } from './proactiveGate.js';
import type { FiringStatus, StepExecutors, TurnOutcome } from './triggerChain.js';
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
    `Your answer is sent as your message to the conversation this trigger was created in. If nothing is worth telling, answer exactly ${NOTHING_TO_SAY} and nothing is sent.`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function createKernelExecutors(deps: KernelExecutorDeps): StepExecutors {
  const checks = storeContextChecks(deps.store, deps.liveness);
  return {
    ...checks,
    runDataAction: (trigger, action) => deps.dataActions.run(trigger.agentSlug, action),
    post: (trigger, text) => deps.gate.send(trigger, { text }),
    deliver: (trigger, result, title) =>
      deps.gate.send(trigger, { text: renderDataTable(result.rows, result.columns, title) }),
    async turn(trigger, instruction, status): Promise<TurnOutcome> {
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
      const text = result.answer.text.trim();
      if (text === '' || text.startsWith(NOTHING_TO_SAY)) return { delivered: false, costUsd, modelCalls };
      if (metered.value.refused > 0) {
        // A call the limit refused was swallowed on the way: the answer is
        // not what the agent would have said with its full turn.
        return { delivered: false, costUsd, modelCalls, error: 'the turn reached its model-call limit' };
      }
      const sent = await deps.gate.send(trigger, result.answer);
      return sent.delivered
        ? { delivered: true, costUsd, modelCalls }
        : { delivered: false, costUsd, modelCalls, error: `answer not delivered: ${sent.reason}` };
    },
  };
}
