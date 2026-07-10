import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import type { TemplateManifest, WorkflowGraph } from '@omadia/conductor-core';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { WorkflowSlugExistsError } from '../src/conductor/workflowStore.js';
import type { ConductorWorkflow } from '../src/conductor/workflowStore.js';

// Conductor workflow-template routes (#429): GET /templates, POST /templates/:id/resolve
// (ephemeral, the #330 seam), POST /templates/:id/instantiate (publish through the
// ordinary createOrPublish path). Stub-dep express harness, same pattern as the other
// route tests — no DB.

/** Fixture manifest: one agent slot + one role slot, minimal valid two-step graph.
 *  Metadata + the worker label are localized records ({ en, de }); the approver slot
 *  stays a plain string to prove both LocalizedText shapes survive the routes. */
function fixtureManifest(): TemplateManifest {
  return {
    id: 'fixture-approval',
    name: { en: 'Fixture approval', de: 'Fixture-Freigabe' },
    description: { en: 'Two-step approval used by the route tests.', de: 'Zweistufige Freigabe für die Route-Tests.' },
    useCase: 'approval',
    defaultSlug: 'fixture-approval',
    graph: {
      entryStepId: 'work',
      steps: [
        { id: 'work', kind: 'agent', agentId: 'slot:agent:worker', prompt: 'Do the work.' },
        {
          id: 'approve',
          kind: 'human',
          human: {
            principal: { kind: 'role', ref: 'slot:role:approver' },
            channel: 'teams',
            message: 'Approve the result?',
          },
        },
      ],
      transitions: [{ id: 't-done', source: 'work', target: 'approve' }],
    },
    slots: {
      agents: [{ key: 'worker', label: { en: 'Worker agent', de: 'Arbeits-Agent' } }],
      roles: [{ key: 'approver', label: 'Approver role' }],
    },
  };
}

const KNOWN_AGENT = 'real-agent';
const KNOWN_ROLE = 'real-role';

function completeMapping(): Record<string, Record<string, string>> {
  return { agents: { worker: KNOWN_AGENT }, roles: { approver: KNOWN_ROLE } };
}

interface PublishCall {
  slug: string;
  name: string;
  description?: string | null;
  graph: WorkflowGraph;
  enable?: boolean;
  expectNew?: boolean;
  onPublished?: (client: PoolClient, workflowId: string) => Promise<void>;
}

interface Harness {
  baseUrl: string;
  publishCalls: PublishCall[];
  reconcileCalls: Array<{ workflowId: string; graph: WorkflowGraph }>;
  /** slugs GET-by-slug reports as taken. */
  existingSlugs: Set<string>;
}

const servers: Server[] = [];

