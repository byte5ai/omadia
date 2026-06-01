import type { KnowledgeGraph, PluginContext } from '@omadia/plugin-api';
import type { TurnHookRegistrar } from '@omadia/orchestrator';

import { shouldPlan } from './gate.js';
import { materializePlan } from './materializer.js';

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

  const dispose = registrar.register('onBeforeTurn', {
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
      if (result) {
        ctx.log(
          `[plan-runner] materialised ${result.planExternalId} (${String(
            result.stepCount,
          )} steps)`,
        );
      }
    },
  });

  ctx.log('[plan-runner] ready (onBeforeTurn hook registered)');
  return {
    async close(): Promise<void> {
      ctx.log('[plan-runner] deactivating');
      dispose();
    },
  };
}
