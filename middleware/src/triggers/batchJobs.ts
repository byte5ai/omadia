/**
 * #2082 — learning and consolidation as bounded agent batch triggers (spec
 * 2042 §5.12 "Changes to today's mechanisms": "due entries are found
 * deterministically; the classification runs as a bounded batch trigger
 * owned by the agent whose memory it is, with budget and deadline").
 *
 * Plugins register a `BatchJob` here (service `batchJobRegistry`) instead of
 * running their own interval. `sync` gives every agent with due items one
 * trigger per job (`context_kind 'memory'`, origin `system`, unique per job
 * and agent): a `wake_every` at the job's cadence (at least the instance
 * minimum) with one `batch` step, the default budget and a deadline. An
 * agent with nothing due gets no trigger; a trigger past its deadline ends
 * and the next sync arms a fresh one only if work is due again.
 */

import type { BatchJob, BatchJobRegistry } from '@omadia/plugin-api';
import { meterModelCalls, meterUsageCost } from '@omadia/usage-telemetry';

import type { BatchOutcome } from './triggerChain.js';
import type { TriggerLimits } from './triggerPolicy.js';
import type { TriggerService } from './triggerService.js';
import type { Trigger } from './types.js';

const MINUTE_S = 60;
const DAY_MS = 86_400_000;
const JOB_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** A batch run that does not finish in this time is aborted. */
export const BATCH_TIMEOUT_MS = 10 * 60_000;

export class KernelBatchJobRegistry implements BatchJobRegistry {
  private readonly jobs = new Map<string, BatchJob>();

  register(job: BatchJob): () => void {
    if (!JOB_ID.test(job.id)) throw new Error(`invalid batch job id '${job.id}'`);
    if (this.jobs.has(job.id)) throw new Error(`batch job '${job.id}' is already registered`);
    this.jobs.set(job.id, job);
    return () => {
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    };
  }

  /**
   * The registry as one plugin sees it. A batch job spends every agent's
   * trigger budget, so only a built-in plugin (shipped with the kernel) may
   * register one; any other plugin is refused.
   */
  forCaller(pluginId: string, mayRegister: boolean): BatchJobRegistry {
    return {
      register: (job) => {
        if (!mayRegister) {
          throw new Error(`plugin '${pluginId}' may not register batch jobs (built-in plugins only)`);
        }
        return this.register(job);
      },
    };
  }

  get(id: string): BatchJob | undefined {
    return this.jobs.get(id);
  }

  list(): readonly BatchJob[] {
    return [...this.jobs.values()];
  }
}

/** The context id of an agent's trigger for a job. */
export const batchContextId = (jobId: string, agentSlug: string): string => `${jobId}:${agentSlug}`;

/** Items one firing may handle: the job's batch, within the model-call cap. */
export const batchLimit = (job: Pick<BatchJob, 'batchSize'>, trigger: Pick<Trigger, 'modelCallsPerFiring'>): number =>
  Math.max(1, Math.min(Math.floor(job.batchSize), trigger.modelCallsPerFiring));

