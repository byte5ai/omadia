import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';

// `GET /people` — the people-directory union for human-step principals. Same
// in-process express harness as the other conductor router tests.

const servers: Server[] = [];

async function startApp(extra: Partial<ConductorRouterDeps>): Promise<string> {
  const deps = {
    workflowStore: { getBySlug: async () => undefined },
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    executor: {},
    eventRouter: {},
    ...extra,
  } as unknown as ConductorRouterDeps;
  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/operator/conductors`;
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('GET /people', () => {
  it('400s on a missing or too-short query', async () => {
    const base = await startApp({});
    assert.equal((await fetch(`${base}/people`)).status, 400);
    assert.equal((await fetch(`${base}/people?q=t`)).status, 400);
  });

  it('answers an empty, non-partial result when no directory is wired (not 503)', async () => {
    const base = await startApp({});
    const res = await fetch(`${base}/people?q=ter`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { people: [], partial: false, channelTypes: [] });
  });

  it('returns people + partial + channelTypes and passes clamped limit/channel through', async () => {
    const seen: Array<{ query: string; opts: { limit: number; channelType?: string } }> = [];
    const base = await startApp({
      peopleChannelTypes: () => ['teams'],
      searchPeople: async (query, opts) => {
        seen.push({ query, opts });
        return { people: [{ principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel', channelType: 'teams', channelUserId: 'aad-oid-secret', hint: 'Finance' }], partial: true };
      },
    });
    const res = await fetch(`${base}/people?q=Teresita&limit=999&channel=teams`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { people: Record<string, unknown>[]; partial: boolean; channelTypes: string[] };
    assert.equal(body.people.length, 1);
    assert.deepEqual(body.people[0], { principalRef: 'teresita.biel@byte5.de', displayName: 'Teresita Biel', channelType: 'teams', hint: 'Finance' }, 'channelUserId never leaves the server');
    assert.equal(body.partial, true);
    assert.deepEqual(body.channelTypes, ['teams']);
    assert.deepEqual(seen, [{ query: 'Teresita', opts: { limit: 25, channelType: 'teams' } }]);

    await fetch(`${base}/people?q=te&limit=0`);
    assert.equal(seen[1]?.opts.limit, 1);
    await fetch(`${base}/people?q=te`);
    assert.equal(seen[2]?.opts.limit, 10);
    assert.equal(seen[2]?.opts.channelType, undefined);
  });

  it('500s with a generic code when the registry throws — no provider message leaks', async () => {
    const base = await startApp({
      searchPeople: async () => {
        throw new Error('graph.microsoft.com refused: tenant xyz');
      },
    });
    const res = await fetch(`${base}/people?q=ter`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'conductor.people_search_failed');
    assert.equal(body.message.includes('tenant'), false);
  });

  it('rate-limits directory enumeration per caller (60/min → 429)', async () => {
    const base = await startApp({ searchPeople: async () => ({ people: [], partial: false }) });
    let last = 0;
    for (let i = 0; i < 60; i += 1) last = (await fetch(`${base}/people?q=aa`)).status;
    assert.equal(last, 200);
    const limited = await fetch(`${base}/people?q=aa`);
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { code: string }).code, 'conductor.rate_limited');
  });

  it('is not swallowed by the /:slug catch-all', async () => {
    const base = await startApp({});
    const res = await fetch(`${base}/people?q=ter`);
    assert.equal(res.status, 200); // a /:slug lookup would 404
  });
});
