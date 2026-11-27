/**
 * #2290 / ADR-0261 — migration 0122 moves standard agents on context-memory
 * mode `off` to `members`, leaves every other mode and every non-standard
 * archetype alone, and records the switch for the memory tab's notice. The
 * notice ends with the next explicit mode write through `ConfigStore`.
 *
 * Runs the core series up to 0119 first (from a copy of the directory without
 * 0122), seeds agents as an instance before this change would hold them, then
 * applies the full series.
 */

import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'contextMemoryOffToMembers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION = '0122_context_memory_off_to_members.sql';
const SCHEMA = `cm_off_members_${String(process.pid)}`;

describe('migration 0122 — context memory off → members (#2290)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let beforeDir: string;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });

    beforeDir = mkdtempSync(join(tmpdir(), 'mig-0119-'));
    for (const f of readdirSync(MIGRATIONS_DIR)) {
      if (f.endsWith('.sql') && f < MIGRATION) copyFileSync(join(MIGRATIONS_DIR, f), join(beforeDir, f));
    }
    await runMultiOrchestratorMigrations(pool, () => undefined, beforeDir);

    await pool.query(
      `INSERT INTO agents (slug, name, context_memory) VALUES
         ('legacy-off', 'Legacy', 'off'),
         ('scoped', 'Scoped', 'enforce'),
         ('fresh', 'Fresh', 'members')`,
    );
    await pool.query(
      `INSERT INTO agents (slug, name, context_memory, archetype)
       VALUES ('mara', 'Mara', 'off', 'facilitator')`,
    );

    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pool.end();
    }
    if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
  });

  async function row(slug: string): Promise<{ mode: string; switched: Date | null }> {
    const { rows } = await pool.query<{ context_memory: string; context_memory_switched_at: Date | null }>(
      'SELECT context_memory, context_memory_switched_at FROM agents WHERE slug = $1',
      [slug],
    );
    const r = rows[0];
    assert.ok(r, `agent ${slug} missing`);
    return { mode: r.context_memory, switched: r.context_memory_switched_at };
  }

  it('switches a standard agent on off to members and records it', async () => {
    const r = await row('legacy-off');
    assert.equal(r.mode, 'members');
    assert.ok(r.switched instanceof Date);
  });

  it('leaves other modes and the facilitator archetype untouched', async () => {
    assert.deepEqual(await row('scoped'), { mode: 'enforce', switched: null });
    assert.deepEqual(await row('fresh'), { mode: 'members', switched: null });
    assert.deepEqual(await row('mara'), { mode: 'off', switched: null });
  });

  it('surfaces the switch on the row and clears it with the next mode write', async () => {
    const store = new ConfigStore(pool);
    const agent = await store.getAgentBySlug('legacy-off');
    assert.ok(agent);
    assert.equal(typeof agent.contextMemorySwitchedAt, 'string');

    await store.updateAgent(agent.id, { name: 'Legacy renamed' });
    assert.equal(typeof (await store.getAgentBySlug('legacy-off'))?.contextMemorySwitchedAt, 'string');

    await store.updateAgent(agent.id, { contextMemory: 'off' });
    const after = await store.getAgentBySlug('legacy-off');
    assert.equal(after?.contextMemory, 'off');
    assert.equal(after?.contextMemorySwitchedAt, null);
  });
});
