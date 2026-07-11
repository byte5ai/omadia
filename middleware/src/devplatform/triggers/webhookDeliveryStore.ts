/**
 * Epic #470 W4 — the webhook delivery ledger (`dev_webhook_deliveries`, spec §3).
 *
 * EVERY inbound GitHub delivery leaves exactly one row here, keyed on the
 * `X-GitHub-Delivery` GUID. The table serves three jobs at once:
 *   1. Dedupe — the GUID PRIMARY KEY + atomic {@link WebhookDeliveryStore.claim}
 *      make a redelivery a no-op (GitHub retries deliveries; without this a
 *      retried label event would spawn a second job).
 *   2. Audit — a silent drop is impossible; the terminal `outcome` explains what
 *      happened to every delivery.
 *   3. Rate-limit / first-source counts — the row is also the counter the route
 *      reads for per-repo / per-sender hourly limits and the "have we ever run a
 *      job for this (repo, sender) pair?" first-source gate.
 *
 * No secret ever lands here; the payload fields (repo, sender) are recorded ONLY
 * after the route has verified the HMAC signature, so they are attacker-forgeable
 * no longer.
 */

import type { Pool } from 'pg';

/** The terminal outcome recorded for a delivery. `received` is the transient
 *  claim-time value, overwritten before the response is sent. */
export type WebhookDeliveryOutcome =
  | 'received'
  | 'job_created'
  | 'refused_sender'
  | 'rate_limited'
  | 'deduped_active_job'
  | 'refused_policy'
  | 'disabled'
  | 'duplicate'
  | 'dropped_event'
  | 'dropped_repo'
  | 'dropped_label';

export interface WebhookDeliveryClaim {
  deliveryId: string;
  event: string | null;
  repo: string | null;
  issueNumber: number | null;
  sender: string | null;
}

export class WebhookDeliveryStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Atomically claim a delivery GUID. Returns `true` iff THIS call inserted the
   * row — i.e. we own processing this delivery. `false` means the GUID was already
   * recorded (a redelivery), so the caller must NOT create a job. The
   * `INSERT … ON CONFLICT (delivery_id) DO NOTHING` closes the check-then-act race
   * two concurrent redeliveries would otherwise open (both passing a bare
   * `exists()` check and both spawning a job).
   */
  async claim(input: WebhookDeliveryClaim): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO dev_webhook_deliveries (delivery_id, event, repo, issue_number, sender, outcome)
       VALUES ($1,$2,$3,$4,$5,'received')
       ON CONFLICT (delivery_id) DO NOTHING`,
      [input.deliveryId, input.event, input.repo, input.issueNumber, input.sender],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Record the terminal outcome of a delivery we claimed. */
  async setOutcome(deliveryId: string, outcome: WebhookDeliveryOutcome): Promise<void> {
    await this.pool.query(`UPDATE dev_webhook_deliveries SET outcome = $2 WHERE delivery_id = $1`, [
      deliveryId,
      outcome,
    ]);
  }

  /** Count deliveries that produced a job for this repo at/after `sinceIso`. Only
   *  `job_created` rows count — refused/dropped deliveries never consume the budget. */
  async countJobsForRepoSince(repo: string, sinceIso: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM dev_webhook_deliveries
        WHERE repo = $1 AND outcome = 'job_created' AND received_at >= $2`,
      [repo, sinceIso],
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  /** Count deliveries that produced a job for this (repo, sender) at/after `sinceIso`. */
  async countJobsForSenderSince(repo: string, sender: string, sinceIso: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM dev_webhook_deliveries
        WHERE repo = $1 AND sender = $2 AND outcome = 'job_created' AND received_at >= $3`,
      [repo, sender, sinceIso],
    );
    return Number(r.rows[0]?.n ?? '0');
  }

  /** True iff this (repo, sender) pair has EVER produced a job — drives the
   *  first-job-from-a-new-source human gate (spec §3 finding S7). */
  async hasPriorJob(repo: string, sender: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM dev_webhook_deliveries
        WHERE repo = $1 AND sender = $2 AND outcome = 'job_created' LIMIT 1`,
      [repo, sender],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
