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

function fakeEndpointStore(): { store: ConductorWebhookEndpointStore; rotate: Array<{ endpointId: string; graceMs: number }> } {
  const rows = new Map<string, ConductorWebhookEndpoint>();
  const deliveries = new Map<string, ConductorWebhookInboundDelivery[]>();
  const secrets = new Map<string, string>();
  const rotate: Array<{ endpointId: string; graceMs: number }> = [];
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
        secretPreviousUntil: null,
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
    // Annotated explicitly: the surrounding object is cast through `unknown`, so TS
    // infers nothing for these parameters (the pre-existing debt in this file).
    async getVerificationSecrets(endpointId: string) {
      const current = secrets.get(endpointId);
      return current === undefined ? {} : { current };
    },
    // #1707 — records the grace the route asked for, so the test can assert that the
    // configured window (and `?immediate=true`'s zero) actually reaches the store.
    async rotateSecret(endpointId: string, graceMs = 0) {
      rotate.push({ endpointId, graceMs });
      const secret = `rotated-${endpointId}`;
      secrets.set(endpointId, secret);
      const row = rows.get(endpointId);
      if (row) {
        rows.set(endpointId, {
          ...row,
          secretPreviousUntil: graceMs > 0 ? new Date(Date.now() + graceMs) : null,
        });
      }
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
        includeContext: input.includeContext ?? false,
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
    async setIncludeContext(id: string, includeContext: boolean) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, includeContext });
    },
    async delete(id) {
      rows.delete(id);
      secrets.delete(id);
    },
    async redactDeliveryPayloadsOlderThan() {
      return 0;
    },
    async deleteDeliveriesOlderThan() {
      return 0;
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

/** #1707 — what `deps.auditWebhookChange` was handed, so the tests can assert the
 *  trail exists AND that it never carries a secret. */
type AuditCall = Parameters<NonNullable<ConductorRouterDeps['auditWebhookChange']>>[0];

interface Harness {
  baseUrl: string;
  endpoints: ReturnType<typeof fakeEndpointStore>;
  subscriptions: ReturnType<typeof fakeSubscriptionStore>;
  urlChecks: string[];
  audits: AuditCall[];
  rejectUrl?: string;
}

const servers: Server[] = [];

async function makeHarness(opts?: {
  wired?: boolean;
  rejectUrl?: string;
  webhookInboundBaseUrl?: string;
  secretGraceMs?: number;
  posture?: Record<string, unknown>;
  auditThrows?: boolean;
}): Promise<Harness> {
  const wired = opts?.wired ?? true;
  const endpoints = fakeEndpointStore();
  const subscriptions = fakeSubscriptionStore();
  const urlChecks: string[] = [];
  const audits: AuditCall[] = [];

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
    ...(opts?.secretGraceMs !== undefined ? { webhookSecretGraceMs: opts.secretGraceMs } : {}),
    ...(opts?.posture ? { webhookPosture: opts.posture } : {}),
    auditWebhookChange: async (entry: AuditCall) => {
      audits.push(entry);
      if (opts?.auditThrows === true) throw new Error('audit sink exploded');
    },
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
    const viewerEmail = req.header('x-viewer-email');
    if (viewer || viewerEmail) {
      (req as Request & { session?: { sub?: string; email?: string } }).session = {
        ...(viewer ? { sub: viewer } : {}),
        ...(viewerEmail ? { email: viewerEmail } : {}),
      };
    }
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
    audits,
  };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function headers(viewer?: string, viewerEmail?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(viewer ? { 'x-viewer': viewer } : {}),
    ...(viewerEmail ? { 'x-viewer-email': viewerEmail } : {}),
  };
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
    assert.deepEqual(h.endpoints.rotate.map((r) => r.endpointId), [endpoint.endpointId]);
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

describe('webhook admin hardening (#1707)', () => {
  // The reported gap: `SELECT action FROM admin_audit WHERE action ILIKE '%webhook%'`
  // returned no rows — creating, rotating, disabling and deleting endpoints and
  // subscriptions were all unrecorded.

  it('records an audit entry for every endpoint mutation, never the secret', async () => {
    const h = await makeHarness();
    const created = (await (await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' }, 'op-a')).json()) as {
      endpoint: ConductorWebhookEndpoint;
      secret: string;
    };
    const id = created.endpoint.endpointId;
    await post(`${h.baseUrl}/webhooks/endpoints/${id}/rotate-secret`, {}, 'op-a');
    await post(`${h.baseUrl}/webhooks/endpoints/${id}/status`, { enabled: false }, 'op-a');
    await del(`${h.baseUrl}/webhooks/endpoints/${id}`, 'op-a');

    assert.deepEqual(
      h.audits.map((a) => `${a.kind}.${a.change}`),
      ['endpoint.create', 'endpoint.rotate_secret', 'endpoint.status', 'endpoint.delete'],
    );
    assert.deepEqual(new Set(h.audits.map((a) => a.id)), new Set([id]));
    assert.deepEqual(new Set(h.audits.map((a) => a.actor)), new Set(['op-a']));
    // No secret may ever reach the trail — neither the created nor the rotated one.
    const serialized = JSON.stringify(h.audits);
    assert.equal(serialized.includes(created.secret), false);
    assert.equal(serialized.includes(`rotated-${id}`), false);
  });

  it('records an audit entry for every subscription mutation', async () => {
    const h = await makeHarness();
    const created = (await (
      await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/hook', event: 'run.completed' }, 'op-b')
    ).json()) as { subscription: ConductorWebhookSubscription };
    const id = created.subscription.id;
    await post(`${h.baseUrl}/webhooks/subscriptions/${id}/rotate-secret`, {}, 'op-b');
    await post(`${h.baseUrl}/webhooks/subscriptions/${id}/status`, { enabled: false }, 'op-b');
    await post(`${h.baseUrl}/webhooks/subscriptions/${id}/payload-scope`, { includeContext: true }, 'op-b');
    await del(`${h.baseUrl}/webhooks/subscriptions/${id}`, 'op-b');

    assert.deepEqual(
      h.audits.map((a) => `${a.kind}.${a.change}`),
      [
        'subscription.create',
        'subscription.rotate_secret',
        'subscription.status',
        'subscription.payload_scope',
        'subscription.delete',
      ],
    );
  });

  it('a delete audit entry describes what was deleted (read before the DELETE)', async () => {
    const h = await makeHarness();
    const created = (await (await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' })).json()) as {
      endpoint: ConductorWebhookEndpoint;
    };
    await del(`${h.baseUrl}/webhooks/endpoints/${created.endpoint.endpointId}`);
    const entry = h.audits.find((a) => a.change === 'delete');
    assert.deepEqual(entry?.before, { eventId: 'orders.created', enabled: true });
  });

  it('an audit-sink failure never fails the mutation the operator already made', async () => {
    const h = await makeHarness({ auditThrows: true });
    const res = await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    assert.equal(res.status, 201);
    assert.equal(h.audits.length, 1);
  });

  // Rotation grace: the old secret used to 401 on the sender's very next request.

  it('rotate-secret passes the configured grace window to the store', async () => {
    const h = await makeHarness({ secretGraceMs: 3_600_000 });
    const created = (await (await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' })).json()) as {
      endpoint: ConductorWebhookEndpoint;
    };
    const res = await post(`${h.baseUrl}/webhooks/endpoints/${created.endpoint.endpointId}/rotate-secret`, {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { secret: string; previousSecretValidUntil: string | null };
    assert.equal(h.endpoints.rotate[0]?.graceMs, 3_600_000);
    assert.notEqual(body.previousSecretValidUntil, null);
    assert.equal(h.audits.at(-1)?.change, 'rotate_secret');
  });

  it('?immediate=true cuts over with no grace — the answer to a leaked secret', async () => {
    const h = await makeHarness({ secretGraceMs: 3_600_000 });
    const created = (await (await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' })).json()) as {
      endpoint: ConductorWebhookEndpoint;
    };
    const res = await post(`${h.baseUrl}/webhooks/endpoints/${created.endpoint.endpointId}/rotate-secret?immediate=true`, {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { previousSecretValidUntil: string | null };
    assert.equal(h.endpoints.rotate[0]?.graceMs, 0);
    assert.equal(body.previousSecretValidUntil, null);
  });

  // The run-context opt-in: the delivery payload used to carry every step result,
  // free-text human responses included, with nothing to turn that off.

  it('a subscription is created WITHOUT the run context unless it opts in', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/a', event: 'run.completed' });
    const body = (await res.json()) as { subscription: ConductorWebhookSubscription };
    assert.equal(body.subscription.includeContext, false);
  });

  it('includeContext must be the boolean true — a truthy string does not opt in', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/webhooks/subscriptions`, {
      url: 'https://example.com/b',
      event: 'run.completed',
      includeContext: 'yes',
    });
    const body = (await res.json()) as { subscription: ConductorWebhookSubscription };
    assert.equal(body.subscription.includeContext, false);
  });

  it('payload-scope flips the opt-in and 400s a non-boolean', async () => {
    const h = await makeHarness();
    const created = (await (
      await post(`${h.baseUrl}/webhooks/subscriptions`, { url: 'https://example.com/c', event: 'run.completed' })
    ).json()) as { subscription: ConductorWebhookSubscription };
    const id = created.subscription.id;

    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions/${id}/payload-scope`, { includeContext: 'yes' })).status, 400);
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions/${id}/payload-scope`, { includeContext: true })).status, 204);
    const listed = (await (await get(`${h.baseUrl}/webhooks/subscriptions`)).json()) as {
      subscriptions: ConductorWebhookSubscription[];
    };
    assert.equal(listed.subscriptions.find((sub) => sub.id === id)?.includeContext, true);
    assert.equal((await post(`${h.baseUrl}/webhooks/subscriptions/unknown/payload-scope`, { includeContext: true })).status, 404);
  });

  // The kill switch was invisible: with CONDUCTOR_WEBHOOKS_ENABLED=false the admin
  // page showed no state at all.

  // Review finding: an unknown id used to answer 204 AND write an audit row, so the
  // trail recorded a state change that never happened.

  it('status on an unknown endpoint 404s and writes no audit row', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/webhooks/endpoints/does-not-exist/status`, { enabled: false });
    assert.equal(res.status, 404);
    assert.deepEqual(h.audits, []);
  });

  it('status on an unknown subscription 404s and writes no audit row', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/webhooks/subscriptions/does-not-exist/status`, { enabled: false });
    assert.equal(res.status, 404);
    assert.deepEqual(h.audits, []);
  });

  it('deleting an id that is already gone stays idempotent (204) but audits nothing', async () => {
    const h = await makeHarness();
    assert.equal((await del(`${h.baseUrl}/webhooks/endpoints/does-not-exist`)).status, 204);
    assert.equal((await del(`${h.baseUrl}/webhooks/subscriptions/does-not-exist`)).status, 204);
    assert.deepEqual(h.audits, [], 'a delete that deleted nothing is not a trail entry');
  });

  it('a real status change still 204s and still audits', async () => {
    const h = await makeHarness();
    const created = (await (await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' })).json()) as {
      endpoint: ConductorWebhookEndpoint;
    };
    const res = await post(`${h.baseUrl}/webhooks/endpoints/${created.endpoint.endpointId}/status`, { enabled: false });
    assert.equal(res.status, 204);
    assert.deepEqual(h.audits.at(-1)?.before, { enabled: true });
    assert.deepEqual(h.audits.at(-1)?.after, { enabled: false });
  });

  // Review finding: `actor_email` was receiving the session SUB, which under Entra is
  // a guid — unreadable for the operator who has to answer "who disabled this?".
  // `auditRoleChange` (the sibling sink) has always preferred the email.
  it('the audit actor label is the session email when there is one', async () => {
    const h = await makeHarness();
    await fetch(`${h.baseUrl}/webhooks/endpoints`, {
      method: 'POST',
      headers: headers('00000000-aaaa-bbbb-cccc-000000000001', 'ops@byte5.de'),
      body: JSON.stringify({ eventId: 'orders.created' }),
    });
    assert.equal(h.audits.at(-1)?.actor, 'ops@byte5.de');
  });

  it('falls back to the sub, then to the operator marker, when no email is present', async () => {
    const h = await makeHarness();
    await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' }, 'sub-only');
    assert.equal(h.audits.at(-1)?.actor, 'sub-only');

    await post(`${h.baseUrl}/webhooks/endpoints`, { eventId: 'orders.created' });
    assert.equal(h.audits.at(-1)?.actor, 'operator');
  });

  it('posture reports the enforced state', async () => {
    const h = await makeHarness({ posture: { configured: true, inboundEnabled: false, requireTimestamp: true } });
    const res = await get(`${h.baseUrl}/webhooks/posture`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { posture: Record<string, unknown> };
    assert.equal(body.posture['inboundEnabled'], false);
    assert.equal(body.posture['requireTimestamp'], true);
  });

  it('posture answers 200 even unwired — "webhooks are off" is the answer it exists to give', async () => {
    const h = await makeHarness({ wired: false });
    const res = await get(`${h.baseUrl}/webhooks/posture`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { posture: Record<string, unknown> };
    assert.equal(body.posture['inboundEnabled'], false);
    assert.equal(body.posture['configured'], false);
  });
});
