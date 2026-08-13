/**
 * Epic #470 W4 (spec §5) — LLM budget accounting + enforcement for the W2 proxy.
 *
 * This module implements the {@link LlmProxyBudgetHook} the proxy calls after
 * every billable (2xx) response. It is the ONE place per-job LLM spend is metered
 * and capped. Given a call's provider usage it:
 *
 *   1. computes the USD cost with the shared `@omadia/usage-telemetry`
 *      `computeCostUsd` (no re-invented cost math);
 *   2. runs ONE atomic accumulate-and-readback (`store.accumulateJobUsage`) that
 *      bumps the per-job counters and returns the NEW position together with the
 *      effective budgets (job override coalesced with the repo default in SQL);
 *   3. records the call into the `token_usage` ledger as `source='dev-job'`,
 *      `sessionId='devjob:<jobId>'`, so the usage dashboard's per-source split
 *      surfaces the dev-job slice and per-job drill-down is
 *      `token_usage WHERE session_id='devjob:<id>'` — with ZERO dashboard changes;
 *   4. enforces the budget POST-HOC, edge-triggered on the readback:
 *        - crossing 80 % of a budget emits ONE `budget_warning` job event;
 *        - crossing 100 % marks the job `budget_exceeded` through the finalize
 *          choke point (which also terminates the backend handle) and reports
 *          `exceeded: true` so the proxy answers the in-flight call 402.
 *
 * Budget resolution per job: job override → repo budget → config default
 * (`DEV_JOB_DEFAULT_BUDGET_USD`, cost only; token budgets have no default and are
 * enforced only when explicitly set). The job→repo coalesce happens inside the
 * store's readback; this module applies the config default when the readback's
 * effective cost budget is null.
 *
 * Edge-triggering (previous position `< threshold` AND new `>= threshold`, with
 * previous = new − this call's delta) makes both the warning and the crossing
 * fire EXACTLY ONCE across a job's calls, with no per-job in-memory state, and is
 * race-safe because concurrent calls each get their own serialized readback and
 * only one call's [prev, new) interval contains any given threshold.
 *
 * The `terminate(handle)` step is NOT invoked here directly: `markBudgetExceeded`
 * is wired to `finalizeDevJob(..., 'budget_exceeded')`, and that single choke
 * point resolves the runner handle from the job row and dispatches the backend
 * `terminate` itself (so terminate is never double-dispatched).
 *
 * Wiring is the caller's job (see `wireDevPlatform`): pass the returned hook as
 * `createLlmProxyRouter({ budget })`.
 */

import {
  computeCostUsd as defaultComputeCostUsd,
  recordUsage as defaultRecordUsage,
  type UsageTokens,
} from '@omadia/usage-telemetry';

import type { DevJobBudgetPosition } from './devJobStore.js';
import type {
  LlmProxyBudgetDecision,
  LlmProxyBudgetHook,
  LlmProxyMeteredUsage,
  LlmProxyUsageRecord,
} from './llmProxy.js';

/** The narrow store slice the accounting hook needs (real `DevJobStore` satisfies
 *  it; tests inject a fake or the real pg store). */
export interface BudgetAccumulateStore {
  accumulateJobUsage(
    jobId: string,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
  ): Promise<DevJobBudgetPosition | null>;
}

/** Payload handed to `emitBudgetWarning` when a job first crosses the warn line. */
export interface BudgetWarningInfo {
  /** New cumulative cost after this call. */
  costUsd: number;
  /** Effective cost budget (job → repo → config default). */
  budgetCostUsd: number;
  /** New cumulative total tokens after this call. */
  tokensTotal: number;
  /** Effective token budget, or null when unset (no token default). */
  budgetTokens: number | null;
  /** `costUsd / budgetCostUsd` at the moment of the warning. */
  fraction: number;
  /** The warn threshold that was crossed (default 0.8). */
  threshold: number;
}

export interface LlmProxyAccountingDeps {
  /** The atomic accumulate-and-readback store method. */
  store: BudgetAccumulateStore;
  /** Terminal transition through the finalize choke point (which also terminates
   *  the backend handle). Wire to `finalizeDevJob(..., 'budget_exceeded')`. */
  markBudgetExceeded: (jobId: string) => Promise<void>;
  /** Emit a `budget_warning` job event. Called at most once per job (edge). */
  emitBudgetWarning: (jobId: string, info: BudgetWarningInfo) => Promise<void>;
  /** Cost-budget default when neither the job nor its repo sets one
   *  (`DEV_JOB_DEFAULT_BUDGET_USD`, spec §5). */
  defaultBudgetCostUsd: number;
  /** Ledger writer. Defaults to the shared `@omadia/usage-telemetry` recorder. */
  recordUsage?: (record: LlmProxyUsageRecord) => void;
  /** Cost function seam. Defaults to `@omadia/usage-telemetry`'s `computeCostUsd`. */
  computeCostUsd?: (model: string, usage: UsageTokens) => number;
  /** Optional `max_tokens` clamp ceiling surfaced to the proxy (bounds overshoot). */
  maxOutputTokens?: number;
  /** Warn fraction of budget (default 0.8). */
  warnThreshold?: number;
  /** Structured log sink for accounting failures (never thrown to the proxy). */
  log?: (msg: string) => void;
}

const DEFAULT_WARN_THRESHOLD = 0.8;

