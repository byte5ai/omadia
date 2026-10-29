import { planNodeId, PROCESS_MEMORY_SERVICE_NAME } from '@omadia/plugin-api';
import type {
  KnowledgeGraph,
  PluginContext,
  ProcessMemoryService,
} from '@omadia/plugin-api';
import type { TurnAnnotation, TurnHookRegistrar } from '@omadia/orchestrator';
import { graphScopeFor, turnContext } from '@omadia/orchestrator';

import { shouldPlan } from './gate.js';
import { buildPlanSnapshot } from './snapshot.js';
import { gcSupersededPlans } from './gc.js';
import {
  materializePlan,
  materializePlanFromSteps,
  summariseRequest,
} from './materializer.js';
import {
  abandonPlan,
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
import { remapPlanSteps, TRACE_RESULT_HEAD, type TraceEntry } from './stepMapper.js';

/**
 * `@omadia/plugin-plan-runner` — #133 (plan-as-data) slices E2–E4.
 *
 * When enabled, subscribes to the orchestrator turn hooks (E0):
 *   - onBeforeTurn: Haiku gate (E2) → materialise a Plan + PlanStep DAG (E1)
 *     before the turn executes.
 *   - onAfterToolCall: advance step status / record evidence (E3); on a tool
 *     failure, replan the remainder of the DAG (E4).
 *   - onAfterTurn: close the plan — steps the turn never reached end
 *     `skipped` (#1502).
 *
 * On by default: the `enabled` setup field defaults to `on` (a cheap Haiku
 * gate keeps simple Q&A neutral; set `enabled=off` to disarm). The plugin
 * still degrades to a no-op when any dependency (turn-hook registry,
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
  /** Title of the stored process this plan was reused from (no LLM
   *  re-planning), threaded into every plan snapshot so the UI badges it.
   *  Undefined for freshly-materialised plans. */
  readonly reusedProcessTitle?: string;
  /** Replan counter — namespaces recovery step ids. */
  generation: number;
  /** #1502 option C — the turn's successful work calls, for the turn-end
   *  mapping pass. */
  readonly trace: TraceEntry[];
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

/** Default hybrid-retrieval score above which a stored process is reused
 *  instead of re-planned. Tunable via the `processReuseThreshold` setup field. */
export const DEFAULT_PROCESS_REUSE_THRESHOLD = 0.6;

/**
 * Parse the `processReuseThreshold` setup value into a usable score.
 *
 * The manifest pattern rejects out-of-range and non-numeric input in the
 * install/setup flow, but it is NOT the only write path:
 * `PATCH /api/v1/admin/runtime/installed/:id/config` blind-merges the JSON body
 * and profile apply stores the profile's YAML `config` as-is — neither re-runs
 * `checkSetupFieldPattern`, and both keep the raw JSON/YAML type. So a value
 * like `"0,6"` (decimal comma), `"5"`, or the NUMBER `0.8` can reach this code.
 * Two reasons `Number.parseFloat` alone is the wrong parser for strings:
 *
 *   - it parses a PREFIX, so `"0,6"` → `0` — finite, in range, and therefore
 *     invisible to any range check: every retrieved process would be reused
 *     regardless of similarity;
 *   - it happily returns out-of-range numbers, so `"5"` silently disables
 *     reuse while the startup log prints a plausible-looking threshold.
 *
 * So: a number is range-checked as-is; a string must be a complete numeric
 * literal (`Number`, not `parseFloat`) in the documented 0–1 range; anything
 * else (boolean, object, unset, blank) takes the default, which is what the
 * manifest promises. Never throws — a bad value must not fail activation.
 */
export function parseProcessReuseThreshold(raw: unknown): number {
  if (isUnsetThreshold(raw)) return DEFAULT_PROCESS_REUSE_THRESHOLD;
  return thresholdInRange(raw) ?? DEFAULT_PROCESS_REUSE_THRESHOLD;
}

/** `true` when an operator SET a threshold that `parseProcessReuseThreshold`
 *  discarded for the default — `activate()` logs it so the fallback is visible. */
function isRejectedThreshold(raw: unknown): boolean {
  return !isUnsetThreshold(raw) && thresholdInRange(raw) === undefined;
}

// `Number('')` and `Number('   ')` are 0, not NaN — a blank value means "unset"
// and must take the default, never the reuse-everything score.
function isUnsetThreshold(raw: unknown): boolean {
  return (
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && raw.trim().length === 0)
  );
}

