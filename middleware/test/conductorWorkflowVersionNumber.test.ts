import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import type { ConductorWorkflow } from '../src/conductor/workflowStore.js';

// The API exposed only `activeVersionId`; the number behind it came back from
// the publish response alone, so a list or a reload could not show `v4`. The SQL
// itself runs against real Postgres in conductorWorkflowStore.pg.test.ts.

const ROW = {
  id: 'wf-1',
  slug: 'demo',
  name: 'Demo',
  description: null,
  status: 'enabled',
  active_version_id: 'ver-4',
  active_version_number: 4,
  template_id: null,
  template_version: null,
  origin: 'manual',
  expires_at: null,
  created_by_agent: null,
  reaped_at: null,
};

function rowPool(rows: unknown[]): Pool {
  return { query: async () => ({ rows }) } as unknown as Pool;
}

describe('ConductorWorkflowStore activeVersionNumber', () => {
  it('maps the number on list() and getBySlug()', async () => {
    const store = new ConductorWorkflowStore(rowPool([ROW]));
    const [listed] = await store.list();
    assert.equal(listed?.activeVersionNumber, 4);
    const bySlug = await store.getBySlug('demo');
    assert.equal(bySlug?.activeVersionNumber, 4);
  });

  it('stays null for a workflow without an active version', async () => {
    const store = new ConductorWorkflowStore(
      rowPool([{ ...ROW, active_version_id: null, active_version_number: null }]),
    );
    const [listed] = await store.list();
    assert.equal(listed?.activeVersionNumber, null);
  });
});

describe('Conductor routes activeVersionNumber', () => {
  const servers: Server[] = [];

  after(async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  async function harness(): Promise<string> {
    const workflow: ConductorWorkflow = {
      id: 'wf-1',
      slug: 'demo',
      name: 'Demo',
      description: null,
      status: 'enabled',
      activeVersionId: 'ver-4',
      activeVersionNumber: 4,
    };
    const deps = {
      workflowStore: {
        list: async () => [workflow],
        getBySlug: async () => workflow,
        getVersion: async () => ({ id: 'ver-4', workflowId: 'wf-1', version: 4, graph: {} }),
      },
      runStore: {},
      awaitStore: {},
      roleStore: {},
      scheduleStore: {},
      executor: {},
      eventRouter: {},
    } as unknown as ConductorRouterDeps;
    const app: Express = express();
    app.use('/conductors', createConductorRouter(deps));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it('GET / carries the number on every workflow', async () => {
    const res = await fetch(`${await harness()}/conductors`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { workflows: ConductorWorkflow[] };
    assert.equal(body.workflows[0]?.activeVersionNumber, 4);
  });

  it('GET /:slug carries the number on the workflow', async () => {
    const res = await fetch(`${await harness()}/conductors/demo`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { workflow: ConductorWorkflow };
    assert.equal(body.workflow.activeVersionNumber, 4);
  });
});
