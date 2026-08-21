import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';

// #330 — the 'eph-' slug prefix is the ephemeral namespace: the manual create
// route AND the template-instantiate route must reject it before touching any
// store, so a user-authored workflow can never collide with the reaper's
// lifecycle. Same in-process express harness as conductorTemplateRoutes.test.ts.

const servers: Server[] = [];

async function startApp(): Promise<{ baseUrl: string; publishCalls: number[] }> {
  const publishCalls: number[] = [];
  const deps = {
    workflowStore: {
      createOrPublish: async () => {
        publishCalls.push(1);
        throw new Error('unexpected publish in slug-guard test');
      },
    },
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    executor: {},
    eventRouter: {},
    templateKnownRefs: async () => ({ agentIds: [], actionIds: [], roleKeys: [], eventIds: [] }),
  } as unknown as ConductorRouterDeps;

  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`, publishCalls };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const JSON_HEADERS = { 'content-type': 'application/json' };

describe("reserved 'eph-' slug prefix (#330)", () => {
  it("POST / rejects an 'eph-' slug before any store access", async () => {
    const { baseUrl, publishCalls } = await startApp();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'eph-sneaky', name: 'Sneaky', graph: {} }),
    });
    const body = (await res.json()) as { code?: string };

    assert.equal(res.status, 400);
    assert.equal(body.code, 'conductor.reserved_slug_prefix');
    assert.equal(publishCalls.length, 0);
  });

  it('POST / still validates ordinary slugs normally (guard is prefix-scoped)', async () => {
    const { baseUrl } = await startApp();
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'ordinary', name: 'Ordinary', graph: {} }),
    });
    const body = (await res.json()) as { code?: string };

    assert.equal(res.status, 400);
    assert.equal(body.code, 'conductor.invalid_graph'); // past the guard, into validate()
  });

  it("POST /:slug/status rejects 'eph-' workflows — the reaper owns their lifecycle", async () => {
    const { baseUrl } = await startApp();
    const res = await fetch(`${baseUrl}/eph-demo-1/status`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'enabled' }),
    });
    const body = (await res.json()) as { code?: string };

    assert.equal(res.status, 400);
    assert.equal(body.code, 'conductor.reserved_slug_prefix');
  });

  it("POST /:slug/runs rejects manual runs on 'eph-' workflows", async () => {
    const { baseUrl } = await startApp();
    const res = await fetch(`${baseUrl}/eph-demo-1/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ payload: {} }),
    });
    const body = (await res.json()) as { code?: string };

    assert.equal(res.status, 400);
    assert.equal(body.code, 'conductor.reserved_slug_prefix');
  });

  it("POST /templates/:id/instantiate rejects an 'eph-' slug before template resolution", async () => {
    const { baseUrl, publishCalls } = await startApp();
    const res = await fetch(`${baseUrl}/templates/anything/instantiate`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'eph-sneaky' }),
    });
    const body = (await res.json()) as { code?: string };

    assert.equal(res.status, 400);
    assert.equal(body.code, 'conductor.reserved_slug_prefix');
    assert.equal(publishCalls.length, 0);
  });
});
