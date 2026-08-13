import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { ConductorWorkflowStore, WorkflowSlugExistsError } from '../src/conductor/workflowStore.js';

// createOrPublish create-only mode (#429 instantiate hardening): the slug conflict is
// detected by the INSERT itself (ON CONFLICT DO NOTHING) inside the publish transaction,
// never by a SELECT pre-check — two racing creates of the same fresh slug can never both
// publish. Fake-pool harness scripts pg responses by SQL shape; no DB.

interface IssuedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(opts: { slugTaken: boolean }): { pool: Pool; queries: IssuedQuery[] } {
  const queries: IssuedQuery[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
      queries.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.startsWith('INSERT INTO conductor_workflows ')) {
        // The create-only INSERT reports the conflict as zero returned rows.
        if (s.includes('DO NOTHING') && opts.slugTaken) return { rows: [] };
        return { rows: [{ id: 'wf-1' }] };
      }
      if (s.includes('FOR UPDATE')) return { rows: [{ id: 'wf-1' }] };
      if (s.includes('COALESCE(MAX(version)')) return { rows: [{ next: 1 }] };
      if (s.startsWith('INSERT INTO conductor_workflow_versions')) {
        return { rows: [{ id: 'ver-1', workflow_id: 'wf-1', version: 1, graph: JSON.parse(params[2] as string) }] };
      }
      if (s.startsWith('UPDATE conductor_workflows')) {
        return {
          rows: [{ id: 'wf-1', slug: 'fresh', name: 'Fresh', description: null, status: 'disabled', active_version_id: 'ver-1' }],
        };
      }
      throw new Error(`unscripted query: ${s}`);
    },
    release: (): void => {},
  };
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

const GRAPH: WorkflowGraph = { entryStepId: 's', steps: [{ id: 's', kind: 'agent', agentId: 'a', prompt: 'p' }], transitions: [] };

function sqlOf(queries: IssuedQuery[]): string[] {
  return queries.map((q) => q.sql.replace(/\s+/g, ' ').trim());
}

describe('ConductorWorkflowStore.createOrPublish expectNew', () => {
  it('publishes a fresh slug create-only (ON CONFLICT DO NOTHING, never DO UPDATE) and commits', async () => {
    const { pool, queries } = fakePool({ slugTaken: false });
    const out = await new ConductorWorkflowStore(pool).createOrPublish({ slug: 'fresh', name: 'Fresh', graph: GRAPH, expectNew: true });

    assert.equal(out.workflow.slug, 'fresh');
    assert.equal(out.version.version, 1);
    const insert = sqlOf(queries).find((s) => s.startsWith('INSERT INTO conductor_workflows '));
    assert.ok(insert?.includes('ON CONFLICT (slug) DO NOTHING'), insert);
    assert.ok(!insert?.includes('DO UPDATE'), insert);
    assert.ok(sqlOf(queries).includes('COMMIT'));
  });

  it('throws WorkflowSlugExistsError on a taken slug — rolled back, no version published', async () => {
    const { pool, queries } = fakePool({ slugTaken: true });
    await assert.rejects(
      new ConductorWorkflowStore(pool).createOrPublish({ slug: 'taken', name: 'Taken', graph: GRAPH, expectNew: true }),
      (err: unknown) => err instanceof WorkflowSlugExistsError && err.slug === 'taken' && err.message.includes("'taken'"),
    );
    const sql = sqlOf(queries);
    assert.ok(sql.includes('ROLLBACK'), 'conflict must roll the transaction back');
    assert.ok(!sql.includes('COMMIT'));
    assert.ok(!sql.some((s) => s.includes('conductor_workflow_versions')), 'no version may be written for the losing create');
  });

  it('keeps the idempotent upsert (DO UPDATE) without expectNew — POST / and canvas save unchanged', async () => {
    const { pool, queries } = fakePool({ slugTaken: true }); // taken is irrelevant: the upsert always returns the id
    const out = await new ConductorWorkflowStore(pool).createOrPublish({ slug: 'existing', name: 'Existing', graph: GRAPH });

    assert.equal(out.version.version, 1);
    const insert = sqlOf(queries).find((s) => s.startsWith('INSERT INTO conductor_workflows '));
    assert.ok(insert?.includes('ON CONFLICT (slug) DO UPDATE'), insert);
    assert.ok(!insert?.includes('DO NOTHING'), insert);
    assert.ok(sqlOf(queries).includes('COMMIT'));
  });
});
