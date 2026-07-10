import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express, Request } from 'express';
import type { PoolClient } from 'pg';
import type { TemplateManifest, WorkflowGraph } from '@omadia/conductor-core';

import { applyTemplateSlots } from '@omadia/conductor-core';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { WorkflowSlugExistsError } from '../src/conductor/workflowStore.js';
import type { ConductorWorkflow } from '../src/conductor/workflowStore.js';
import { TemplateIdExistsError } from '../src/conductor/templateStore.js';
import type { ConductorTemplateStore, TemplateRecord, TemplateStatus } from '../src/conductor/templateStore.js';
import { createCompositeTemplateCatalog } from '../src/conductor/templateCatalog.js';
import type { CompositeTemplateCatalog, TemplateSummary } from '../src/conductor/templateCatalog.js';
import type { WorkflowWithTemplateHint } from '../src/conductor/templateHints.js';

// Conductor workflow-template routes: the #429 surface (GET /templates, resolve,
// instantiate) plus the #478 v2 surface (CRUD, versioning, viewer-scoped
// visibility incl. the reviewer-reachable pending rule, provenance + telemetry).
// Express harness over the REAL composite catalog with an in-memory template
// store and a stub workflow store — no DB. Viewer identity is injected from the
// `x-viewer` header (default 'operator', matching the route fallback).

/** Fixture manifest: one agent slot + one role slot, minimal valid two-step graph.
 *  Metadata + the worker label are localized records ({ en, de }); the approver slot
 *  stays a plain string to prove both LocalizedText shapes survive the routes. */