/** The engine's `batch` step: due check without a model, then a metered run. */
export function createBatchExecutor(
  registry: KernelBatchJobRegistry,
  timeoutMs = BATCH_TIMEOUT_MS,
): (trigger: Trigger, jobId: string) => Promise<BatchOutcome> {
  return async (trigger, jobId) => {
    const job = registry.get(jobId);
    if (!job) return { due: 0, processed: 0, costUsd: 0, modelCalls: 0, error: `batch job '${jobId}' is not registered` };
    let due: number;
    try {
      due = await job.due(trigger.agentSlug);
    } catch (err) {
      return { due: 0, processed: 0, costUsd: 0, modelCalls: 0, error: `due check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (due <= 0) return { due: 0, processed: 0, costUsd: 0, modelCalls: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('batch run timed out')), timeoutMs);
    try {
      const metered = await meterUsageCost(() =>
        meterModelCalls(
          async () => {
            try {
              return await job.run(trigger.agentSlug, { limit: batchLimit(job, trigger), signal: controller.signal });
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
          { limit: trigger.modelCallsPerFiring },
        ),
      );
      const base = { due, costUsd: metered.costUsd, modelCalls: metered.value.modelCalls };
      const out = metered.value.value;
      if ('error' in out) return { ...base, processed: 0, error: out.error };
      return { ...base, processed: out.processed };
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface BatchTriggerSyncDeps {
  readonly registry: KernelBatchJobRegistry;
  readonly service: () => TriggerService | undefined;
  /** The agents in service (enabled). */
  readonly agents: () => readonly { readonly id: string; readonly slug: string }[];
  readonly limits: () => TriggerLimits;
  readonly now?: () => Date;
  readonly log: (message: string) => void;
}

export interface BatchSyncResult {
  readonly armed: number;
  readonly ended: number;
}

/** Arm a trigger for every (job, agent) with due items; end orphans. */
export function createBatchTriggerSync(deps: BatchTriggerSyncDeps): () => Promise<BatchSyncResult> {
  const clock = deps.now ?? (() => new Date());
  return async () => {
    const service = deps.service();
    if (!service) return { armed: 0, ended: 0 };
    const limits = deps.limits();
    const agents = deps.agents();
    const jobs = deps.registry.list();
    const existing = await service.listForContextKind('memory');
    const byContext = new Map(existing.map((t) => [t.contextId, t]));
    const wanted = new Set<string>();
    let armed = 0;
    for (const job of jobs) {
      const intervalS = Math.max(job.intervalMinutes * MINUTE_S, limits.minIntervalSeconds);
      for (const agent of agents) {
        const contextId = batchContextId(job.id, agent.slug);
        wanted.add(contextId);
        if (byContext.has(contextId)) continue;
        let due = 0;
        try {
          due = await job.due(agent.slug);
        } catch (err) {
          deps.log(`[batch] ${job.id} due check for '${agent.slug}' failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (due <= 0) continue;
        const now = clock();
        const until = new Date(now.getTime() + limits.recurringMaxDays * DAY_MS);
        const maxRuns = Math.max(1, Math.min(limits.maxRunsCap, Math.floor((limits.recurringMaxDays * DAY_MS) / (intervalS * 1000))));
        const res = await service
          .create(
            'wake_every',
            {
              purpose: job.purpose,
              interval: `${String(Math.ceil(intervalS / MINUTE_S))}m`,
              until: until.toISOString(),
              max_runs: maxRuns,
              actions: [{ type: 'batch', job: job.id }],
              budget: {
                per_firing_usd: limits.perFiringUsdDefault,
                total_usd: limits.perTriggerUsdDefault,
                model_calls_per_firing: Math.min(job.batchSize, limits.modelCallsPerFiringMax),
              },
            },
            {
              agentId: agent.id,
              agentSlug: agent.slug,
              origin: 'system',
              ownerKey: null,
              contextKind: 'memory',
              contextId,
              liveContext: false,
              deliveryChannel: null,
              deliveryRef: null,
              labels: [],
              createdBy: `batch:${job.id}`,
            },
          )
          .catch((err: unknown) => {
            // Another machine armed it first (one trigger per job and agent).
            if ((err as { code?: string }).code === '23505') return undefined;
            throw err;
          });
        if (res && !res.ok) deps.log(`[batch] ${job.id} for '${agent.slug}' not armed: ${res.code}: ${res.message}`);
        else if (res) armed += 1;
      }
    }
    // A job that is gone (plugin removed or disabled) or an agent out of
    // service: its trigger ends.
    let ended = 0;
    for (const t of existing) {
      if (wanted.has(t.contextId)) continue;
      if (await service.end(t.id, 'cancelled', { batch: t.contextId, why: 'job or agent gone' })) ended += 1;
    }
    return { armed, ended };
  };
}
