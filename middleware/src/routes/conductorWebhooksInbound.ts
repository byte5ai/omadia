/**
 * Issue #437 — inbound Conductor webhooks (`POST /api/hooks/:endpointId`).
 *
 * MOUNTING CONTRACT (mirrors `devplatform/routes/devWebhooks.ts`): this router MUST be mounted
 * BEFORE the global `app.use(express.json(...))`. HMAC verification needs the RAW
 * request bytes; once `express.json` has parsed and re-serialised the body, those
 * bytes are gone and every signature check fails. The router attaches its OWN
 * `express.raw` parser (type any, 256kb limit) at the route level, so it consumes
 * only this one path. There is NO `requireAuth` — the per-endpoint HMAC signature
 * IS the authentication.
 *
 * `getDeps` is a lazy accessor (not a plain deps object) because this router is
 * mounted early in `index.ts`, before the Conductor subsystem — which owns the
 * endpoint store, secret vault, and event router — is wired further down (the same
 * forward-reference pattern `index.ts` uses for `conductorTemplateRegistrarRef`).
 * By the time a real request arrives the server has finished booting and the
 * accessor always resolves.
 *
 * ORDER OF OPERATIONS is security-critical, same as devWebhooks:
 *   1. Verify the signature FIRST, before trusting anything about the endpoint.
 *      An unknown endpoint id and a known endpoint with a wrong signature answer
 *      byte-for-byte the same 401 — the acceptance criterion ("invalid secret
 *      returns 401 without leaking endpoint existence").
 *   2. Atomically CLAIM the delivery id (dedupe) AND enforce the per-endpoint
 *      rolling-window rate limit, before doing any work. A correctly-signed sender
 *      can mint a fresh delivery id on every call, so dedupe alone would not bound
 *      how many workflow runs one endpoint can start — a request over the cap gets
 *      429 and consumes no delivery id (nothing is recorded, so it costs the sender
 *      nothing to retry once the window rolls forward).
 *   3. From there every branch finalizes exactly one terminal outcome — a silent
 *      drop is impossible — and noise (disabled endpoint, malformed JSON, no
 *      subscribed workflow) always answers 2xx so a well-behaved sender's retry
 *      policy never turns an ignorable delivery into a redelivery storm.
 */

import crypto from 'node:crypto';

import express, { Router } from 'express';
import type { Request, Response } from 'express';

import type { JsonObject } from '@omadia/conductor-core';
import type { WebhookClaimResult, WebhookInboundOutcome } from '../conductor/webhookEndpointStore.js';
import { generateInboundDeliveryId } from '../conductor/webhookEndpointStore.js';

const RAW_BODY_LIMIT = '256kb';

export interface ConductorWebhookInboundEndpoint {
  eventId: string;
  enabled: boolean;
}

export interface ConductorWebhookEmitResult {
  startedRuns: Array<{ workflowSlug: string; runId: string }>;
}

export interface ConductorWebhookInboundDeps {
  /** Global kill switch (`CONDUCTOR_WEBHOOKS_ENABLED`). */
  enabled: boolean;
  getEndpoint: (endpointId: string) => Promise<ConductorWebhookInboundEndpoint | null>;
  getSecret: (endpointId: string) => Promise<string | undefined>;
  /** Atomically dedupes AND enforces the per-endpoint rate limit — see
   *  `ConductorWebhookEndpointStore.claim` for the security rationale (issue #437:
   *  a correctly-signed sender can mint a fresh delivery id per call, so dedupe
   *  alone doesn't bound how many runs an endpoint can start). */
  claim: (deliveryId: string, endpointId: string) => Promise<WebhookClaimResult>;
  setOutcome: (deliveryId: string, endpointId: string, outcome: WebhookInboundOutcome) => Promise<void>;
  emit: (eventId: string, payload: JsonObject, source: string) => Promise<ConductorWebhookEmitResult>;
  log?: (msg: string) => void;
}

/** Constant-time signature check over the RAW body: `sha256=<hex>`. A missing or
 *  malformed header, or an absent secret (unknown endpoint), fails closed. Length is
 *  guarded before `timingSafeEqual`, which throws on unequal-length buffers. */
function verifySignature(rawBody: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function paramStr(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

export function createConductorWebhooksInboundRouter(getDeps: () => ConductorWebhookInboundDeps | undefined): Router {
  const router = Router();

  router.post(
    '/api/hooks/:endpointId',
    express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }),
    (req: Request, res: Response) => {
      void handle(getDeps, req, res).catch((err: unknown) => {
        getDeps()?.log?.(`[conductor] webhook inbound handler error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.status(500).json({ code: 'webhook.internal' });
      });
    },
  );

  return router;
}

async function handle(getDeps: () => ConductorWebhookInboundDeps | undefined, req: Request, res: Response): Promise<void> {
  const deps = getDeps();
  if (!deps) {
    res.status(503).json({ code: 'webhook.not_ready' });
    return;
  }

  // Global kill switch — checked before any endpoint lookup, so it never
  // distinguishes a real endpoint id from a made-up one.
  if (!deps.enabled) {
    res.status(200).json({ ok: true, outcome: 'disabled' });
    return;
  }

  const endpointId = paramStr(req.params.endpointId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // 1. Signature FIRST — before trusting anything about the endpoint. A missing
  //    endpoint (getSecret resolves undefined) fails verifySignature the same way
  //    a wrong secret would, so both answer the identical 401 below.
  const endpoint = endpointId ? await deps.getEndpoint(endpointId) : null;
  const secret = endpoint ? await deps.getSecret(endpointId) : undefined;
  if (!verifySignature(raw, req.header('x-webhook-signature'), secret)) {
    res.status(401).json({ code: 'webhook.bad_signature' });
    return;
  }
  // endpoint is non-null here: verifySignature only succeeds with a real secret,
  // which only `getSecret` for a real endpoint can supply.
  const ep = endpoint!;

  // 2. Atomically claim the delivery id (dedupe) AND enforce the per-endpoint rate
  //    limit, in one call. A caller that sends X-Webhook-Delivery-Id gets true
  //    idempotency; one that doesn't gets a fresh id every call (no dedupe, but
  //    still logged — never a silent drop, unless it's rate-limited, in which case
  //    nothing is recorded at all — see the store's claim() doc comment).
  const deliveryId = req.header('x-webhook-delivery-id') || generateInboundDeliveryId();
  const claimResult = await deps.claim(deliveryId, endpointId);
  if (claimResult === 'rate_limited') {
    res.status(429).json({ code: 'webhook.rate_limited' });
    return;
  }
  if (claimResult === 'duplicate') {
    res.status(200).json({ ok: true, outcome: 'duplicate' });
    return;
  }

  // From here we own the row: every branch finalizes exactly one outcome.
  const finish = async (outcome: WebhookInboundOutcome, status = 200, extra: Record<string, unknown> = {}): Promise<void> => {
    await deps.setOutcome(deliveryId, endpointId, outcome);
    if (!res.headersSent) res.status(status).json({ ok: true, outcome, ...extra });
  };

  if (!ep.enabled) {
    await finish('disabled');
    return;
  }

  let payload: JsonObject;
  try {
    const parsed: unknown = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
    payload = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch {
    await finish('invalid_payload');
    return;
  }

  const result = await deps.emit(ep.eventId, payload, `webhook:${endpointId}`);
  if (result.startedRuns.length === 0) {
    await finish('no_subscribers');
    return;
  }
  await finish('started', 202, { startedRuns: result.startedRuns.length });
}
