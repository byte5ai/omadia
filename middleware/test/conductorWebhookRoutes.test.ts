import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express, Request } from 'express';

import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { createConductorRouter } from '../src/conductor/routes.js';
import type {
  ConductorWebhookEndpoint,
  ConductorWebhookInboundDelivery,
  ConductorWebhookEndpointStore,
} from '../src/conductor/webhookEndpointStore.js';
import type {
  ConductorWebhookSubscription,
  ConductorWebhookDelivery,
  ConductorWebhookSubscriptionStore,
} from '../src/conductor/webhookSubscriptionStore.js';
import { WebhookUrlNotAllowedError } from '../src/conductor/webhookOutbound.js';

type EndpointWithUrl = ConductorWebhookEndpoint & { inboundUrl?: string };

// Issue #437 review finding: the admin CRUD HTTP surface for both inbound endpoints
// and outbound subscriptions (registerWebhookRoutes) had ZERO route-level test
// coverage — only the underlying stores were unit-tested. Express harness over an
// in-memory fake of each store (real store SQL is covered separately by the
// conductorWebhook{Endpoint,Subscription}Store.pg.test.ts files); this file is only
// about the HTTP contract — status codes, error codes, and the 503-when-unwired /
// 404 / 400 branches the routes are responsible for.

function fakeEndpointStore(): { store: ConductorWebhookEndpointStore; rotate: string[] } {
  const rows = new Map<string, ConductorWebhookEndpoint>();
  const deliveries = new Map<string, ConductorWebhookInboundDelivery[]>();
  const secrets = new Map<string, string>();
  const rotate: string[] = [];
  let seq = 0;
  const store: ConductorWebhookEndpointStore = {
    async create(input) {
      seq += 1;
      const endpointId = `ep-${String(seq)}`;
      const secret = `secret-${String(seq)}`;
      const endpoint: ConductorWebhookEndpoint = {
        endpointId,
        eventId: input.eventId,
        description: input.description ?? null,
        enabled: true,
        createdBy: input.createdBy,
        createdAt: new Date('2026-07-28T00:00:00.000Z'),
      };
      rows.set(endpointId, endpoint);
      secrets.set(endpointId, secret);
      return { endpoint, secret };
    },
    async list() {
      return [...rows.values()];
    },
    async get(endpointId) {
      return rows.get(endpointId) ?? null;
    },
    async getSecret(endpointId) {
      return secrets.get(endpointId);
    },
    async rotateSecret(endpointId) {
      rotate.push(endpointId);
      const secret = `rotated-${endpointId}`;
      secrets.set(endpointId, secret);
      return secret;
    },
    async setEnabled(endpointId, enabled) {
      const row = rows.get(endpointId);
      if (row) rows.set(endpointId, { ...row, enabled });
    },
    async delete(endpointId) {
      rows.delete(endpointId);
      secrets.delete(endpointId);
    },
    async claim() {
      throw new Error('not used by the admin routes');
    },
    async setOutcome() {
      throw new Error('not used by the admin routes');
    },
    async listDeliveries(endpointId) {
      return deliveries.get(endpointId) ?? [];
    },
    // test-only seam
    _seedDeliveries: (endpointId: string, rows2: ConductorWebhookInboundDelivery[]) => deliveries.set(endpointId, rows2),
  } as unknown as ConductorWebhookEndpointStore & { _seedDeliveries: (id: string, rows: ConductorWebhookInboundDelivery[]) => void };
  return { store, rotate };
}

function fakeSubscriptionStore(): { store: ConductorWebhookSubscriptionStore; rotate: string[] } {
  const rows = new Map<string, ConductorWebhookSubscription>();
  const deliveries = new Map<string, ConductorWebhookDelivery[]>();
  const secrets = new Map<string, string>();
  const rotate: string[] = [];
  let seq = 0;
  const store: ConductorWebhookSubscriptionStore = {
    async create(input) {
      seq += 1;
      const id = `sub-${String(seq)}`;
      const secret = `secret-${String(seq)}`;
      const subscription: ConductorWebhookSubscription = {
        id,
        url: input.url,
        event: input.event,
        description: input.description ?? null,
        enabled: true,
        createdBy: input.createdBy,
        createdAt: new Date('2026-07-28T00:00:00.000Z'),
      };
      rows.set(id, subscription);
      secrets.set(id, secret);
      return { subscription, secret };
    },
    async list() {
      return [...rows.values()];
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async listEnabledForEvent() {
      return [];
    },
    async getSecret(id) {
      return secrets.get(id);
    },
    async rotateSecret(id) {
      rotate.push(id);
      const secret = `rotated-${id}`;
      secrets.set(id, secret);
      return secret;
    },
    async setEnabled(id, enabled) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, enabled });
    },
    async delete(id) {
      rows.delete(id);
      secrets.delete(id);
    },
    async createDelivery() {
      throw new Error('not used by the admin routes');
    },
    async claimDue() {
      return [];
    },
    async claimOne() {
      return null;
    },
    async listMissingRunDeliveries() {
      return [];
    },
    async recordSuccess() {},
    async recordFailure() {},
    async listForSubscription(id) {
      return deliveries.get(id) ?? [];
    },
    // test-only seam
    _seedDeliveries: (id: string, rows2: ConductorWebhookDelivery[]) => deliveries.set(id, rows2),
  } as unknown as ConductorWebhookSubscriptionStore & { _seedDeliveries: (id: string, rows: ConductorWebhookDelivery[]) => void };
  return { store, rotate };
}

