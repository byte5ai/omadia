import type { KnowledgeGraph, PluginContext } from '@omadia/plugin-api';
import type { TurnHookRegistrar } from '@omadia/orchestrator';

import { shouldPlan } from './gate.js';
import { materializePlan } from './materializer.js';
import {
  advanceStep,
  finishPlan,
  startFirstStep,
  type TurnPlanState,
} from './progress.js';

/**
 * `@omadia/plugin-plan-runner` — #133 (plan-as-data) slice E2.
 *
 * When enabled, subscribes to the orchestrator's `onBeforeTurn` hook (E0),
 * runs a Haiku gate to decide whether the turn warrants a plan, and — if so —
 * materialises a `Plan` + `PlanStep` DAG (E1) before the turn executes.
 *
 * Inert by default: the `enabled` setup field defaults to `off`, and the
 * plugin degrades to a no-op when any dependency (turn-hook registry,
 * knowledge graph, LLM) is unavailable.
 */

/** Compact, labelled evidence string for a step's resultSummary. */
function summarise(toolName: string | undefined, result: string): string {
  const head = result.length > 200 ? `${result.slice(0, 200)}…` : result;
  return toolName ? `${toolName}: ${head}` : head;
}

export interface PlanRunnerPluginHandle {
  close(): Promise<void>;
}

const NOOP: PlanRunnerPluginHandle = {
  async close(): Promise<void> {
    /* nothing registered */
  },
};

export async function activate(
  ctx: PluginContext,
): Promise<PlanRunnerPluginHandle> {
  ctx.log('[plan-runner] activating');

  if (ctx.config.get<string>('enabled') !== 'on') {
    ctx.log('[plan-runner] disabled (set setup field `enabled=on` to arm)');
    return NOOP;
  }

  const registrar = ctx.services.get<TurnHookRegistrar>('turnHookRegistry');
  const kg = ctx.services.get<KnowledgeGraph>('knowledgeGraph');
  const llm = ctx.llm;
  if (!registrar || !kg || !llm) {
    ctx.log(
      `[plan-runner] inert — missing deps (turnHookRegistry=${String(
        !!registrar,
      )} knowledgeGraph=${String(!!kg)} llm=${String(!!llm)})`,
    );
    return NOOP;
  }

  // Per-turn progress state, keyed by orchestrator turn id. Populated at
  // onBeforeTurn (after materialisation) and drained at onAfterTurn. An
  // errored turn (no onAfterTurn) leaves a small stale entry — acceptable
  // for E3; a TTL/cap is a later hardening.
  const planState = new Map<string, TurnPlanState>();
  const disposers: Array<() => void> = [];

  disposers.push(
    registrar.register('onBeforeTurn', {
      label: 'plan-runner:onBeforeTurn',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void> => {
        const userMessage = payload.userMessage?.trim();
        if (!userMessage) return;
        if (!(await shouldPlan(userMessage, llm))) return;
        const result = await materializePlan({
          planId: hookCtx.turnId,
          scope: hookCtx.sessionScope ?? hookCtx.turnId,
          userMessage,
          createdAt: new Date().toISOString(),
          llm,
          kg,
        });
        if (!result) return;
        const state: TurnPlanState = {
          stepExternalIds: result.stepExternalIds,
          cursor: 0,
        };
        planState.set(hookCtx.turnId, state);
        await startFirstStep(state, kg);
        ctx.log(
          `[plan-runner] materialised ${result.planExternalId} (${String(
            result.stepCount,
          )} steps)`,
        );
      },
    }),
  );

  disposers.push(
    registrar.register('onAfterToolCall', {
      label: 'plan-runner:onAfterToolCall',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void> => {
        const state = planState.get(hookCtx.turnId);
        if (!state) return;
        await advanceStep(
          state,
          kg,
          payload.toolResult !== undefined
            ? { resultSummary: summarise(payload.toolName, payload.toolResult) }
            : undefined,
        );
      },
    }),
  );

  disposers.push(
    registrar.register('onAfterTurn', {
      label: 'plan-runner:onAfterTurn',
      priority: 10,
      hook: async (hookCtx): Promise<void> => {
        const state = planState.get(hookCtx.turnId);
        if (!state) return;
        await finishPlan(state, kg);
        planState.delete(hookCtx.turnId);
      },
    }),
  );

  ctx.log(
    '[plan-runner] ready (onBeforeTurn/onAfterToolCall/onAfterTurn hooks registered)',
  );
  return {
    async close(): Promise<void> {
      ctx.log('[plan-runner] deactivating');
      for (const dispose of disposers) dispose();
      planState.clear();
    },
  };
}
