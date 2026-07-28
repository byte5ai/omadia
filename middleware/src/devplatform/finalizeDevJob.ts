/**
 * Epic #470 W0 — finalizeDevJob: the single terminal-transition choke point.
 *
 * Every path that ends a job — the worker (stall, wall-clock, apply failure),
 * the cancel route, the W1 reaper, and W2's phase engine — calls this and only
 * this. It flips the status (through the brand-gated `finishTerminal`, so no
 * other code can), appends a host `status` event, runs any registered
 * credential revokers (a no-op in W0; W2 fills the registry), and terminates a
 * live backend handle. It is idempotent: called on an already-terminal job it
 * returns the existing state and performs NO side effects — never an error.
 *
 * The seam exists in W0 precisely so W2 adds revocation to the registry rather
 * than retrofitting the transition logic across every caller (spec §4).
 */

import { TERMINAL_FINISH_BRAND, type TerminalPatch } from './devJobStore.js';
import {
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobEvent,
  type DevJobEventType,
  type DevJobResult,
  type DevJobStatus,
  type RunnerHandle,
} from './types.js';

/** A credential revoker — W2 registers real ones; W0 has none. */
export type CredentialRevoker = (job: DevJob) => Promise<void> | void;

/**
 * The registered-revoker hook the spec calls out. Empty in W0; W2 registers
 * per-job credential revocation here. `revokeAll` is best-effort — one
 * revoker's failure must not abort finalization or the others.
 */
export class CredentialRevokerRegistry {
  private readonly revokers: CredentialRevoker[] = [];

  register(revoker: CredentialRevoker): () => void {
    this.revokers.push(revoker);
    return () => {
      const i = this.revokers.indexOf(revoker);
      if (i >= 0) this.revokers.splice(i, 1);
    };
  }

  get size(): number {
    return this.revokers.length;
  }

  async revokeAll(job: DevJob, onError?: (err: unknown) => void): Promise<void> {
    for (const revoke of this.revokers) {
      try {
        await revoke(job);
      } catch (err) {
        onError?.(err);
      }
    }
  }
}

/** The store surface finalizeDevJob needs. Real `DevJobStore` satisfies it;
 *  tests inject a fake. */
export interface FinalizeStore {
  getJob(jobId: string): Promise<DevJob | null>;
  finishTerminal(
    brand: typeof TERMINAL_FINISH_BRAND,
    jobId: string,
    status: DevJobStatus,
    patch?: TerminalPatch,
  ): Promise<DevJob | null>;
  appendHostEvent(
    jobId: string,
    type: DevJobEventType,
    payload?: Record<string, unknown>,
  ): Promise<DevJobEvent | null>;
}

export interface FinalizeDevJobDeps {
  store: FinalizeStore;
  /** Terminate a live backend handle. The worker dispatches to the right
   *  backend; omitted where there is nothing to terminate (e.g. cancel of a
   *  still-queued job). */
  terminate?: (handle: RunnerHandle) => Promise<void> | void;
  /** Credential revokers — a registry or a raw list. Empty/no-op in W0. */
  revokers?: CredentialRevokerRegistry | CredentialRevoker[];
  /** Observe (do not throw on) side-effect failures — event append, revoke,
   *  terminate. Finalization must never be blocked by them. */
  onError?: (err: unknown, phase: 'event' | 'revoke' | 'terminate') => void;
}

export interface FinalizeContext {
  /** Stored in `dev_jobs.error`. */
  error?: string;
  /** Stored in `dev_jobs.result`. */
  result?: DevJobResult;
  /** Stored in `dev_jobs.branch` (e.g. on a successful apply). */
  branch?: string;
  /** Stored in `dev_jobs.pr_url`. */
  prUrl?: string;
  /** Human-readable reason, surfaced in the status event payload. */
  reason?: string;
  /** Extra fields merged into the status event payload. */
  eventPayload?: Record<string, unknown>;
}

function toRegistry(revokers: FinalizeDevJobDeps['revokers']): CredentialRevokerRegistry {
  if (revokers instanceof CredentialRevokerRegistry) return revokers;
  const reg = new CredentialRevokerRegistry();
  for (const r of revokers ?? []) reg.register(r);
  return reg;
}

/**
 * Transition a job to a terminal `status`, idempotently. Returns the finalized
 * job (or `null` if it does not exist). Calling it on an already-terminal job
 * returns that job unchanged with no side effects.
 */
export async function finalizeDevJob(
  deps: FinalizeDevJobDeps,
  jobId: string,
  status: DevJobStatus,
  ctx: FinalizeContext = {},
): Promise<DevJob | null> {
  if (!isTerminalDevJobStatus(status)) {
    throw new TypeError(`finalizeDevJob: '${status}' is not a terminal status`);
  }

  const before = await deps.store.getJob(jobId);
  if (!before) return null;
  // Already terminal ⇒ idempotent no-op. No status flip, no event, no revoke,
  // no terminate — this is what makes a double-finalize safe.
  if (isTerminalDevJobStatus(before.status)) return before;

  const patch: TerminalPatch = {
    error: ctx.error ?? null,
    result: ctx.result ?? null,
    branch: ctx.branch ?? null,
    prUrl: ctx.prUrl ?? null,
  };
  const after = await deps.store.finishTerminal(TERMINAL_FINISH_BRAND, jobId, status, patch);
  if (!after) return before;

  // Run side effects only when THIS call performed the flip. If a concurrent
  // finalize won with a different terminal status, `after.status` reflects
  // theirs and we skip — they already ran the side effects.
  if (after.status === status) {
    try {
      await deps.store.appendHostEvent(jobId, 'status', {
        status,
        previous: before.status,
        ...(ctx.reason !== undefined ? { reason: ctx.reason } : {}),
        ...(ctx.eventPayload ?? {}),
      });
    } catch (err) {
      deps.onError?.(err, 'event');
    }

    try {
      await toRegistry(deps.revokers).revokeAll(after, (err) => deps.onError?.(err, 'revoke'));
    } catch (err) {
      deps.onError?.(err, 'revoke');
    }

    const handle = before.runnerHandle ?? after.runnerHandle;
    if (handle && deps.terminate) {
      try {
        await deps.terminate(handle);
      } catch (err) {
        deps.onError?.(err, 'terminate');
      }
    }
  }

  return after;
}