interface Harness {
  baseUrl: string;
  endpoints: ReturnType<typeof fakeEndpointStore>;
  subscriptions: ReturnType<typeof fakeSubscriptionStore>;
  urlChecks: string[];
  rejectUrl?: string;
}

const servers: Server[] = [];

async function makeHarness(opts?: { wired?: boolean; rejectUrl?: string; webhookInboundBaseUrl?: string }): Promise<Harness> {
  const wired = opts?.wired ?? true;
  const endpoints = fakeEndpointStore();
  const subscriptions = fakeSubscriptionStore();
  const urlChecks: string[] = [];

  const deps = {
    workflowStore: {},
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    executor: {},
    eventRouter: {},
    ...(wired ? { webhookEndpoints: endpoints.store, webhookSubscriptions: subscriptions.store } : {}),
    ...(opts?.webhookInboundBaseUrl ? { webhookInboundBaseUrl: opts.webhookInboundBaseUrl } : {}),
    assertOutboundUrlAllowed: (url: string) => {
      urlChecks.push(url);
      if (opts?.rejectUrl && url === opts.rejectUrl) {
        throw new WebhookUrlNotAllowedError(`'${url}' is not allowed`);
      }
    },
  } as unknown as ConductorRouterDeps;

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const viewer = req.header('x-viewer');
    if (viewer) (req as Request & { session?: { sub: string } }).session = { sub: viewer };
    next();
  });
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`,
    endpoints,
    subscriptions,
    urlChecks,
  };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function headers(viewer?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(viewer ? { 'x-viewer': viewer } : {}) };
}

async function get(url: string, viewer?: string): Promise<Response> {
  return fetch(url, { headers: headers(viewer) });
}
async function post(url: string, body: unknown, viewer?: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers: headers(viewer), body: JSON.stringify(body) });
}
async function del(url: string, viewer?: string): Promise<Response> {
  return fetch(url, { method: 'DELETE', headers: headers(viewer) });
}

describe('inbound webhook endpoints admin routes (#437)', () => {
  it('503s every endpoint route when webhookEndpoints is not wired', async () => {
    const h = await makeHarness({ wired: false });
    assert.equal((await get(`${h.baseUrl}/webhooks/endpoints`)).status, 503);
    assert.equal((await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' })).status, 503);
    assert.equal((await post(`${h.baseUrl}/webhooks/endpoints/ep-1/rotate-secret`, {})).status, 503);
    assert.equal((await post(`${h.baseUrl}/webhooks/endpoints/ep-1/status`, { enabled: false })).status, 503);
    assert.equal((await del(`${h.baseUrl}/webhooks/endpoints/ep-1`)).status, 503);
    assert.equal((await get(`${h.baseUrl}/webhooks/endpoints/ep-1/deliveries`)).status, 503);
  });

  it('creates an endpoint and returns the plaintext secret exactly once', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created', description: 'order intake' }, 'operator-a');
    assert.equal(res.status, 201);
    const body = (await res.json()) as { endpoint: ConductorWebhookEndpoint; secret: string };
    assert.equal(body.endpoint.eventId, 'orders.created');
    assert.equal(body.endpoint.createdBy, 'operator-a');
    assert.ok(body.secret.length > 0);

    // the secret never comes back on a list read.
    const list = await get(`${h.baseUrl}/webhooks/endpoints`);
    const listed = ((await list.json()) as { endpoints: Array<Record<string, unknown>> }).endpoints;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.secret, undefined);
  });

  // Review finding (issue #437): the admin UI must display an inbound URL it can
  // actually reach, not one derived from window.location.origin. The route computes
  // it server-side from `deps.webhookInboundBaseUrl` — absent entirely when that's
  // not configured, rather than guessing.
  it('create AND list attach an absolute inboundUrl when webhookInboundBaseUrl is configured', async () => {
    const h = await makeHarness({ webhookInboundBaseUrl: 'http://localhost:3979/' });
    const created = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    const { endpoint } = (await created.json()) as { endpoint: EndpointWithUrl };
    assert.equal(endpoint.inboundUrl, `http://localhost:3979/api/hooks/${endpoint.endpointId}`);

    const list = await get(`${h.baseUrl}/webhooks/endpoints`);
    const listed = ((await list.json()) as { endpoints: EndpointWithUrl[] }).endpoints;
    assert.equal(listed[0]?.inboundUrl, `http://localhost:3979/api/hooks/${endpoint.endpointId}`);
  });

  it('omits inboundUrl when webhookInboundBaseUrl is not configured', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    const { endpoint } = (await created.json()) as { endpoint: EndpointWithUrl };
    assert.equal(endpoint.inboundUrl, undefined);
  });

  it('400s a create with a missing eventId', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/webhooks/endpoints`, {});
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.invalid_input');
  });

  it('rotate-secret 404s an unknown endpoint and 200s a known one with a NEW secret', async () => {
    const h = await makeHarness();
    assert.equal((await post(`${h.baseUrl}/webhooks/endpoints/does-not-exist/rotate-secret`, {})).status, 404);

    const created = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    const { endpoint, secret: original } = (await created.json()) as { endpoint: ConductorWebhookEndpoint; secret: string };
    const rotated = await post(`${h.baseUrl}/webhooks/endpoints/${endpoint.endpointId}/rotate-secret`, {});
    assert.equal(rotated.status, 200);
    const { secret: next } = (await rotated.json()) as { secret: string };
    assert.notEqual(next, original);
    assert.deepEqual(h.endpoints.rotate, [endpoint.endpointId]);
  });

  it('status toggles enabled and 400s a non-boolean body', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    const { endpoint } = (await created.json()) as { endpoint: ConductorWebhookEndpoint };

    const bad = await post(`${h.baseUrl}/webhooks/endpoints/${endpoint.endpointId}/status`, { enabled: 'yes' });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, 'conductor.invalid_input');

    const ok = await post(`${h.baseUrl}/webhooks/endpoints/${endpoint.endpointId}/status`, { enabled: false });
    assert.equal(ok.status, 204);
    const list = (await (await get(`${h.baseUrl}/webhooks/endpoints`)).json()) as { endpoints: ConductorWebhookEndpoint[] };
    assert.equal(list.endpoints[0]!.enabled, false);
  });

  it('deletes an endpoint (204) and it vanishes from the list', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    const { endpoint } = (await created.json()) as { endpoint: ConductorWebhookEndpoint };
    const res = await del(`${h.baseUrl}/webhooks/endpoints/${endpoint.endpointId}`);
    assert.equal(res.status, 204);
    const list = (await (await get(`${h.baseUrl}/webhooks/endpoints`)).json()) as { endpoints: ConductorWebhookEndpoint[] };
    assert.deepEqual(list.endpoints, []);
  });

  it('lists delivery history for an endpoint', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    const { endpoint } = (await created.json()) as { endpoint: ConductorWebhookEndpoint };
    const delivery: ConductorWebhookInboundDelivery = {
      deliveryId: 'd-1',
      endpointId: endpoint.endpointId,
      outcome: 'started',
      receivedAt: new Date('2026-07-28T00:00:00.000Z'),
    };
    (h.endpoints.store as unknown as { _seedDeliveries: (id: string, rows: ConductorWebhookInboundDelivery[]) => void })._seedDeliveries(
      endpoint.endpointId,
      [delivery],
    );
    const res = await get(`${h.baseUrl}/webhooks/endpoints/${endpoint.endpointId}/deliveries`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliveries: Array<{ deliveryId: string; outcome: string }> };
    assert.equal(body.deliveries.length, 1);
    assert.equal(body.deliveries[0]!.deliveryId, 'd-1');
    assert.equal(body.deliveries[0]!.outcome, 'started');
  });
});

describe('outbound webhook subscriptions admin routes (#437)', () => {
  it('503s every subscription route when webhookSubscriptions is not wired', async () => {
    const h = await makeHarness({ wired: false });
    assert.equal((await get(`${h.baseUrl}/webhooks/subscriptions`)).status, 503);
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook', event: 'run.completed' })).status, 503);
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions/sub-1/rotate-secret`, {})).status, 503);
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions/sub-1/status`, { enabled: false })).status, 503);
    assert.equal((await del(`${h.baseUrl}/webhooks/subscriptions/sub-1`)).status, 503);
    assert.equal((await get(`${h.baseUrl}/webhooks/subscriptions/sub-1/deliveries`)).status, 503);
  });

  it('creates a subscription (checking the URL via assertOutboundUrlAllowed) and returns the secret once', async () => {
    const h = await makeHarness();
    const res = await post(
      `${h.baseUrl}/webhooks/subscriptions`,
      { url: 'https://example.com/hook', event: 'run.completed', description: 'ops channel' },
      'operator-a',
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as { subscription: ConductorWebhookSubscription; secret: string };
    assert.equal(body.subscription.url, 'https://example.com/hook');
    assert.equal(body.subscription.event, 'run.completed');
    assert.equal(body.subscription.createdBy, 'operator-a');
    assert.ok(body.secret.length > 0);
    assert.deepEqual(h.urlChecks, ['https://example.com/hook']);

    const list = await get(`${h.baseUrl}/webhooks/subscriptions`);
    const listed = ((await list.json()) as { subscriptions: Array<Record<string, unknown>> }).subscriptions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.secret, undefined);
  });

  it('400s a create with a missing url or event', async () => {
    const h = await makeHarness();
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions`, { event: 'run.completed' })).status, 400);
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook' })).status, 400);
  });

  it('400s a create whose URL the SSRF guard rejects, WITHOUT ever calling the store', async () => {
    const h = await makeHarness({ rejectUrl: 'http://169.254.169.254/latest/meta-data' });
    const res = await post(`${h.baseUrl}/webhooks/subscriptions`, {
      url: 'http://169.254.169.254/latest/meta-data',
      event: 'run.completed',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.webhook_url_forbidden');
    assert.deepEqual((await (await get(`${h.baseUrl}/webhooks/subscriptions`)).json()) as { subscriptions: unknown[] }, {
      subscriptions: [],
    });
  });

  it('rotate-secret 404s an unknown subscription and 200s a known one with a NEW secret', async () => {
    const h = await makeHarness();
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions/does-not-exist/rotate-secret`, {})).status, 404);

    const created = await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook', event: 'run.completed' });
    const { subscription, secret: original } = (await created.json()) as { subscription: ConductorWebhookSubscription; secret: string };
    const rotated = await post(`${h.baseUrl}/webhooks/subscriptions/${subscription.id}/rotate-secret`, {});
    assert.equal(rotated.status, 200);
    const { secret: next } = (await rotated.json()) as { secret: string };
    assert.notEqual(next, original);
    assert.deepEqual(h.subscriptions.rotate, [subscription.id]);
  });

  it('status toggles enabled and 400s a non-boolean body', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook', event: 'run.completed' });
    const { subscription } = (await created.json()) as { subscription: ConductorWebhookSubscription };

    const bad = await post(`${h.baseUrl}/webhooks/subscriptions/${subscription.id}/status`, { enabled: 'nope' });
    assert.equal(bad.status, 400);

    const ok = await post(`${h.baseUrl}/webhooks/subscriptions/${subscription.id}/status`, { enabled: false });
    assert.equal(ok.status, 204);
    const list = (await (await get(`${h.baseUrl}/webhooks/subscriptions`)).json()) as { subscriptions: ConductorWebhookSubscription[] };
    assert.equal(list.subscriptions[0]!.enabled, false);
  });

  it('deletes a subscription (204) and it vanishes from the list', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook', event: 'run.completed' });
    const { subscription } = (await created.json()) as { subscription: ConductorWebhookSubscription };
    const res = await del(`${h.baseUrl}/webhooks/subscriptions/${subscription.id}`);
    assert.equal(res.status, 204);
    const list = (await (await get(`${h.baseUrl}/webhooks/subscriptions`)).json()) as { subscriptions: ConductorWebhookSubscription[] };
    assert.deepEqual(list.subscriptions, []);
  });

  it('lists delivery history for a subscription', async () => {
    const h = await makeHarness();
    const created = await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook', event: 'run.completed' });
    const { subscription } = (await created.json()) as { subscription: ConductorWebhookSubscription };
    const delivery: ConductorWebhookDelivery = {
      id: 'd-1',
      subscriptionId: subscription.id,
      event: 'run.completed',
      payload: { runId: 'r-1' },
      status: 'delivered',
      attempts: 1,
      lastError: null,
      nextAttemptAt: new Date('2026-07-28T00:00:00.000Z'),
      deliveredAt: new Date('2026-07-28T00:00:01.000Z'),
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
    };
    (h.subscriptions.store as unknown as { _seedDeliveries: (id: string, rows: ConductorWebhookDelivery[]) => void })._seedDeliveries(
      subscription.id,
      [delivery],
    );
    const res = await get(`${h.baseUrl}/webhooks/subscriptions/${subscription.id}/deliveries`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deliveries: Array<{ id: string; status: string }> };
    assert.equal(body.deliveries.length, 1);
    assert.equal(body.deliveries[0]!.id, 'd-1');
    assert.equal(body.deliveries[0]!.status, 'delivered');
  });
});