function fixtureManifest(id = 'fixture-approval'): TemplateManifest {
  return {
    id,
    name: { en: 'Fixture approval', de: 'Fixture-Freigabe' },
    description: { en: 'Two-step approval used by the route tests.', de: 'Zweistufige Freigabe für die Route-Tests.' },
    useCase: 'approval',
    defaultSlug: id,
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

interface FakeTemplateStore {
  store: ConductorTemplateStore;
  instantiations: Array<{ templateId: string; templateName: string; version: number; workflowSlug: string }>;
  stamps: Array<{ workflowId: string; templateId: string; version: number }>;
}

/** In-memory ConductorTemplateStore — the composite catalog and routes run for
 *  real on top of it; only the SQL layer is faked (covered by
 *  conductorTemplateStore.test.ts). */
function fakeTemplateStore(): FakeTemplateStore {
  const rows = new Map<string, { createdBy: string; status: TemplateStatus; latestVersion: number; reviewedBy: string | null; versions: Map<number, TemplateManifest> }>();
  const instantiations: FakeTemplateStore['instantiations'] = [];
  const stamps: FakeTemplateStore['stamps'] = [];
  const NOW = '2026-07-10T00:00:00.000Z';

  const record = (id: string): TemplateRecord | undefined => {
    const r = rows.get(id);
    if (!r) return undefined;
    return {
      id,
      createdBy: r.createdBy,
      status: r.status,
      latestVersion: r.latestVersion,
      reviewedBy: r.reviewedBy,
      createdAt: NOW,
      updatedAt: NOW,
      manifest: { ...r.versions.get(r.latestVersion)!, version: r.latestVersion },
    };
  };

  const store: ConductorTemplateStore = {
     
    async create(manifest, createdBy) {
      if (rows.has(manifest.id)) throw new TemplateIdExistsError(manifest.id);
      rows.set(manifest.id, { createdBy, status: 'private', latestVersion: 1, reviewedBy: null, versions: new Map([[1, manifest]]) });
      return record(manifest.id)!;
    },
     
    async addVersion(id, manifest) {
      const r = rows.get(id);
      if (!r) return undefined;
      r.latestVersion += 1;
      r.versions.set(r.latestVersion, manifest);
      return record(id);
    },
     
    async get(id) {
      return record(id);
    },
     
    async list() {
      return [...rows.keys()].sort().map((id) => record(id)!);
    },
     
    async delete(id) {
      return rows.delete(id);
    },
     
    async setStatus(id, status, reviewedBy) {
      const r = rows.get(id);
      if (!r) return undefined;
      r.status = status;
      if (reviewedBy !== undefined) r.reviewedBy = reviewedBy;
      return record(id);
    },
     
    async listVersions(id) {
      const r = rows.get(id);
      return r ? [...r.versions.keys()].sort((a, b) => a - b).map((version) => ({ version, createdAt: NOW })) : [];
    },
     
    async getVersion(id, version) {
      const m = rows.get(id)?.versions.get(version);
      return m ? { ...m, version } : undefined;
    },
     
    async recordInstantiation(input) {
      instantiations.push(input);
    },
     
    async instantiationCounts() {
      const counts: Record<string, number> = {};
      for (const i of instantiations) counts[i.templateId] = (counts[i.templateId] ?? 0) + 1;
      return counts;
    },
     
    async stampWorkflowProvenance(_client, workflowId, templateId, version) {
      stamps.push({ workflowId, templateId, version });
    },
  };
  return { store, instantiations, stamps };
}

interface Harness {
  baseUrl: string;
  publishCalls: PublishCall[];
  reconcileCalls: Array<{ workflowId: string; graph: WorkflowGraph }>;
  /** slugs GET-by-slug reports as taken. */
  existingSlugs: Set<string>;
  templateStore: ConductorTemplateStore;
  instantiations: FakeTemplateStore['instantiations'];
  stamps: FakeTemplateStore['stamps'];
  /** seedable workflow rows served by the fake store's list/getBySlug (#478). */
  workflowRows: ConductorWorkflow[];
  /** seedable version rows keyed by version id, served by getVersion (#478). */
  versionRows: Map<string, { id: string; workflowId: string; version: number; graph: WorkflowGraph }>;
  /** the REAL composite catalog — exposes the plugin registration seam (#478). */
  catalog?: CompositeTemplateCatalog;
}

const servers: Server[] = [];

async function makeHarness(opts?: { withCatalog?: boolean }): Promise<Harness> {
  const publishCalls: PublishCall[] = [];
  const reconcileCalls: Array<{ workflowId: string; graph: WorkflowGraph }> = [];
  const existingSlugs = new Set<string>();
  const manifest = fixtureManifest();
  const fake = fakeTemplateStore();
  const workflowRows: ConductorWorkflow[] = [];
  const versionRows = new Map<string, { id: string; workflowId: string; version: number; graph: WorkflowGraph }>();

  const workflowStore = {
    list: async (): Promise<ConductorWorkflow[]> => [...workflowRows],
    getVersion: async (versionId: string) => versionRows.get(versionId) ?? null,
    getBySlug: async (slug: string): Promise<ConductorWorkflow | null> =>
      workflowRows.find((w) => w.slug === slug) ??
      (existingSlugs.has(slug)
        ? { id: 'wf-existing', slug, name: 'existing', description: null, status: 'disabled', activeVersionId: null }
        : null),
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

  // REAL composite catalog over the bundled fixture + the fake store —
  // the #478 visibility rule under test is the catalog's, not a stub's.
  const catalog =
    opts?.withCatalog === false
      ? undefined
      : createCompositeTemplateCatalog({
          bundled: { list: () => [manifest], get: (id: string) => (id === manifest.id ? manifest : undefined) },
          store: fake.store,
          log: () => undefined,
        });

  const deps = {
    workflowStore,
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore,
    executor: {},
    eventRouter: {},
    ...(catalog
      ? {
          templateCatalog: catalog,
          templateStore: fake.store,
        }
      : {}),
    templateKnownRefs: async () => ({
      agentIds: [KNOWN_AGENT],
      actionIds: [],
      roleKeys: [KNOWN_ROLE],
      eventIds: [],
    }),
  } as unknown as ConductorRouterDeps;

  const app: Express = express();
  app.use(express.json());
  // Viewer identity injection — mirrors requireAuth's `req.session = claims`.
  app.use((req, _res, next) => {
    const viewer = req.header('x-viewer');
    if (viewer) (req as Request & { session?: { sub: string } }).session = { sub: viewer };
    next();
  });
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`,
    publishCalls,
    reconcileCalls,
    existingSlugs,
    templateStore: fake.store,
    instantiations: fake.instantiations,
    stamps: fake.stamps,
    workflowRows,
    versionRows,
    ...(catalog ? { catalog } : {}),
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

async function put(url: string, body: unknown, viewer?: string): Promise<Response> {
  return fetch(url, { method: 'PUT', headers: headers(viewer), body: JSON.stringify(body) });
}

async function del(url: string, viewer?: string): Promise<Response> {
  return fetch(url, { method: 'DELETE', headers: headers(viewer) });
}

async function listIds(h: Harness, viewer?: string): Promise<string[]> {
  const res = await get(`${h.baseUrl}/templates`, viewer);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { templates: TemplateSummary[] };
  return body.templates.map((t) => t.id);
}

describe('GET /templates', () => {
  it('returns the full manifests including graph and slot declarations', async () => {
    const h = await makeHarness();
    const res = await get(`${h.baseUrl}/templates`);
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

  it('keeps every v1 wire field untouched and only ADDS metadata (#330 contract)', async () => {
    const h = await makeHarness();
    const res = await get(`${h.baseUrl}/templates`);
    const body = (await res.json()) as { templates: Array<TemplateSummary & Record<string, unknown>> };
    const tpl = body.templates[0]!;
    const v1 = fixtureManifest();
    // v1 fields: byte-identical to the manifest the v1 route served.
    for (const key of ['id', 'name', 'description', 'useCase', 'defaultSlug', 'graph', 'slots'] as const) {
      assert.deepEqual(tpl[key], v1[key], `v1 field '${key}' drifted`);
    }
    // v2 fields: additive.
    assert.equal(tpl.source, 'bundled');
    assert.equal(tpl.version, 1);
    assert.equal(tpl.latestVersion, 1);
    assert.equal(tpl.instantiationCount, 0);
    assert.equal(tpl.status, undefined); // user-template-only fields stay absent
    assert.equal(tpl.createdBy, undefined);
  });

  it('returns an empty catalog when no templateCatalog dep is wired', async () => {
    const h = await makeHarness({ withCatalog: false });
    const res = await get(`${h.baseUrl}/templates`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { templates: [] });
  });

  it('is NOT swallowed by the /:slug catch-all workflow route (route-order regression)', async () => {
    // getBySlug('templates') would return null → the '/:slug' handler answers
    // 404 conductor.not_found. Getting the catalog instead proves route order.
    const h = await makeHarness();
    const res = await get(`${h.baseUrl}/templates`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.templates), `expected a catalog response, got: ${JSON.stringify(body)}`);
    assert.equal(body.code, undefined);
  });
});

describe('GET /templates/:id', () => {
  it('returns a bundled template with its additive metadata', async () => {
    const h = await makeHarness();
    const res = await get(`${h.baseUrl}/templates/fixture-approval`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.id, 'fixture-approval');
    assert.equal(body.template.source, 'bundled');
    assert.equal(body.template.version, 1);
  });

  it('404s with the TEMPLATE error code on an unknown id (not the /:slug 404)', async () => {
    const h = await makeHarness();
    const res = await get(`${h.baseUrl}/templates/does-not-exist`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_not_found');
  });
});

describe('template visibility (#478 — reviewer-reachable review gate)', () => {
  it("hides operator A's PRIVATE template from operator B (list AND get), but not from A", async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-private'), 'operator-a');

    assert.ok(!(await listIds(h, 'operator-b')).includes('a-private'));
    assert.equal((await get(`${h.baseUrl}/templates/a-private`, 'operator-b')).status, 404);

    assert.ok((await listIds(h, 'operator-a')).includes('a-private'));
    assert.equal((await get(`${h.baseUrl}/templates/a-private`, 'operator-a')).status, 200);
  });

  it("shows operator A's PENDING template to non-author operator B via list and get — the review-gate fix", async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-pending'), 'operator-a');
    await h.templateStore.setStatus('a-pending', 'pending');

    assert.ok((await listIds(h, 'operator-b')).includes('a-pending'), 'pending template missing from the reviewer list');
    const res = await get(`${h.baseUrl}/templates/a-pending`, 'operator-b');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.status, 'pending');
    assert.equal(body.template.createdBy, 'operator-a');
  });

  it('shows SHARED templates to every operator', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-shared'), 'operator-a');
    await h.templateStore.setStatus('a-shared', 'shared', 'operator-b');

    assert.ok((await listIds(h, 'operator-c')).includes('a-shared'));
    assert.equal((await get(`${h.baseUrl}/templates/a-shared`, 'operator-c')).status, 200);
  });

  it('always shows the author their own template regardless of status', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('mine'), 'operator-a');
    for (const status of ['private', 'pending', 'shared'] as const) {
      await h.templateStore.setStatus('mine', status);
      assert.ok((await listIds(h, 'operator-a')).includes('mine'), `author lost sight of own '${status}' template`);
    }
  });
});

describe('POST /templates', () => {
  it("creates a 'private' user template owned by the viewer", async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates`, { manifest: fixtureManifest('team-standup') }, 'operator-a');
    assert.equal(res.status, 201);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.id, 'team-standup');
    assert.equal(body.template.source, 'user');
    assert.equal(body.template.status, 'private');
    assert.equal(body.template.createdBy, 'operator-a');
    assert.equal(body.template.version, 1);
    assert.equal(body.template.latestVersion, 1);
  });

  it('409s on a duplicate user-template id', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('taken'), 'operator-a');
    const res = await post(`${h.baseUrl}/templates`, { manifest: fixtureManifest('taken') }, 'operator-b');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_id_exists');
  });

  it('409s on an id colliding with a bundled manifest', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates`, { manifest: fixtureManifest('fixture-approval') }, 'operator-a');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_id_exists');
  });

  it('400s an invalid manifest with the check issues array', async () => {
    const h = await makeHarness();
    const broken = fixtureManifest('broken');
    broken.slots = {}; // graph placeholders now undeclared
    const res = await post(`${h.baseUrl}/templates`, { manifest: broken }, 'operator-a');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; errors: Array<{ code: string }> };
    assert.equal(body.code, 'conductor.template_invalid');
    assert.ok(body.errors.some((e) => e.code === 'template_undeclared_slot'), JSON.stringify(body.errors));
  });
});

describe('PUT /templates/:id (versioning)', () => {
  it('author appends version 2; list serves the new latest; version 1 stays resolvable explicitly', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('evolving'), 'operator-a');

    const v2 = fixtureManifest('evolving');
    v2.graph.steps[0]!.prompt = 'Do the work, v2.';
    const res = await put(`${h.baseUrl}/templates/evolving`, { manifest: v2 }, 'operator-a');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.version, 2);
    assert.equal(body.template.latestVersion, 2);

    // resolve defaults to latest…
    const latest = await post(`${h.baseUrl}/templates/evolving/resolve`, { mapping: completeMapping() }, 'operator-a');
    assert.equal(latest.status, 200);
    assert.equal(((await latest.json()) as { graph: WorkflowGraph }).graph.steps[0]!.prompt, 'Do the work, v2.');

    // …and an explicit body `version` serves the immutable old manifest.
    const old = await post(`${h.baseUrl}/templates/evolving/resolve`, { mapping: completeMapping(), version: 1 }, 'operator-a');
    assert.equal(old.status, 200);
    assert.equal(((await old.json()) as { graph: WorkflowGraph }).graph.steps[0]!.prompt, 'Do the work.');

    const gone = await post(`${h.baseUrl}/templates/evolving/resolve`, { mapping: completeMapping(), version: 3 }, 'operator-a');
    assert.equal(gone.status, 404);
    const bad = await post(`${h.baseUrl}/templates/evolving/resolve`, { mapping: completeMapping(), version: 0 }, 'operator-a');
    assert.equal(bad.status, 400);
  });

  it('403s a non-author even on a shared (visible) template', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('shared-tpl'), 'operator-a');
    await h.templateStore.setStatus('shared-tpl', 'shared');
    const res = await put(`${h.baseUrl}/templates/shared-tpl`, { manifest: fixtureManifest('shared-tpl') }, 'operator-b');
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_forbidden');
  });

  it("404s a non-author on another author's PRIVATE template (invisible, no existence leak)", async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-secret'), 'operator-a');
    const res = await put(`${h.baseUrl}/templates/a-secret`, { manifest: fixtureManifest('a-secret') }, 'operator-b');
    assert.equal(res.status, 404);
  });

  it('403s on bundled templates (read-only source) and 400s on a manifest.id mismatch', async () => {
    const h = await makeHarness();
    const bundled = await put(`${h.baseUrl}/templates/fixture-approval`, { manifest: fixtureManifest('fixture-approval') }, 'operator-a');
    assert.equal(bundled.status, 403);

    await h.templateStore.create(fixtureManifest('mine'), 'operator-a');
    const mismatch = await put(`${h.baseUrl}/templates/mine`, { manifest: fixtureManifest('other-id') }, 'operator-a');
    assert.equal(mismatch.status, 400);
    assert.equal(((await mismatch.json()) as { code: string }).code, 'conductor.invalid_input');
  });
});

describe('DELETE /templates/:id', () => {
  it('author deletes an own template (204) and it vanishes from the catalog', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('doomed'), 'operator-a');
    const res = await del(`${h.baseUrl}/templates/doomed`, 'operator-a');
    assert.equal(res.status, 204);
    assert.ok(!(await listIds(h, 'operator-a')).includes('doomed'));
  });

  it('403s non-authors (shared) and bundled sources; 404s invisible private templates', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('shared-tpl'), 'operator-a');
    await h.templateStore.setStatus('shared-tpl', 'shared');
    assert.equal((await del(`${h.baseUrl}/templates/shared-tpl`, 'operator-b')).status, 403);
    assert.equal((await del(`${h.baseUrl}/templates/fixture-approval`, 'operator-a')).status, 403);

    await h.templateStore.create(fixtureManifest('a-secret'), 'operator-a');
    assert.equal((await del(`${h.baseUrl}/templates/a-secret`, 'operator-b')).status, 404);
  });
});

describe('GET /templates/:id/versions', () => {
  it('lists a user template’s version history; bundled templates report their single version', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('evolving'), 'operator-a');
    await h.templateStore.addVersion('evolving', fixtureManifest('evolving'));

    const res = await get(`${h.baseUrl}/templates/evolving/versions`, 'operator-a');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { versions: Array<{ version: number }> };
    assert.deepEqual(body.versions.map((v) => v.version), [1, 2]);

    const bundled = await get(`${h.baseUrl}/templates/fixture-approval/versions`);
    assert.deepEqual(((await bundled.json()) as { versions: Array<{ version: number }> }).versions, [{ version: 1 }]);
  });

  it('is visibility-gated exactly like get (404 on an invisible private template)', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-secret'), 'operator-a');
    assert.equal((await get(`${h.baseUrl}/templates/a-secret/versions`, 'operator-b')).status, 404);
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

  it('stamps template provenance atomically and appends an anonymous telemetry row (#478)', async () => {
    const h = await makeHarness();
    const res = await post(`${h.baseUrl}/templates/fixture-approval/instantiate`, {
      slug: 'tracked',
      mapping: completeMapping(),
    });
    assert.equal(res.status, 201);

    // Telemetry row appended by the route after the successful publish.
    assert.deepEqual(h.instantiations, [
      { templateId: 'fixture-approval', templateName: 'Fixture approval', version: 1, workflowSlug: 'tracked' },
    ]);

    // Provenance stamp rides the SAME onPublished callback as the schedule reconcile.
    await h.publishCalls[0]!.onPublished!({} as PoolClient, 'wf-1');
    assert.deepEqual(h.stamps, [{ workflowId: 'wf-1', templateId: 'fixture-approval', version: 1 }]);

    // The counter surfaces in the catalog list.
    const list = await get(`${h.baseUrl}/templates`);
    const tpl = ((await list.json()) as { templates: TemplateSummary[] }).templates.find((t) => t.id === 'fixture-approval');
    assert.equal(tpl!.instantiationCount, 1);
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
    assert.equal(h.instantiations.length, 0); // no telemetry for a failed publish
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

// ---------------------------------------------------------------------------
// #478 B3 — review-gate state machine, save-as-template inference, workflow
// update hint, plugin-contributed read-only templates.
// ---------------------------------------------------------------------------

describe('review gate: POST /templates/:id/{submit,approve,reject}', () => {
  it('author submits an own PRIVATE template → pending', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('mine'), 'operator-a');
    const res = await post(`${h.baseUrl}/templates/mine/submit`, {}, 'operator-a');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.status, 'pending');
    // submit records no reviewer — only approve/reject do.
    assert.equal((await h.templateStore.get('mine'))!.reviewedBy, null);
  });

  it('submit stays author-only: 404 on an invisible private template, 403 on a visible one', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-tpl'), 'operator-a');
    // invisible (private, foreign) → 404, no existence leak
    assert.equal((await post(`${h.baseUrl}/templates/a-tpl/submit`, {}, 'operator-b')).status, 404);
    // visible (shared) but foreign → 403
    await h.templateStore.setStatus('a-tpl', 'shared');
    const res = await post(`${h.baseUrl}/templates/a-tpl/submit`, {}, 'operator-b');
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_forbidden');
  });

  it('submit on a non-private template → 409 template_status_conflict', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('mine'), 'operator-a');
    await h.templateStore.setStatus('mine', 'pending');
    const res = await post(`${h.baseUrl}/templates/mine/submit`, {}, 'operator-a');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.template_status_conflict');
  });

  it('approve by a NON-AUTHOR operator: pending → shared, reviewed_by recorded (reviewer-reachability)', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-pending'), 'operator-a');
    await h.templateStore.setStatus('a-pending', 'pending');

    const res = await post(`${h.baseUrl}/templates/a-pending/approve`, {}, 'operator-b');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.status, 'shared');
    const record = (await h.templateStore.get('a-pending'))!;
    assert.equal(record.status, 'shared');
    assert.equal(record.reviewedBy, 'operator-b');
    // shared → visible install-wide.
    assert.ok((await listIds(h, 'operator-c')).includes('a-pending'));
  });

  it('reject by a non-author: pending → private, reviewed_by recorded, template leaves the reviewer view', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-pending'), 'operator-a');
    await h.templateStore.setStatus('a-pending', 'pending');

    const res = await post(`${h.baseUrl}/templates/a-pending/reject`, {}, 'operator-b');
    assert.equal(res.status, 200);
    // Rejecting flips the template private — the non-author reviewer can no
    // longer see it, so the response carries `template: null` by design.
    assert.equal(((await res.json()) as { template: TemplateSummary | null }).template, null);
    const record = (await h.templateStore.get('a-pending'))!;
    assert.equal(record.status, 'private');
    assert.equal(record.reviewedBy, 'operator-b');
    assert.ok(!(await listIds(h, 'operator-b')).includes('a-pending'));
  });

  it('approve: 409 on non-pending, 403 on bundled (read-only), 404 on unknown', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('a-shared'), 'operator-a');
    await h.templateStore.setStatus('a-shared', 'shared');
    const conflict = await post(`${h.baseUrl}/templates/a-shared/approve`, {}, 'operator-b');
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { code: string }).code, 'conductor.template_status_conflict');

    assert.equal((await post(`${h.baseUrl}/templates/fixture-approval/approve`, {}, 'operator-b')).status, 403);
    assert.equal((await post(`${h.baseUrl}/templates/does-not-exist/approve`, {}, 'operator-b')).status, 404);
  });

  it('self-approval by the author is permitted (single-operator installs must not deadlock)', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('solo'), 'operator-a');
    await h.templateStore.setStatus('solo', 'pending');
    const res = await post(`${h.baseUrl}/templates/solo/approve`, {}, 'operator-a');
    assert.equal(res.status, 200);
    const record = (await h.templateStore.get('solo'))!;
    assert.equal(record.status, 'shared');
    assert.equal(record.reviewedBy, 'operator-a'); // auditable
  });
});

/** Concrete (non-templated) graph as a designer would publish it — every ref
 *  field carries a real entity id; one event trigger exercises that walk too. */
function concreteGraph(): WorkflowGraph {
  return {
    entryStepId: 'work',
    steps: [
      { id: 'work', kind: 'agent', agentId: KNOWN_AGENT, prompt: 'Do the work.' },
      {
        id: 'approve',
        kind: 'human',
        human: { principal: { kind: 'role', ref: KNOWN_ROLE }, channel: 'teams', message: 'Approve the result?' },
      },
    ],
    transitions: [{ id: 't-done', source: 'work', target: 'approve' }],
    triggers: [{ id: 'tr-ev', kind: 'event', eventId: 'expense.created' }],
  };
}

describe('POST /:slug/save-as-template (#478 slot inference)', () => {
  function seedSource(h: Harness): void {
    h.workflowRows.push({
      id: 'wf-src',
      slug: 'expense-flow',
      name: 'Expense flow',
      description: 'Approves expenses',
      status: 'enabled',
      activeVersionId: 'v-src',
      templateId: null,
      templateVersion: null,
    });
    h.versionRows.set('v-src', { id: 'v-src', workflowId: 'wf-src', version: 3, graph: concreteGraph() });
  }

  it('infers one declared slot per distinct concrete ref; the identity mapping reproduces the graph', async () => {
    const h = await makeHarness();
    seedSource(h);
    const res = await post(`${h.baseUrl}/expense-flow/save-as-template`, {}, 'operator-a');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { draft: TemplateManifest; sourceWorkflow: { slug: string; version: number } };
    assert.deepEqual(body.sourceWorkflow, { slug: 'expense-flow', version: 3 });

    const { draft } = body;
    assert.equal(draft.id, 'expense-flow');
    assert.equal(draft.defaultSlug, 'expense-flow');
    assert.equal(draft.name, 'Expense flow'); // workflow-derived defaults
    assert.equal(draft.description, 'Approves expenses');
    assert.equal(draft.useCase, 'general');

    // Every concrete ref became a placeholder + declaration (labels = the concrete ref).
    assert.equal(draft.graph.steps[0]!.agentId, `slot:agent:${KNOWN_AGENT}`);
    assert.deepEqual(draft.slots.agents, [{ key: KNOWN_AGENT, label: KNOWN_AGENT }]);
    assert.deepEqual(draft.slots.roles, [{ key: KNOWN_ROLE, label: KNOWN_ROLE }]);
    assert.deepEqual(draft.slots.channels, [{ key: 'teams', label: 'teams' }]);
    assert.deepEqual(draft.slots.events, [{ key: 'expense-created', label: 'expense.created' }]); // key slugified

    // Identity mapping (slot key → its original concrete ref, i.e. the label)
    // round-trips to the exact source graph.
    const mapping: Record<string, Record<string, string>> = {};
    for (const kind of ['agents', 'actions', 'roles', 'events', 'channels'] as const) {
      for (const slot of draft.slots[kind] ?? []) {
        mapping[kind] = { ...mapping[kind], [slot.key]: slot.label as string };
      }
    }
    assert.deepEqual(applyTemplateSlots(draft, mapping), concreteGraph());

    // Nothing was persisted — the draft is the UI's to edit and publish.
    assert.ok(!(await listIds(h, 'operator-a')).includes('expense-flow'));
    // …and the inferred draft is publishable as-is via POST /templates.
    assert.equal((await post(`${h.baseUrl}/templates`, { manifest: draft }, 'operator-a')).status, 201);
  });

  it('respects explicit id/name/useCase overrides from the body', async () => {
    const h = await makeHarness();
    seedSource(h);
    const res = await post(
      `${h.baseUrl}/expense-flow/save-as-template`,
      { id: 'my-template', name: { en: 'Custom', de: 'Eigenes' }, useCase: 'approval' },
      'operator-a',
    );
    const { draft } = (await res.json()) as { draft: TemplateManifest };
    assert.equal(draft.id, 'my-template');
    assert.deepEqual(draft.name, { en: 'Custom', de: 'Eigenes' });
    assert.equal(draft.useCase, 'approval');
  });

  it("suffixes the derived id with '-template' when the slug-based id is taken", async () => {
    const h = await makeHarness();
    seedSource(h);
    await h.templateStore.create(fixtureManifest('expense-flow'), 'operator-b'); // even a FOREIGN private template blocks the id
    const res = await post(`${h.baseUrl}/expense-flow/save-as-template`, {}, 'operator-a');
    const { draft } = (await res.json()) as { draft: TemplateManifest };
    assert.equal(draft.id, 'expense-flow-template');
  });

  it('404s (workflow_not_found) on an unknown slug and on a workflow without a published version', async () => {
    const h = await makeHarness();
    const unknown = await post(`${h.baseUrl}/nope/save-as-template`, {}, 'operator-a');
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, 'conductor.workflow_not_found');

    h.existingSlugs.add('unpublished'); // getBySlug hit, but activeVersionId null
    const unpublished = await post(`${h.baseUrl}/unpublished/save-as-template`, {}, 'operator-a');
    assert.equal(unpublished.status, 404);
    assert.equal(((await unpublished.json()) as { code: string }).code, 'conductor.workflow_not_found');
  });
});

describe('workflow template update hint (#478)', () => {
  function seedInstance(h: Harness, templateVersion: number, slug = 'from-template'): void {
    h.workflowRows.push({
      id: `wf-${slug}`,
      slug,
      name: 'From template',
      description: null,
      status: 'disabled',
      activeVersionId: `v-${slug}`,
      templateId: 'evolving',
      templateVersion,
    });
    h.versionRows.set(`v-${slug}`, { id: `v-${slug}`, workflowId: `wf-${slug}`, version: 1, graph: concreteGraph() });
  }

  it('reports updateAvailable on list AND detail once the template gains a newer version', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('evolving'), 'operator-a');
    seedInstance(h, 1);

    // v1 instantiated, v1 latest → no update.
    let res = await get(`${h.baseUrl}/from-template`, 'operator-a');
    assert.equal(res.status, 200);
    let detail = (await res.json()) as { workflow: WorkflowWithTemplateHint };
    assert.deepEqual(detail.workflow.template, { id: 'evolving', version: 1, latestVersion: 1, updateAvailable: false });

    await h.templateStore.addVersion('evolving', fixtureManifest('evolving'));

    const listRes = await get(h.baseUrl, 'operator-a');
    assert.equal(listRes.status, 200);
    const { workflows } = (await listRes.json()) as { workflows: WorkflowWithTemplateHint[] };
    assert.deepEqual(workflows[0]!.template, { id: 'evolving', version: 1, latestVersion: 2, updateAvailable: true });

    res = await get(`${h.baseUrl}/from-template`, 'operator-a');
    detail = (await res.json()) as { workflow: WorkflowWithTemplateHint };
    assert.deepEqual(detail.workflow.template, { id: 'evolving', version: 1, latestVersion: 2, updateAvailable: true });

    // A workflow re-instantiated from v2 reports v2, no update pending.
    seedInstance(h, 2, 'from-template-v2');
    const v2 = await get(`${h.baseUrl}/from-template-v2`, 'operator-a');
    assert.deepEqual(((await v2.json()) as { workflow: WorkflowWithTemplateHint }).workflow.template, {
      id: 'evolving',
      version: 2,
      latestVersion: 2,
      updateAvailable: false,
    });
  });

  it('does not leak an invisible (foreign private) template: hint degrades, never updateAvailable', async () => {
    const h = await makeHarness();
    await h.templateStore.create(fixtureManifest('evolving'), 'operator-a');
    await h.templateStore.addVersion('evolving', fixtureManifest('evolving'));
    seedInstance(h, 1);

    const res = await get(`${h.baseUrl}/from-template`, 'operator-b'); // NOT the author; template is private
    const detail = (await res.json()) as { workflow: WorkflowWithTemplateHint };
    assert.deepEqual(detail.workflow.template, { id: 'evolving', version: 1, latestVersion: 1, updateAvailable: false });
  });

  it('omits the template key entirely on workflows without provenance', async () => {
    const h = await makeHarness();
    h.workflowRows.push({
      id: 'wf-plain',
      slug: 'plain',
      name: 'Plain',
      description: null,
      status: 'disabled',
      activeVersionId: 'v-plain',
      templateId: null,
      templateVersion: null,
    });
    h.versionRows.set('v-plain', { id: 'v-plain', workflowId: 'wf-plain', version: 1, graph: concreteGraph() });
    const res = await get(`${h.baseUrl}/plain`, 'operator-a');
    const detail = (await res.json()) as { workflow: WorkflowWithTemplateHint };
    assert.equal(detail.workflow.template, undefined);
  });
});

describe('plugin-contributed templates (#478 read-only catalog source)', () => {
  it('registered plugin templates list as source plugin; every write path 403s; unregister removes them', async () => {
    const h = await makeHarness();
    const id = 'plugin:acme:approval';
    h.catalog!.registerPluginTemplates('acme', [fixtureManifest(id)]);

    assert.ok((await listIds(h, 'operator-a')).includes(id));
    const res = await get(`${h.baseUrl}/templates/${encodeURIComponent(id)}`, 'operator-a');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { template: TemplateSummary };
    assert.equal(body.template.source, 'plugin');
    assert.equal(body.template.version, 1);

    // Read-only: PUT / DELETE / submit / approve all refuse.
    const url = `${h.baseUrl}/templates/${encodeURIComponent(id)}`;
    assert.equal((await put(url, { manifest: fixtureManifest(id) }, 'operator-a')).status, 403);
    assert.equal((await del(url, 'operator-a')).status, 403);
    assert.equal((await post(`${url}/submit`, {}, 'operator-a')).status, 403);
    assert.equal((await post(`${url}/approve`, {}, 'operator-a')).status, 403);

    // POST /templates with a colliding id → 409 (the id is reserved by the plugin source).
    const collide = await post(`${h.baseUrl}/templates`, { manifest: fixtureManifest(id) }, 'operator-a');
    assert.equal(collide.status, 409);

    h.catalog!.unregisterPluginTemplates('acme');
    assert.ok(!(await listIds(h, 'operator-a')).includes(id));
    assert.equal((await get(`${h.baseUrl}/templates/${encodeURIComponent(id)}`, 'operator-a')).status, 404);
  });
});
