/**
 * Memory-ACL plan, step 4d — the ACL contract after migrations, on data
 * written before them.
 *
 * The other contract suites seed a database that is already at the newest
 * schema, so a migration that rewrites stored rows never meets seeded data. A
 * data migration that widens who may read a memory would pass them all. This
 * suite builds the knowledge graph in a schema of its own, applies the graph
 * migrations up to {@link BASE}, writes the world the way the code before the
 * later migrations stored it, then lets `runGraphMigrations` apply the rest,
 * as a deployment's boot does. The result must equal the oracle for the
 * world as the migrations are documented to leave it ({@link migrated}).
 *
 * When a new migration changes stored visibility or owners, write what it
 * does into {@link migrated} with its migration id, by hand from the
 * migration's documented intent, never from its SQL. When the seed needs a
 * column a newer migration adds, move {@link BASE} to the newest migration
 * the seed still runs on; the migrations behind it were covered while BASE
 * sat before them.
 *
 * Process memory is not seeded (its table gains a column after BASE); the
 * contract covers memorable knowledge and excerpts, the stores whose
 * visibility migrations rewrite.
 *
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * skips without one. Runs in `npm run test:pg`.
 */
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, it } from 'node:test';

import { Pool } from 'pg';

import { InMemoryMemoryStore } from '@omadia/memory';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { runAclContract } from './aclContract.js';
import { seedWorld, type Seeded } from './seed.js';
import { TENANTS, buildWorld, type Item, type MkItem, type TenantKey, type World } from './world.js';

/**
 * The newest migration applied before the world is written. 0037 (#1823,
 * ADR-0183) is the migration this pins first: it moved defaulted `team`
 * memories to `private`.
 */
const BASE = '0036_token_usage_cache_write_1h.sql';

const MIGRATIONS_DIR = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@omadia/knowledge-graph-neon/dist/migrator.js')),
  'migrations',
);

/**
 * The world as the migrations after {@link BASE} leave it. Hand-written from
 * each migration's documented intent.
 */
export function migrated(world: World): World {
  const mks = new Map<MkItem, MkItem>();
  for (const mk of world.byStore['memorable-knowledge']) {
    // Before #1823 a memory written without visibility took the column
    // default `team`.
    const stored = mk.visibility === 'absent' ? 'team' : mk.visibility;
    // 0037 (#1823, ADR-0183): a `team` memory with owners becomes private
    // ("memorable knowledge is private unless shared on purpose"). Kept
    // shared: operator rules (`system:rules-hook`, not in this world),
    // `public`, and rows without owners.
    const owned = mk.owners !== 'absent' && mk.owners.length > 0;
    const visibility = stored === 'team' && owned ? 'private' : stored;
    mks.set(mk, { ...mk, visibility });
  }
  const items: Item[] = world.items.map((i) => {
    if (i.store === 'memorable-knowledge') return mks.get(i)!;
    if (i.store === 'excerpt') return { ...i, parent: mks.get(i.parent)! };
    return i;
  });
  const byStore = Object.fromEntries(
    Object.keys(world.byStore).map((s) => [s, items.filter((i) => i.store === s)]),
  ) as unknown as World['byStore'];
  return { items, byStore };
}

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryAccess/aclAfterMigrations',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const schema = `acl_mig_${run.replace(/-/g, '_')}`;
let admin: Pool | undefined;
let pool: Pool | undefined;
let seeded: Seeded | undefined;
let applied: { base: number; after: string[] } | undefined;

before(async () => {
  if (!pgUp) return;
  admin = new Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Unqualified names resolve to the new schema first; `vector` stays in public.
  pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema},public` });

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.includes(BASE), `BASE ${BASE} is not a graph migration`);
  const upToBase = files.filter((f) => f <= BASE);
  await pool.query(
    'CREATE TABLE _graph_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  for (const f of upToBase) {
    await pool.query(await readFile(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await pool.query('INSERT INTO _graph_migrations (id) VALUES ($1)', [f]);
  }

  const world = buildWorld();
  const tenantId = (k: TenantKey): string => `${TENANTS[k]}-${run}`;
  const p = pool;
  const store = (k: TenantKey) => ({
    graph: new NeonKnowledgeGraph({ pool: p, tenantId: tenantId(k) }),
    memory: new InMemoryMemoryStore(),
  });
  const written = await seedWorld(world, { main: store('main'), other: store('other') }, async (k, id, vector) => {
    await p.query('UPDATE graph_nodes SET embedding = $1::vector WHERE tenant_id = $2 AND external_id = $3', [
      `[${vector.join(',')}]`,
      tenantId(k),
      id,
    ]);
  });

  // The rows as the code before #1823 wrote them: no visibility given meant
  // the column default `team`. Today's code writes `private` explicitly.
  const legacy = world.byStore['memorable-knowledge'].filter((mk) => mk.visibility === 'absent');
  const res = await pool.query(
    `UPDATE graph_nodes SET visibility = 'team'
      WHERE type = 'MemorableKnowledge' AND external_id = ANY($1)`,
    [legacy.map((mk) => written.location.get(mk.canary))],
  );
  assert.equal(res.rowCount, legacy.length, 'every defaulted memory was rewritten to its legacy form');

  await runGraphMigrations(pool);
  const ledger = await pool.query<{ id: string }>('SELECT id FROM _graph_migrations ORDER BY id');
  applied = { base: upToBase.length, after: ledger.rows.map((r) => r.id).filter((id) => id > BASE) };
  await pool.query('ANALYZE graph_nodes, graph_edges');
  seeded = { ...written, world: migrated(world) };
});

it('memory ACL after migrations · the migrations after BASE ran on the seeded rows', (t) => {
  if (!applied) return t.skip('no test database');
  // Positive control: with nothing after BASE the suite would test nothing.
  assert.ok(applied.after.length > 0, `no graph migration after ${BASE}`);
});

const setup = async (): Promise<Seeded | undefined> => seeded;
runAclContract('NeonKnowledgeGraph (migrated from BASE)', 'memorable-knowledge', setup);
runAclContract('NeonKnowledgeGraph (migrated from BASE)', 'excerpt', setup);

after(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
