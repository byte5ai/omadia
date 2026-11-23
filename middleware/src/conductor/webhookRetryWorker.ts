import { describeError } from '../platform/describeError.js';

import type { ConductorWebhookDispatcher } from './webhookDispatcher.js';
import type { ConductorWebhookSubscriptionStore } from './webhookSubscriptionStore.js';

/**
 * Polls `conductor_webhook_deliveries` for rows past their `next_attempt_at` and
 * re-attempts them through the same `ConductorWebhookDispatcher.attempt` the first,
 * inline attempt uses — so a delivery that fails (or a process restart that
 * interrupts an in-flight attempt) is retried with backoff until it succeeds or
 * exhausts `maxAttempts`. Mirrors `ConductorScheduleWorker`'s poll-loop shape.
 *
 * Also runs an optional `reconcile` pass every tick, BEFORE `claimDue` — issue #437
 * finding: `notifyRunEnded` fires the dispatcher fire-and-forget AFTER a run's
 * terminal status is already committed, so a process kill in that window loses the
 * webhook permanently (no delivery row was ever created for it, so nothing here
 * would otherwise retry it). `reconcile` finds those gaps and creates the missing
 * row(s); running it before `claimDue` means a just-recovered row (created with
 * `next_attempt_at = now()`, i.e. immediately due) gets attempted in this SAME tick
 * rather than waiting a full poll interval.
 *
 * #1704 — this worker drives attempts 2..maxAttempts, so the issue's "no log line
 * per failed attempt" is as much about this file as about the dispatcher: every
 * log here names the cause via `describeError` (undici hides the reason for a
 * transport failure in `err.cause`), and the one outcome this worker records
 * WITHOUT going through the dispatcher — a delivery whose subscription has been
 * deleted — now leaves a line too. It is terminal, and it used to be silent.
 */
export class ConductorWebhookRetryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly deps: {
      store: ConductorWebhookSubscriptionStore;
      dispatcher: ConductorWebhookDispatcher;
      intervalMs?: number;
      batchSize?: number;
      reconcile?: () => Promise<void>;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 30_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.deps.log?.('[conductor] webhook retry worker started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.deps.reconcile) {
        await this.deps.reconcile().catch((err: unknown) => {
          this.deps.log?.(`[conductor] webhook reconciliation pass failed: ${describeError(err)}`);
        });
      }
      let due;
      try {
        due = await this.deps.store.claimDue(this.deps.batchSize ?? 25);
      } catch (err) {
        this.deps.log?.(`[conductor] webhook retry worker claim failed: ${describeError(err)}`);
        return;
      }
      for (const delivery of due) {
        const subscription = await this.deps.store.get(delivery.subscriptionId).catch(() => null);
        if (!subscription) {
          // Terminal, and the dispatcher never sees it — so this is the only place
          // that can say what happened to the row (#1704: it recorded silently).
          await this.deps.store.recordFailure(delivery.id, 'subscription no longer exists', null);
          this.deps.log?.(
            `[conductor] webhook delivery ${delivery.id} for subscription ${delivery.subscriptionId} abandoned: subscription no longer exists`,
          );
          continue;
        }
        await this.deps.dispatcher.attempt(delivery, subscription).catch((err: unknown) => {
          this.deps.log?.(`[conductor] webhook retry ${delivery.id} crashed: ${describeError(err)}`);
        });
      }
    } finally {
      this.ticking = false;
    }
  }
}
