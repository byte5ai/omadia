/**
 * Bounded batch jobs (#2082, spec 2042 §5.12 "Changes to today's
 * mechanisms", ADR-0020): periodic learning and consolidation run as a
 * batch trigger owned by the agent whose memory it is, with a deadline, a
 * budget and a breaker — never as a free-running interval of a plugin.
 *
 * A plugin registers the job with the kernel's {@link BatchJobRegistry}
 * (service {@link BATCH_JOB_REGISTRY_SERVICE}); the kernel decides when it
 * runs and for which agent. `due` finds work deterministically (no model);
 * `run` does at most `limit` items and may use a model only inside the
 * firing's model-call and cost meter.
 */

/** The kernel service a plugin registers its batch jobs with. */
export const BATCH_JOB_REGISTRY_SERVICE = 'batchJobRegistry';

export interface BatchJobRunOptions {
  /** At most this many items in this run. */
  readonly limit: number;
  /** Aborted when the firing times out or the kernel stops. */
  readonly signal: AbortSignal;
}

export interface BatchJobResult {
  /** Items handled in this run (promoted, dropped, classified, …). */
  readonly processed: number;
  /** Items that failed and stay for the next run. */
  readonly failed: number;
}

export interface BatchJob {
  /** Stable id, unique per kernel (`<plugin>.<job>`). */
  readonly id: string;
  /** Why the job runs, in one sentence (shown to operators). */
  readonly purpose: string;
  /** How often it may run, in minutes (the kernel enforces its minimum). */
  readonly intervalMinutes: number;
  /** Items per run. */
  readonly batchSize: number;
  /** How many items are due for `agentSlug`, found without a model. */
  due(agentSlug: string): Promise<number>;
  /** Handle up to `limit` due items of `agentSlug`. Never throws for one item. */
  run(agentSlug: string, options: BatchJobRunOptions): Promise<BatchJobResult>;
}

export interface BatchJobRegistry {
  /** Register a job; the returned function unregisters it. */
  register(job: BatchJob): () => void;
}
