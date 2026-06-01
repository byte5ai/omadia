import type { KnowledgeGraph, PluginContext } from '@omadia/plugin-api';
import type { TurnHookRegistrar } from '@omadia/orchestrator';

import { shouldPlan } from './gate.js';
import { materializePlan } from './materializer.js';
import {
  advanceStep,
  applyReplan,
  finishPlan,
  startFirstStep,
  type TurnPlanState,
} from './progress.js';
import {
  exitConditionMet,
  isToolFailure,
  markLatestPlanVerifierBlocked,
  replanRemainder,
} from './replanner.js';

/**
 * `@omadia/plugin-plan-runner` — #133 (plan-as-data) slices E2–E4.
 *
 * When enabled, subscribes to the orchestrator turn hooks (E0):
 *   - onBeforeTurn: Haiku gate (E2) → materialise a Plan + PlanStep DAG (E1)
 *     before the turn executes.
 *   - onAfterToolCall: advance step status / record evidence (E3); on a tool
 *     failure, replan the remainder of the DAG (E4).
 *   - onAfterTurn: finalise the in-progress step.
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

/** Per-turn plan state + replan context, keyed by orchestrator turn id. */
interface TurnRecord {
  readonly plan: TurnPlanState;
  readonly planExternalId: string;
  readonly planId: string;
  readonly scope: string;
  readonly userMessage: string;
  /** ISO timestamp the plan was created with — reused on the onAfterTurn
   *  re-ingest so the PLAN_OF back-link doesn't rewrite `createdAt` (E8). */
  readonly createdAt: string;
  /** Wall-clock ms at creation — used to evict leaked records (an errored
   *  turn never fires onAfterTurn, so its entry would otherwise live forever). */
  readonly startedAtMs: number;
  /** Step external id → its exit condition, for the opt-in E4 trigger (b)
   *  check. Only initial-plan steps are tracked (replan steps aren't). */
  readonly exitConditionByStep: ReadonlyMap<string, string>;
  /** Replan counter — namespaces recovery step ids. */
  generation: number;
}

/** Default eviction bounds for the per-turn state map. A turn that errors
 *  before `onAfterTurn` leaves a stale entry; without this it would leak. */
const TURN_TTL_MS = 30 * 60 * 1000; // 30 min — far longer than any real turn
const TURN_MAX_ENTRIES = 1000;

/**
 * Evict stale + over-cap entries from the per-turn state map in place.
 * Pure-ish (mutates the passed map only) and exported for unit testing.
 * Called on each `onBeforeTurn` before inserting the new record, so a leaked
 * entry (errored turn → no `onAfterTurn`) is cleaned up by later activity.
 */