async function makeHarness(opts?: { withCatalog?: boolean }): Promise<Harness> {
  const publishCalls: PublishCall[] = [];
  const reconcileCalls: Array<{ workflowId: string; graph: WorkflowGraph }> = [];
  const existingSlugs = new Set<string>();
  const manifest = fixtureManifest();

  const workflowStore = {
    getBySlug: async (slug: string): Promise<ConductorWorkflow | null> =>
      existingSlugs.has(slug)
        ? { id: 'wf-existing', slug, name: 'existing', description: null, status: 'disabled', activeVersionId: null }
        : null,
    createOrPublish: async (input: PublishCall) => {
      publishCalls.push(input);
      // Mirrors the real store's atomic create-only semantics: in expectNew mode a
      // taken slug fails the INSERT (WorkflowSlugExistsError), never a pre-check.
      if (input.expectNew && existingSlugs.has(input.slug)) throw new WorkflowSlugExistsError(input.slug);
      return {
        workflow: {
          id: 'wf-1',
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          status: input.enable ? 'enabled' : 'disabled',
          activeVersionId: 'ver-1',
        },
        version: { id: 'ver-1', workflowId: 'wf-1', version: 1, graph: input.graph },
      };
    },
  };

  const scheduleStore = {
    reconcileOnClient: async (_client: PoolClient, workflowId: string, graph: WorkflowGraph): Promise<void> => {
      reconcileCalls.push({ workflowId, graph });
    },
  };

  const deps = {
    workflowStore,
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore,
    executor: {},
    eventRouter: {},
    ...(opts?.withCatalog === false
      ? {}
      : {
          templateCatalog: {
            list: () => [manifest],
            get: (id: string) => (id === manifest.id ? manifest : undefined),
          },
        }),
    templateKnownRefs: async () => ({
      agentIds: [KNOWN_AGENT],
      actionIds: [],
      roleKeys: [KNOWN_ROLE],
      eventIds: [],
    }),
  } as unknown as ConductorRouterDeps;

  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`, publishCalls, reconcileCalls, existingSlugs };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('GET /templates', () => {
  it('returns the full manifests including graph and slot declarations', async () => {
    const h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/templates`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { templates: TemplateManifest[] };
    assert.equal(body.templates.length, 1);
    const [tpl] = body.templates;
    assert.equal(tpl!.id, 'fixture-approval');
    // Localized fields pass through UNRESOLVED — the catalog stays machine-readable
    // (#330) and the client resolves the active locale itself.
    assert.deepEqual(tpl!.name, { en: 'Fixture approval', de: 'Fixture-Freigabe' });
    assert.deepEqual(tpl!.slots.agents, [{ key: 'worker', label: { en: 'Worker agent', de: 'Arbeits-Agent' } }]);
    assert.deepEqual(tpl!.slots.roles, [{ key: 'approver', label: 'Approver role' }]);
    assert.equal(tpl!.graph.steps[0]!.agentId, 'slot:agent:worker');
  });

  it('returns an empty catalog when no templateCatalog dep is wired', async () => {
    const h = await makeHarness({ withCatalog: false });
    const res = await fetch(`${h.baseUrl}/templates`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { templates: [] });
  });

  it('is NOT swallowed by the /:slug catch-all workflow route (route-order regression)', async () => {
    // getBySlug('templates') would return null → the '/:slug' handler answers
    // 404 conductor.not_found. Getting the catalog instead proves route order.
    const h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/templates`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.templates), `expected a catalog response, got: ${JSON.stringify(body)}`);
    assert.equal(body.code, undefined);
  });
});

describe('POST /templates/:id/resolve', () => {
  it('substitutes a complete mapping and returns the validated graph, zero placeholders', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/resolve`, { mapping: completeMapping() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { graph: WorkflowGraph };
    assert.equal(body.graph.steps[0]!.agentId, KNOWN_AGENT);
    assert.equal(body.graph.steps[1]!.human!.principal.ref, KNOWN_ROLE);
    assert.ok(!JSON.stringify(body.graph).includes('slot:'), 'resolved graph still contains a placeholder');
  });

  it('rejects an incomplete mapping fail-clear, listing exactly the missing slots', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/resolve`, {
      mapping: { agents: { worker: KNOWN_AGENT } }, // role mapping missing
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; missing: unknown };
    assert.equal(body.code, 'conductor.template_slot_mapping_incomplete');
    assert.deepEqual(body.missing, [{ kind: 'roles', key: 'approver', label: 'Approver role' }]);
  });

  it('rejects a mapping to a nonexistent agent with the live-refs validation codes', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/resolve`, {
      mapping: { agents: { worker: 'no-such-agent' }, roles: { approver: KNOWN_ROLE } },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; errors: Array<{ code: string }> };
    assert.equal(body.code, 'conductor.invalid_graph');
    assert.ok(body.errors.some((e) => e.code === 'unknown_agent_ref'), JSON.stringify(body.errors));
  });

  it('404s on an unknown template id', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/does-not-exist/resolve`, { mapping: completeMapping() });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_not_found');
  });
});

describe('POST /templates/:id/instantiate', () => {
  it('publishes the substituted graph via createOrPublish (defaults: disabled, manifest name/description)', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, {
      slug: 'my-approval',
      mapping: completeMapping(),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { workflow: ConductorWorkflow; version: { id: string; version: number } };
    assert.equal(body.workflow.slug, 'my-approval');
    assert.deepEqual(body.version, { id: 'ver-1', version: 1 });

    assert.equal(h.publishCalls.length, 1);
    const call = h.publishCalls[0]!;
    assert.equal(call.slug, 'my-approval');
    assert.equal(call.name, 'Fixture approval'); // defaults to manifest.name, resolved to its en base
    assert.equal(call.description, 'Two-step approval used by the route tests.'); // en-resolved too
    assert.equal(call.enable, false); // enable defaults to false
    assert.equal(call.expectNew, true); // create-only publish — the atomic "create new" contract
    assert.equal(call.graph.steps[0]!.agentId, KNOWN_AGENT); // substituted, not the placeholder

    // onPublished is wired to the atomic cron-schedule reconcile.
    assert.equal(typeof call.onPublished, 'function');
    await call.onPublished!({} as PoolClient, 'wf-1');
    assert.equal(h.reconcileCalls.length, 1);
    assert.equal(h.reconcileCalls[0]!.workflowId, 'wf-1');
    assert.equal(h.reconcileCalls[0]!.graph, call.graph);
  });

  it('honors explicit name/description/enable overrides', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, {
      slug: 'named',
      name: 'Custom name',
      description: 'Custom description',
      enable: true,
      mapping: completeMapping(),
    });
    assert.equal(res.status, 201);
    assert.equal(h.publishCalls[0]!.name, 'Custom name');
    assert.equal(h.publishCalls[0]!.description, 'Custom description');
    assert.equal(h.publishCalls[0]!.enable, true);
  });

  it('409s on a slug collision — surfaced by the atomic create-only publish, no republish', async () => {
    const h = await makeHarness();
    h.existingSlugs.add('taken');
    const res = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, {
      slug: 'taken',
      mapping: completeMapping(),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'conductor.slug_exists');
    assert.ok(body.message.includes("'taken'"), body.message);
    // The collision travels through createOrPublish's expectNew mode (one attempted,
    // failed create) — there is no racy getBySlug pre-check left to bypass.
    assert.equal(h.publishCalls.length, 1);
    assert.equal(h.publishCalls[0]!.expectNew, true);
    assert.equal(h.reconcileCalls.length, 0);
  });

  it("does not leak create-only semantics into POST / — the designer's upsert stays", async () => {
    const h = await makeHarness();
    const res = await post(h.baseUrl, {
      slug: 'existing-or-not',
      name: 'Ordinary publish',
      graph: fixtureManifest().graph, // structurally valid; placeholders are plain strings for POST /
    });
    assert.equal(res.status, 201);
    assert.equal(h.publishCalls.length, 1);
    assert.equal(h.publishCalls[0]!.expectNew, undefined);
  });

  it('400s on a missing slug', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, { mapping: completeMapping() });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.invalid_input');
    assert.equal(h.publishCalls.length, 0);
  });

  it('mirrors resolve error handling: 404 unknown id, 400 incomplete mapping, 400 invalid graph', async () => {
    const h = await makeHarness();

    const notFound = await post(`${h.baseUrl}/templates/does-not-exist/instantiate`, { slug: 'x', mapping: completeMapping() });
    assert.equal(notFound.status, 404);
    assert.equal(((await notFound.json()) as { code: string }).code, 'conductor.template_not_found');

    const incomplete = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, { slug: 'x', mapping: {} });
    assert.equal(incomplete.status, 400);
    const incompleteBody = (await incomplete.json()) as { code: string; missing: Array<{ kind: string; key: string }> };
    assert.equal(incompleteBody.code, 'conductor.template_slot_mapping_incomplete');
    assert.deepEqual(
      incompleteBody.missing.map((m) => `${m.kind}:${m.key}`).sort(),
      ['agents:worker', 'roles:approver'],
    );

    const invalid = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, {
      slug: 'x',
      mapping: { agents: { worker: KNOWN_AGENT }, roles: { approver: 'no-such-role' } },
    });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { code: string; errors: Array<{ code: string }> };
    assert.equal(invalidBody.code, 'conductor.invalid_graph');
    assert.ok(invalidBody.errors.some((e) => e.code === 'unknown_role_ref'), JSON.stringify(invalidBody.errors));

    assert.equal(h.publishCalls.length, 0);
  });
});
