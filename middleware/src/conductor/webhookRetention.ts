import type { ConductorWebhookSubscriptionStore } from './webhookSubscriptionStore.js';

/**
 * Issue #1707 — bounded retention for stored outbound webhook payloads.
 *
 * `conductor_webhook_deliveries.payload` was kept for the lifetime of the install,
 * and (before the context opt-in) held the run's whole step-result context, free-text
 * human responses included. Two windows now apply, swept on one unref'd interval:
 *
 *   1. PAYLOAD window (`payloadRetentionDays`) — the payload is redacted down to
 *      `{runId, status, redacted}`. The row stays, so the delivery history an
 *      operator reads (which run, status, attempts, timings) is not lost.
 *   2. LEDGER window (`deliveryRetentionDays`) — the terminal row itself is deleted,
 *      bounding table growth. `pending` rows are never deleted: they still owe a
 *      delivery attempt.
 *
 * Both are clamped against `MIN_RETENTION_DAYS`, and the ledger window is clamped to
 * at least the payload window. The floor is not cosmetic: the retry worker's
 * reconciliation pass looks back 24h for terminal runs with no delivery row, so a
 * window inside that lookback would let this sweep delete a row the pass then
 * recreates — re-sending a webhook the receiver already got, forever.
 */

/** Floor for both windows — comfortably outside the reconciliation lookback (24h). */
export const MIN_RETENTION_DAYS = 2;

export interface WebhookRetentionOptions {
  store: ConductorWebhookSubscriptionStore;
  /** Age at which a stored payload is redacted. */
  payloadRetentionDays: number;
  /** Age at which a terminal delivery row is deleted. */
  deliveryRetentionDays: number;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/** The effective windows after clamping — exported so the operator-facing posture
 *  route reports what is actually enforced, not what was configured. */
export function resolveRetentionWindows(opts: {
  payloadRetentionDays: number;
  deliveryRetentionDays: number;
}): { payloadRetentionDays: number; deliveryRetentionDays: number } {
  const payloadRetentionDays = Math.max(MIN_RETENTION_DAYS, Math.trunc(opts.payloadRetentionDays));
  return {
    payloadRetentionDays,
    deliveryRetentionDays: Math.max(payloadRetentionDays, Math.trunc(opts.deliveryRetentionDays)),
  };
}

/**
 * Start the sweep. Unref'd interval (never keeps the process alive) plus an eager
 * first pass — without the boot pass, a process restarting more often than the
 * interval would never enforce retention at all (the #757 receipt-reaper lesson).
 * Every tick is best-effort: a failure is logged and the next tick retries.
 */
export function startWebhookPayloadRetention(opts: WebhookRetentionOptions): { stop: () => void } {
  const { payloadRetentionDays, deliveryRetentionDays } = resolveRetentionWindows(opts);
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000; // 6h
  const log = opts.log ?? ((): void => undefined);

  const tick = async (): Promise<void> => {
    try {
      const redacted = await opts.store.redactDeliveryPayloadsOlderThan(payloadRetentionDays);
      if (redacted > 0) {
        log(`[conductor] webhook retention redacted ${String(redacted)} delivery payload(s) past ${String(payloadRetentionDays)}d`);
      }
      const deleted = await opts.store.deleteDeliveriesOlderThan(deliveryRetentionDays);
      if (deleted > 0) {
        log(`[conductor] webhook retention deleted ${String(deleted)} delivery row(s) past ${String(deliveryRetentionDays)}d`);
      }
    } catch (err) {
      log(`[conductor] webhook retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
  return { stop: () => clearInterval(timer) };
}
