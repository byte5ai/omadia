import type { JsonObject } from '@omadia/conductor-core';

import type { ConductorWebhookDelivery, ConductorWebhookSubscription, ConductorWebhookSubscriptionStore } from './webhookSubscriptionStore.js';
import { postWebhook, signWebhookBody, type PostWebhookResult } from './webhookOutbound.js';

/**
 * Issue #437 — outbound delivery: fans an internal event (today `run.completed` /
 * `run.failed`, fired from `ConductorRunExecutor`'s terminal-run hook) out to every
 * enabled subscription for that event, HMAC-signs the body, and retries a failed
 * attempt with exponential backoff up to `maxAttempts`. `deliverEvent` makes the
 * FIRST attempt inline (fire-and-forget); `ConductorWebhookRetryWorker` re-attempts
 * anything still `pending` on a poll loop, so a delivery survives a process restart.
 */

const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000; // 30s, doubling per attempt, capped below
const MAX_BACKOFF_MS = 30 * 60_000; // 30 min

export class ConductorWebhookDispatcher {
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly deps: {
      store: ConductorWebhookSubscriptionStore;
      maxAttempts?: number;
      timeoutMs?: number;
      /** Test seam: the SSRF-guarded POST used for a real attempt. Production leaves
       *  this unset and gets `postWebhook` from webhookOutbound.ts. */
      sendRequest?: (input: { url: string; headers: Record<string, string>; body: string; timeoutMs?: number }) => Promise<PostWebhookResult>;
      log?: (msg: string) => void;
    },
  ) {
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.log = deps.log ?? (() => undefined);
  }

  /** Fan an event out to every enabled subscription. Best-effort — a lookup or
   *  per-subscription failure is logged and does not affect the others (the caller
   *  is the run executor's terminal hook; it must never throw). */
  async deliverEvent(event: string, payload: JsonObject): Promise<void> {
    let subs: ConductorWebhookSubscription[];
    try {
      subs = await this.deps.store.listEnabledForEvent(event);
    } catch (err) {
      this.log(`[conductor] webhook dispatcher: listing subscriptions for '${event}' failed: ${errMsg(err)}`);
      return;
    }
    for (const sub of subs) {
      try {
        const created = await this.deps.store.createDelivery({ subscriptionId: sub.id, event, payload });
        // Claim the row before attempting inline — closes the race with the retry
        // worker's poll loop, which sees this same row as immediately due (issue #437
        // finding: an unclaimed inline attempt and a concurrent worker tick could both
        // send it, and whichever recordFailure lands last would flip an already
        // `delivered` row back to `pending`). `null` means the worker's tick already
        // won the race for this row — it, not us, now owns the attempt.
        const claimed = await this.deps.store.claimOne(created.id);
        if (!claimed) continue;
        void this.attempt(claimed, sub).catch((err) => {
          this.log(`[conductor] webhook delivery ${created.id} attempt crashed: ${errMsg(err)}`);
        });
      } catch (err) {
        this.log(`[conductor] webhook dispatcher: creating delivery for subscription ${sub.id} failed: ${errMsg(err)}`);
      }
    }
  }

  /** Make one delivery attempt (used both for the first, inline attempt and by the
   *  retry worker for every subsequent one). Never throws — every branch records a
   *  terminal or retryable outcome on the delivery row. */
  async attempt(delivery: ConductorWebhookDelivery, subscription: ConductorWebhookSubscription): Promise<void> {
    if (!subscription.enabled) {
      await this.deps.store.recordFailure(delivery.id, 'subscription disabled', null);
      return;
    }
    const secret = await this.deps.store.getSecret(subscription.id).catch(() => undefined);
    if (!secret) {
      // Not retryable — no secret means no subscription+deliveries will ever succeed;
      // exhaust it immediately rather than spin attempts against a broken row.
      await this.deps.store.recordFailure(delivery.id, 'subscription secret missing', null);
      return;
    }

    const body = JSON.stringify({ event: delivery.event, deliveryId: delivery.id, payload: delivery.payload });
    const headers = {
      'content-type': 'application/json',
      'x-omadia-event': delivery.event,
      'x-omadia-delivery-id': delivery.id,
      'x-omadia-signature': signWebhookBody(secret, body),
    };

    const send = this.deps.sendRequest ?? postWebhook;
    try {
      const result = await send({ url: subscription.url, headers, body, timeoutMs: this.timeoutMs });
      if (result.ok) {
        await this.deps.store.recordSuccess(delivery.id);
        return;
      }
      await this.fail(delivery, `http ${String(result.status)}: ${result.bodySnippet}`);
    } catch (err) {
      await this.fail(delivery, errMsg(err));
    }
  }

  private async fail(delivery: ConductorWebhookDelivery, error: string): Promise<void> {
    const attemptNumber = delivery.attempts + 1; // this attempt, 1-indexed
    if (attemptNumber >= this.maxAttempts) {
      await this.deps.store.recordFailure(delivery.id, error, null);
      this.log(`[conductor] webhook delivery ${delivery.id} exhausted after ${String(attemptNumber)} attempts: ${error}`);
      return;
    }
    const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** delivery.attempts);
    await this.deps.store.recordFailure(delivery.id, error, new Date(Date.now() + backoffMs));
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
