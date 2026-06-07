import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express, type RequestHandler } from 'express';

import { createBuilderRouter } from '../../src/routes/builder.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import type { DraftQuota } from '../../src/plugins/builder/draftQuota.js';
import type { BuildPipeline, PipelineRunResult } from '../../src/plugins/builder/buildPipeline.js';
import type { PackageUploadService } from '../../src/plugins/packageUploadService.js';
import { OperatorGate } from '../../src/plugins/selfExtension/index.js';
import { BASE_SPEC_INPUT } from './_fixtures.js';

const USER = 'op@byte5.de';
const AGENT_ID = BASE_SPEC_INPUT.id;

function withSessionEmail(email: string | null): RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { session: { email: string | null } }).session = { email };
    next();
  };
}

function fakePipeline(): BuildPipeline {
  return {
    run: async (): Promise<PipelineRunResult> =>
      ({
        buildN: 1,
        draft: { id: 'x', spec: { id: AGENT_ID, version: '0.1.0' } },
        buildResult: { ok: true, zip: Buffer.from('PK'), zipPath: '/tmp/x.zip', durationMs: 1 },
      }) as unknown as PipelineRunResult,
  } as unknown as BuildPipeline;
}

function fakeUpload(): PackageUploadService {
  return {
    ingest: async () => ({ ok: true, plugin_id: AGENT_ID, version: '0.2.0', package: { zip_bytes: 9 } }),
  } as unknown as PackageUploadService;
}

interface TestApp {
  baseUrl: string;
  close: () => Promise<void>;
  store: DraftStore;
}

async function makeApp(email: string | null, store: DraftStore): Promise<TestApp> {
  const app: Express = express();
  app.use(express.json());
  app.use(withSessionEmail(email));
  app.use(
    '/b',
    createBuilderRouter({
      store,
      quota: {} as unknown as DraftQuota,
      selfExtension: {
        gate: new OperatorGate(),
        draftStore: store,
        buildPipeline: fakePipeline(),
        packageUploadService: fakeUpload(),
      },
    }),
  );
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    store,
  };
}

async function postJson(baseUrl: string, p: string, body: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const TOOL_PATCH = { op: 'add', path: '/tools/-', value: { id: 'dynamics_aggregate', description: 'agg', input: {} } };

describe('self-extension routes', () => {
  let dir: string;
  let store: DraftStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'selfext-routes-'));
    store = new DraftStore({ dbPath: path.join(dir, 'd.db') });
    await store.open();
    const draft = await store.create(USER, 'Dynamics');
    await store.update(USER, draft.id, { spec: BASE_SPEC_INPUT, publishedAgentId: AGENT_ID });
  });
  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('401 without a session', async () => {
    const app = await makeApp(null, store);
    const r = await postJson(app.baseUrl, `/b/self-extension/${AGENT_ID}/propose`, { rationale: 'x', patches: [TOOL_PATCH] });
    assert.equal(r.status, 401);
    await app.close();
  });

  it('404 when no source draft exists for the plugin', async () => {
    const app = await makeApp(USER, store);
    const r = await postJson(app.baseUrl, `/b/self-extension/de.byte5.agent.unknown/propose`, { rationale: 'x', patches: [TOOL_PATCH] });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'self_ext.source_not_found');
    await app.close();
  });

  it('propose a clean tool-add → needs_approval', async () => {
    const app = await makeApp(USER, store);
    const r = await postJson(app.baseUrl, `/b/self-extension/${AGENT_ID}/propose`, {
      rationale: 'add aggregation tool',
      patches: [TOOL_PATCH],
    });
    assert.equal(r.status, 200);
    const proposal = r.body.proposal as Record<string, unknown>;
    assert.equal(proposal.decision, 'needs_approval');
    assert.equal(proposal.status, 'pending');
    await app.close();
  });

  it('propose a privilege escalation → auto denied with escalations', async () => {
    const app = await makeApp(USER, store);
    const r = await postJson(app.baseUrl, `/b/self-extension/${AGENT_ID}/propose`, {
      rationale: 'grab write access',
      patches: [{ op: 'add', path: '/permissions/graph/writes/-', value: 'odoo:invoices:*' }],
    });
    assert.equal(r.status, 200);
    const proposal = r.body.proposal as Record<string, unknown>;
    assert.equal(proposal.decision, 'denied_escalation');
    assert.equal(proposal.status, 'denied');
    assert.equal((proposal.escalations as unknown[]).length, 1);
    await app.close();
  });

  it('full happy path: propose → approve → install', async () => {
    const app = await makeApp(USER, store);
    const proposed = await postJson(app.baseUrl, `/b/self-extension/${AGENT_ID}/propose`, {
      rationale: 'add aggregation tool',
      patches: [TOOL_PATCH],
    });
    const id = (proposed.body.proposal as { id: string }).id;

    const approved = await postJson(app.baseUrl, `/b/self-extension/proposals/${id}/approve`, {});
    assert.equal(approved.status, 200);
    assert.equal((approved.body.proposal as { status: string }).status, 'approved');

    const installed = await postJson(app.baseUrl, `/b/self-extension/proposals/${id}/install`, {});
    assert.equal(installed.status, 200);
    assert.equal(installed.body.publishedAgentId, AGENT_ID);
    assert.equal(installed.body.version, '0.2.0');
    await app.close();
  });

  it('approving an escalation-denied proposal → 409 illegal transition', async () => {
    const app = await makeApp(USER, store);
    const proposed = await postJson(app.baseUrl, `/b/self-extension/${AGENT_ID}/propose`, {
      rationale: 'grab write access',
      patches: [{ op: 'add', path: '/network/web_scanner', value: true }],
    });
    const id = (proposed.body.proposal as { id: string }).id;
    const approved = await postJson(app.baseUrl, `/b/self-extension/proposals/${id}/approve`, {});
    assert.equal(approved.status, 409);
    assert.equal(approved.body.code, 'self_ext.illegal_transition');
    await app.close();
  });

  it('rejects a widening narrowing on approve → 409', async () => {
    const app = await makeApp(USER, store);
    const proposed = await postJson(app.baseUrl, `/b/self-extension/${AGENT_ID}/propose`, {
      rationale: 'add aggregation tool',
      patches: [TOOL_PATCH],
    });
    const id = (proposed.body.proposal as { id: string }).id;
    const approved = await postJson(app.baseUrl, `/b/self-extension/proposals/${id}/approve`, {
      narrowingPatches: [{ op: 'add', path: '/network/outbound/-', value: 'new.example.com' }],
    });
    assert.equal(approved.status, 409);
    assert.equal(approved.body.code, 'self_ext.narrowing_widens');
    await app.close();
  });
});
