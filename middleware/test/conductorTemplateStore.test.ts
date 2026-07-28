import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool, PoolClient } from 'pg';
import type { TemplateManifest } from '@omadia/conductor-core';

import { createTemplateStore, TemplateIdExistsError, TemplateInvalidError } from '../src/conductor/templateStore.js';

// DB template store (#478): immutable versions, version-column-authoritative
// manifest stamping, telemetry counters, provenance stamping. Stateful fake-pool
// harness implementing exactly the SQL statements the store issues (same
// convention as conductorWorkflowStore.test.ts) — no DB.

function fixtureManifest(id = 'tpl-approval'): TemplateManifest {
  return {
    id,
    name: { en: 'Approval', de: 'Freigabe' },
    description: 'Two-step approval.',
    useCase: 'approval',
    defaultSlug: id,
    graph: {
      entryStepId: 'work',
      steps: [
        { id: 'work', kind: 'agent', agentId: 'slot:agent:worker', prompt: 'Do the work.' },
      ],
      transitions: [],
    },
    slots: { agents: [{ key: 'worker', label: 'Worker agent' }] },
  };
}

interface Db {
  pool: Pool;
  client: PoolClient;
  templates: Map<string, { created_by: string; status: string; latest_version: number; reviewed_by: string | null; created_at: string; updated_at: string }>;
  versions: Map<string, { manifest: TemplateManifest; created_at: string }>;
  instantiations: Array<{ template_id: string; template_name: string; template_version: number; workflow_slug: string }>;
  workflows: Map<string, { template_id: string; template_version: number }>;
}

/** In-memory Postgres stand-in for the store's statements. Throws on anything
 *  unscripted so a store SQL change fails loudly here. */
