import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import type { RoutineRunner } from '../src/plugins/routines/routineRunner.js';
import type { RoutineRunsStore } from '../src/plugins/routines/routineRunsStore.js';
import type { RoutineStore } from '../src/plugins/routines/routineStore.js';
import { createRoutinesRouter } from '../src/routes/routines.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1398 — `routines.id` and `routine_runs.id` are uuid columns. A malformed id
 * used to reach Postgres, fail with 22P02 and come back as a 500 carrying the
 * database message. It now answers the route's own 404 without touching the
 * store. Every store/runner method here throws the way Postgres would, so a
 * request that still reaches one fails the test with a 500.
 */
const pg22P02 = (): never => {
  throw new Error('invalid input syntax for type uuid: "999"');
};
const throwingProxy = <T>(): T =>
  new Proxy({}, { get: () => pg22P02 }) as unknown as T;

describe('routines router — malformed ids (#1398)', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/v1/routines',
      createRoutinesRouter({
        store: throwingProxy<RoutineStore>(),
        runsStore: throwingProxy<RoutineRunsStore>(),
        runner: throwingProxy<RoutineRunner>(),
        log: () => {},
      }),
    );
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const validId = '00000000-0000-4000-8000-000000000001';
  const cases: ReadonlyArray<readonly [string, string, string, unknown]> = [
    ['GET', '/999/runs/999', 'routines.not_found', undefined],
    ['GET', `/${validId}/runs/999`, 'routines.run_not_found', undefined],
    ['GET', '/999/runs', 'routines.not_found', undefined],
    ['PATCH', '/999/status', 'routines.not_found', { status: 'paused' }],
    ['POST', '/999/trigger', 'routines.not_found', undefined],
    ['PUT', '/999/template', 'routines.not_found', { template: null }],
    ['DELETE', '/999', 'routines.not_found', undefined],
  ];

  for (const [method, path, code, body] of cases) {
    it(`${method} ${path} answers 404 ${code}`, async () => {
      const res = await fetch(`${baseUrl}/v1/routines${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 404);
      const json = (await res.json()) as { code: string; message: string };
      assert.equal(json.code, code);
      assert.doesNotMatch(json.message, /invalid input syntax/);
    });
  }

  it('leaves the id-less preview route alone', async () => {
    const res = await fetch(`${baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'routines.template_missing');
  });
});
