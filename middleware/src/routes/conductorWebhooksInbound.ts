/**
 * Issue #437 — inbound Conductor webhooks (`POST /api/hooks/:endpointId`).
 *
 * MOUNTING CONTRACT (the same one every raw-body webhook router carries): this router MUST be mounted
 * BEFORE the global `app.use(express.json(...))`. HMAC verification needs the RAW
 * request bytes; once `express.json` has parsed and re-serialised the body, those
 * bytes are gone and every signature check fails. The router attaches its OWN
 * `express.raw` parser (ANY content type — see the matcher note at the route, 256kb
 * limit) at the route level, so it consumes only this one path. There is NO `requireAuth` — the per-endpoint HMAC signature
 * IS the authentication.
 *
 * `getDeps` is a lazy accessor (not a plain deps object) because this router is
 * mounted early in `index.ts`, before the Conductor subsystem — which owns the
 * endpoint store, secret vault, and event router — is wired further down (the same
 * forward-reference pattern `index.ts` uses for `conductorTemplateRegistrarRef`).
 * By the time a real request arrives the server has finished booting and the
 * accessor always resolves.
 *
 * ORDER OF OPERATIONS is security-critical:
 *   1. The REPLAY WINDOW (issue #1707) — a request whose `X-Webhook-Timestamp` is
 *      malformed or outside the tolerance is refused here, before any endpoint
 *      lookup. The verdict depends only on the header and this server's clock, so it
 *      cannot leak which endpoint ids exist, and a sender whose clock drifted gets a
 *      diagnosable error instead of `bad_signature`.
 *   2. A timestamped delivery must also name its `X-Webhook-Delivery-Id`, because the
 *      timestamped scheme signs it — see REPLAY AND ROTATION below for why omitting
 *      it would reopen the window. Header-only verdict, so it leaks nothing either.
 *   3. Verify the signature, before trusting anything about the endpoint. An unknown
 *      endpoint id and a known endpoint with a wrong signature answer byte-for-byte
 *      the same 401 — the acceptance criterion ("invalid secret returns 401 without
 *      leaking endpoint existence").
 *   4. Atomically CLAIM the delivery id (dedupe) AND enforce the per-endpoint
 *      rolling-window rate limit, before doing any work. A correctly-signed sender
 *      can mint a fresh delivery id on every call, so dedupe alone would not bound
 *      how many workflow runs one endpoint can start — a request over the cap gets
 *      429 and consumes no delivery id (nothing is recorded, so it costs the sender
 *      nothing to retry once the window rolls forward).
 *   5. From there every branch finalizes exactly one outcome — a silent drop is
 *      impossible — and noise (disabled endpoint, malformed JSON, no subscribed
 *      workflow) always answers 2xx so a well-behaved sender's retry policy never
 *      turns an ignorable delivery into a redelivery storm.
 *
 * REPLAY AND ROTATION (issue #1707). Before, an inbound request carried a signature
 * and a delivery id but no timestamp: a captured request stayed valid forever, and
 * only the delivery-id ledger stopped a literal repeat. A sender may now stamp
 * `X-Webhook-Timestamp` (unix seconds) and sign `<timestamp>.<delivery id>.<body>`.
 *
 * BOTH of those headers have to be inside the MAC, and the delivery id is the half
 * that is easy to get wrong (review finding): the ledger is the only thing that stops
 * a repeat, its key is the caller-supplied `X-Webhook-Delivery-Id`, and that header is
 * not secret. Signing only `<timestamp>.<body>` therefore left a live hole — a
 * captured request replayed with a FRESH delivery id passed the signature, passed the
 * tolerance, passed the dedupe, and started a real run on every repeat for the whole
 * tolerance window. Covering the id closes it, which is also why a timestamped
 * request MUST carry one: letting it be omitted would hand the attacker the same hole
 * back (the server mints an id for an unsigned-id request, so every replay would get
 * a fresh one).
 *
 * Senders that predate the header still verify over the bare body —
 * `CONDUCTOR_WEBHOOK_REQUIRE_TIMESTAMP` is what turns that legacy path off and
 * actually closes the window. Independently, a secret rotation keeps the superseded
 * secret valid for its grace window, so rotating no longer 401s the sender's next
 * request.
 *
 * THE KILL SWITCH IS VISIBLE (issue #1707). With `CONDUCTOR_WEBHOOKS_ENABLED=false`
 * every inbound request used to be answered `200 {"outcome":"disabled"}` — senders
 * saw success for deliveries that were never processed or recorded. It is a 503
 * `webhook.inbound_disabled` now: honest and retryable. The boot log states the
 * state, and the admin surface reads it from `GET …/webhooks/posture`.
 *
 * Not every recorded outcome is terminal for dedupe (issue #1701): a delivery refused
 * because the endpoint is disabled is written to the ledger, but it is in the store's
 * `REDELIVERABLE_OUTCOMES`, so `claim()` hands that row out again and the sender's
 * redelivery of the SAME id after the endpoint is enabled actually starts a run
 * instead of being answered `'duplicate'` with the event dropped. The re-claim
 * overwrites the `'disabled'` outcome, so the ledger shows a refusal only while it is
 * still the delivery's latest state.
 */