function thresholdInRange(raw: unknown): number | undefined {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.trim())
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : undefined;
}

export interface ReusableProcess {
  readonly steps: readonly string[];
  readonly title: string;
  readonly id: string;
}

/**
 * Find a learned process worth reusing for `query`. Returns the top hit when
 * its hybrid score clears `threshold` and it has steps, else null. Never
 * throws — a degraded process-recall must fall through to LLM planning, not
 * kill the turn. Exported for unit testing.
 */
export async function pickReusableProcess(
  processMemory: Pick<ProcessMemoryService, 'query'>,
  query: string,
  threshold: number,
): Promise<ReusableProcess | null> {
  let hits: Awaited<ReturnType<ProcessMemoryService['query']>>;
  try {
    // #1540 — a turn the Privacy Shield masks reuses no process stored from
    // an unprotected turn: its title and steps go into the plan, and so into
    // the prompt.
    hits = await processMemory.query({
      query,
      limit: 1,
      ...(turnContext.current()?.privacyHandle !== undefined ? { excludeUnprotected: true } : {}),
    });
  } catch {
    return null;
  }
  const top = hits[0];
  if (!top || top.score < threshold || top.record.steps.length === 0) {
    return null;
  }
  return { steps: top.record.steps, title: top.record.title, id: top.record.id };
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

  // #237 — garbage-collect prior semantic-duplicate plans for a scope when a
  // fresh plan is materialised, keeping only the latest. ON by default (the
  // accumulation it fixes is the common case); set `gcDuplicatePlans=off` to
  // disarm the hard-delete.
  const gcDuplicatePlans =
    ctx.config.get<string>('gcDuplicatePlans') !== 'off';

  // #1502 option C — one Haiku pass after the turn maps the whole tool trace
  // to the steps and corrects the STORED plan (recall reads it). The live
  // card keeps the in-turn heuristic. ON by default; `off` saves the call.
  const mapStepsAtTurnEnd =
    ctx.config.get<string>('mapStepsAtTurnEnd') !== 'off';

  // Reuse a learned process (ProcessMemory) instead of re-planning a matching
  // turn via Haiku — the core "stop re-thinking every turn" fix. ON by default
  // (set `reuseProcesses=off` to disarm). Inert when no processMemory@1
  // provider is published (e.g. the in-memory KG) → falls through to the gate.
  const reuseProcesses = ctx.config.get<string>('reuseProcesses') !== 'off';
  const processMemory = reuseProcesses
    ? ctx.services.get<ProcessMemoryService>(PROCESS_MEMORY_SERVICE_NAME)
    : undefined;
  // `unknown`, not `string`: the admin PATCH route and profile apply persist
  // raw JSON/YAML types, so a stored number is a real input (see the parser).
  const reuseThresholdRaw = ctx.config.get<unknown>('processReuseThreshold');
  const reuseThreshold = parseProcessReuseThreshold(reuseThresholdRaw);
  if (isRejectedThreshold(reuseThresholdRaw)) {
    ctx.log(
      `[plan-runner] processReuseThreshold ${JSON.stringify(
        reuseThresholdRaw,
      )} is not a number in 0–1; using default ${DEFAULT_PROCESS_REUSE_THRESHOLD.toFixed(2)}`,
    );
  }
  if (processMemory) {
    ctx.log(
      `[plan-runner] process reuse ON (threshold=${reuseThreshold.toFixed(2)})`,
    );
  }

  // Per-turn plan state + replan context, keyed by orchestrator turn id.
  // Populated at onBeforeTurn (after materialisation) and drained at
  // onAfterTurn. An errored turn never fires onAfterTurn, so we evict stale
  // entries (TTL + hard cap) on each onBeforeTurn via pruneTurns().
  const turns = new Map<string, TurnRecord>();
  const disposers: Array<() => void> = [];
  // Turn-end mapping runs in flight; `close()` waits for them so none writes
  // to the graph after deactivation.
  const pendingMappings = new Set<Promise<void>>();

  // #1502 — a replan that throws after marking the step `failed` must not
  // leave the cursor on it, or the turn's end would rewrite that `failed`.
  const replanOrAbandon = async (
    record: TurnRecord,
    input: Parameters<typeof replanRemainder>[0],
  ): ReturnType<typeof replanRemainder> => {
    try {
      return await replanRemainder(input);
    } catch (err) {
      abandonPlan(record.plan);
      throw err;
    }
  };

  // #133 (E9) — build the `plan` annotation the orchestrator streams to the UI.
  // Reads the current step state from the graph so the snapshot reflects live
  // status. Never throws (a failed snapshot just means no UI update this tick).
  const planAnnotation = async (
    planExternalId: string,
    reusedProcessTitle?: string,
  ): Promise<TurnAnnotation[]> => {
    try {
      return [
        {
          channel: 'plan',
          payload: await buildPlanSnapshot(
            planExternalId,
            kg,
            reusedProcessTitle ? { reusedProcessTitle } : undefined,
          ),
        },
      ];
    } catch {
      return [];
    }
  };

  disposers.push(
    registrar.register('onBeforeTurn', {
      label: 'plan-runner:onBeforeTurn',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void | TurnAnnotation[]> => {
        const userMessage = payload.userMessage?.trim();
        if (!userMessage) return;
        // Per-orchestrator isolation: qualify the plan scope with the Agent
        // slug (same `graphScopeFor` formula SessionLogger uses for Turns) so
        // `listRecentPlans` recall stays per-Agent. `agentSlug` is undefined
        // on legacy boots → raw scope (the `default::` dual-clause covers it).
        const scope = graphScopeFor(
          hookCtx.agentSlug,
          hookCtx.sessionScope ?? hookCtx.turnId,
        );
        const nowMs = Date.now();
        const createdAt = new Date(nowMs).toISOString();

        // Process reuse first: a learned workflow that matches this request is
        // materialised straight from its stored steps — no gate, no Haiku
        // re-planning. A matched process is multi-step by construction, so the
        // gate would only confirm what we already know. Data is still fetched
        // fresh by the tool loop; the plan fixes the steps, not their results.
        let result = null as Awaited<ReturnType<typeof materializePlan>>;
        let reusedProcessId: string | undefined;
        let reusedProcessTitle: string | undefined;
        if (processMemory) {
          const reuse = await pickReusableProcess(
            processMemory,
            userMessage,
            reuseThreshold,
          );
          if (reuse) {
            result = await materializePlanFromSteps({
              planId: hookCtx.turnId,
              scope,
              userMessage,
              createdAt,
              kg,
              steps: reuse.steps,
              processTitle: reuse.title,
            });
            if (result) {
              reusedProcessId = reuse.id;
              reusedProcessTitle = reuse.title;
            }
          }
        }

        // No reusable process → the original gate → LLM-materialise path.
        if (!result) {
          if (!(await shouldPlan(userMessage, llm))) return;
          result = await materializePlan({
            planId: hookCtx.turnId,
            scope,
            userMessage,
            createdAt,
            llm,
            kg,
          });
        }
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
          ...(reusedProcessTitle ? { reusedProcessTitle } : {}),
          generation: 0,
          trace: [],
        };
        turns.set(hookCtx.turnId, record);
        await startFirstStep(record.plan, kg);
        ctx.log(
          `[plan-runner] ${
            reusedProcessId
              ? `reused process ${reusedProcessId} →`
              : 'materialised'
          } ${result.planExternalId} (${String(result.stepCount)} steps)`,
        );
        // #237 — GC prior duplicate plans for this scope. Fire-and-forget: it
        // only hard-deletes OLDER plans (never the survivor or any in-flight
        // turn), so it must not delay turn start or fail the turn. Protect
        // every plan whose turn is still tracked in this process.
        if (gcDuplicatePlans) {
          const protectedPlanExternalIds = new Set<string>(
            [...turns.keys()].map((tid) => planNodeId(tid)),
          );
          void gcSupersededPlans({
            scope,
            keepPlanExternalId: result.planExternalId,
            requestSummary: summariseRequest(userMessage),
            protectedPlanExternalIds,
            llm,
            kg,
          })
            .then((gc) => {
              if (gc.deletedPlanExternalIds.length > 0) {
                ctx.log(
                  `[plan-runner] GC removed ${String(
                    gc.deletedPlanExternalIds.length,
                  )} superseded plan(s) (${String(gc.deletedSteps)} steps)`,
                );
              }
            })
            .catch((err: unknown) => {
              ctx.log(
                `[plan-runner] plan GC failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
        // E9 — stream the freshly-materialised plan as the turn's first event.
        return await planAnnotation(result.planExternalId, reusedProcessTitle);
      },
    }),
  );

  disposers.push(
    registrar.register('onAfterToolCall', {
      label: 'plan-runner:onAfterToolCall',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void | TurnAnnotation[]> => {
        const record = turns.get(hookCtx.turnId);
        if (!record) return;
        // #1502 — memory reads, answer rendering and follow-up cards serve the
        // turn, not a plan step: they neither advance nor fail one.
        if (payload.toolIsBookkeeping === true) return;
        const failed = payload.toolFailed ?? isToolFailure(payload.toolResult);
        // #1502 option C — every successful work call, also past the last
        // step: the turn-end mapping sees what the cursor could not.
        if (!failed && payload.toolName) {
          record.trace.push({
            toolName: payload.toolName,
            // Only the head is ever used; a full result can be megabytes.
            result: (payload.toolResult ?? '').slice(0, TRACE_RESULT_HEAD),
          });
        }
        const currentId = record.plan.stepExternalIds[record.plan.cursor];
        if (currentId === undefined) return;

        // Trigger (a) — tool failure → replan the remainder of the DAG. The
        // orchestrator's `toolFailed` also covers a sub-agent whose inner calls
        // all failed; the `Error:` check is the fallback for older kernels.
        if (failed) {
          record.generation += 1;
          const { newStepExternalIds } = await replanOrAbandon(record, {
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
            abandonPlan(record.plan);
          }
          return await planAnnotation(record.planExternalId, record.reusedProcessTitle);
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
          const { newStepExternalIds } = await replanOrAbandon(record, {
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
            abandonPlan(record.plan);
          }
          return await planAnnotation(record.planExternalId, record.reusedProcessTitle);
        }

        // #1502 — always record evidence: recall only trusts an evidenced
        // `done` (`isEvidencedPlanStepDone`).
        const summary =
          payload.toolResult !== undefined
            ? summarise(payload.toolName, payload.toolResult)
            : '';
        await advanceStep(record.plan, kg, {
          resultSummary: summary || payload.toolName || 'tool call',
        });
        // E9 — emit the refreshed plan snapshot so the UI advances the step live.
        return await planAnnotation(record.planExternalId, record.reusedProcessTitle);
      },
    }),
  );

  disposers.push(
    registrar.register('onAfterTurn', {
      label: 'plan-runner:onAfterTurn',
      priority: 10,
      hook: async (hookCtx, payload): Promise<void | TurnAnnotation[]> => {
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
        // E9 — emit the final plan snapshot (unreached steps skipped, #1502)
        // before the turn's `done` event, then drop the per-turn state.
        const annotation = await planAnnotation(record.planExternalId, record.reusedProcessTitle);
        turns.delete(hookCtx.turnId);
        // #1502 option C — correct the stored record after the snapshot, so
        // the live card keeps the heuristic and `done` does not wait on Haiku.
        // A plan whose turn ran no work call has nothing to map.
        if (mapStepsAtTurnEnd && record.trace.length > 0) {
          const run: Promise<void> = remapPlanSteps(
            {
              planExternalId: record.planExternalId,
              stepExternalIds: record.plan.stepExternalIds,
              trace: record.trace,
              answered: (payload.assistantAnswer ?? '').trim().length > 0,
            },
            kg,
            llm,
          )
            .then((changed) => {
              ctx.log(
                changed === undefined
                  ? `[plan-runner] step mapping failed for ${record.planExternalId} — kept the in-turn mapping`
                  : `[plan-runner] step mapping for ${record.planExternalId}: ${String(changed)} step(s) corrected`,
              );
            })
            .catch((err: unknown) => {
              ctx.log(
                `[plan-runner] step mapping failed for ${record.planExternalId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            })
            .finally(() => {
              pendingMappings.delete(run);
            });
          pendingMappings.add(run);
        }
        return annotation;
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
        if (!hookCtx.sessionScope) return;
        // Qualify identically to the write side so the plan is found.
        const scope = graphScopeFor(hookCtx.agentSlug, hookCtx.sessionScope);
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
      await Promise.allSettled([...pendingMappings]);
    },
  };
}
