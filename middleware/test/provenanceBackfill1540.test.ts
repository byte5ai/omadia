/**
 * #1540 path 4 — the provenance backfill against a real pgvector Postgres
 * (`GRAPH_PG_TEST_URL`; skipped without one): only legacy items the detector
 * flags are marked, excluded trees and later content are untouched, a dry
 * run writes nothing, and a detector failure aborts.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import {
  ProvenanceDetectorError,
  runProvenanceBackfill,
} from '../packages/harness-orchestrator-extras/src/provenanceBackfill.js';
import { isUnprotectedNote } from '../packages/harness-orchestrator-extras/src/noteProvenance.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'provenance-backfill-1540';
const OLD = '2026-10-01T00:00:00Z';
const BEFORE = new Date('2026-10-28T16:00:00Z');
const NAME = 'Christian Wendler';
const detect = async (text: string): Promise<boolean> => text.includes(NAME);

const NOTES: Array<[string, string, string]> = [
  ['/memories/_rules/hr-approver.md', `# Genehmiger ${NAME}`, OLD],
  ['/memories/_rules/opos.md', '# OPOS-Konvention', OLD],
  ['/memories/orchestrators/a/customers/x.md', `Kontakt ${NAME}`, OLD],
  ['/memories/orchestrators/a/plugins/crm/cache.md', `Kontakt ${NAME}`, OLD],
  ['/memories/sessions/s/2026-10-01.md', `**User:** ${NAME}`, OLD],
  ['/memories/orchestrators/a/members.json', `{"owners":["${NAME}"]}`, OLD],
  ['/memories/orchestrators/a/new.md', `Kontakt ${NAME}`, '2026-10-28T17:00:00Z'],
];

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'provenanceBackfill1540',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function seed(p: Pool): Promise<void> {
  await runGraphMigrations(p);
  await p.query(`CREATE TABLE IF NOT EXISTS memory_files (
    virtual_path TEXT PRIMARY KEY, content TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await clean(p);
  for (const [path, content, at] of NOTES) {
    await p.query(
      `INSERT INTO memory_files (virtual_path, content, size_bytes, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
      [path, content, content.length, at],
    );
  }
  const node = async (id: string, props: Record<string, unknown>, at = OLD) =>
    p.query(
      `INSERT INTO graph_nodes (tenant_id, external_id, type, properties, created_at) VALUES ($1,$2,'MemorableKnowledge',$3::jsonb,$4)`,
      [TENANT, id, JSON.stringify(props), at],
    );
  await node('mk:rule-name', { created_by: 'system:rules-hook', summary: `Genehmiger ${NAME}` });
  await node('mk:rule-plain', { created_by: 'system:rules-hook', summary: 'OPOS' });
  await node('mk:mcp', { created_by: 'auto:u1', summary: 'MCP crm · get_contact', rationale: NAME });
  await node('mk:other', { created_by: 'auto:u1', summary: `Gespräch mit ${NAME}` });
  await p.query(
    `INSERT INTO processes (id, tenant_id, scope, title, steps, created_at) VALUES
      ('process:s:a', $1, 's', 'HR: Freigabe durch ${NAME}', '["a"]', $2),
      ('process:s:b', $1, 's', 'Accounting: OPOS', '["b"]', $2)`,
    [TENANT, OLD],
  );
}

async function clean(p: Pool): Promise<void> {
  await p.query(`DELETE FROM memory_files WHERE virtual_path = ANY($1)`, [NOTES.map((n) => n[0])]);
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]);
}

after(async () => {
  if (!pool) return;
  await clean(pool);
  await pool.end();
});

describe('#1540 · provenance backfill (real PG)', () => {
  it('marks only flagged legacy items, dry run first', async (t) => {
    if (!pool) return t.skip('no test database');
    await seed(pool);
    const opts = { pool, tenantId: TENANT, detect, before: BEFORE };

    const dry = await runProvenanceBackfill({ ...opts, apply: false });
    assert.deepEqual([...dry.notes.flagged].sort(), [
      '/memories/_rules/hr-approver.md',
      '/memories/orchestrators/a/customers/x.md',
    ]);
    assert.deepEqual(dry.ruleMemories.flagged, ['mk:rule-name']);
    assert.deepEqual(dry.mcpMemories.flagged, ['mk:mcp']);
    assert.deepEqual(dry.processes.flagged, ['process:s:a']);
    const untouched = await pool.query(`SELECT content FROM memory_files WHERE virtual_path = $1`, [
      '/memories/_rules/hr-approver.md',
    ]);
    assert.equal(isUnprotectedNote(untouched.rows[0].content), false);

    await runProvenanceBackfill({ ...opts, apply: true });
    const notes = await pool.query<{ virtual_path: string; content: string }>(
      `SELECT virtual_path, content FROM memory_files WHERE virtual_path = ANY($1)`,
      [NOTES.map((n) => n[0])],
    );
    const marked = notes.rows.filter((r) => isUnprotectedNote(r.content)).map((r) => r.virtual_path).sort();
    assert.deepEqual(marked, ['/memories/_rules/hr-approver.md', '/memories/orchestrators/a/customers/x.md']);
    const stamped = await pool.query<{ external_id: string }>(
      `SELECT external_id FROM graph_nodes WHERE tenant_id = $1 AND (properties->>'unprotected')::boolean ORDER BY 1`,
      [TENANT],
    );
    assert.deepEqual(stamped.rows.map((r) => r.external_id), ['mk:mcp', 'mk:rule-name']);
    const procs = await pool.query<{ id: string }>(
      `SELECT id FROM processes WHERE tenant_id = $1 AND unprotected ORDER BY 1`,
      [TENANT],
    );
    assert.deepEqual(procs.rows.map((r) => r.id), ['process:s:a']);

    // Idempotent: a second run flags nothing new.
    const again = await runProvenanceBackfill({ ...opts, apply: true });
    assert.equal(again.notes.flagged.length + again.ruleMemories.flagged.length + again.processes.flagged.length, 0);
  });

  it('aborts on a detector failure instead of guessing', async (t) => {
    if (!pool) return t.skip('no test database');
    await seed(pool);
    await assert.rejects(
      () =>
        runProvenanceBackfill({
          pool,
          tenantId: TENANT,
          before: BEFORE,
          apply: true,
          detect: async () => {
            throw new Error('sidecar down');
          },
        }),
      ProvenanceDetectorError,
    );
  });
});
