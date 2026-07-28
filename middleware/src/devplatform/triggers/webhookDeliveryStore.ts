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

  /**
   * Atomically reserve a rate-limit slot for the claimed delivery — the fix for
   * the count→create→setOutcome TOCTOU (Epic #470 W4 concurrency fix #1). A naive
   * "count `job_created` rows, then create" lets N concurrent deliveries all read
   * the same pre-reservation count and all pass a cap of 2.
   *
   * ONE transaction, in order:
   *   1. `pg_advisory_xact_lock(hashtext(repo))` — serialises admission PER REPO,
   *      so a concurrent delivery for the same repo blocks here until we COMMIT.
   *   2. Count committed `job_created` rows in the rolling window, per-repo and
   *      per-(repo, sender).
   *   3. Over either cap ⇒ stamp this delivery `'rate_limited'`, COMMIT, refuse.
   *      Otherwise RESERVE the slot by stamping this delivery `'job_created'`,
   *      COMMIT (releasing the lock).
   *
   * Because the reservation is COMMITTED while the lock is held, the next delivery
   * to acquire the lock counts it — the window is consistent. If job creation then
   * refuses/dedupes, the route corrects this delivery's outcome to the real
   * terminal value, freeing the slot; a transient over-count in that gap is
   * fail-safe (it can only refuse, never over-admit).
   */
  async reserveJobSlot(input: {
    repo: string;
    sender: string;
    deliveryId: string;
    repoLimit: number;
    senderLimit: number;
    sinceIso: string;
  }): Promise<{ admitted: boolean; reason?: 'rate_limited' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // int4 from hashtext widens to the bigint pg_advisory_xact_lock(bigint) overload.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.repo]);
      const repoRes = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM dev_webhook_deliveries
          WHERE repo = $1 AND outcome = 'job_created' AND received_at >= $2`,
        [input.repo, input.sinceIso],
      );
      const senderRes = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM dev_webhook_deliveries
          WHERE repo = $1 AND sender = $2 AND outcome = 'job_created' AND received_at >= $3`,
        [input.repo, input.sender, input.sinceIso],
      );
      const repoCount = Number(repoRes.rows[0]?.n ?? '0');
      const senderCount = Number(senderRes.rows[0]?.n ?? '0');
      const nextOutcome: WebhookDeliveryOutcome =
        repoCount >= input.repoLimit || senderCount >= input.senderLimit ? 'rate_limited' : 'job_created';
      await client.query(`UPDATE dev_webhook_deliveries SET outcome = $2 WHERE delivery_id = $1`, [
        input.deliveryId,
        nextOutcome,
      ]);
      await client.query('COMMIT');
      return nextOutcome === 'job_created' ? { admitted: true } : { admitted: false, reason: 'rate_limited' };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
