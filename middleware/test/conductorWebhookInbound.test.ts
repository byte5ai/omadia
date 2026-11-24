import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import {
  createConductorWebhooksInboundRouter,
  type ConductorWebhookInboundDeps,
  type ConductorWebhookEmitResult,
  type ConductorWebhookInboundEndpoint,
} from '../src/routes/conductorWebhooksInbound.js';
import type { WebhookClaimResult, WebhookInboundOutcome } from '../src/conductor/webhookEndpointStore.js';
import { REDELIVERABLE_OUTCOMES } from '../src/conductor/webhookEndpointStore.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

// Issue #1707 extends the same suite: the kill switch answers 503 instead of a
// 200 that told every sender its delivery had been accepted; a request may carry
// `X-Webhook-Timestamp` and then MUST sign `<timestamp>.<body>` (so the stamp can be
// neither kept nor rewritten); and the secret a rotation superseded still verifies
// while its grace window is open.
//
// Issue #437 — inbound Conductor webhook route: signature-first verification
// (unknown endpoint and wrong secret must answer byte-for-byte the same 401),
// atomic delivery-id dedupe scoped per endpoint, a per-endpoint rate limit, a
// terminal outcome recorded for every claimed delivery, and 2xx-on-noise so a
// sender's retry policy never turns an ignorable delivery into a redelivery storm.

const SECRET = 'whsec_unit_test_secret';
/** #1707 — what a rotation left behind; valid only while the grace window is open. */
const PREVIOUS_SECRET = 'whsec_unit_test_previous';
const ENDPOINT_ID = 'ep-1';

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** #1707 — the timestamped scheme: the HMAC covers `<timestamp>.<delivery id>.<body>`. */
function signTimestamped(secret: string, timestamp: string, deliveryId: string, body: string): string {
  return sign(secret, `${timestamp}.${deliveryId}.${body}`);
}