import crypto from 'node:crypto';

import express, { Router } from 'express';
import type { Request, Response } from 'express';

import type { JsonObject } from '@omadia/conductor-core';
import type {
  WebhookClaimResult,
  WebhookInboundOutcome,
  WebhookVerificationSecrets,
} from '../conductor/webhookEndpointStore.js';
import { generateInboundDeliveryId } from '../conductor/webhookEndpointStore.js';

const RAW_BODY_LIMIT = '256kb';

/** Issue #1707 — the replay window. A sender that stamps this header (unix seconds)
 *  must sign `<timestamp>.<delivery id>.<raw body>` instead of the bare body, which is
 *  what makes both of them un-rewritable: a captured request can neither keep its old
 *  timestamp (outside the tolerance) nor get a fresh one, and it cannot be given a
 *  fresh delivery id either (the HMAC would no longer verify in any of those cases). */
const TIMESTAMP_HEADER = 'x-webhook-timestamp';
const SIGNATURE_HEADER = 'x-webhook-signature';
const DELIVERY_ID_HEADER = 'x-webhook-delivery-id';

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
  /** Issue #1707 — how far an `X-Webhook-Timestamp` may be from this server's clock,
   *  in both directions (`CONDUCTOR_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`). */
  timestampToleranceMs: number;
  /** Issue #1707 — refuse a request that carries NO timestamp at all
   *  (`CONDUCTOR_WEBHOOK_REQUIRE_TIMESTAMP`). Off by default: a sender that predates
   *  the header signs the bare body and must keep working until its operator has
   *  moved it over. Replay protection is only actually CLOSED with this on. */
  requireTimestamp: boolean;
  getEndpoint: (endpointId: string) => Promise<ConductorWebhookInboundEndpoint | null>;
  /** Issue #1707 — the current secret plus, during a rotation grace, the one it
   *  superseded. Replaces the single-secret read: rotation used to 401 the sender's
   *  very next request. */
  getSecrets: (endpointId: string) => Promise<WebhookVerificationSecrets>;
  /** Atomically dedupes AND enforces the per-endpoint rate limit — see
   *  `ConductorWebhookEndpointStore.claim` for the security rationale (issue #437:
   *  a correctly-signed sender can mint a fresh delivery id per call, so dedupe
   *  alone doesn't bound how many runs an endpoint can start). */
  claim: (deliveryId: string, endpointId: string) => Promise<WebhookClaimResult>;
  setOutcome: (deliveryId: string, endpointId: string, outcome: WebhookInboundOutcome) => Promise<void>;
  emit: (eventId: string, payload: JsonObject, source: string) => Promise<ConductorWebhookEmitResult>;
  log?: (msg: string) => void;
}

/** Constant-time signature check over `signedBytes`: `sha256=<hex>`. A missing or
 *  malformed header, or an absent secret (unknown endpoint), fails closed. Length is
 *  guarded before `timingSafeEqual`, which throws on unequal-length buffers. */
function verifySignature(signedBytes: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(signedBytes).digest('hex')}`);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Issue #1707 — WHAT is signed. With no timestamp the signed bytes are the raw body,
 * exactly as before (a pre-#1707 sender keeps verifying). With a timestamp they are
 * `<timestamp>.<delivery id>.<raw body>`, and ONLY that form is accepted for a
 * timestamped request: if the bare-body signature also verified, an attacker could
 * take a captured request, stamp a fresh timestamp over it and replay it forever — the
 * stamp has to be inside the MAC to bound anything, and so does the delivery id, which
 * is the ledger key that stops the repeat.
 */
function signedBytesFor(timestamp: string | undefined, deliveryId: string, rawBody: Buffer): Buffer {
  return timestamp === undefined
    ? rawBody
    : Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`, 'utf8'), rawBody]);
}

/** Try the current secret, then the one a rotation superseded while its grace is still
 *  open (issue #1707). Both candidates go through the same constant-time compare, and
 *  the answer is a plain boolean — which secret matched is never reported. */
function verifyAgainstSecrets(signedBytes: Buffer, header: string | undefined, secrets: WebhookVerificationSecrets): boolean {
  const current = verifySignature(signedBytes, header, secrets.current);
  const previous = verifySignature(signedBytes, header, secrets.previous);
  return current || previous;
}

export type TimestampCheck = 'ok' | 'absent' | 'malformed' | 'outside_window';

/**
 * Validate the replay window. Endpoint-INDEPENDENT on purpose: it runs before any
 * endpoint lookup, so refusing a stale request cannot distinguish a real endpoint id
 * from a made-up one, and a sender with a skewed clock gets an error it can act on
 * instead of an undifferentiated `bad_signature`.
 *
 * Seconds, not milliseconds (the de-facto convention for this header), and the
 * tolerance applies in BOTH directions — a sender whose clock runs fast is as
 * suspect as a replay from the past, and a far-future stamp would otherwise be a
 * capture that stays valid until that time arrives.
 */
