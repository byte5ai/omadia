import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRoutinesRouter } from '../src/routes/routines.js';
import type { RoutineRunner } from '../src/plugins/routines/routineRunner.js';
import type { RoutineRunsStore } from '../src/plugins/routines/routineRunsStore.js';
import type {
  Routine,
  RoutineStore,
} from '../src/plugins/routines/routineStore.js';

/**
 * Contract lock for `GET /api/v1/routines` (customer findings OM-14 / OM-32).
 *
 * The web-ui now validates this payload (`expectArray` in app/_lib/api.ts) and
 * turns a malformed body into a caught ApiError rather than letting the page
 * crash on `routines.filter(...)`. That only helps if the happy path really is
 * `{routines: [], count: 0}` — in particular, an *empty* store must still emit
 * the `routines` key rather than `{}` or `{count: 0}`, otherwise a fresh
 * install would trip the new validation on every load.
 */

function makeRoutine(id: string): Routine {
  const now = new Date();
  return {
    id,
    tenant: 'tenant-A',
    userId: 'user-1',
    name: 'demo',
    cron: '*/30 * * * *',
    prompt: 'Hi.',
    channel: 'teams',
    conversationRef: {},
    status: 'active',
    timeoutMs: 600_000,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    outputTemplate: null,
  };
}

class StubStore {
  public rows: Routine[] = [];
  public failWith: Error | null = null;

  async listAll(): Promise<Routine[]> {
    if (this.failWith) throw this.failWith;
    return this.rows;
  }
}

interface Harness {
  server: Server;
  baseUrl: string;
  store: StubStore;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const store = new StubStore();
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/v1/routines',
    createRoutinesRouter({
      store: store as unknown as RoutineStore,
      runsStore: {} as RoutineRunsStore,
      runner: {} as RoutineRunner,
      log: () => {},
    }),
  );

  return new Promise<Harness>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        store,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              r();
            });
          }),
      });
    });
  });
}

describe('GET /v1/routines — list contract the web-ui validates against', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('returns 200 {routines: [], count: 0} on an empty store', async () => {
    const res = await fetch(`${h.baseUrl}/v1/routines`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { routines: unknown; count: unknown };
    // The key must be PRESENT and an array — not omitted, not null.
    assert.ok(
      Object.hasOwn(body, 'routines'),
      'empty store must still emit the "routines" key',
    );
    assert.ok(Array.isArray(body.routines), '"routines" must be an array');
    assert.equal((body.routines as unknown[]).length, 0);
    assert.equal(body.count, 0);
  });

  it('returns the rows and a matching count when routines exist', async () => {
    h.store.rows = [makeRoutine('r1'), makeRoutine('r2')];

    const res = await fetch(`${h.baseUrl}/v1/routines`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      routines: Array<{ id: string }>;
      count: number;
    };
    assert.ok(Array.isArray(body.routines));
    assert.equal(body.routines.length, 2);
    assert.equal(body.count, 2);
    assert.deepEqual(
      body.routines.map((r) => r.id),
      ['r1', 'r2'],
    );
  });

  it('surfaces a store failure as 500 routines.list_failed — never a 200 with a bad shape', async () => {
    h.store.failWith = new Error('connection terminated');

    const res = await fetch(`${h.baseUrl}/v1/routines`);
    assert.equal(res.status, 500);

    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'routines.list_failed');
  });
});
