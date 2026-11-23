import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import express from 'express';

import type { ConductorAwaitStore } from '../src/conductor/awaitStore.js';
import type { ConductorFacilitationAdmin } from '../src/conductor/facilitationAdmin.js';
import type { ConductorRunStore } from '../src/conductor/runStore.js';
import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1706 — `conductor_runs.id`, `conductor_awaits.id` and `conductor_workflows.id`
 * are `uuid` columns, and the operator routes passed the caller's id to the store
 * unchecked. Postgres rejected a malformed one with
 * `22P02 invalid input syntax for type uuid: "999"`, each handler's catch-all
 * copied that message into the response, and the operator got a 500 carrying the
 * database error (`conductor.get_run_failed`, `conductor.cancel_failed`,
 * `conductor.respond_failed`, `conductor.facilitation_terminate_failed`).
 *
 * The router now refuses the shape first: 400 for an id that cannot name a row,
 * and the handler's own 404 for a well-formed id that names none. Every store
 * method in the first harness throws the way Postgres would, so a request that
 * still reaches one fails the test with a 500 instead of passing quietly.
 */
const pg22P02 = (): never => {
  throw new Error('invalid input syntax for type uuid: "999"');
};
const throwingProxy = <T>(): T => new Proxy({}, { get: () => pg22P02 }) as unknown as T;

const servers: Server[] = [];

async function harness(deps: Partial<ConductorRouterDeps>): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/conductors', createConductorRouter(deps as ConductorRouterDeps));
  const server = await listenLoopback(app);
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/conductors`;
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000001';

describe('conductor router — malformed ids (#1706)', () => {
  const cases: ReadonlyArray<readonly [string, string, unknown]> = [
    ['GET', '/orders/runs/999', undefined],
    ['POST', '/orders/runs/999/cancel', {}],
    ['POST', '/awaits/999/respond', { response: { approved: true } }],
    ['POST', '/facilitations/999/terminate', {}],
  ];

  for (const [method, path, body] of cases) {
    it(`${method} ${path} answers 400 without touching the store`, async () => {
      const baseUrl = await harness({
        workflowStore: throwingProxy<ConductorWorkflowStore>(),
        runStore: throwingProxy<ConductorRunStore>(),
        awaitStore: throwingProxy<ConductorAwaitStore>(),
        executor: throwingProxy<ConductorRouterDeps['executor']>(),
        facilitationAdmin: throwingProxy<ConductorFacilitationAdmin>(),
      });
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      assert.equal(res.status, 400);
      const json = (await res.json()) as { code: string; message: string };
      assert.equal(json.code, 'conductor.invalid_input');
      assert.doesNotMatch(json.message, /invalid input syntax/);
    });
  }

  // The guard is registered per parameter NAME, so the slug-shaped ids on the
  // same router must keep working: ':id' belongs to the template routes
  // ('notify-and-escalate'), which is why the webhook subscription routes name
  // theirs ':subscriptionId'.
  it('leaves the slug-shaped template id alone', async () => {
    const baseUrl = await harness({
      workflowStore: throwingProxy<ConductorWorkflowStore>(),
      runStore: throwingProxy<ConductorRunStore>(),
      awaitStore: throwingProxy<ConductorAwaitStore>(),
      executor: throwingProxy<ConductorRouterDeps['executor']>(),
    });
    const res = await fetch(`${baseUrl}/templates/notify-and-escalate`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_not_found');
  });
});

describe('conductor router — well-formed ids that name no row (#1706)', () => {
  /** Real executor over empty stores: `resolveAwait` must distinguish "no such
   *  await row" from "this await is closed", which used to be one 409. */
  function executorOverEmptyStores(): ConductorRunExecutor {
    return new ConductorRunExecutor({
      workflowStore: { getBySlug: async () => null, getById: async () => null } as unknown as ConductorWorkflowStore,
      runStore: { get: async () => null } as unknown as ConductorRunStore,
      awaitStore: { get: async () => null } as unknown as ConductorAwaitStore,
      effects: {} as never,
      resolveRoleHolders: async () => ({ holders: [], partial: false, bySource: [] }),
    });
  }

  it('respond answers 404, not the 409 that reads as "your await is closed"', async () => {
    const baseUrl = await harness({
      workflowStore: { getBySlug: async () => null } as unknown as ConductorWorkflowStore,
      runStore: { get: async () => null } as unknown as ConductorRunStore,
      awaitStore: { get: async () => null } as unknown as ConductorAwaitStore,
      executor: executorOverEmptyStores(),
    });
    const res = await fetch(`${baseUrl}/awaits/${UNKNOWN_UUID}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { approved: true } }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.not_found');
  });

  it('a run id with no row behind it keeps its 404', async () => {
    const baseUrl = await harness({
      workflowStore: { getBySlug: async () => null } as unknown as ConductorWorkflowStore,
      runStore: { get: async () => null } as unknown as ConductorRunStore,
      awaitStore: { get: async () => null } as unknown as ConductorAwaitStore,
      executor: executorOverEmptyStores(),
    });
    const res = await fetch(`${baseUrl}/orders/runs/${UNKNOWN_UUID}`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.not_found');
  });
});