function unixNow(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

interface Harness {
  base: string;
  /** The single known endpoint, by reference — mutate `enabled` mid-test to model an
   *  operator flipping the endpoint off and on again (issue #1701). */
  endpoint: ConductorWebhookInboundEndpoint;
  outcomes: Map<string, WebhookInboundOutcome>;
  emitCalls: Array<{ eventId: string; source: string }>;
  close: () => Promise<void>;
}

async function harness(
  over: Partial<ConductorWebhookInboundDeps> = {},
  opts: { rateLimit?: number; jsonParserFirst?: boolean; endpointEnabled?: boolean; graceSecret?: boolean } = {},
): Promise<Harness> {
  // Keyed `${endpointId}::${deliveryId}` — mirrors the store's composite PK scoping
  // (finding: a global key would misread endpoint B's id '1' as a dupe of A's). The
  // VALUE is the row's recorded outcome, because the real claim() decides duplicate
  // vs. re-claim from it — and this fake asks the PRODUCTION set (not a hand-copied
  // list), so adding an outcome to REDELIVERABLE_OUTCOMES cannot leave this harness
  // quietly asserting the old behaviour.
  const ledger = new Map<string, WebhookInboundOutcome>();
  const perEndpointCount = new Map<string, number>();
  const outcomes = new Map<string, WebhookInboundOutcome>();
  const emitCalls: Array<{ eventId: string; source: string }> = [];
  const rateLimit = opts.rateLimit ?? Number.POSITIVE_INFINITY;
  const endpoint: ConductorWebhookInboundEndpoint = {
    eventId: 'orders.created',
    enabled: opts.endpointEnabled ?? true,
  };

  const deps: ConductorWebhookInboundDeps = {
    enabled: true,
    timestampToleranceMs: 300_000,
    requireTimestamp: false,
    getEndpoint: async (endpointId) => (endpointId === ENDPOINT_ID ? endpoint : null),
    getSecrets: async (endpointId) =>
      endpointId === ENDPOINT_ID ? { current: SECRET, ...(opts.graceSecret === true ? { previous: PREVIOUS_SECRET } : {}) } : {},
    claim: async (deliveryId, endpointId): Promise<WebhookClaimResult> => {
      // Dedupe BEFORE the rate check — a redelivery of an id already claimed by
      // this endpoint must never be misreported as rate-limited just because the
      // endpoint is currently busy with other (unique) deliveries.
      const key = `${endpointId}::${deliveryId}`;
      const recorded = ledger.get(key);
      // Issue #1701: a row whose outcome never reached emit() does not consume the
      // delivery id — the store re-claims it instead of answering 'duplicate'.
      if (recorded !== undefined && !REDELIVERABLE_OUTCOMES.has(recorded)) return 'duplicate';
      if (recorded === undefined) {
        const count = perEndpointCount.get(endpointId) ?? 0;
        if (count >= rateLimit) return 'rate_limited';
        perEndpointCount.set(endpointId, count + 1);
      }
      ledger.set(key, 'received');
      return 'claimed';
    },
    setOutcome: async (deliveryId, endpointId, outcome) => {
      outcomes.set(deliveryId, outcome);
      ledger.set(`${endpointId}::${deliveryId}`, outcome);
    },
    emit: async (eventId, _payload, source): Promise<ConductorWebhookEmitResult> => {
      emitCalls.push({ eventId, source });
      return { startedRuns: [{ workflowSlug: 'wf-1', runId: 'run-1' }] };
    },
    log: () => {},
    ...over,
  };

  const app = express();
  // Mount order is load-bearing, not incidental. body-parser stamps the request
  // `_body` once it reads the stream, and every later parser — including this
  // router's own route-level `express.raw()` — then short-circuits, so the handler
  // sees a parsed object instead of a Buffer and HMACs an EMPTY buffer.
  // `jsonParserFirst` reproduces that broken order on purpose; production
  // (`src/index.ts`) mounts this router BEFORE the global parser.
  if (opts.jsonParserFirst === true) app.use(express.json({ limit: '10mb' }));
  app.use(createConductorWebhooksInboundRouter(() => deps));
  const server = await listenLoopback(app);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    endpoint,
    outcomes,
    emitCalls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

interface PostOpts {
  secret?: string | null;
  deliveryId?: string;
  endpointId?: string;
  /** #1707 — stamp `X-Webhook-Timestamp` and sign `<timestamp>.<body>`. */
  timestamp?: string;
  /** #1707 — stamp the timestamp but sign the BARE body: the misconfiguration an
   *  attacker's rewritten stamp would look like, which must 401. */
  signBodyOnly?: boolean;
  /** #1707 review — sign over a DIFFERENT delivery id than the one sent, which is
   *  exactly what a replay with a fresh id looks like. */
  signedDeliveryId?: string;
  /** Send no `X-Webhook-Delivery-Id` even though a timestamp is stamped. */
  omitDeliveryId?: boolean;
}

async function post(base: string, body: string, opts: PostOpts = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) {
    headers['x-webhook-signature'] =
      opts.timestamp !== undefined && opts.signBodyOnly !== true
        ? signTimestamped(secret, opts.timestamp, opts.signedDeliveryId ?? opts.deliveryId ?? '', body)
        : sign(secret, body);
  }
  if (opts.timestamp !== undefined) headers['x-webhook-timestamp'] = opts.timestamp;
  if (opts.deliveryId && opts.omitDeliveryId !== true) headers['x-webhook-delivery-id'] = opts.deliveryId;
  const res = await fetch(`${base}/api/hooks/${opts.endpointId ?? ENDPOINT_ID}`, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** POSTs over `node:http`, because `fetch` ALWAYS sets a `Content-Type` for a
 *  string body — so `post()` above structurally cannot express the request issue
 *  #1700 is about: a correctly signed delivery that carries NO content type (or an
 *  empty one). Pass `contentType: undefined` to omit the header entirely. */
async function postRaw(
  base: string,
  body: string,
  opts: { contentType?: string; secret?: string; deliveryId: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string | number> = {
    'content-length': Buffer.byteLength(body),
    'x-webhook-signature': sign(opts.secret ?? SECRET, body),
    'x-webhook-delivery-id': opts.deliveryId,
  };
  if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(port), path: `/api/hooks/${ENDPOINT_ID}`, method: 'POST', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('conductor webhook inbound route', () => {
  it('valid signature starts subscribed workflow runs (202, outcome started)', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, JSON.stringify({ orderId: 42 }), { deliveryId: 'd-1' });
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'started');
      assert.equal(r.json['startedRuns'], 1);
      assert.deepEqual(h.emitCalls, [{ eventId: 'orders.created', source: 'webhook:ep-1' }]);
      assert.equal(h.outcomes.get('d-1'), 'started');
    } finally {
      await h.close();
    }
  });

  it('wrong secret → 401, no leak, nothing recorded', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{}', { secret: 'wrong-secret', deliveryId: 'd-2' });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.bad_signature');
      assert.equal(h.emitCalls.length, 0);
      assert.equal(h.outcomes.has('d-2'), false);
    } finally {
      await h.close();
    }
  });

  it('unknown endpoint answers the identical 401 as a wrong secret (no existence leak)', async () => {
    const h = await harness();
    try {
      const body = '{}';
      const known = await post(h.base, body, { secret: 'wrong-secret', deliveryId: 'd-3a' });
      const unknown = await post(h.base, body, { endpointId: 'does-not-exist', deliveryId: 'd-3b' });
      assert.equal(unknown.status, known.status);
      assert.deepEqual(unknown.json, known.json);
      assert.equal(unknown.status, 401);
    } finally {
      await h.close();
    }
  });

  it('missing signature header → 401', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{}', { secret: null, deliveryId: 'd-4' });
      assert.equal(r.status, 401);
    } finally {
      await h.close();
    }
  });

  it('duplicate delivery id → 200 duplicate, emit not called twice', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify({ a: 1 });
      const first = await post(h.base, body, { deliveryId: 'd-dup' });
      const second = await post(h.base, body, { deliveryId: 'd-dup' });
      assert.equal(first.status, 202);
      assert.equal(second.status, 200);
      assert.equal(second.json['outcome'], 'duplicate');
      assert.equal(h.emitCalls.length, 1);
    } finally {
      await h.close();
    }
  });

  // #1707 — the kill switch used to answer 200 {"outcome":"disabled"}: every sender
  // (unsigned, wrong secret, made-up endpoint id alike) was told its delivery had
  // been accepted while nothing was processed or recorded, so its retry policy
  // dropped the event. 503 is honest AND retryable.
  it('global kill switch → 503 webhook.inbound_disabled, no endpoint lookup, no claim', async () => {
    const h = await harness({ enabled: false, getEndpoint: async () => { throw new Error('must not be called'); } });
    try {
      const r = await post(h.base, '{}', { deliveryId: 'd-5' });
      assert.equal(r.status, 503);
      assert.equal(r.json['code'], 'webhook.inbound_disabled');
      assert.equal(r.json['ok'], undefined);
      assert.equal(h.outcomes.has('d-5'), false);
    } finally {
      await h.close();
    }
  });

  it('kill switch answers an UNSIGNED request the same 503 — no success for anyone', async () => {
    const h = await harness({ enabled: false, getEndpoint: async () => { throw new Error('must not be called'); } });
    try {
      const r = await post(h.base, '{}', { secret: null });
      assert.equal(r.status, 503);
      assert.equal(r.json['code'], 'webhook.inbound_disabled');
    } finally {
      await h.close();
    }
  });

  it('disabled endpoint → 200 disabled (recorded), even with a valid signature', async () => {
    const h = await harness({ getEndpoint: async () => ({ eventId: 'orders.created', enabled: false }) });
    try {
      const r = await post(h.base, '{}', { deliveryId: 'd-6' });
      assert.equal(r.status, 200);
      assert.equal(r.json['outcome'], 'disabled');
      assert.equal(h.outcomes.get('d-6'), 'disabled');
      assert.equal(h.emitCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  // Issue #1701 — the reported repro, end to end: a request to a disabled endpoint is
  // answered 200 {"outcome":"disabled"} and recorded, and the sender's redelivery of
  // the SAME delivery id after the endpoint is enabled again used to be answered
  // 'duplicate' with no run started — the event was lost silently.
  it('a delivery refused while disabled is redeliverable once the endpoint is enabled again', async () => {
    const h = await harness({}, { endpointEnabled: false });
    try {
      const body = JSON.stringify({ orderId: 7 });

      const refused = await post(h.base, body, { deliveryId: 'd7' });
      assert.equal(refused.status, 200);
      assert.equal(refused.json['outcome'], 'disabled');
      assert.equal(h.outcomes.get('d7'), 'disabled', 'the refusal is still recorded for the operator audit');
      assert.equal(h.emitCalls.length, 0);

      h.endpoint.enabled = true;
      const retried = await post(h.base, body, { deliveryId: 'd7' });

      assert.equal(retried.status, 202);
      assert.equal(retried.json['outcome'], 'started');
      assert.equal(h.emitCalls.length, 1, 'the redelivery must actually start a run');
      assert.equal(h.outcomes.get('d7'), 'started');
    } finally {
      await h.close();
    }
  });

  it('a delivery that already started a run stays a duplicate across an endpoint off/on cycle', async () => {
    const h = await harness();
    try {
      const body = JSON.stringify({ orderId: 8 });
      assert.equal((await post(h.base, body, { deliveryId: 'd8' })).status, 202);

      // Redelivered while the endpoint is OFF: answered from the ledger before the
      // enabled check, so the 'started' row is never overwritten with 'disabled' —
      // which would otherwise make the delivery re-runnable after the next enable.
      h.endpoint.enabled = false;
      const whileOff = await post(h.base, body, { deliveryId: 'd8' });
      assert.equal(whileOff.json['outcome'], 'duplicate');
      assert.equal(h.outcomes.get('d8'), 'started');

      // And enabling it again does not resurrect a delivery that already ran.
      h.endpoint.enabled = true;
      const whileOn = await post(h.base, body, { deliveryId: 'd8' });

      assert.equal(whileOn.json['outcome'], 'duplicate');
      assert.equal(h.emitCalls.length, 1);
    } finally {
      await h.close();
    }
  });

  it('malformed JSON body → 200 invalid_payload, no emit', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{not json', { deliveryId: 'd-7' });
      assert.equal(r.status, 200);
      assert.equal(r.json['outcome'], 'invalid_payload');
      assert.equal(h.emitCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('no subscribed workflow → 200 no_subscribers', async () => {
    const h = await harness({ emit: async () => ({ startedRuns: [] }) });
    try {
      const r = await post(h.base, '{}', { deliveryId: 'd-8' });
      assert.equal(r.status, 200);
      assert.equal(r.json['outcome'], 'no_subscribers');
    } finally {
      await h.close();
    }
  });

  it('repeated correctly-signed requests with unique delivery ids are rate-limited (429), not unbounded', async () => {
    const h = await harness({}, { rateLimit: 2 });
    try {
      const first = await post(h.base, '{}', { deliveryId: 'd-rl-1' });
      const second = await post(h.base, '{}', { deliveryId: 'd-rl-2' });
      const third = await post(h.base, '{}', { deliveryId: 'd-rl-3' });
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.equal(third.status, 429);
      assert.equal(third.json['code'], 'webhook.rate_limited');
      assert.equal(h.emitCalls.length, 2); // the rate-limited request never reached emit()
    } finally {
      await h.close();
    }
  });

  it('a redelivery of the SAME delivery id is a duplicate, not a rate-limit hit', async () => {
    const h = await harness({}, { rateLimit: 1 });
    try {
      const first = await post(h.base, '{}', { deliveryId: 'd-same' });
      const second = await post(h.base, '{}', { deliveryId: 'd-same' });
      assert.equal(first.status, 202);
      assert.equal(second.status, 200);
      assert.equal(second.json['outcome'], 'duplicate'); // not rate_limited
      assert.equal(h.emitCalls.length, 1);
    } finally {
      await h.close();
    }
  });
});

// Issue #1700 — the raw parser's content-type matcher must not decide whether the
// HMAC ever sees the signed bytes. body-parser's wildcard type STRING (`'*' + '/*'`)
// runs through `type-is`, which needs a media type to compare against: a request
// with no `content-type` header — or an empty one — matched nothing, so the parser
// skipped, `req.body` stayed `{}`, the handler HMAC'd `Buffer.alloc(0)` and a
// CORRECTLY signed delivery answered 401 `webhook.bad_signature`. The route uses a
// function matcher for exactly this reason. These tests must go through `node:http`:
// `fetch` always sets a content type for a string body and so cannot express the case.
describe('conductor webhook inbound route — content type never gates the signature (#1700)', () => {
  it('no content-type header at all → the signature verifies (202 started)', async () => {
    const h = await harness();
    try {
      const r = await postRaw(h.base, JSON.stringify({ orderId: 42 }), { deliveryId: 'd-1700-absent' });
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'started');
      assert.equal(h.emitCalls.length, 1);
      assert.equal(h.outcomes.get('d-1700-absent'), 'started');
    } finally {
      await h.close();
    }
  });

  it('empty content-type value → the signature verifies (202 started)', async () => {
    const h = await harness();
    try {
      const r = await postRaw(h.base, JSON.stringify({ orderId: 42 }), {
        contentType: '',
        deliveryId: 'd-1700-empty',
      });
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'started');
    } finally {
      await h.close();
    }
  });

  it('no content-type and a non-JSON body → invalid_payload, NOT bad_signature', async () => {
    const h = await harness();
    try {
      // The outcome the issue expected for a missing header, and the right one for
      // unparseable bytes: the signature passed, only the JSON parse failed.
      const r = await postRaw(h.base, 'not json at all', { deliveryId: 'd-1700-text' });
      assert.equal(r.status, 200);
      assert.equal(r.json['outcome'], 'invalid_payload');
      assert.equal(h.emitCalls.length, 0);
      assert.equal(h.outcomes.get('d-1700-text'), 'invalid_payload');
    } finally {
      await h.close();
    }
  });

  it('a WRONG signature without a content-type still answers 401 (the fix widens parsing, not auth)', async () => {
    const h = await harness();
    try {
      const r = await postRaw(h.base, JSON.stringify({ orderId: 42 }), {
        secret: 'wrong-secret',
        deliveryId: 'd-1700-wrong',
      });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.bad_signature');
      assert.equal(h.emitCalls.length, 0);
      assert.equal(h.outcomes.size, 0);
    } finally {
      await h.close();
    }
  });

  it('text/plain carries the bytes too — the content type is irrelevant to the HMAC', async () => {
    const h = await harness();
    try {
      const r = await postRaw(h.base, JSON.stringify({ orderId: 42 }), {
        contentType: 'text/plain',
        deliveryId: 'd-1700-plain',
      });
      assert.equal(r.status, 202);
      assert.equal(r.json['outcome'], 'started');
    } finally {
      await h.close();
    }
  });
});

// Epic #470 C10 — extracting the subsystem removed the LLM-proxy path carve-out that
// used to wrap the global `express.json`. That wrapper sat ABOVE this
// router, so on the pre-C10 tree a correctly-signed delivery reached the handler with
// `req.body` already parsed and the HMAC was computed over `Buffer.alloc(0)` — every
// signed webhook 401'd. The router now sits before the only global parser.
//
// The suite above cannot catch a regression here: it mounts the router alone on a bare
// app, which passes under BOTH orders. These two tests make the ordering itself the
// thing under test; `778RouteMounts.wiring.test.ts` pins the real order in `src/index.ts`.
describe('conductor webhook inbound route — raw-body mount order (#470 C10)', () => {
  it('verifies a correct signature when mounted before the global JSON parser', async () => {
    const h = await harness();
    try {
      const res = await post(h.base, JSON.stringify({ hello: 'world' }), { deliveryId: 'd-order-ok' });
      assert.equal(res.status, 202);
      assert.equal(res.json['outcome'], 'started');
      assert.equal(h.emitCalls.length, 1);
    } finally {
      await h.close();
    }
  });

  it('rejects the SAME correct signature when a JSON parser runs first (401, raw body lost)', async () => {
    const h = await harness({}, { jsonParserFirst: true });
    try {
      const res = await post(h.base, JSON.stringify({ hello: 'world' }), { deliveryId: 'd-order-broken' });
      // Byte-identical request to the test above; only the mount order differs.
      assert.equal(res.status, 401);
      // Signature verification failed, so nothing was ever claimed or emitted.
      assert.equal(h.emitCalls.length, 0);
      assert.equal(h.outcomes.size, 0);
    } finally {
      await h.close();
    }
  });

});

describe('conductor webhook inbound route — replay window + rotation grace (#1707)', () => {
  // ── #1707: the replay window ──────────────────────────────────────────────
  // Before this, an inbound request carried a signature and a delivery id but no
  // timestamp: a captured request stayed valid forever and only the delivery-id
  // ledger stopped a literal repeat.

  it('a timestamped delivery signed over <timestamp>.<body> is accepted', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'ts-1', timestamp: unixNow() });
      assert.equal(r.status, 202);
      assert.equal(h.outcomes.get('ts-1'), 'started');
    } finally {
      await h.close();
    }
  });

  it('a captured delivery replayed with its ORIGINAL timestamp is refused as stale', async () => {
    const h = await harness();
    try {
      // 10 minutes old, tolerance 5 — exactly the capture-and-replay-later case.
      const r = await post(h.base, '{"a":1}', { deliveryId: 'ts-2', timestamp: unixNow(-600) });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.stale_timestamp');
      assert.equal(h.outcomes.has('ts-2'), false);
      assert.equal(h.emitCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('a far-FUTURE timestamp is refused too — it would stay valid until that time', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{}', { deliveryId: 'ts-3', timestamp: unixNow(3600) });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.stale_timestamp');
    } finally {
      await h.close();
    }
  });

  // The attack the signed-timestamp scheme closes: a captured request with a FRESH
  // stamp written over it. Its signature only ever covered the body (or the old
  // stamp), so it cannot verify against `<new timestamp>.<body>`.
  it('a rewritten timestamp over a body-only signature does not verify', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'ts-4', timestamp: unixNow(), signBodyOnly: true });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.bad_signature');
      assert.equal(h.emitCalls.length, 0);
    } finally {
      await h.close();
    }
  });

  it('a malformed timestamp is refused before any endpoint lookup', async () => {
    const h = await harness({ getEndpoint: async () => { throw new Error('must not be called'); } });
    try {
      const r = await post(h.base, '{}', { deliveryId: 'ts-5', timestamp: 'yesterday' });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.stale_timestamp');
    } finally {
      await h.close();
    }
  });

  it('without the header the legacy bare-body scheme still verifies (default posture)', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'ts-6' });
      assert.equal(r.status, 202);
    } finally {
      await h.close();
    }
  });

  it('requireTimestamp closes that legacy path: no header → 401 timestamp_required', async () => {
    const h = await harness({ requireTimestamp: true, getEndpoint: async () => { throw new Error('must not be called'); } });
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'ts-7' });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.timestamp_required');
      assert.equal(h.outcomes.has('ts-7'), false);
    } finally {
      await h.close();
    }
  });

  it('requireTimestamp still accepts a properly timestamped delivery', async () => {
    const h = await harness({ requireTimestamp: true });
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'ts-8', timestamp: unixNow() });
      assert.equal(r.status, 202);
    } finally {
      await h.close();
    }
  });

  // ── #1707: rotation grace ─────────────────────────────────────────────────
  // Rotation used to take effect instantly — the sender's very next request with the
  // old secret answered 401, so every rotation was an outage until it had been
  // reconfigured.

  it('the secret a rotation superseded still verifies while the grace window is open', async () => {
    const h = await harness({}, { graceSecret: true });
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'rot-1', secret: PREVIOUS_SECRET });
      assert.equal(r.status, 202);
      assert.equal(h.outcomes.get('rot-1'), 'started');
    } finally {
      await h.close();
    }
  });

  it('the current secret keeps verifying during that same window', async () => {
    const h = await harness({}, { graceSecret: true });
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'rot-2' });
      assert.equal(r.status, 202);
    } finally {
      await h.close();
    }
  });

  it('once the grace has lapsed (no previous secret offered) the old secret is 401', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'rot-3', secret: PREVIOUS_SECRET });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.bad_signature');
    } finally {
      await h.close();
    }
  });

  it('a grace-window secret still has to sign the timestamped scheme when one is stamped', async () => {
    const h = await harness({}, { graceSecret: true });
    try {
      const ok = await post(h.base, '{"a":1}', { deliveryId: 'rot-4', secret: PREVIOUS_SECRET, timestamp: unixNow() });
      assert.equal(ok.status, 202);
      const bad = await post(h.base, '{"a":1}', {
        deliveryId: 'rot-5',
        secret: PREVIOUS_SECRET,
        timestamp: unixNow(),
        signBodyOnly: true,
      });
      assert.equal(bad.status, 401);
      assert.equal(bad.json['code'], 'webhook.bad_signature');
    } finally {
      await h.close();
    }
  });

  // ── #1707 review finding: the delivery id must be inside the MAC ──────────
  // The ledger is the only thing that stops a repeat and its key is the
  // caller-supplied header. Signing only `<timestamp>.<body>` left the window open:
  // a captured request replayed with a FRESH delivery id passed signature, tolerance
  // AND dedupe, starting a real run every time until the tolerance expired.

  it('a captured request replayed with a fresh delivery id does not verify', async () => {
    const h = await harness();
    try {
      const ts = unixNow();
      const first = await post(h.base, '{"a":1}', { deliveryId: 'mac-1', timestamp: ts });
      assert.equal(first.status, 202);

      // Same timestamp (still inside the window) and same body, but a new ledger key
      // and the ORIGINAL signature: this is the replay.
      const replay = await post(h.base, '{"a":1}', {
        deliveryId: 'mac-2',
        signedDeliveryId: 'mac-1',
        timestamp: ts,
      });
      assert.equal(replay.status, 401);
      assert.equal(replay.json['code'], 'webhook.bad_signature');
      assert.equal(h.emitCalls.length, 1, 'the replay must not start a second run');
    } finally {
      await h.close();
    }
  });

  it('a redelivery of the SAME id still dedupes rather than running twice', async () => {
    const h = await harness();
    try {
      const ts = unixNow();
      assert.equal((await post(h.base, '{"a":1}', { deliveryId: 'mac-3', timestamp: ts })).status, 202);
      const again = await post(h.base, '{"a":1}', { deliveryId: 'mac-3', timestamp: ts });
      assert.equal(again.status, 200);
      assert.equal(again.json['outcome'], 'duplicate');
      assert.equal(h.emitCalls.length, 1);
    } finally {
      await h.close();
    }
  });

  it('a timestamped delivery that omits the delivery id is refused', async () => {
    // Permitting the omission would hand the hole back: the server mints an id for a
    // caller that sends none, so every replay would get a fresh ledger key.
    const h = await harness({ getEndpoint: async () => { throw new Error('must not be called'); } });
    try {
      const r = await post(h.base, '{"a":1}', { deliveryId: 'mac-4', timestamp: unixNow(), omitDeliveryId: true });
      assert.equal(r.status, 401);
      assert.equal(r.json['code'], 'webhook.delivery_id_required');
    } finally {
      await h.close();
    }
  });

  it('the legacy un-timestamped path still needs no delivery id', async () => {
    const h = await harness();
    try {
      const r = await post(h.base, '{"a":1}', {});
      assert.equal(r.status, 202);
    } finally {
      await h.close();
    }
  });
});