export function checkTimestamp(header: string | undefined, toleranceMs: number, now = Date.now()): TimestampCheck {
  if (header === undefined || header.trim() === '') return 'absent';
  const raw = header.trim();
  if (!/^\d{1,15}$/.test(raw)) return 'malformed';
  const skewMs = Math.abs(now - Number(raw) * 1000);
  return skewMs <= toleranceMs ? 'ok' : 'outside_window';
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
    // The content-type matcher is a FUNCTION, not `'*/*'`, and that is load-bearing
    // (issue #1700). A string matcher goes through `type-is`, which needs a media type
    // to compare against: a request with NO `content-type` header — or an empty one —
    // matches nothing, not even `'*/*'`. body-parser then skips parsing, `req.body`
    // stays Express's default `{}`, the `Buffer.isBuffer` fallback in `handle()` HMACs
    // `Buffer.alloc(0)`, and a CORRECTLY signed delivery answers 401
    // `webhook.bad_signature` — the sender gets pointed at its signing code when the
    // real cause is a missing header. A function matcher skips the type check
    // altogether, which is the only shape that keeps verification independent of the
    // sender's content type: an HMAC is over bytes, not over a media type. A request
    // with no body at all (no `content-length`/`transfer-encoding`) still skips the
    // parser via body-parser's own `hasBody` guard, and `Buffer.alloc(0)` is then the
    // correct raw byte string for it, so signing `''` keeps verifying.
    express.raw({ type: () => true, limit: RAW_BODY_LIMIT }),
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
  //
  // 503, not 200 (issue #1707): answering `200 {"outcome":"disabled"}` told every
  // sender — unsigned, wrong secret, made-up endpoint id alike — that its delivery
  // had been accepted, while nothing was processed and nothing was recorded. A
  // sender's retry policy saw success and dropped the event. 503 is the honest
  // answer and the retryable one: the delivery comes back when the switch is on.
  if (!deps.enabled) {
    res.status(503).json({ code: 'webhook.inbound_disabled' });
    return;
  }

  const endpointId = paramStr(req.params.endpointId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // 1. Replay window FIRST (issue #1707), before any endpoint lookup — the verdict
  //    depends only on the header and this server's clock, so it leaks nothing about
  //    which endpoint ids exist, and a sender with a broken clock or a missing header
  //    gets an error it can act on rather than `bad_signature`.
  const timestampHeader = req.header(TIMESTAMP_HEADER);
  const timestamp = checkTimestamp(timestampHeader, deps.timestampToleranceMs);
  if (timestamp === 'malformed' || timestamp === 'outside_window') {
    res.status(401).json({ code: 'webhook.stale_timestamp' });
    return;
  }
  if (timestamp === 'absent' && deps.requireTimestamp) {
    res.status(401).json({ code: 'webhook.timestamp_required' });
    return;
  }

  // 2. A timestamped delivery MUST name its delivery id, because the timestamped
  //    scheme signs it (see `signedBytesFor`). Without this the replay window would
  //    still be open: the server mints an id for a caller that sends none, so an
  //    attacker could strip the header and every replay of one captured request would
  //    get a fresh ledger key. Header-only verdict, so it leaks no endpoint existence.
  const deliveryIdHeader = req.header(DELIVERY_ID_HEADER)?.trim();
  if (timestamp === 'ok' && !deliveryIdHeader) {
    res.status(401).json({ code: 'webhook.delivery_id_required' });
    return;
  }
  // A caller that sends no id gets a server-minted one — no dedupe, but no silent
  // drop either. That is the legacy (un-timestamped) path only; the branch above has
  // already refused a timestamped request without one.
  const deliveryId = deliveryIdHeader || generateInboundDeliveryId();

  // Only a VALIDATED timestamp enters the signed bytes. An absent one keeps the
  // legacy bare-body scheme; a malformed/stale one never gets here.
  const signedBytes = signedBytesFor(timestamp === 'ok' ? timestampHeader?.trim() : undefined, deliveryId, raw);

  // 3. Signature — before trusting anything about the endpoint. A missing endpoint
  //    (getSecrets resolves `{}`) fails verification the same way a wrong secret
  //    would, so both answer the identical 401 below. During a rotation grace the
  //    superseded secret verifies too (issue #1707) — rotation is no longer an
  //    instant outage for the sender.
  const endpoint = endpointId ? await deps.getEndpoint(endpointId) : null;
  const secrets = endpoint ? await deps.getSecrets(endpointId) : {};
  if (!verifyAgainstSecrets(signedBytes, req.header(SIGNATURE_HEADER), secrets)) {
    res.status(401).json({ code: 'webhook.bad_signature' });
    return;
  }
  // endpoint is non-null here: verification only succeeds with a real secret, which
  // only `getSecrets` for a real endpoint can supply.
  const ep = endpoint!;

  // 4. Atomically claim the delivery id (dedupe) AND enforce the per-endpoint rate
  //    limit, in one call. A caller that sends X-Webhook-Delivery-Id gets true
  //    idempotency; one that doesn't gets a fresh id every call (no dedupe, but
  //    still logged — never a silent drop, unless it's rate-limited, in which case
  //    nothing is recorded at all — see the store's claim() doc comment).
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
