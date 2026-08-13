// Issue #437 — operator-facing webhook admin routes, registered by createConductorRouter
// BEFORE its '/:slug' catch-all (split out of routes.ts purely for file size, same
// convention as templateRoutes.ts). Covers both inbound endpoints (the
// `/api/hooks/:endpointId` unauthenticated route reads them) and outbound
// subscriptions (the run-lifecycle dispatcher reads them). A created/rotated secret
// is returned to the caller EXACTLY ONCE — never again, and never in a list/get
// response — mirroring the GitHub App secret UX this store is modeled on.

import type { Request, Response, Router } from 'express';

import type { JsonObject } from '@omadia/conductor-core';
import type { ConductorRouterDeps } from './routes.js';
import type { ConductorWebhookEndpoint } from './webhookEndpointStore.js';

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

/** Review finding (issue #437): the operator UI must display the inbound endpoint URL
 *  it can actually reach — computed here from the middleware's own configured base
 *  URL, never from the browser's origin. `baseUrl` absent (no config wired) omits the
 *  field rather than guessing; the admin UI falls back to a relative path in that case. */
function withInboundUrl(endpoint: ConductorWebhookEndpoint, baseUrl: string | undefined): ConductorWebhookEndpoint & { inboundUrl?: string } {
  return baseUrl ? { ...endpoint, inboundUrl: `${baseUrl.replace(/\/+$/, '')}/api/hooks/${endpoint.endpointId}` } : endpoint;
}

export function registerWebhookRoutes(router: Router, deps: ConductorRouterDeps): void {
  const creatorOf = (req: Request): string => req.session?.sub ?? 'operator';

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
      // secret is returned ONCE — the operator must copy it now.
      res.status(201).json({ endpoint: withInboundUrl(endpoint, deps.webhookInboundBaseUrl), secret });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_endpoint_create_failed', message: errMsg(err) });
    }
  });

  router.post('/webhooks/endpoints/:endpointId/rotate-secret', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookEndpoints) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const endpointId = paramStr(req.params.endpointId);
    try {
      const existing = await deps.webhookEndpoints.get(endpointId);
      if (!existing) {
        res.status(404).json({ code: 'conductor.not_found', message: 'endpoint not found' });
        return;
      }
      const secret = await deps.webhookEndpoints.rotateSecret(endpointId);
      res.json({ secret });
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
    try {
      await deps.webhookEndpoints.setEnabled(paramStr(req.params.endpointId), enabled);
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
    try {
      await deps.webhookEndpoints.delete(paramStr(req.params.endpointId));
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
      });
      // secret is returned ONCE — the receiver must be configured with it now.
      res.status(201).json({ subscription, secret });
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_subscription_create_failed', message: errMsg(err) });
    }
  });

  router.post('/webhooks/subscriptions/:id/rotate-secret', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    const id = paramStr(req.params.id);
    try {
      const existing = await deps.webhookSubscriptions.get(id);
      if (!existing) {
        res.status(404).json({ code: 'conductor.not_found', message: 'subscription not found' });
        return;
      }
      const secret = await deps.webhookSubscriptions.rotateSecret(id);
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
    try {
      await deps.webhookSubscriptions.setEnabled(paramStr(req.params.id), enabled);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.webhook_status_failed', message: errMsg(err) });
    }
  });

  router.delete('/webhooks/subscriptions/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deps.webhookSubscriptions) {
      res.status(503).json({ code: 'conductor.webhooks_unavailable', message: 'webhooks are not wired' });
      return;
    }
    try {
      await deps.webhookSubscriptions.delete(paramStr(req.params.id));
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
