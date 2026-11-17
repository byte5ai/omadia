// Issue #437 — operator-facing webhook admin routes, registered by createConductorRouter
// BEFORE its '/:slug' catch-all (split out of routes.ts purely for file size, same
// convention as templateRoutes.ts). Covers both inbound endpoints (the
// `/api/hooks/:endpointId` unauthenticated route reads them) and outbound
// subscriptions (the run-lifecycle dispatcher reads them). A created/rotated secret
// is returned to the caller EXACTLY ONCE — never again, and never in a list/get
// response — mirroring the GitHub App secret UX this store is modeled on.
//
// Issue #1707 added three things to every mutation here:
//   - an `admin_audit` row (`deps.auditWebhookChange`). Creating, rotating, disabling
//     and deleting these objects decides what may start a workflow run and where run
//     data goes; none of it was recorded before. Best-effort at the call site: an
//     audit-write failure is logged loudly but never fails the mutation the operator
//     already performed.
//   - `GET /webhooks/posture` — the kill switch and the hardening windows, so the
//     admin UI can SHOW that inbound webhooks are off instead of leaving the operator
//     to infer it from senders that silently see success.
//   - the subscription payload scope (`includeContext`), the opt-in that decides
//     whether a delivery carries the run's step results at all.

import type { Request, Response, Router } from 'express';

import type { JsonObject } from '@omadia/conductor-core';
import { auditActorFromRequest } from '../auth/adminAuditLog.js';
import type { WebhookAuditChange } from '../auth/adminAuditLog.js';
import type { ConductorRouterDeps } from './routes.js';
import type { ConductorWebhookEndpoint } from './webhookEndpointStore.js';

/**
 * #1707 — the operator-visible state of the webhook surface, served verbatim by
 * `GET /webhooks/posture`. A real type rather than a bag of JSON (review finding):
 * `wireConductor` builds the literal and the admin UI mirrors the same shape, and an
 * untyped `JsonObject` in between let the two drift silently.
 *
 * `configured: false` means this server has no Conductor wiring at all (no Postgres),
 * which is also "webhooks are off" — for a different reason than the kill switch.
 */
