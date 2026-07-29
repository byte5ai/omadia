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
  | 'rate_limited'
  | 'disabled'
  | 'invalid_payload'
  | 'no_subscribers';

/** Result of {@link ConductorWebhookEndpointStore.claim}: `'claimed'` means THIS call
 *  owns processing the delivery; `'duplicate'` means the id was already recorded (a
 *  redelivery); `'rate_limited'` means the endpoint's rolling-window cap is already
 *  full and no row was inserted (rejected before dedupe, no delivery id is consumed). */
export type WebhookClaimResult = 'claimed' | 'duplicate' | 'rate_limited';

/**
 * Issue #437 review finding: a delivery row is inserted with outcome `'received'`
 * BEFORE the caller runs `emit()`. If the caller crashes (e.g. `emit()` throws) before
 * it can call `setOutcome()`, the row is stuck at `'received'` forever — and without
 * this staleness window, a legitimate retry with the same `X-Webhook-Delivery-Id`
 * would see that row, be told `'duplicate'`, and `emit()` would never run again for
 * that event (permanent loss). A row still at `'received'` after this many ms is
 * treated as an ABANDONED claim (the process that owned it crashed or hung) rather
 * than a terminal duplicate, and `claim()` lets a fresh call re-attempt processing.
 *
 * The window must stay comfortably above how long a real `handle()` invocation takes
 * end to end (DB round-trips + `emit()`), so a genuinely concurrent redelivery of the
 * same id — arriving while the first attempt is still legitimately in flight — is
 * still reported as `'duplicate'` and does not trigger a second `emit()`.
 */
export const IN_FLIGHT_CLAIM_STALE_MS = 30_000;

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
   * Atomically claim a delivery id AND enforce the per-endpoint rate limit in one
   * transaction. A correctly-signed sender can mint a fresh `X-Webhook-Delivery-Id`
   * on every call, so dedupe alone doesn't bound how many workflow runs an endpoint
   * can start — this is the gate that does (issue #437 security gate).
   *
   * ONE transaction, in order (mirrors `WebhookDeliveryStore.reserveJobSlot`,
   * Epic #470 W4, adapted to a single-endpoint cap instead of repo+sender):
   *   1. `pg_advisory_xact_lock(hashtext(endpointId))` — serialises admission PER
   *      ENDPOINT, so a concurrent delivery for the same endpoint blocks here until
   *      we COMMIT (closing the count→insert TOCTOU a bare `COUNT` check would open).
   *   2. Dedupe FIRST: does this (endpoint_id, delivery_id) row already exist? A
   *      redelivery of an id THIS endpoint already claimed is `'duplicate'`
   *      regardless of the current rate — it consumes no new slot, so it must never
   *      be misreported as `'rate_limited'` just because the endpoint is currently
   *      busy with OTHER (unique) deliveries. EXCEPTION: if the existing row is still
   *      at outcome `'received'` (never reached a terminal outcome — see
   *      {@link IN_FLIGHT_CLAIM_STALE_MS}) AND it has been stuck there longer than the
   *      staleness window, the owning process almost certainly crashed before it
   *      could call `setOutcome()`. Re-claiming that row (bumping `received_at`, NOT
   *      inserting a new one) lets a legitimate retry actually re-run `emit()`
   *      instead of being told the event was already handled when it never was.
   *   3. Only for a genuinely NEW id: count this endpoint's delivery rows in the
   *      rolling window. Over the cap ⇒ COMMIT and refuse as `'rate_limited'` — no
   *      row is inserted, so a rate-limited request never consumes a delivery id.
   *   4. Otherwise `INSERT … ON CONFLICT (endpoint_id, delivery_id) DO NOTHING` —
   *      scoped per-endpoint (not globally on `delivery_id`) so endpoint B's
   *      delivery '1' is never misread as a dupe of endpoint A's delivery '1'. The
   *      conflict branch can't actually fire here (step 2 already ruled it out
   *      inside the same locked transaction) — `ON CONFLICT DO NOTHING` stays as a
   *      belt-and-braces guard, not the primary dedupe path.
   */
  async claim(
    deliveryId: string,
    endpointId: string,
    rateLimit: { limit: number; windowMs: number },
  ): Promise<WebhookClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // int4 from hashtext widens to the bigint pg_advisory_xact_lock(bigint) overload.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [endpointId]);
      const existsRes = await client.query<{ outcome: WebhookInboundOutcome; received_at: Date }>(
        `SELECT outcome, received_at FROM conductor_webhook_inbound_deliveries
          WHERE endpoint_id = $1 AND delivery_id = $2`,
        [endpointId, deliveryId],
      );
      const existing = existsRes.rows[0];
      if (existing) {
        const abandonedInFlightClaim =
          existing.outcome === 'received' &&
          Date.now() - existing.received_at.getTime() > IN_FLIGHT_CLAIM_STALE_MS;
        if (!abandonedInFlightClaim) {
          await client.query('COMMIT');
          return 'duplicate';
        }
        await client.query(
          `UPDATE conductor_webhook_inbound_deliveries SET outcome = 'received', received_at = now()
            WHERE endpoint_id = $1 AND delivery_id = $2`,
          [endpointId, deliveryId],
        );
        await client.query('COMMIT');
        return 'claimed';
      }
      const sinceIso = new Date(Date.now() - rateLimit.windowMs).toISOString();
      const countRes = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM conductor_webhook_inbound_deliveries
          WHERE endpoint_id = $1 AND received_at >= $2`,
        [endpointId, sinceIso],
      );
      if (Number(countRes.rows[0]?.n ?? '0') >= rateLimit.limit) {
        await client.query('COMMIT');
        return 'rate_limited';
      }
      const insertRes = await client.query(
        `INSERT INTO conductor_webhook_inbound_deliveries (delivery_id, endpoint_id, outcome)
         VALUES ($1, $2, 'received')
         ON CONFLICT (endpoint_id, delivery_id) DO NOTHING`,
        [deliveryId, endpointId],
      );
      await client.query('COMMIT');
      return (insertRes.rowCount ?? 0) > 0 ? 'claimed' : 'duplicate';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Scoped by (endpointId, deliveryId) — matching the composite PK the row was
   *  claimed under, so this can never touch a different endpoint's same-named id. */
  async setOutcome(deliveryId: string, endpointId: string, outcome: WebhookInboundOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_webhook_inbound_deliveries SET outcome = $3 WHERE endpoint_id = $2 AND delivery_id = $1`,
      [deliveryId, endpointId, outcome],
    );
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
