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

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE conductor_webhook_subscriptions SET enabled = $2, updated_at = now() WHERE id = $1`, [
      id,
      enabled,
    ]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM conductor_webhook_subscriptions WHERE id = $1`, [id]);
    await this.vault.deleteKey(CONDUCTOR_VAULT_AGENT_ID, outboundSecretKey(id));
  }

  // ── outbound delivery ledger (retry + audit) ──────────────────────────────

  async createDelivery(input: { subscriptionId: string; event: string; payload: JsonObject }): Promise<ConductorWebhookDelivery> {
    const r = await this.pool.query<DeliveryRow>(
      `INSERT INTO conductor_webhook_deliveries (subscription_id, event, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, subscription_id, event, payload, status, attempts, last_error, next_attempt_at, delivered_at, created_at`,
      [input.subscriptionId, input.event, JSON.stringify(input.payload)],
    );
    return toDelivery(r.rows[0]!);
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