export interface ConductorWebhookPosture {
  configured: boolean;
  inboundEnabled: boolean;
  requireTimestamp?: boolean;
  timestampToleranceSeconds?: number;
  secretGraceSeconds?: number;
  maxInboundDeliveriesPerMinute?: number;
  payloadRetentionDays?: number;
  deliveryRetentionDays?: number;
  contextOptIn?: boolean;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObject(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}

function paramStr(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

/**
 * Load the row a mutation targets, answering 404 when it is gone. `undefined` means
 * this helper has already answered and the caller must just return.
 *
 * Extracted because five routes need the identical guard (review finding: the
 * read-then-404 block was written out five times). Deliberately NOT a
 * load-mutate-audit wrapper: what each route reads, writes and records differs, and
 * flattening that into one generic helper hides the part worth reading.
 *
 * No `.catch` anywhere near it: a failed read must surface as a 500 before anything
 * is mutated, never degrade into "the row does not exist".
 */
async function loadOr404<T>(res: Response, load: () => Promise<T | null>, missing: string): Promise<T | undefined> {
  const row = await load();
  if (row) return row;
  res.status(404).json({ code: 'conductor.not_found', message: missing });
  return undefined;
}

/** A `?flag=true` query parameter. Only the literal `true` counts — a query value is
 *  caller-controlled and can be an array or a nested object, and none of those shapes
 *  may be read as an opt-in to the immediate (outage-causing) rotation. */
function queryFlag(req: Request, name: string): boolean {
  return req.query[name] === 'true';
}

/** Review finding (issue #437): the operator UI must display the inbound endpoint URL
 *  it can actually reach — computed here from the middleware's own configured base
 *  URL, never from the browser's origin. `baseUrl` absent (no config wired) omits the
 *  field rather than guessing; the admin UI falls back to a relative path in that case. */
function withInboundUrl(endpoint: ConductorWebhookEndpoint, baseUrl: string | undefined): ConductorWebhookEndpoint & { inboundUrl?: string } {
  return baseUrl ? { ...endpoint, inboundUrl: `${baseUrl.replace(/\/+$/, '')}/api/hooks/${endpoint.endpointId}` } : endpoint;
}

export function registerWebhookRoutes(router: Router, deps: ConductorRouterDeps): void {
  const creatorOf = (req: Request): string => req.session?.sub ?? 'operator';
  /** The label that reaches the free-text `admin_audit.actor_email`. Email FIRST,
   *  like `auditRoleChange` and like `webhookChangeAuditEntry`'s own contract says —
   *  an Entra `sub` is a guid, and a trail column named actor_email holding a guid is
   *  unreadable to the operator who has to answer "who disabled this?" (review
   *  finding). `creatorOf` above stays the SUB, because it feeds the `created_by`
   *  metadata column whose existing values are subs. */
  const auditActorOf = (req: Request): string => req.session?.email ?? req.session?.sub ?? 'operator';

  /** #1707 — one audit write, never able to fail the mutation it describes. The
   *  mutation has already happened when this runs; refusing the operator a 204
   *  because the trail write failed would be strictly worse than a loud log line. */
  const audit = async (req: Request, entry: WebhookAuditChange): Promise<void> => {
    if (!deps.auditWebhookChange) return;
    // #775 lesson — the sub is an email under local auth and must never land in the
    // uuid `admin_audit.actor_id`; the uuid rides separately when the session has one.
    const actorUserId = auditActorFromRequest(req).id;
    try {
      await deps.auditWebhookChange({
        ...entry,
        actor: auditActorOf(req),
        ...(actorUserId === undefined ? {} : { actorUserId }),
      });
    } catch (err) {
      console.error('[conductor] webhook audit write failed:', err);
    }
  };

  // ── posture (issue #1707) ─────────────────────────────────────────────────

  /**
   * The operator-visible state of the webhook surface: is the inbound route live at
   * all, and which hardening windows are in force. Reported even when the stores are
   * absent — "webhooks are off" is exactly the answer this route exists to give, and
   * a 503 here would be indistinguishable from the kill switch being on.
   */
  router.get('/webhooks/posture', (_req: Request, res: Response): void => {
    res.json({
      posture: deps.webhookPosture ?? { inboundEnabled: false, configured: false },
    });
  });

  // ── inbound endpoints ─────────────────────────────────────────────────────

  router.get('/webhooks/endpoints', async (_req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    try {
      const endpoints = await deps.webhookEndpoints.list();
      res.json({ endpoints: endpoints.map((ep) => withInboundUrl(ep, deps.webhookInboundBaseUrl)) });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_endpoints_failed', message: errMsg(err) });
    }
  });

  router.post('/webhooks/endpoints', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const body = asObject(req.body);
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    if (!eventId) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'eventId is required' });
      return;
    }
    try {
      const { endpoint, secret } = await deps.webhookEndpoints.create({
        eventId,
        description: typeof body.description === 'string' ? body.description : null,
        createdBy: creatorOf(req),
      });
      // `after` carries the routing decision (which event this endpoint can emit),
      // never the secret that was just minted.
      await audit(req, { kind: 'endpoint', change: 'create', id: endpoint.endpointId, after: { eventId, enabled: endpoint.enabled } });
      // secret is returned ONCE — the operator must copy it now.
      res.status(201).json({ endpoint: withInboundUrl(endpoint, deps.webhookInboundBaseUrl), secret });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_endpoint_create_failed', message: errMsg(err) });
    }
  });

  /**
   * Rotate with a grace window (issue #1707). `deps.webhookSecretGraceMs` keeps the
   * superseded secret valid for that long, so the sender can be reconfigured without
   * an outage — before this, the old secret 401'd on the very next request.
   *
   * `?immediate=true` opts out and cuts over instantly, which is the right answer for
   * the one case that needs it: rotating BECAUSE the secret leaked. The store then
   * deletes the old key rather than storing it, so a leaked secret is not parked in
   * the vault for the length of the grace.
   */
  router.post('/webhooks/endpoints/:endpointId/rotate-secret', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const endpointId = paramStr(req.params.endpointId);
    const graceMs = queryFlag(req, 'immediate') ? 0 : (deps.webhookSecretGraceMs ?? 0);
    try {
      if (!(await loadOr404(res, () => deps.webhookEndpoints!.get(endpointId), 'endpoint not found'))) return;
      const secret = await deps.webhookEndpoints.rotateSecret(endpointId, graceMs);
      const updated = await deps.webhookEndpoints.get(endpointId).catch(() => null);
      await audit(req, {
        kind: 'endpoint',
        change: 'rotate_secret',
        id: endpointId,
        after: { graceSeconds: Math.round(graceMs / 1000), previousSecretValidUntil: updated?.secretPreviousUntil ?? null },
      });
      res.json({ secret, previousSecretValidUntil: updated?.secretPreviousUntil ?? null });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_rotate_failed', message: errMsg(err) });
    }
  });

  router.post('/webhooks/endpoints/:endpointId/status', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const enabled = asObject(req.body).enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'enabled must be a boolean' });
      return;
    }
    const endpointId = paramStr(req.params.endpointId);
    try {
      // Read before the write (#1707 review finding): an unknown id used to answer
      // 204 and still write an audit row, so the trail claimed a state change that
      // never happened.
      const before = await loadOr404(res, () => deps.webhookEndpoints!.get(endpointId), 'endpoint not found');
      if (!before) return;
      await deps.webhookEndpoints.setEnabled(endpointId, enabled);
      await audit(req, {
        kind: 'endpoint',
        change: 'status',
        id: endpointId,
        before: { enabled: before.enabled },
        after: { enabled },
      });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_status_failed', message: errMsg(err) });
    }
  });

  router.delete('/webhooks/endpoints/:endpointId', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const endpointId = paramStr(req.params.endpointId);
    try {
      // Read before the DELETE: afterwards there is nothing left to describe what the
      // trail entry is about, and "an endpoint was deleted" alone is not an answer.
      // No `.catch` — a failed read must not degrade into an audit row with no before
      // state; it 500s before anything is deleted.
      const before = await deps.webhookEndpoints.get(endpointId);
      // DELETE stays idempotent (204 for an id that is already gone) — but the call
      // still runs, because it also clears vault keys a partial write may have left
      // behind. Only the AUDIT is skipped: a row for a delete that deleted nothing
      // would be a trail entry for a no-op (#1707 review finding).
      await deps.webhookEndpoints.delete(endpointId);
      if (before) {
        await audit(req, {
          kind: 'endpoint',
          change: 'delete',
          id: endpointId,
          before: { eventId: before.eventId, enabled: before.enabled },
        });
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_delete_failed', message: errMsg(err) });
    }
  });

  router.get('/webhooks/endpoints/:endpointId/deliveries', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    try {
      res.json({ deliveries: await deps.webhookEndpoints.listDeliveries(paramStr(req.params.endpointId)) });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_deliveries_failed', message: errMsg(err) });
    }
  });

  // ── outbound subscriptions ────────────────────────────────────────────────

  router.get('/webhooks/subscriptions', async (_req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    try {
      res.json({ subscriptions: await deps.webhookSubscriptions.list() });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_subscriptions_failed', message: errMsg(err) });
    }
  });

  router.post('/webhooks/subscriptions', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const body = asObject(req.body);
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const event = typeof body.event === 'string' ? body.event.trim() : '';
    if (!url || !event) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'url and event are required' });
      return;
    }
    // #1707 — absent or non-boolean means NO context. The opt-in has to be explicit:
    // a typo'd field must not quietly send step results to an external receiver.
    const includeContext = body.includeContext === true;
    try {
      deps.assertOutboundUrlAllowed?.(url);
    } catch (err) {
      res.status(400).json({ code: 'conductor.webhook_url_forbidden', message: errMsg(err) });
      return;
    }
    try {
      const { subscription, secret } = await deps.webhookSubscriptions.create({
        url,
        event,
        description: typeof body.description === 'string' ? body.description : null,
        createdBy: creatorOf(req),
        includeContext,
      });
      await audit(req, {
        kind: 'subscription',
        change: 'create',
        id: subscription.id,
        after: { url, event, enabled: subscription.enabled, includeContext: subscription.includeContext },
      });
      // secret is returned ONCE — the receiver must be configured with it now.
      res.status(201).json({ subscription, secret });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_subscription_create_failed', message: errMsg(err) });
    }
  });

  /** No grace window here, unlike the inbound endpoint: WE are the sender for an
   *  outbound delivery, so only one secret is ever used to sign. Overlapping validity
   *  is the receiver's side of the contract — it has to accept both secrets while it
   *  is being reconfigured. The audit row is what tells the operator when to expect
   *  that receiver's verification to start failing. */
  router.post('/webhooks/subscriptions/:id/rotate-secret', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const id = paramStr(req.params.id);
    try {
      const existing = await loadOr404(res, () => deps.webhookSubscriptions!.get(id), 'subscription not found');
      if (!existing) return;
      const secret = await deps.webhookSubscriptions.rotateSecret(id);
      await audit(req, { kind: 'subscription', change: 'rotate_secret', id, after: { url: existing.url } });
      res.json({ secret });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_rotate_failed', message: errMsg(err) });
    }
  });

  router.post('/webhooks/subscriptions/:id/status', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const enabled = asObject(req.body).enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'enabled must be a boolean' });
      return;
    }
    const id = paramStr(req.params.id);
    try {
      // Same as the endpoint status route: 404 an unknown id instead of auditing a
      // state change that never happened.
      const before = await loadOr404(res, () => deps.webhookSubscriptions!.get(id), 'subscription not found');
      if (!before) return;
      await deps.webhookSubscriptions.setEnabled(id, enabled);
      await audit(req, {
        kind: 'subscription',
        change: 'status',
        id,
        before: { enabled: before.enabled },
        after: { enabled },
      });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_status_failed', message: errMsg(err) });
    }
  });

  /**
   * #1707 — the run-context opt-in. Its own route, and its own audit action, because
   * switching it ON is the decision that sends every step result — including the free
   * text a human typed into an approval — to an external receiver. Takes effect on the
   * next delivery; payloads already stored are left to the retention sweep.
   */
  router.post('/webhooks/subscriptions/:id/payload-scope', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const includeContext = asObject(req.body).includeContext;
    if (typeof includeContext !== 'boolean') {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'includeContext must be a boolean' });
      return;
    }
    const id = paramStr(req.params.id);
    try {
      const before = await loadOr404(res, () => deps.webhookSubscriptions!.get(id), 'subscription not found');
      if (!before) return;
      await deps.webhookSubscriptions.setIncludeContext(id, includeContext);
      await audit(req, {
        kind: 'subscription',
        change: 'payload_scope',
        id,
        before: { includeContext: before.includeContext },
        after: { includeContext },
      });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_payload_scope_failed', message: errMsg(err) });
    }
  });

  router.delete('/webhooks/subscriptions/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const id = paramStr(req.params.id);
    try {
      const before = await deps.webhookSubscriptions.get(id);
      // Idempotent like the endpoint delete, and for the same reason the call still
      // runs on a missing row (vault-key cleanup); only the audit row is skipped.
      await deps.webhookSubscriptions.delete(id);
      if (before) {
        await audit(req, {
          kind: 'subscription',
          change: 'delete',
          id,
          before: { url: before.url, event: before.event, enabled: before.enabled },
        });
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_delete_failed', message: errMsg(err) });
    }
  });

  router.get('/webhooks/subscriptions/:id/deliveries', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    try {
      res.json({ deliveries: await deps.webhookSubscriptions.listForSubscription(paramStr(req.params.id)) });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_deliveries_failed', message: errMsg(err) });
    }
  });
}
