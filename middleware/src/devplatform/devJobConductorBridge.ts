/**
 * Epic #470 W3 — devplatform binding for the dev-job Conductor step.
 *
 * The conductor layer defines the ports (`devJobStepEffect.ts`); this file implements them
 * against the dev-platform primitives. It keeps the dependency arrow pointing the right way
 * (devplatform → conductor port, never conductor → devplatform) and stays thin: the heavy
 * wiring (which store, which event bus, which finalize) is injected by boot, which this file
 * deliberately does NOT touch. Everything here is a factory the boot wiring calls.
 */

import type { JsonObject, JsonValue, Step } from '@omadia/conductor-core';

import type {
  DevJobStepPort,
  DevJobOutcomeSource,
  DevJobTerminalOutcome,
} from '../conductor/devJobStepEffect.js';
import { isTerminalDevJobStatus, type DevJob } from './types.js';

/**
 * Injected primitives for the launch port. `createConductorJob` MUST be idempotent per
 * `(runId, stepId)` — a re-drive after a crash presents the same key and must return the
 * SAME `jobId` (see `DevJobStepPort.launch`). `setAwaitId`/`getAwaitId` read and write
 * `dev_jobs.conductor_await_id` (added in migration 0024).
 */
export interface DevJobLaunchDeps {
  createConductorJob(input: {
    runId: string;
    stepId: string;
    step: Step;
    context: JsonObject;
  }): Promise<{ jobId: string }>;
  setAwaitId(jobId: string, awaitId: string): Promise<void>;
  getAwaitId(jobId: string): Promise<string | null>;
}

/** Build the `DevJobStepPort` the executor launches through. A thin adapter — the injected
 *  deps carry all the storage/queueing concerns. */
export function createDevJobLaunchPort(deps: DevJobLaunchDeps): DevJobStepPort {
  return {
    launch: (input) => deps.createConductorJob(input),
    bindAwait: (jobId, awaitId) => deps.setAwaitId(jobId, awaitId),
    awaitIdForJob: (jobId) => deps.getAwaitId(jobId),
  };
}

/** The terminal-job fields the outcome carries. A finalized `DevJob` satisfies it. */
export type TerminalDevJobView = Pick<
  DevJob,
  'id' | 'status' | 'prUrl' | 'branch' | 'result' | 'error'
>;

/** Build a `DevJobTerminalOutcome` from a terminal job row. */
export function toTerminalOutcome(job: TerminalDevJobView): DevJobTerminalOutcome {
  return {
    jobId: job.id,
    status: job.status,
    prUrl: job.prUrl,
    branch: job.branch,
    result: (job.result ?? null) as JsonValue | null,
    error: job.error,
  };
}

/**
 * In-process fan-in for terminal dev-job outcomes → the conductor resolver.
 *
 * The `DevJobEventBus` is keyed per jobId and has no "all jobs" tail, so the natural place to
 * observe *any* job finishing is `finalizeDevJob` (the single terminal choke point). Boot
 * pushes each finalized job in via {@link emit}; this class implements `DevJobOutcomeSource`
 * for `subscribeDevJobResolver`. There is no buffering and there are no timers — a subscriber
 * that attaches late simply misses in-flight emits (the run is still parked and can be
 * re-driven from the durable await by a future emit or a resume sweep).
 */
export class DevJobOutcomeEmitter implements DevJobOutcomeSource {
  private readonly handlers = new Set<(o: DevJobTerminalOutcome) => void | Promise<void>>();

  onTerminal(handler: (outcome: DevJobTerminalOutcome) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Push a terminal job's outcome to every subscriber. NO-OP for a non-terminal job — this
   * is the guard that stops a caller wiring the emitter to every state change from resuming
   * the run mid-job. Each handler is invoked in isolation; one handler's rejection cannot
   * suppress the others.
   */
  emit(job: TerminalDevJobView): void {
    if (!isTerminalDevJobStatus(job.status)) return;
    const outcome = toTerminalOutcome(job);
    for (const handler of this.handlers) {
      void Promise.resolve(handler(outcome)).catch(() => undefined);
    }
  }

  /** Number of live subscribers (test/introspection only). */
  get subscriberCount(): number {
    return this.handlers.size;
  }
}
