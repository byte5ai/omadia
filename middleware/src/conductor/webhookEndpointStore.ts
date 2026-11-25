import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

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
/** Issue #1707 — the secret a rotation superseded, kept VALID until the endpoint's
 *  `secret_previous_until` deadline so a rotation is not an instant outage for the
 *  sender. Its own vault key: the current secret must never be ambiguous. */
const inboundPreviousSecretKey = (endpointId: string): string => `webhook-endpoint/${endpointId}/secret.previous`;

/**
 * Advisory-lock namespace for one endpoint's SECRET LIFECYCLE — rotation and the lazy
 * cleanup of a lapsed grace (issue #1707 review finding).
 *
 * Those two are the only writers of the `(secret_previous_until, previous vault key)`
 * pair, and the pair spans two stores, so no single transaction can make a write to
 * both atomic. Serialising the two writers is what makes the pair consistent instead:
 * without it, a rotation that had written the new previous key but not yet stamped the
 * deadline could be observed by a reader still seeing the PREVIOUS rotation's lapsed
 * deadline — the reader's cleanup then deleted the key the rotation had just written
 * and the grace window silently vanished (the sender got 401s for an hour it was
 * promised).
 *
 * Deliberately its own namespace rather than the one-arg `hashtext(endpointId)` space
 * `claim()` locks: an operator's rotation must never block the inbound delivery hot
 * path for the same endpoint. The two-arg `pg_advisory_xact_lock(int4, int4)` overload
 * takes this constant plus `hashtext(endpointId)`, so the two lock spaces cannot
 * collide. The number is the issue.
 */
const SECRET_LIFECYCLE_LOCK_NAMESPACE = 1707;

export interface ConductorWebhookEndpoint {
  endpointId: string;
  eventId: string;
  description: string | null;
  enabled: boolean;
  /** Issue #1707 — while this is in the future, the secret the last rotation
   *  superseded still verifies, so the operator can reconfigure the sender without
   *  an outage. NULL once the grace has lapsed (or if nothing was ever rotated).
   *  Returned to the admin UI so the window is visible, never the secret itself. */
  secretPreviousUntil: Date | null;
  createdBy: string;
  createdAt: Date;
}

/** Issue #1707 — the secrets an inbound request may verify against: the current one,
 *  plus the superseded one while its rotation grace is still open. Both are tried in
 *  constant time; neither presence nor absence is ever reported to the caller. */
export interface WebhookVerificationSecrets {
  current?: string;
  previous?: string;
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
 *  owns processing the delivery; `'duplicate'` means the id was already recorded AND
 *  that record consumed it (so not every recorded id answers `'duplicate'` — see
 *  {@link REDELIVERABLE_OUTCOMES}); `'rate_limited'` means the endpoint's
 *  rolling-window cap is already full and no row was inserted (rejected before
 *  dedupe, no delivery id is consumed). */
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

/**
 * Issue #1701 — recorded outcomes that do NOT consume the delivery id: a sender may
 * redeliver the same `X-Webhook-Delivery-Id` and `claim()` will hand it out again.
 *
 * A delivery refused because the endpoint was disabled never reached `emit()`: the
 * event was not processed, nothing was routed, no run started. Treating that row as a
 * terminal duplicate loses the event for good — the sender's honest redelivery after
 * the endpoint is enabled again is answered `'duplicate'` and no run ever starts (the
 * reported bug: a disabled endpoint silently swallows the delivery id).
 *
 * So `claim()` re-claims such a row instead of reporting it as a duplicate. Unlike the
 * abandoned-claim recovery above there is NO staleness window: nothing is in flight to
 * protect against, and the endpoint can be enabled a second after the refusal.
 *
 * Deliberately NOT in this set:
 *   - `'started'` / `'no_subscribers'` — `emit()` DID run for these, so re-claiming
 *     would re-route an event this endpoint already processed (a duplicate run).
 *   - `'invalid_payload'` — the body is covered by the HMAC, so a corrected payload is
 *     a different request the sender should send under a fresh delivery id.
 *   - `'duplicate'` — never written as a row's outcome; it IS the dedupe answer.
 *   - `'rate_limited'` — inserts no row at all, so it already consumes no id.
 *
 * TWO CONSEQUENCES, both deliberate:
 *   1. The refusal is NOT a durable audit record. There is one row per
 *      `(endpoint_id, delivery_id)`, so a later successful redelivery overwrites the
 *      `'disabled'` outcome. An operator reading `conductor_webhook_inbound_deliveries`
 *      sees `'disabled'` only for refusals nobody has redelivered yet — which is the
 *      set that matters (those are the events still missing). Recording every attempt
 *      separately would need its own table or an attempt counter; the ledger's job
 *      here is dedupe, not a request log.
 *   2. A refusal still occupies a rate-limit slot for the rolling window, and a
 *      re-claim bumps `received_at`, extending that residence. That is what bounds
 *      ledger growth while an endpoint is off — exempting refusals would make a
 *      disabled endpoint an unbounded row sink for a correctly-signed sender minting
 *      fresh ids. The redelivery of an already-refused id is never throttled: it
 *      short-circuits in the dedupe branch, before the window count.
 */
export const REDELIVERABLE_OUTCOMES: ReadonlySet<WebhookInboundOutcome> = new Set(['disabled']);

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
  secret_previous_until: Date | null;
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
    secretPreviousUntil: r.secret_previous_until,
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
       RETURNING endpoint_id, event_id, description, enabled, secret_previous_until, created_by, created_at`,
      [endpointId, input.eventId, input.description ?? null, input.createdBy],
    );
    await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId), secret);
    return { endpoint: toEndpoint(r.rows[0]!), secret };
  }

  async list(): Promise<ConductorWebhookEndpoint[]> {
    const r = await this.pool.query<EndpointRow>(
      `SELECT endpoint_id, event_id, description, enabled, secret_previous_until, created_by, created_at
         FROM conductor_webhook_endpoints ORDER BY created_at DESC`,
    );
    return r.rows.map(toEndpoint);
  }

  /** Metadata only — NEVER returns the secret. */
  async get(endpointId: string): Promise<ConductorWebhookEndpoint | null> {
    const r = await this.pool.query<EndpointRow>(
      `SELECT endpoint_id, event_id, description, enabled, secret_previous_until, created_by, created_at
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

