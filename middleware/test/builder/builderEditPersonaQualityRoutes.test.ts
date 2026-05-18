import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';
import {
  assembleEditRouteContext,
  registerBuilderEditRoutes,
} from '../../src/routes/builderEdit.js';
import { setPersonaConfigTool } from '../../src/plugins/builder/tools/setPersonaConfig.js';
import { setQualityConfigTool } from '../../src/plugins/builder/tools/setQualityConfig.js';

declare module 'express-serve-static-core' {
  interface Request {
    session?: { email?: string };
  }
}

/**
 * Issue #53 + #54 follow-up — verify the new PATCH /persona and
 * PATCH /quality routes:
 *   - run the corresponding Builder tool (so spec validation runs)
 *   - emit a `spec_patch` event with cause='agent'
 *   - schedule a preview rebuild
 *   - write a `builder_audit` row (#56)
 *   - surface tool-side `warnings` for unknown preset IDs (quality only)
 */

async function boot(
  store: DraftStore,
  bus: SpecEventBus,
  email: string,
  rebuilds: { userEmail: string; draftId: string }[],
): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { email };
    next();
  });
  const router = express.Router();
  registerBuilderEditRoutes(router, {
    draftStore: store,
    bus,
    rebuildScheduler: {
      schedule(userEmail: string, draftId: string) {
        rebuilds.push({ userEmail, draftId });
      },
    },
  });
  app.use('/v1/builder', router);
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('PATCH /drafts/:id/{persona,quality} (issues #53 + #54)', () => {
  let tmpRoot: string;
  let store: DraftStore;
  let bus: SpecEventBus;
  let busEvents: { draftId: string; event: SpecBusEvent }[];
  let rebuilds: { userEmail: string; draftId: string }[];
  let server: Server;
  let baseUrl: string;
  let draftId: string;
  const userEmail = 'alice@example.com';

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'edit-tool-routes-'));
    store = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await store.open();
    bus = new SpecEventBus();
    busEvents = [];
    rebuilds = [];
    const d = await store.create(userEmail, 'Weather');
    draftId = d.id;
    // Subscribe after we know the draftId
    bus.subscribe(draftId, (event: SpecBusEvent) => {
      busEvents.push({ draftId, event });
    });
    const boot1 = await boot(store, bus, userEmail, rebuilds);
    server = boot1.server;
    baseUrl = boot1.url;
  });

  afterEach(async () => {
    await closeServer(server);
    await store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('PATCH /persona writes the persona block, emits cause=agent, schedules rebuild, audits', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/persona`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: 'customer-service',
        custom_notes: 'auf Deutsch',
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { draft: { spec: { persona?: unknown } } };
    assert.ok(body.draft.spec.persona);

    // Bus emit with cause='agent'
    const patchEvents = busEvents
      .map((e) => e.event)
      .filter((e): e is Extract<SpecBusEvent, { type: 'spec_patch' }> => e.type === 'spec_patch');
    assert.equal(patchEvents.length, 1);
    assert.equal(patchEvents[0]!.cause, 'agent');

    // Rebuild scheduled
    assert.equal(rebuilds.length, 1);
    assert.equal(rebuilds[0]!.draftId, draftId);

    // Audit row written
    const audit = await store.listAudit(userEmail, draftId);
    assert.equal(audit.total, 1);
    assert.equal(audit.events[0]!.action, 'persona_updated');
  });

  it('PATCH /quality writes the quality block, emits cause=agent, schedules rebuild, audits', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/quality`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sycophancy: 'medium',
        boundaries: { presets: ['no-pii'], custom: ['no PII'] },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { draft: { spec: { quality?: unknown } }; warnings?: string[] };
    assert.ok(body.draft.spec.quality);
    assert.equal(body.warnings, undefined, 'no warnings expected for known preset');

    const patchEvents = busEvents
      .map((e) => e.event)
      .filter((e): e is Extract<SpecBusEvent, { type: 'spec_patch' }> => e.type === 'spec_patch');
    assert.equal(patchEvents.length, 1);
    assert.equal(patchEvents[0]!.cause, 'agent');

    assert.equal(rebuilds.length, 1);
    const audit = await store.listAudit(userEmail, draftId);
    assert.equal(audit.total, 1);
    assert.equal(audit.events[0]!.action, 'quality_updated');
  });

  it('PATCH /quality surfaces tool-side warnings for unknown preset IDs', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/quality`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        boundaries: { presets: ['no-pii', 'bogus-preset'], custom: [] },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { warnings?: string[] };
    assert.deepEqual(body.warnings, ['unknown preset: bogus-preset']);
  });

  it('PATCH /persona returns 400 on Zod validation failure (unknown axis is dropped, so trigger via bad type)', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/persona`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ custom_notes: 12345 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'builder.invalid_persona');
  });

  it('PATCH /quality returns 401 without a session', async () => {
    // Mount a parallel server without the session middleware to assert 401
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerBuilderEditRoutes(router, {
      draftStore: store,
      bus,
      rebuildScheduler: { schedule() {} },
    });
    app.use('/v1/builder', router);
    const noAuth = await new Promise<Server>((resolve) => {
      const s = createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = noAuth.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/v1/builder/drafts/${draftId}/quality`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sycophancy: 'low' }),
      });
      assert.equal(res.status, 401);
    } finally {
      await closeServer(noAuth);
    }
  });
});

describe('assembleEditRouteContext (issue #53 + #54)', () => {
  let tmpRoot: string;
  let store: DraftStore;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'assemble-ctx-'));
    store = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('thrower stubs catch silent contract violations from unused tool fields', () => {
    const bus = new SpecEventBus();
    const ctx = assembleEditRouteContext(
      {
        draftStore: store,
        bus,
        rebuildScheduler: { schedule() {} },
      },
      'alice@example.com',
      'draft-1',
    );
    // Real fields are populated
    assert.equal(ctx.userEmail, 'alice@example.com');
    assert.equal(ctx.draftId, 'draft-1');
    assert.ok(ctx.audit);
    // Thrower stubs all throw with a clear message
    assert.throws(() => ctx.catalogToolNames(), /not available/);
    assert.throws(() => ctx.knownPluginIds(), /not available/);
    assert.throws(() => ctx.slotRetryTracker.recordFail('s'), /not available/);
    assert.throws(() => ctx.buildFailureBudget.recordFail(), /not available/);
  });

  it('the two in-scope tools (set_persona_config, set_quality_config) never reach the thrower stubs', () => {
    // The tools' run() bodies are pure — they only touch the 6 real
    // fields. If a future PR adds a `ctx.knownPluginIds()` call, this
    // test will fail at runtime as soon as the route invokes the tool.
    const text = setPersonaConfigTool.run.toString() + setQualityConfigTool.run.toString();
    const stubFields = [
      'catalogToolNames',
      'knownPluginIds',
      'slotRetryTracker',
      'buildFailureBudget',
      'templateRoot',
      'referenceCatalog',
      'slotTypechecker',
    ];
    for (const field of stubFields) {
      assert.equal(
        text.includes(`ctx.${field}`),
        false,
        `${field} reference found in tool body — assembleEditRouteContext stub will throw`,
      );
    }
  });
});
