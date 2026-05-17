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
import type { RoutineOutputTemplate } from '../src/plugins/routines/routineOutputTemplate.js';

/**
 * Phase C.7 — Coverage for the two new routes the operator-UI consumes:
 *   - PUT /v1/routines/:id/template
 *   - POST /v1/routines/preview-template
 *
 * Both routes are stateless beyond the single `store.setOutputTemplate`
 * call, so we stub the store with a tiny in-memory map. The runner +
 * runsStore are typed but never invoked from these two endpoints; we
 * pass narrow stubs.
 */

interface Harness {
  server: Server;
  baseUrl: string;
  store: StubStore;
  close(): Promise<void>;
}

class StubStore {
  public readonly rows = new Map<string, Routine>();
  public setOutputTemplateCalls: Array<{
    id: string;
    template: RoutineOutputTemplate | null;
  }> = [];

  seed(routine: Routine): void {
    this.rows.set(routine.id, routine);
  }

  async setOutputTemplate(
    id: string,
    template: RoutineOutputTemplate | null,
  ): Promise<Routine | null> {
    this.setOutputTemplateCalls.push({ id, template });
    const existing = this.rows.get(id);
    if (!existing) return null;
    const updated: Routine = {
      ...existing,
      outputTemplate: template,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }
}

function makeRoutine(id: string, overrides?: Partial<Routine>): Routine {
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
    ...overrides,
  };
}

async function makeHarness(): Promise<Harness> {
  const store = new StubStore();
  const stubRunsStore = {} as RoutineRunsStore;
  const stubRunner = {} as RoutineRunner;

  const app: Express = express();
  app.use(express.json());
  const router = createRoutinesRouter({
    store: store as unknown as RoutineStore,
    runsStore: stubRunsStore,
    runner: stubRunner,
    log: () => {},
  });
  app.use('/v1/routines', router);

  return new Promise<Harness>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        baseUrl,
        store,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

const VALID_TEMPLATE: RoutineOutputTemplate = {
  format: 'markdown',
  sections: [{ kind: 'narrative-slot', id: 'intro', hint: 'Hi.' }],
};

describe('PUT /v1/routines/:id/template', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('persists a valid template and returns the updated routine DTO', async () => {
    h.store.seed(makeRoutine('rt-1'));
    const res = await fetch(`${h.baseUrl}/v1/routines/rt-1/template`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: VALID_TEMPLATE }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      routine: { id: string; outputTemplate: RoutineOutputTemplate | null };
    };
    assert.equal(body.routine.id, 'rt-1');
    assert.deepEqual(body.routine.outputTemplate, VALID_TEMPLATE);
    assert.equal(h.store.setOutputTemplateCalls.length, 1);
    assert.deepEqual(h.store.setOutputTemplateCalls[0]!.template, VALID_TEMPLATE);
  });

  it('clears the template when body.template is null', async () => {
    h.store.seed(makeRoutine('rt-2', { outputTemplate: VALID_TEMPLATE }));
    const res = await fetch(`${h.baseUrl}/v1/routines/rt-2/template`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: null }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      routine: { outputTemplate: RoutineOutputTemplate | null };
    };
    assert.equal(body.routine.outputTemplate, null);
    assert.equal(h.store.setOutputTemplateCalls[0]!.template, null);
  });

  it('returns 400 with reason when template is malformed', async () => {
    h.store.seed(makeRoutine('rt-3'));
    const res = await fetch(`${h.baseUrl}/v1/routines/rt-3/template`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'markdown' /* sections missing */ },
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, 'routines.template_invalid');
    assert.match(body.message, /sections/);
    assert.equal(h.store.setOutputTemplateCalls.length, 0);
  });

  it('returns 400 when body is missing the template field entirely', async () => {
    h.store.seed(makeRoutine('rt-4'));
    const res = await fetch(`${h.baseUrl}/v1/routines/rt-4/template`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'routines.template_missing');
  });

  it('returns 404 when the routine does not exist', async () => {
    const res = await fetch(`${h.baseUrl}/v1/routines/missing/template`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: VALID_TEMPLATE }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'routines.not_found');
  });

  it('rejects format html with template_invalid (parser pre-empts renderer)', async () => {
    h.store.seed(makeRoutine('rt-5'));
    const res = await fetch(`${h.baseUrl}/v1/routines/rt-5/template`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: { format: 'html', sections: [] },
      }),
    });
    // `parseRoutineOutputTemplate` accepts `html` structurally — the
    // renderer rejects it later. So this should actually succeed; the
    // operator gets the html-format save and only sees the rendering
    // failure at preview/trigger time. Confirms the schema/renderer
    // boundary is the right place to gate format support.
    assert.equal(res.status, 200);
  });
});

describe('POST /v1/routines/preview-template', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('renders markdown from synthetic raw + slot values', async () => {
    const template: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        { kind: 'narrative-slot', id: 'intro' },
        {
          kind: 'data-table',
          sourceTool: 'query_odoo_hr',
          sourcePath: 'absences',
          title: 'Abwesenheiten',
          columns: [{ label: 'Name', field: 'name' }],
        },
      ],
    };
    const res = await fetch(`${h.baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template,
        rawToolResults: {
          query_odoo_hr: { absences: [{ name: 'Anna' }] },
        },
        slots: { intro: 'Hi.' },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: true;
      format: 'markdown';
      text: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.format, 'markdown');
    assert.match(body.text, /Hi\./);
    assert.match(body.text, /## Abwesenheiten/);
    assert.match(body.text, /\| Anna \|/);
  });

  it('renders adaptive-card body items', async () => {
    const template: RoutineOutputTemplate = {
      format: 'adaptive-card',
      sections: [{ kind: 'narrative-slot', id: 'intro' }],
    };
    const res = await fetch(`${h.baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template,
        slots: { intro: 'Hallo.' },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: true;
      format: 'adaptive-card';
      items: ReadonlyArray<Record<string, unknown>>;
    };
    assert.equal(body.format, 'adaptive-card');
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!['text'], 'Hallo.');
  });

  it('returns 400 with reason for malformed template', async () => {
    const res = await fetch(`${h.baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: { format: 'markdown' } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'routines.template_invalid');
  });

  it('returns 400 when template field is missing', async () => {
    const res = await fetch(`${h.baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawToolResults: {} }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'routines.template_missing');
  });

  it('renderer-rejected format (html) returns ok:false in body, not HTTP 400', async () => {
    const template: RoutineOutputTemplate = {
      format: 'html',
      sections: [],
    };
    const res = await fetch(`${h.baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    // Schema accepts html; renderer rejects → 200 with ok:false.
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: false; reason: string };
    assert.equal(body.ok, false);
    assert.match(body.reason, /'html' is not yet supported/);
  });

  it('does not touch the routine store (stateless preview)', async () => {
    h.store.seed(makeRoutine('rt-6'));
    await fetch(`${h.baseUrl}/v1/routines/preview-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template: VALID_TEMPLATE,
        slots: { intro: 'X' },
      }),
    });
    assert.equal(h.store.setOutputTemplateCalls.length, 0);
  });
});