export function pruneTurns<T extends { startedAtMs: number }>(
  turns: Map<string, T>,
  now: number,
  opts: { ttlMs?: number; maxEntries?: number } = {},
): void {
  const ttlMs = opts.ttlMs ?? TURN_TTL_MS;
  const maxEntries = opts.maxEntries ?? TURN_MAX_ENTRIES;
  for (const [id, rec] of turns) {
    if (now - rec.startedAtMs > ttlMs) turns.delete(id);
  }
  if (turns.size > maxEntries) {
    // Map preserves insertion order → oldest-first. Drop the excess head.
    const excess = turns.size - maxEntries;
    let dropped = 0;
    for (const id of turns.keys()) {
      if (dropped >= excess) break;
      turns.delete(id);
      dropped += 1;
    }
  }
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

  // Opt-in E4 trigger (b): after a tool completes a step that declared an exit
  // condition, ask Haiku whether the result satisfies it; if not, replan the
  // remainder. Off by default — it adds a Haiku call per completing step on the
  // turn hot-path, so operators arm it deliberately.
  const verifyExitConditions =
    ctx.config.get<string>('verifyExitConditions') === 'on';

  // Per-turn plan state + replan context, keyed by orchestrator turn id.
  // Populated at onBeforeTurn (after materialisation) and drained at
  // onAfterTurn. An errored turn never fires onAfterTurn, so we evict stale
  // entries (TTL + hard cap) on each onBeforeTurn via pruneTurns().
  const turns = new Map<string, TurnRecord>();
  const disposers: Array<() => void> = [];

  disposers.push(
    registrar.register('onBeforeTurn', {
      label: 'plan-runner:onBeforeTurn',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void> => {
        const userMessage = payload.userMessage?.trim();
        if (!userMessage) return;
        if (!(await shouldPlan(userMessage, llm))) return;
        const scope = hookCtx.sessionScope ?? hookCtx.turnId;
        const nowMs = Date.now();
        const createdAt = new Date(nowMs).toISOString();
        const result = await materializePlan({
          planId: hookCtx.turnId,
          scope,
          userMessage,
          createdAt,
          llm,
          kg,
        });
        if (!result) return;
        // Evict any leaked records before adding this turn's.
        pruneTurns(turns, nowMs);
        const exitConditionByStep = new Map<string, string>();
        result.stepExternalIds.forEach((stepId, i) => {
          const cond = result.exitConditions[i];
          if (cond) exitConditionByStep.set(stepId, cond);
        });
        const record: TurnRecord = {
          plan: { stepExternalIds: result.stepExternalIds, cursor: 0 },
          planExternalId: result.planExternalId,
          planId: hookCtx.turnId,
          scope,
          userMessage,
          createdAt,
          startedAtMs: nowMs,
          exitConditionByStep,
          generation: 0,
        };
        turns.set(hookCtx.turnId, record);
        await startFirstStep(record.plan, kg);
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
        const record = turns.get(hookCtx.turnId);
        if (!record) return;
        const currentId = record.plan.stepExternalIds[record.plan.cursor];
        if (currentId === undefined) return;

        // Trigger (a) — tool failure → replan the remainder of the DAG.
        if (isToolFailure(payload.toolResult)) {
          record.generation += 1;
          const { newStepExternalIds } = await replanRemainder({
            planExternalId: record.planExternalId,
            planId: record.planId,
            scope: record.scope,
            userMessage: record.userMessage,
            failedStepExternalId: currentId,
            failureReason: payload.toolResult ?? 'tool failed',
            generation: record.generation,
            llm,
            kg,
          });
          if (newStepExternalIds.length > 0) {
            await applyReplan(record.plan, newStepExternalIds, kg);
            ctx.log(
              `[plan-runner] replanned after step failure (+${String(
                newStepExternalIds.length,
              )} steps)`,
            );
          } else {
            // No recovery path — abandon the plan but don't loop.
            record.plan.cursor += 1;
          }
          return;
        }

        // Trigger (b) — exit condition unmet → replan the remainder. Opt-in
        // (verifyExitConditions), and only for a step that declared a condition
        // with a real tool result. Defaults to "satisfied" on LLM error so a
        // flaky check never causes a replan storm.
        const exitCond = record.exitConditionByStep.get(currentId);
        if (
          verifyExitConditions &&
          exitCond !== undefined &&
          payload.toolResult !== undefined &&
          !(await exitConditionMet(exitCond, payload.toolResult, llm))
        ) {
          record.generation += 1;
          const { newStepExternalIds } = await replanRemainder({
            planExternalId: record.planExternalId,
            planId: record.planId,
            scope: record.scope,
            userMessage: record.userMessage,
            failedStepExternalId: currentId,
            failureReason: `exit condition not met: ${exitCond}`,
            generation: record.generation,
            llm,
            kg,
          });
          if (newStepExternalIds.length > 0) {
            await applyReplan(record.plan, newStepExternalIds, kg);
            ctx.log(
              `[plan-runner] replanned after unmet exit condition (+${String(
                newStepExternalIds.length,
              )} steps)`,
            );
          } else {
            record.plan.cursor += 1;
          }
          return;
        }

        await advanceStep(
          record.plan,
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
      hook: async (hookCtx, payload): Promise<void> => {
        const record = turns.get(hookCtx.turnId);
        if (!record) return;
        // E8 — the Turn node only exists once the session log lands, which is
        // after our onBeforeTurn plan creation. Now that the orchestrator hands
        // us the persisted Turn id, re-ingest the (idempotent) Plan with it: this
        // writes the PLAN_OF back-link + sets `plan.props.turnId`, so the plan is
        // no longer a graph orphan and the chat UI can resolve it by turn id.
        if (payload.turnExternalId) {
          try {
            await kg.ingestPlan({
              planId: record.planId,
              scope: record.scope,
              turnExternalId: payload.turnExternalId,
              createdBy: 'gate',
              createdAt: record.createdAt,
            });
          } catch (err) {
            ctx.log(
              `[plan-runner] PLAN_OF link failed for ${record.planExternalId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        await finishPlan(record.plan, kg);
        turns.delete(hookCtx.turnId);
      },
    }),
  );

  // #133 E6 — a verifier `blocked` verdict (fired by VerifierService, keyed by
  // scope) marks the scope's latest plan as verifier-rejected. Advisory: the
  // verifier runs its own retry; this surfaces the rejection on the plan.
  disposers.push(
    registrar.register('onVerifierBlocked', {
      label: 'plan-runner:onVerifierBlocked',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void> => {
        const scope = hookCtx.sessionScope;
        if (!scope) return;
        const marked = await markLatestPlanVerifierBlocked(
          scope,
          payload.blockReason ?? 'contradiction',
          kg,
        );
        if (marked) {
          ctx.log(`[plan-runner] verifier block recorded on ${marked}`);
        }
      },
    }),
  );

  ctx.log(
    '[plan-runner] ready (onBeforeTurn/onAfterToolCall/onAfterTurn/onVerifierBlocked hooks registered)',
  );
  return {
    async close(): Promise<void> {
      ctx.log('[plan-runner] deactivating');
      for (const dispose of disposers) dispose();
      turns.clear();
    },
  };
}
