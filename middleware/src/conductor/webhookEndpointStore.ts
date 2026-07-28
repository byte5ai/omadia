import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { SecretVault } from '../secrets/vault.js';

/**
 * Issue #437 — inbound Conductor webhooks: `conductor_webhook_endpoints` (metadata)
 * + `conductor_webhook_inbound_deliveries` (dedupe/audit ledger). Secrets never touch
 * a column; they live in Vault under `CONDUCTOR_VAULT_AGENT_ID`, the same split
 * `DevGithubAppStore` uses for GitHub App credentials (metadata in Postgres, secrets
 * in Vault).
 */

/** Vault namespace for all Conductor-webhook secret material (inbound endpoint
 *  secrets AND outbound subscription secrets — see webhookSubscriptionStore.ts). */
export const CONDUCTOR_VAULT_AGENT_ID = 'core:conductor';

const inboundSecretKey = (endpointId: string): string => `webhook-endpoint/${endpointId}/secret`;

export interface ConductorWebhookEndpoint {
  endpointId: string;
  eventId: string;
  description: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
}

export type WebhookInboundOutcome =
  | 'received'
  | 'started'
  | 'duplicate'
  | 'disabled'
  | 'invalid_payload'
  | 'no_subscribers';

export interface ConductorWebhookInboundDelivery {
  deliveryId: string;
  endpointId: string;
  outcome: WebhookInboundOutcome;
  receivedAt: Date;
}

interface EndpointRow {
  endpoint_id: string;
  event_id: string;
  description: string | null;
  enabled: boolean;
  created_by: string;
  created_at: Date;
}

interface InboundDeliveryRow {
  delivery_id: string;
  endpoint_id: string;
  outcome: WebhookInboundOutcome;
  received_at: Date;
}

function toEndpoint(r: EndpointRow): ConductorWebhookEndpoint {
  return {
    endpointId: r.endpoint_id,
    eventId: r.event_id,
    description: r.description,
    enabled: r.enabled,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toDelivery(r: InboundDeliveryRow): ConductorWebhookInboundDelivery {
  return { deliveryId: r.delivery_id, endpointId: r.endpoint_id, outcome: r.outcome, receivedAt: r.received_at };
}

/** Mint a URL-safe opaque endpoint id — unguessable, distinct from any DB serial so
 *  it never leaks row-count/ordering information. */
function mintEndpointId(): string {
  return randomBytes(16).toString('hex');
}

/** Mint a webhook signing secret (32 random bytes, hex-encoded — same shape as the
 *  GitHub App webhook secrets this pattern is modeled on). */
function mintSecret(): string {
  return randomBytes(32).toString('hex');
}

export class ConductorWebhookEndpointStore {
  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
  ) {}

  /** Create a new inbound endpoint. Returns the plaintext secret ONCE — the caller
   *  (the admin route) must show it to the operator now; it is never retrievable again. */
  async create(input: { eventId: string; description?: string | null; createdBy: string }): Promise<{
    endpoint: ConductorWebhookEndpoint;
    secret: string;
  }> {
    const endpointId = mintEndpointId();
    const secret = mintSecret();
    const r = await this.pool.query<EndpointRow>(
      `INSERT INTO conductor_webhook_endpoints (endpoint_id, event_id, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING endpoint_id, event_id, description, enabled, created_by, created_at`,
      [endpointId, input.eventId, input.description ?? null, input.createdBy],
    );
    await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId), secret);
    return { endpoint: toEndpoint(r.rows[0]!), secret };
  }

  async list(): Promise<ConductorWebhookEndpoint[]> {
    const r = await this.pool.query<EndpointRow>(
      `SELECT endpoint_id, event_id, description, enabled, created_by, created_at
         FROM conductor_webhook_endpoints ORDER BY created_at DESC`,
    );
    return r.rows.map(toEndpoint);
  }

  /** Metadata only — NEVER returns the secret. */
  async get(endpointId: string): Promise<ConductorWebhookEndpoint | null> {
    const r = await this.pool.query<EndpointRow>(
      `SELECT endpoint_id, event_id, description, enabled, created_by, created_at
         FROM conductor_webhook_endpoints WHERE endpoint_id = $1`,
      [endpointId],
    );
    return r.rows[0] ? toEndpoint(r.rows[0]) : null;
  }

  /** Read the signing secret for signature verification. Absent ⇒ endpoint unusable
   *  (never happens for a row created through `create`, but defends a partial write). */
  async getSecret(endpointId: string): Promise<string | undefined> {
    return this.vault.get(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId));
  }

  /** Replace the signing secret. Returns the new plaintext secret ONCE. */
  async rotateSecret(endpointId: string): Promise<string> {
    const secret = mintSecret();
    await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId), secret);
    return secret;
  }

  async setEnabled(endpointId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_webhook_endpoints SET enabled = $2, updated_at = now() WHERE endpoint_id = $1`,
      [endpointId, enabled],
    );
  }

  async delete(endpointId: string): Promise<void> {
    await this.pool.query(`DELETE FROM conductor_webhook_endpoints WHERE endpoint_id = $1`, [endpointId]);
    await this.vault.deleteKey(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId));
  }

  // ── inbound delivery ledger (dedupe + audit) ──────────────────────────────

  /**
   * Atomically claim a delivery id. Returns `true` iff THIS call inserted the row —
   * i.e. we own processing this delivery; `false` means it was already recorded (a
   * redelivery), so the caller must not start a second run. Mirrors
   * `WebhookDeliveryStore.claim` (Epic #470 W4) — `INSERT … ON CONFLICT DO NOTHING`
   * closes the check-then-act race two concurrent redeliveries would otherwise open.
   */
  async claim(deliveryId: string, endpointId: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO conductor_webhook_inbound_deliveries (delivery_id, endpoint_id, outcome)
       VALUES ($1, $2, 'received')
       ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, endpointId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setOutcome(deliveryId: string, outcome: WebhookInboundOutcome): Promise<void> {
    await this.pool.query(`UPDATE conductor_webhook_inbound_deliveries SET outcome = $2 WHERE delivery_id = $1`, [
      deliveryId,
      outcome,
    ]);
  }

  async listDeliveries(endpointId: string, limit = 50): Promise<ConductorWebhookInboundDelivery[]> {
    const safe = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const r = await this.pool.query<InboundDeliveryRow>(
      `SELECT delivery_id, endpoint_id, outcome, received_at
         FROM conductor_webhook_inbound_deliveries
        WHERE endpoint_id = $1
        ORDER BY received_at DESC
        LIMIT $2`,
      [endpointId, safe],
    );
    return r.rows.map(toDelivery);
  }
}

/** A random delivery id for callers that omit `X-Webhook-Delivery-Id` — recorded for
 *  audit but cannot dedupe a redelivery (there is no stable key to claim on). */
export function generateInboundDeliveryId(): string {
  return `auto:${randomUUID()}`;
}
