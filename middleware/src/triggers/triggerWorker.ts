/**
 * #2082 — the durable trigger scheduler loop. Every tick it gives back or
 * drops leases that ran out, deletes triggers past their deadline, then claims
 * due occurrences under a lease and fires them. Several replicas may run it:
 * the claim is one `FOR UPDATE SKIP LOCKED` statement, so an occurrence goes
 * to exactly one worker.
 */

import { randomUUID } from 'node:crypto';

import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerStore } from './triggerStore.js';

export interface TriggerWorkerDeps {
  readonly store: TriggerStore;
  readonly engine: TriggerEngine;
  readonly intervalMs: number;
  /** How long a claimed occurrence is ours; longer than the longest turn. */
  readonly leaseMs: number;
  /** Essential occurrences are retried at most this often. */
  readonly maxAttempts: number;
  /** Occurrences fired per tick. */
  readonly batch: number;
  /** Whether firing is enabled at all (the kernel config switch). */
  readonly enabled: () => boolean;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export class TriggerWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  readonly leaseOwner = `trigger-worker:${randomUUID()}`;

  constructor(private readonly deps: TriggerWorkerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
    this.deps.log?.(`[triggers] worker started (every ${String(this.deps.intervalMs)} ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One cycle. Exposed for tests. Never throws. */
  async tick(): Promise<number> {
    if (this.ticking || !this.deps.enabled()) return 0;
    this.ticking = true;
    const now = (this.deps.now ?? (() => new Date()))();
    let fired = 0;
    try {
      const leases = await this.deps.store.recoverExpiredLeases(now, this.deps.maxAttempts);
      if (leases.retried + leases.dropped > 0) {
        this.deps.log?.(
          `[triggers] expired leases: ${String(leases.retried)} essential retried, ${String(leases.dropped)} dropped`,
        );
      }
      const expired = await this.deps.store.sweepExpired(now);
      if (expired > 0) this.deps.log?.(`[triggers] ${String(expired)} trigger(s) past their deadline deleted`);

      const claimed = await this.deps.store.claimDue(this.leaseOwner, now, this.deps.leaseMs, this.deps.batch);
      for (const occ of claimed) {
        try {
          const at = (this.deps.now ?? (() => new Date()))();
          const held = await this.deps.store.extendLease(occ.id, this.leaseOwner, at, new Date(at.getTime() + this.deps.leaseMs));
          if (!held) {
            this.deps.log?.(`[triggers] lease of ${occ.id} ran out before its turn in the batch; another worker has it`);
            continue;
          }
          await this.deps.engine.fire(occ);
          fired += 1;
        } catch (err) {
          // The lease stays; it runs out and the recovery above decides by
          // delivery class. Never a tight retry loop.
          this.deps.log?.(
            `[triggers] firing ${occ.id} of ${occ.triggerId} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.deps.log?.(`[triggers] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
    return fired;
  }
}
