import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { WorkflowDisabledError } from '../src/conductor/runExecutor.js';

// #1711 — a workflow instantiated from a template without `enable: true` is
// created `disabled`, and every run start then refuses with 409
// `conductor.disabled`. The web UI maps that code to a sentence and offers the
// enable switch on the row (app/_lib/conductorRunStartError.ts +
// _components/WorkflowStatusToggle.tsx), so this test pins the two halves of
// the contract the UI depends on: the REFUSAL CODE (not just the 409 status)
// and the escape — POST /:slug/status {"status":"enabled"} → 204 → run starts.
//
// Same in-process express harness as conductorEphemeralSlugGuard.test.ts.

const servers: Server[] = [];

async function startApp(): Promise<{ baseUrl: string; statusOf: () => 'enabled' | 'disabled' }> {
  // One mutable workflow, exactly as the operator sees it: created disabled.
  let status: 'enabled' | 'disabled' = 'disabled';
  const deps = {
    workflowStore: {
      setStatus: async (_slug: string, next: 'enabled' | 'disabled') => {
        status = next;
      },
    },
    runStore: {
      stepsForRun: async () => [],
    },
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    executor: {
      // Mirrors runExecutor.startRun: the disabled check precedes any work.
      startRun: async () => {
        if (status === 'disabled') throw new WorkflowDisabledError("workflow 'onb-probe' is disabled");
        return { id: 'run-1', status: 'running' };
      },
    },
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
  return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`, statusOf: () => status };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const JSON_HEADERS = { 'content-type': 'application/json' };

function startRun(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/onb-probe/runs`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ payload: {} }),
  });
}

describe('disabled workflow: refusal code + the operator escape (#1711)', () => {
  it('refuses a run with the code the UI maps, then starts it once enabled', async () => {
    const { baseUrl, statusOf } = await startApp();

    const refused = await startRun(baseUrl);
    const refusedBody = (await refused.json()) as { code?: string };
    assert.equal(refused.status, 409);
    // The CODE, not the status line: it is what the web UI keys its localized
    // sentence on, so a rename here must break this test.
    assert.equal(refusedBody.code, 'conductor.disabled');

    const enabled = await fetch(`${baseUrl}/onb-probe/status`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'enabled' }),
    });
    assert.equal(enabled.status, 204);
    assert.equal(statusOf(), 'enabled');

    const started = await startRun(baseUrl);
    assert.equal(started.status, 202);
  });

  it('disables again from the same route, and the run start refuses once more', async () => {
    const { baseUrl } = await startApp();

    await fetch(`${baseUrl}/onb-probe/status`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'enabled' }),
    });
    const off = await fetch(`${baseUrl}/onb-probe/status`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(off.status, 204);

    const refused = await startRun(baseUrl);
    const body = (await refused.json()) as { code?: string };
    assert.equal(refused.status, 409);
    assert.equal(body.code, 'conductor.disabled');
  });
});
