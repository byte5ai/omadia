import type { JsonObject } from '@omadia/conductor-core';

import { describeError } from '../platform/describeError.js';

import type { ConductorWebhookDelivery, ConductorWebhookSubscription, ConductorWebhookSubscriptionStore } from './webhookSubscriptionStore.js';
import { describeHttpFailure, postWebhook, signWebhookBody, type PostWebhookResult } from './webhookOutbound.js';

/**
 * Issue #437 — outbound delivery: fans an internal event (today `run.completed` /
 * `run.failed`, fired from `ConductorRunExecutor`'s terminal-run hook) out to every
 * enabled subscription for that event, HMAC-signs the body, and retries a failed
 * attempt with exponential backoff up to `maxAttempts`. `deliverEvent` makes the
 * FIRST attempt inline (fire-and-forget); `ConductorWebhookRetryWorker` re-attempts
 * anything still `pending` on a poll loop, so a delivery survives a process restart.
 *
 * #1704 — every failed attempt is diagnosable from the outside: the recorded
 * `last_error` carries the underlying cause (undici reports every transport
 * failure as a bare "fetch failed" and hides the reason in `err.cause`, so a DNS
 * miss, a refused connection and a protocol mismatch all read alike without it),
 * and each attempt leaves its own log line instead of only the final exhaustion
 * up to half an hour after the first failure.
 */

const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000; // 30s, doubling per attempt, capped below
const MAX_BACKOFF_MS = 30 * 60_000; // 30 min
const MAX_LAST_ERROR_CHARS = 500; // see `condense`

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
      this.log(`[conductor] webhook dispatcher: listing subscriptions for '${event}' failed: ${describeError(err)}`);
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
          this.log(`[conductor] webhook delivery ${created.id} attempt crashed: ${describeError(err)}`);
        });
      } catch (err) {
        this.log(`[conductor] webhook dispatcher: creating delivery for subscription ${sub.id} failed: ${describeError(err)}`);
      }
    }
  }

  /** Make one delivery attempt (used both for the first, inline attempt and by the
   *  retry worker for every subsequent one). Never throws — every branch records a
   *  terminal or retryable outcome on the delivery row. */
  async attempt(delivery: ConductorWebhookDelivery, subscription: ConductorWebhookSubscription): Promise<void> {
    if (!subscription.enabled) {
      await this.abandon(delivery, subscription, 'subscription disabled');
      return;
    }
    const secret = await this.deps.store.getSecret(subscription.id).catch(() => undefined);
    if (!secret) {
      // Not retryable — no secret means no subscription+deliveries will ever succeed;
      // exhaust it immediately rather than spin attempts against a broken row.
      await this.abandon(delivery, subscription, 'subscription secret missing');
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
      await this.fail(delivery, subscription, describeHttpFailure(result));
    } catch (err) {
      // `describeError`, not `err.message`: a bare "fetch failed" names no cause,
      // and the cause is the whole diagnosis for a transport failure (#1704).
      await this.fail(delivery, subscription, describeError(err));
    }
  }

  /** Terminal failure that spent no attempt budget: the subscription itself is
   *  broken, so no number of retries could win. Reported as `abandoned`, NOT as
   *  `exhausted after 1 attempts` — the budget is untouched, and an operator
   *  grepping for the exhaustion line must not also land on these. */
  private async abandon(delivery: ConductorWebhookDelivery, subscription: ConductorWebhookSubscription, error: string): Promise<void> {
    const reason = condense(error);
    await this.deps.store.recordFailure(delivery.id, reason, null);
    this.log(`[conductor] webhook delivery ${delivery.id} to ${subscription.url} abandoned: ${reason}`);
  }

  /** A failed attempt: retried with backoff while budget is left, terminal once the
   *  last allowed attempt has been spent. */
  private async fail(delivery: ConductorWebhookDelivery, subscription: ConductorWebhookSubscription, error: string): Promise<void> {
    const attemptNumber = delivery.attempts + 1; // this attempt, 1-indexed
    const reason = condense(error);
    if (attemptNumber >= this.maxAttempts) {
      await this.deps.store.recordFailure(delivery.id, reason, null);
      this.log(
        `[conductor] webhook delivery ${delivery.id} to ${subscription.url} exhausted after ${String(attemptNumber)} attempts: ${reason}`,
      );
      return;
    }
    const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** delivery.attempts);
    await this.deps.store.recordFailure(delivery.id, reason, new Date(Date.now() + backoffMs));
    // One line per failed attempt — without it the first visible sign of trouble is
    // the exhaustion line, up to half an hour after the delivery first failed.
    this.log(
      `[conductor] webhook delivery ${delivery.id} to ${subscription.url} attempt ${String(attemptNumber)}/${String(this.maxAttempts)} failed: ${reason}; retrying in ${String(Math.round(backoffMs / 1000))}s`,
    );
  }
}

/** One line, bounded length — `last_error` is rendered in the operator UI and
 *  repeated into a log line, neither of which wants a 64 KiB HTML error page. */
function condense(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_LAST_ERROR_CHARS ? `${oneLine.slice(0, MAX_LAST_ERROR_CHARS - 1)}\u2026` : oneLine;
}