function toUsageTokens(usage: LlmProxyMeteredUsage): UsageTokens {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  };
}

/** `dev_jobs.tokens_in` folds input + both cache counters (mirrors the proxy's W1
 *  metering); `tokens_out` is the output count. */
function splitTokens(usage: LlmProxyMeteredUsage): { tokensIn: number; tokensOut: number } {
  return {
    tokensIn: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    tokensOut: usage.outputTokens,
  };
}

/** True when the [prev, now) interval crosses `threshold` (edge trigger) for a
 *  positive threshold. */
function crossedEdge(prev: number, now: number, threshold: number): boolean {
  return threshold > 0 && prev < threshold && now >= threshold;
}

export function createLlmProxyAccounting(deps: LlmProxyAccountingDeps): LlmProxyBudgetHook {
  const {
    store,
    markBudgetExceeded,
    emitBudgetWarning,
    defaultBudgetCostUsd,
    recordUsage = defaultRecordUsage,
    computeCostUsd = defaultComputeCostUsd,
    warnThreshold = DEFAULT_WARN_THRESHOLD,
    log = () => {},
  } = deps;

  async function meter(input: {
    jobId: string;
    model: string;
    usage: LlmProxyMeteredUsage;
  }): Promise<LlmProxyBudgetDecision> {
    const { jobId, model, usage } = input;
    const { tokensIn, tokensOut } = splitTokens(usage);
    const deltaTokens = tokensIn + tokensOut;
    const deltaCost = computeCostUsd(model, toUsageTokens(usage));

    // Nothing billable ⇒ no accumulate, no ledger noise, no enforcement.
    if (deltaTokens === 0 && deltaCost === 0) return { exceeded: false };

    let position: DevJobBudgetPosition | null;
    try {
      position = await store.accumulateJobUsage(jobId, tokensIn, tokensOut, deltaCost);
    } catch (err) {
      // Fail OPEN: a metering DB error must not 402 a legitimate call. The loss
      // is surfaced (logged), not swallowed silently.
      log(`[dev-llm-budget] accumulate failed for job ${jobId}: ${errText(err)}`);
      return { exceeded: false };
    }
    if (!position) {
      log(`[dev-llm-budget] job ${jobId} not found during metering (already gone?)`);
      return { exceeded: false };
    }

    // Ledger row — reached only after the authoritative counter committed, so the
    // two stores never diverge into "billed the ledger but not dev_jobs".
    try {
      recordUsage({
        source: 'dev-job',
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        sessionId: `devjob:${jobId}`,
      });
    } catch (err) {
      log(`[dev-llm-budget] ledger record failed for job ${jobId}: ${errText(err)}`);
    }

    const costBudget = position.effectiveBudgetCostUsd ?? defaultBudgetCostUsd;
    const tokenBudget = position.effectiveBudgetTokens ?? undefined;
    const prevCost = position.costUsd - deltaCost;
    const prevTokens = position.tokensTotal - deltaTokens;

    // Enforcement is LEVEL-triggered (Forge W4 audit #1), NOT edge-triggered: EVERY
    // call whose committed spend is at/over budget returns `exceeded` (→402), not only
    // the single call that first crossed the threshold. This closes two holes an
    // edge-only trigger had: (a) if `markBudgetExceeded` fails at the crossing (a
    // transient finalize/DB blip), the job stayed active and every later call was
    // billed for the rest of its life — now each over-budget call RE-ATTEMPTS the
    // idempotent finalize until it sticks (self-healing); and (b) a concurrent burst
    // at the crossing 402s on all of its over-budget calls, not just the edge one.
    const overCost = costBudget > 0 && position.costUsd >= costBudget;
    const overTokens = tokenBudget !== undefined && position.tokensTotal >= tokenBudget;

    if (overCost || overTokens) {
      try {
        await markBudgetExceeded(jobId); // idempotent — no-ops on an already-terminal job
      } catch (err) {
        // The proxy still 402s (both sides converge); the finalize failure is
        // surfaced for operator follow-up and retried by the next over-budget call.
        log(`[dev-llm-budget] markBudgetExceeded failed for job ${jobId}: ${errText(err)}`);
      }
      return { exceeded: true };
    }

    // 80 % warning — edge-triggered, so exactly one is emitted as spend climbs
    // through the threshold (never re-emitted on subsequent over-80 % calls).
    const warnCostAt = costBudget * warnThreshold;
    const warnTokenAt = tokenBudget !== undefined ? tokenBudget * warnThreshold : undefined;
    const warnCost = crossedEdge(prevCost, position.costUsd, warnCostAt);
    const warnTokens =
      warnTokenAt !== undefined && crossedEdge(prevTokens, position.tokensTotal, warnTokenAt);

    if (warnCost || warnTokens) {
      try {
        await emitBudgetWarning(jobId, {
          costUsd: position.costUsd,
          budgetCostUsd: costBudget,
          tokensTotal: position.tokensTotal,
          budgetTokens: tokenBudget ?? null,
          fraction: costBudget > 0 ? position.costUsd / costBudget : 0,
          threshold: warnThreshold,
        });
      } catch (err) {
        log(`[dev-llm-budget] budget_warning emit failed for job ${jobId}: ${errText(err)}`);
      }
    }

    return { exceeded: false };
  }

  return deps.maxOutputTokens !== undefined
    ? { maxOutputTokens: deps.maxOutputTokens, meter }
    : { meter };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
