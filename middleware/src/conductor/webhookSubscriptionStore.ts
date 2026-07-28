import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import type { JsonObject } from '@omadia/conductor-core';

import type { SecretVault } from '../secrets/vault.js';
import { CONDUCTOR_VAULT_AGENT_ID } from './webhookEndpointStore.js';

/**
 * Issue #437 — outbound Conductor webhooks: `conductor_webhook_subscriptions`
 * (metadata) + `conductor_webhook_deliveries` (retry/audit ledger). Same
 * metadata-in-Postgres / secret-in-Vault split as the inbound endpoint store.
 */

const outboundSecretKey = (subscriptionId: string): string => `webhook-subscription/${subscriptionId}/secret`;

export interface ConductorWebhookSubscription {
  id: string;
  url: string;
  event: string;
  description: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'exhausted';

export interface ConductorWebhookDelivery {
  id: string;
  subscriptionId: string;
  event: string;
  payload: JsonObject;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}

interface SubscriptionRow {
  id: string;
  url: string;
  event: string;
  description: string | null;
  enabled: boolean;
  created_by: string;
  created_at: Date;
}

interface DeliveryRow {
  id: string;
  subscription_id: string;
  event: string;
  payload: JsonObject;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  delivered_at: Date | null;
  created_at: Date;
}

function toSubscription(r: SubscriptionRow): ConductorWebhookSubscription {
  return {
    id: r.id,
    url: r.url,
    event: r.event,
    description: r.description,
    enabled: r.enabled,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toDelivery(r: DeliveryRow): ConductorWebhookDelivery {
  return {
    id: r.id,
    subscriptionId: r.subscription_id,
    event: r.event,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
    deliveredAt: r.delivered_at,
    createdAt: r.created_at,
  };
}

function mintSecret(): string {
  return randomBytes(32).toString('hex');
}

export class ConductorWebhookSubscriptionStore {
  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
  ) {}

  /** Create a subscription. Returns the plaintext signing secret ONCE — receivers
   *  configure it out of band to verify the `X-Omadia-Signature` header. */
  async create(input: { url: string; event: string; description?: string | null; createdBy: string }): Promise<{
    subscription: ConductorWebhookSubscription;
    secret: string;
  }> {
    const secret = mintSecret();
    const r = await this.pool.query<SubscriptionRow>(
      `INSERT INTO conductor_webhook_subscriptions (url, event, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, event, description, enabled, created_by, created_at`,
      [input.url, input.event, input.description ?? null, input.createdBy],
    );
    const row = r.rows[0]!;
    await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, outboundSecretKey(row.id), secret);
    return { subscription: toSubscription(row), secret };
  }

  async list(): Promise<ConductorWebhookSubscription[]> {
    const r = await this.pool.query<SubscriptionRow>(
      `SELECT id, url, event, description, enabled, created_by, created_at
         FROM conductor_webhook_subscriptions ORDER BY created_at DESC`,
    );
    return r.rows.map(toSubscription);
  }

  async get(id: string): Promise<ConductorWebhookSubscription | null> {
    const r = await this.pool.query<SubscriptionRow>(
      `SELECT id, url, event, description, enabled, created_by, created_at
         FROM conductor_webhook_subscriptions WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? toSubscription(r.rows[0]) : null;
  }

  /** Enabled subscriptions matching an event — the dispatcher's fan-out read. */
  async listEnabledForEvent(event: string): Promise<ConductorWebhookSubscription[]> {
    const r = await this.pool.query<SubscriptionRow>(
      `SELECT id, url, event, description, enabled, created_by, created_at
         FROM conductor_webhook_subscriptions WHERE event = $1 AND enabled = true`,
      [event],
    );
    return r.rows.map(toSubscription);
  }

  async getSecret(subscriptionId: string): Promise<string | undefined> {
    return this.vault.get(CONDUCTOR_VAULT_AGENT_ID, outboundSecretKey(subscriptionId));
  }

  async rotateSecret(subscriptionId: string): Promise<string> {
    const secret = mintSecret();
    await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, outboundSecretKey(subscriptionId), secret);
    return secret;
  }

  /** Enabling bumps `enabled_since` (review finding — see migration 0007's comment):
   *  `listMissingRunDeliveries` uses it to bound reconciliation to runs that ended
   *  while the subscription was actually active, so re-enabling a long-disabled
   *  subscription never backfills events from its disabled window. Disabling leaves
   *  `enabled_since` untouched — it only ever records the most recent transition
   *  INTO the enabled state. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_webhook_subscriptions
          SET enabled = $2, updated_at = now(), enabled_since = CASE WHEN $2 THEN now() ELSE enabled_since END
        WHERE id = $1`,
      [id, enabled],
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM conductor_webhook_subscriptions WHERE id = $1`, [id]);
    await this.vault.deleteKey(CONDUCTOR_VAULT_AGENT_ID, outboundSecretKey(id));
  }

  // ── outbound delivery ledger (retry + audit) ──────────────────────────────

  /**
   * Insert a delivery row. Conflict-safe on `(subscription_id, run_id)` (review
   * finding — migration 0007's `conductor_webhook_deliveries_run_subscription_uidx`):
   * the live terminal-run hook and the reconciliation pass can race to create the
   * "missing" delivery for the same run, and two reconciliation passes on different
   * replicas can race each other. `ON CONFLICT DO NOTHING` makes at most one delivery
   * ever exist per (subscription, run) pair; on a conflict this returns the row that
   * already won instead of erroring or silently returning nothing, so every caller —
   * including ones that don't check for a conflict — stays idempotent.
   */
  async createDelivery(input: { subscriptionId: string; event: string; payload: JsonObject }): Promise<ConductorWebhookDelivery> {
    const inserted = await this.pool.query<DeliveryRow>(
      `INSERT INTO conductor_webhook_deliveries (subscription_id, event, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (subscription_id, run_id) WHERE run_id IS NOT NULL DO NOTHING
       RETURNING id, subscription_id, event, payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at`,
      [input.subscriptionId, input.event, JSON.stringify(input.payload)],
    );
    if (inserted.rows[0]) return toDelivery(inserted.rows[0]);

    // Conflict: a delivery for this (subscription, run) pair already exists.
    const runId = typeof input.payload['runId'] === 'string' ? input.payload['runId'] : null;
    const existing = await this.pool.query<DeliveryRow>(
      `SELECT id, subscription_id, event, payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
         FROM conductor_webhook_deliveries WHERE subscription_id = $1 AND run_id = $2`,
      [input.subscriptionId, runId],
    );
    if (!existing.rows[0]) {
      // Should be unreachable (the conflict just proved a matching row exists), but
      // never leave the caller without a row to act on.
      throw new Error(`webhook delivery conflict for subscription ${input.subscriptionId}, run ${runId ?? '(none)'} could not be resolved`);
    }
    return toDelivery(existing.rows[0]);
  }

  /** Deliveries due for an attempt now (status='pending' and next_attempt_at <= now).
   *  `FOR UPDATE SKIP LOCKED` so a second worker/replica never double-attempts one. */
  async claimDue(limit: number): Promise<ConductorWebhookDelivery[]> {
    const safe = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<DeliveryRow>(
        `SELECT id, subscription_id, event, payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
           FROM conductor_webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [safe],
      );
      // Push next_attempt_at out immediately so a slow HTTP call doesn't leave the row
      // eligible for a concurrent claim before this attempt finishes recording its result.
      if (r.rows.length > 0) {
        await client.query(
          `UPDATE conductor_webhook_deliveries SET next_attempt_at = now() + interval '5 minutes'
            WHERE id = ANY($1::uuid[])`,
          [r.rows.map((row) => row.id)],
        );
      }
      await client.query('COMMIT');
      return r.rows.map(toDelivery);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Claim exactly ONE delivery row for an immediate inline attempt — the seam that
   * closes the race between `ConductorWebhookDispatcher.deliverEvent`'s first,
   * inline attempt and `ConductorWebhookRetryWorker`'s poll loop. `createDelivery`
   * leaves a row `pending` with `next_attempt_at = now()`, i.e. immediately "due";
   * without this claim, the inline attempt and a concurrent `claimDue` tick could
   * both send the same delivery, and whichever `recordFailure` lands LAST would
   * unconditionally flip an already-`delivered` row back to `pending` (issue #437
   * finding). Same `FOR UPDATE SKIP LOCKED` claim `claimDue` uses, scoped to one id
   * — so the two paths compete for the same row lock and only one of them wins.
   * Returns `null` if the row is no longer claimable (already claimed elsewhere, or
   * no longer pending) — the caller must NOT attempt in that case; whichever path
   * won the race owns it.
   */
  async claimOne(deliveryId: string): Promise<ConductorWebhookDelivery | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<DeliveryRow>(
        `SELECT id, subscription_id, event, payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
           FROM conductor_webhook_deliveries
          WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now()
          FOR UPDATE SKIP LOCKED`,
        [deliveryId],
      );
      if (r.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }
      // Same push-forward `claimDue` does — a slow inline HTTP call must not leave
      // the row eligible for a concurrent claim before this attempt records a result.
      await client.query(
        `UPDATE conductor_webhook_deliveries SET next_attempt_at = now() + interval '5 minutes' WHERE id = $1`,
        [deliveryId],
      );
      await client.query('COMMIT');
      return toDelivery(r.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reconciliation pass (issue #437 finding): `notifyRunEnded` fires the dispatcher
   * fire-and-forget AFTER the run's terminal status is already committed — a process
   * kill in that window loses the webhook permanently, since nothing durable links
   * "this run ended" to "a delivery row was created" for it. This finds terminal,
   * non-dry-run runs (within `sinceIso`) that have NO delivery row for a given
   * enabled subscription yet, and returns what's missing so the caller can create
   * it. `run_id` (generated from `payload->>'runId'`) is how a delivery is tied back
   * to its run — `createDelivery` always includes `runId` in the payload (see
   * `index.ts`'s `notifyRunEnded` hook).
   *
   * Bounded by BOTH `sinceIso` (the caller's lookback window) AND each subscription's
   * own `enabled_since` (review finding): without the latter, creating a brand-new
   * subscription — or re-enabling one that was disabled — would backfill every
   * matching run in the whole `sinceIso` window, including runs that ended before the
   * subscription existed or while it was disabled. `enabled_since` defaults to
   * creation time and is bumped on every transition into the enabled state, so this
   * only ever reconciles runs that ended while the subscription was genuinely active.
   */
  async listMissingRunDeliveries(
    sinceIso: string,
  ): Promise<Array<{ runId: string; status: 'completed' | 'failed'; subscriptionId: string }>> {
    const r = await this.pool.query<{ run_id: string; status: 'completed' | 'failed'; subscription_id: string }>(
      `SELECT r.id AS run_id, r.status AS status, s.id AS subscription_id
         FROM conductor_runs r
         JOIN conductor_webhook_subscriptions s
           ON s.enabled = true
          AND s.event = ('run.' || r.status)
          AND r.ended_at >= s.enabled_since
        WHERE r.is_dry_run = false
          AND r.status IN ('completed', 'failed')
          AND r.ended_at >= $1
          AND NOT EXISTS (
                SELECT 1 FROM conductor_webhook_deliveries d
                 WHERE d.subscription_id = s.id
                   AND d.run_id = r.id::text
              )`,
      [sinceIso],
    );
    return r.rows.map((row) => ({ runId: row.run_id, status: row.status, subscriptionId: row.subscription_id }));
  }

  async recordSuccess(deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_webhook_deliveries
          SET status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error = NULL
        WHERE id = $1`,
      [deliveryId],
    );
  }

  /** Record a failed attempt. `exhausted` when this was the last allowed attempt;
   *  otherwise `pending` again at `nextAttemptAt` (the caller's backoff schedule). */
  async recordFailure(deliveryId: string, error: string, nextAttemptAt: Date | null): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_webhook_deliveries
          SET status = $2, attempts = attempts + 1, last_error = $3,
              next_attempt_at = COALESCE($4, next_attempt_at)
        WHERE id = $1`,
      [deliveryId, nextAttemptAt ? 'pending' : 'exhausted', error, nextAttemptAt],
    );
  }

  async listForSubscription(subscriptionId: string, limit = 50): Promise<ConductorWebhookDelivery[]> {
    const safe = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const r = await this.pool.query<DeliveryRow>(
      `SELECT id, subscription_id, event, payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at
         FROM conductor_webhook_deliveries
        WHERE subscription_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [subscriptionId, safe],
    );
    return r.rows.map(toDelivery);
  }
}