  /**
   * Replace the signing secret, keeping the superseded one valid for `graceMs`
   * (issue #1707). Returns the new plaintext secret ONCE.
   *
   * Before this, rotation was an instant outage: the sender's very next request
   * carried the old secret and got a 401, with no window in which both secrets
   * worked, so a rotation could only be done by stopping the sender first. Now the
   * old secret is copied to its own vault key and `secret_previous_until` is stamped
   * `now() + graceMs`; `getVerificationSecrets` accepts either until that deadline.
   *
   * `graceMs <= 0` keeps the old behaviour (immediate cutover) and is the right
   * choice for the one case that needs it: rotating BECAUSE the old secret leaked.
   * The old key is then deleted rather than stored, so a leaked secret is not kept
   * around in the vault for an hour.
   */
  async rotateSecret(endpointId: string, graceMs = 0): Promise<string> {
    const secret = mintSecret();
    // Under the secret-lifecycle lock (see SECRET_LIFECYCLE_LOCK_NAMESPACE): the
    // deadline and the previous vault key live in different stores, so the lock —
    // not a transaction — is what keeps the lazy cleanup from observing this
    // rotation half-done and deleting the key it just wrote. It also serialises two
    // concurrent rotations of the same endpoint, so the second one supersedes the
    // first's secret rather than both reading the same original.
    return this.withSecretLifecycleLock(endpointId, async (client) => {
      const superseded = graceMs > 0 ? await this.vault.get(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId)) : undefined;
      if (superseded !== undefined) {
        // ORDER IS LOAD-BEARING (review finding). The lock keeps the cleanup out, but
        // `getVerificationSecrets` READS without it, so every intermediate state here
        // is observable by a delivery in flight. Park the superseded secret and stamp
        // its deadline BEFORE swapping the current key: that way no instant exists in
        // which the deadline still says "no grace" while the current key already holds
        // the new secret — which is precisely the window where the old secret would
        // answer 401 despite the grace that was just granted. Written the other way
        // round, the grace promised the operator an hour and the sender lost it for a
        // few milliseconds of every rotation.
        await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, inboundPreviousSecretKey(endpointId), superseded);
        await client.query(
          `UPDATE conductor_webhook_endpoints
              SET secret_previous_until = now() + make_interval(secs => $2), updated_at = now()
            WHERE endpoint_id = $1`,
          [endpointId, graceMs / 1000],
        );
        await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId), secret);
      } else {
        // No grace: nothing this call leaves behind may still verify — otherwise a
        // zero-grace "the secret leaked" rotation would leave an EARLIER rotation's
        // secret live. Here the order is the mirror image, for the mirror reason: kill
        // the deadline FIRST, so no delivery in flight can still be handed a previous
        // secret while we are tearing it down.
        await client.query(
          `UPDATE conductor_webhook_endpoints SET secret_previous_until = NULL, updated_at = now()
            WHERE endpoint_id = $1`,
          [endpointId],
        );
        await this.vault.deleteKey(CONDUCTOR_VAULT_AGENT_ID, inboundPreviousSecretKey(endpointId));
        await this.vault.set(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId), secret);
      }
      return secret;
    });
  }

  /**
   * The secrets an inbound request may verify against. The previous secret is read
   * only while `secret_previous_until` is still in the future — so the common case
   * (no rotation in flight) costs exactly one vault read, and a lapsed grace is
   * cleaned up ONCE (key deleted, deadline NULLed) rather than re-evaluated on every
   * request. Absent endpoint ⇒ `{}`, which fails verification exactly like a wrong
   * secret does; the route must keep answering both with the same 401.
   */
  async getVerificationSecrets(endpointId: string): Promise<WebhookVerificationSecrets> {
    const r = await this.pool.query<{ previous_live: boolean | null; has_previous: boolean | null }>(
      `SELECT (secret_previous_until IS NOT NULL AND secret_previous_until > now()) AS previous_live,
              (secret_previous_until IS NOT NULL)                                  AS has_previous
         FROM conductor_webhook_endpoints WHERE endpoint_id = $1`,
      [endpointId],
    );
    const row = r.rows[0];
    if (!row) return {};
    const current = await this.vault.get(CONDUCTOR_VAULT_AGENT_ID, inboundSecretKey(endpointId));
    if (row.previous_live !== true) {
      // Lapsed, or never rotated. `has_previous` gates the cleanup so the common case
      // takes no lock and writes nothing: this is one write per rotation, not one per
      // request. Best-effort — a failed prune leaves a key the deadline already
      // refuses to accept, so it must never fail the delivery being verified.
      if (row.has_previous === true) await this.pruneLapsedPreviousSecret(endpointId).catch(() => undefined);
      return current === undefined ? {} : { current };
    }
    const previous = await this.vault.get(CONDUCTOR_VAULT_AGENT_ID, inboundPreviousSecretKey(endpointId));
    return {
      ...(current === undefined ? {} : { current }),
      ...(previous === undefined ? {} : { previous }),
    };
  }

  /**
   * Drop a LAPSED grace: NULL the deadline and delete the superseded secret.
   *
   * Two things make this safe against a concurrent rotation (issue #1707 review
   * finding — the previous version deleted the key a rotation had just written):
   * it runs under the secret-lifecycle lock, and it re-checks `<= now()` INSIDE that
   * lock. A rotation that stamped a fresh future deadline while this call waited for
   * the lock therefore fails the predicate, the UPDATE matches no row, and the vault
   * key the rotation just wrote is left alone. The vault delete is conditional on
   * that UPDATE having matched, so the two stores can only ever be cleared together.
   */
  private async pruneLapsedPreviousSecret(endpointId: string): Promise<void> {
    await this.withSecretLifecycleLock(endpointId, async (client) => {
      const r = await client.query(
        `UPDATE conductor_webhook_endpoints SET secret_previous_until = NULL
          WHERE endpoint_id = $1
            AND secret_previous_until IS NOT NULL
            AND secret_previous_until <= now()`,
        [endpointId],
      );
      if ((r.rowCount ?? 0) > 0) {
        await this.vault.deleteKey(CONDUCTOR_VAULT_AGENT_ID, inboundPreviousSecretKey(endpointId));
      }
    });
  }

  /** Run `fn` holding this endpoint's secret-lifecycle advisory lock. The lock is
   *  transaction-scoped, so it is released by the COMMIT/ROLLBACK and cannot leak
   *  past a thrown callback. */
  private async withSecretLifecycleLock<T>(endpointId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SECRET_LIFECYCLE_LOCK_NAMESPACE, endpointId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
    // #1707 — a rotation in grace leaves a second key behind; it must die with the
    // endpoint, or a recreated endpoint id could inherit a live secret.
    await this.vault.deleteKey(CONDUCTOR_VAULT_AGENT_ID, inboundPreviousSecretKey(endpointId));
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
   *      SECOND EXCEPTION (issue #1701): a row whose outcome is in
   *      {@link REDELIVERABLE_OUTCOMES} — today just `'disabled'` — recorded an
   *      attempt that never reached `emit()`, so it is re-claimed the same way, with
   *      no staleness window (nothing was ever in flight). Without this, disabling an
   *      endpoint turns every delivery id a sender tries meanwhile into a permanent
   *      `'duplicate'` and the event is lost even after the endpoint comes back.
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
        const redeliverable = REDELIVERABLE_OUTCOMES.has(existing.outcome);
        if (!abandonedInFlightClaim && !redeliverable) {
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