function fakeDb(): Db {
  const db: Omit<Db, 'pool' | 'client'> = {
    templates: new Map(),
    versions: new Map(),
    instantiations: [],
    workflows: new Map(),
  };
  const NOW = '2026-07-10T00:00:00.000Z';


  async function query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };

    if (s.startsWith('INSERT INTO conductor_templates')) {
      const [id, createdBy] = params as [string, string];
      if (db.templates.has(id)) {
        const err = new Error(`duplicate key value violates unique constraint "conductor_templates_pkey"`);
        (err as Error & { code: string }).code = '23505';
        throw err;
      }
      db.templates.set(id, { created_by: createdBy, status: 'private', latest_version: 1, reviewed_by: null, created_at: NOW, updated_at: NOW });
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO conductor_template_versions')) {
      // create inserts a literal version 1; addVersion parameterizes it.
      const [id, a, b] = params;
      const version = s.includes('($1, 1,') ? 1 : (a as number);
      const manifest = JSON.parse((s.includes('($1, 1,') ? a : b) as string) as TemplateManifest;
      db.versions.set(`${id as string}:${String(version)}`, { manifest, created_at: NOW });
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT latest_version FROM conductor_templates') && s.includes('FOR UPDATE')) {
      const row = db.templates.get(params[0] as string);
      return { rows: row ? [{ latest_version: row.latest_version }] : [], rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('UPDATE conductor_templates SET latest_version')) {
      const row = db.templates.get(params[0] as string);
      if (row) {
        row.latest_version = params[1] as number;
        row.updated_at = '2026-07-10T01:00:00.000Z';
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (s.startsWith('UPDATE conductor_templates SET status')) {
      const row = db.templates.get(params[0] as string);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = params[1] as string;
      row.reviewed_by = (params[2] as string | null) ?? row.reviewed_by;
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }

    if (s.includes('FROM conductor_templates t') && s.includes('JOIN conductor_template_versions v')) {
      const record = (id: string): unknown => {
        const t = db.templates.get(id);
        if (!t) return undefined;
        const v = db.versions.get(`${id}:${String(t.latest_version)}`);
        return v ? { id, ...t, manifest: v.manifest } : undefined;
      };
      if (s.includes('WHERE t.id = $1')) {
        const row = record(params[0] as string);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      const rows = [...db.templates.keys()].sort().map(record).filter((r) => r !== undefined);
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('DELETE FROM conductor_templates')) {
      const id = params[0] as string;
      const existed = db.templates.delete(id);
      for (const key of [...db.versions.keys()]) if (key.startsWith(`${id}:`)) db.versions.delete(key); // ON DELETE CASCADE
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (s.startsWith('SELECT version, created_at FROM conductor_template_versions')) {
      const id = params[0] as string;
      const rows = [...db.versions.entries()]
        .filter(([key]) => key.startsWith(`${id}:`))
        .map(([key, v]) => ({ version: Number(key.split(':')[1]), created_at: v.created_at }))
        .sort((a, b) => a.version - b.version);
      return { rows, rowCount: rows.length };
    }

    if (s.startsWith('SELECT manifest, version FROM conductor_template_versions')) {
      const v = db.versions.get(`${params[0] as string}:${String(params[1] as number)}`);
      return { rows: v ? [{ manifest: v.manifest, version: params[1] }] : [], rowCount: v ? 1 : 0 };
    }

    if (s.startsWith('INSERT INTO conductor_template_instantiations')) {
      const [template_id, template_name, template_version, workflow_slug] = params as [string, string, number, string];
      db.instantiations.push({ template_id, template_name, template_version, workflow_slug });
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT template_id, COUNT(*)')) {
      const counts = new Map<string, number>();
      for (const row of db.instantiations) counts.set(row.template_id, (counts.get(row.template_id) ?? 0) + 1);
      return { rows: [...counts.entries()].map(([template_id, n]) => ({ template_id, count: String(n) })), rowCount: counts.size };
    }

    if (s.startsWith('UPDATE conductor_workflows SET template_id')) {
      const [workflowId, templateId, version] = params as [string, string, number];
      db.workflows.set(workflowId, { template_id: templateId, template_version: version });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unscripted query: ${s}`);
  }

  const client = { query, release: (): void => {} } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pool;
  return { pool, client, ...db };
}

describe('templateStore create/get/list/delete', () => {
  it('round-trips a manifest: private, owned, version column stamped into manifest.version', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    const created = await store.create(fixtureManifest(), 'operator-a');
    assert.equal(created.id, 'tpl-approval');
    assert.equal(created.status, 'private');
    assert.equal(created.createdBy, 'operator-a');
    assert.equal(created.latestVersion, 1);
    assert.equal(created.manifest.version, 1); // stamped from the column, absent in the input

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]!.manifest.slots, fixtureManifest().slots);

    assert.equal(await store.delete('tpl-approval'), true);
    assert.equal(await store.get('tpl-approval'), undefined);
    assert.deepEqual(await store.listVersions('tpl-approval'), []); // versions cascade-deleted
    assert.equal(await store.delete('tpl-approval'), false);
  });

  it('maps the INSERT unique violation to TemplateIdExistsError (atomic, no pre-check)', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    await store.create(fixtureManifest(), 'operator-a');
    await assert.rejects(
      store.create(fixtureManifest(), 'operator-b'),
      (err: unknown) => err instanceof TemplateIdExistsError && err.id === 'tpl-approval',
    );
  });

  it('rejects an invalid manifest with the check issues, persisting nothing', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    const broken = fixtureManifest();
    broken.slots = {}; // undeclared slot placeholder in the graph
    await assert.rejects(
      store.create(broken, 'operator-a'),
      (err: unknown) => err instanceof TemplateInvalidError && err.errors.some((e) => e.code === 'template_undeclared_slot'),
    );
    assert.equal(db.templates.size, 0);
  });
});

describe('templateStore versioning', () => {
  it('addVersion appends an immutable version 2 and keeps version 1 resolvable', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    await store.create(fixtureManifest(), 'operator-a');

    const v2 = fixtureManifest();
    v2.graph.steps[0]!.prompt = 'Do the work, v2.';
    const record = await store.addVersion('tpl-approval', v2);
    assert.equal(record!.latestVersion, 2);
    assert.equal(record!.manifest.version, 2);
    assert.equal(record!.manifest.graph.steps[0]!.prompt, 'Do the work, v2.');

    const old = await store.getVersion('tpl-approval', 1);
    assert.equal(old!.version, 1);
    assert.equal(old!.graph.steps[0]!.prompt, 'Do the work.');

    assert.deepEqual((await store.listVersions('tpl-approval')).map((v) => v.version), [1, 2]);
    assert.equal(await store.getVersion('tpl-approval', 3), undefined);
  });

  it('addVersion on an unknown id returns undefined (no orphan version row)', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    assert.equal(await store.addVersion('nope', fixtureManifest('nope')), undefined);
    assert.equal(db.versions.size, 0);
  });
});

describe('templateStore review status', () => {
  it('setStatus transitions and records the reviewer', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    await store.create(fixtureManifest(), 'operator-a');
    const pending = await store.setStatus('tpl-approval', 'pending');
    assert.equal(pending!.status, 'pending');
    assert.equal(pending!.reviewedBy, null);
    const shared = await store.setStatus('tpl-approval', 'shared', 'operator-b');
    assert.equal(shared!.status, 'shared');
    assert.equal(shared!.reviewedBy, 'operator-b');
    assert.equal(await store.setStatus('nope', 'shared'), undefined);
  });
});

describe('templateStore telemetry + provenance', () => {
  it('recordInstantiation appends anonymous rows; instantiationCounts groups them', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    await store.recordInstantiation({ templateId: 'tpl-a', templateName: 'A', version: 1, workflowSlug: 'wf-1' });
    await store.recordInstantiation({ templateId: 'tpl-a', templateName: 'A', version: 2, workflowSlug: 'wf-2' });
    await store.recordInstantiation({ templateId: 'tpl-b', templateName: 'B', version: 1, workflowSlug: 'wf-3' });
    assert.deepEqual(await store.instantiationCounts(), { 'tpl-a': 2, 'tpl-b': 1 });
    // Denormalized name — the row must carry it so it survives template deletion.
    assert.equal(db.instantiations[0]!.template_name, 'A');
  });

  it('stampWorkflowProvenance writes {template_id, template_version} through the caller client', async () => {
    const db = fakeDb();
    const store = createTemplateStore(db.pool);
    await store.stampWorkflowProvenance(db.client, 'wf-42', 'tpl-approval', 3);
    assert.deepEqual(db.workflows.get('wf-42'), { template_id: 'tpl-approval', template_version: 3 });
  });
});
