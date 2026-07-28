import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import {
  createConductorWebhooksInboundRouter,
  type ConductorWebhookInboundDeps,
  type ConductorWebhookEmitResult,
} from '../src/routes/conductorWebhooksInbound.js';
import type { WebhookClaimResult, WebhookInboundOutcome } from '../src/conductor/webhookEndpointStore.js';

// Issue #437 — inbound Conductor webhook route: signature-first verification
// (unknown endpoint and wrong secret must answer byte-for-byte the same 401),
// atomic delivery-id dedupe scoped per endpoint, a per-endpoint rate limit, a
// terminal outcome recorded for every claimed delivery, and 2xx-on-noise so a
// sender's retry policy never turns an ignorable delivery into a redelivery storm.

const SECRET = 'whsec_unit_test_secret';
const ENDPOINT_ID = 'ep-1';

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

interface Harness {
  base: string;
  outcomes: Map<string, WebhookInboundOutcome>;
  emitCalls: Array<{ eventId: string; source: string }>;
  close: () => Promise<void>;
}

async function harness(
  over: Partial<ConductorWebhookInboundDeps> = {},
  opts: { rateLimit?: number } = {},
): Promise<Harness> {
  // Keyed `${endpointId}::${deliveryId}` — mirrors the store's composite PK scoping
  // (finding: a global key would misread endpoint B's id '1' as a dupe of A's).
  const claimed = new Set<string>();
  const perEndpointCount = new Map<string, number>();
  const outcomes = new Map<string, WebhookInboundOutcome>();
  const emitCalls: Array<{ eventId: string; source: string }> = [];
  const rateLimit = opts.rateLimit ?? Number.POSITIVE_INFINITY;

  const deps: ConductorWebhookInboundDeps = {
    enabled: true,
    getEndpoint: async (endpointId) =>
      endpointId === ENDPOINT_ID ? { eventId: 'orders.created', enabled: true } : null,
    getSecret: async (endpointId) => (endpointId === ENDPOINT_ID ? SECRET : undefined),
    claim: async (deliveryId, endpointId): Promise<WebhookClaimResult> => {
      // Dedupe BEFORE the rate check — a redelivery of an id already claimed by
      // this endpoint must never be misreported as rate-limited just because the
      // endpoint is currently busy with other (unique) deliveries.
      const key = `${endpointId}::${deliveryId}`;
      if (claimed.has(key)) return 'duplicate';
      const count = perEndpointCount.get(endpointId) ?? 0;
      if (count >= rateLimit) return 'rate_limited';
      claimed.add(key);
      perEndpointCount.set(endpointId, count + 1);
      return 'claimed';
    },
    setOutcome: async (deliveryId, _endpointId, outcome) => {
      outcomes.set(deliveryId, outcome);
    },
    emit: async (eventId, _payload, source): Promise<ConductorWebhookEmitResult> => {
      emitCalls.push({ eventId, source });
      return { startedRuns: [{ workflowSlug: 'wf-1', runId: 'run-1' }] };
    },
    log: () => {},
    ...over,
  };

  const app = express();
  app.use(createConductorWebhooksInboundRouter(() => deps));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, outcomes, emitCalls, close: () => new Promise((r) => server.close(() => r())) };
}

interface PostOpts {
  secret?: string | null;
  deliveryId?: string;
  endpointId?: string;
}

async function post(base: string, body: string, opts: PostOpts = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-webhook-signature'] = sign(secret, body);
  if (opts.deliveryId) headers['x-webhook-delivery-id'] = opts.deliveryId;
  const res = await fetch(`${base}/api/hooks/${opts.endpointId ?? ENDPOINT_ID}`, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
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

  it('global kill switch → 200 disabled, no endpoint lookup, no claim', async () => {
    const h = await harness({ enabled: false, getEndpoint: async () => { throw new Error('must not be called'); } });
    try {
      const r = await post(h.base, '{}', { deliveryId: 'd-5' });
      assert.equal(r.status, 200);
      assert.equal(r.json['outcome'], 'disabled');
      assert.equal(h.outcomes.has('d-5'), false);
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
