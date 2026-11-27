/**
 * Memory-ACL plan, step 5 — the harness the lifecycle suites share
 * (`lifecycleInvariants.pg.test.ts`, `lifecycleCleanup.pg.test.ts`). Each
 * suite seeds the world on Neon once, runs real lifecycle jobs on it, and
 * reads the memorable-knowledge search for every viewer and mode (the options
 * a turn of that mode passes, `aclContract.ts`) around each job:
 *
 * - `guarded`: visibility never widens without an ACL audit entry — a canary a
 *   viewer gains in a mode must have an audit row written by that job.
 * - `assertOracleBounds`: what a job creates is readable only as the
 *   hand-written oracle allows for an item of that shape.
 *
 * Two files, each with its own world, so neither nears the per-file timeout.
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * the suites skip without one.
 */
import { strict as assert } from 'node:assert';
import { after, before } from 'node:test';

import { Pool } from 'pg';

import { runMemoryMigrations } from '@omadia/memory-postgres/dist/migrator.js';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { MIN_SIMILARITY, admittedIn, canariesIn, contractViewers, turnSearchOptions } from './aclContract.js';
import { seedNeon, type NeonSeeded } from './backends.js';
import { DEFAULT_SETTINGS, MODES, expected } from './oracle.js';
import { MK_GROUP_COUNT, axis } from './seed.js';
import { AGENTS, USER_KEYS, buildWorld, viewerId, type MkItem, type UserKey } from './world.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryAccess/lifecycle',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
export const pool = pgUp ? new Pool({ connectionString: PG_URL, max: 4 }) : undefined;
let neon: NeonSeeded | undefined;
/** The seeded world, or `undefined` without a test database. */
export const world = (): NeonSeeded | undefined => neon;
/** Unique per run: names this run's identities and scratch path. */
export const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const reaperPath = `/memories/orchestrators/${AGENTS.atlas}/lifecycle-${run}.md`;

/** canary → MK external id, for memories a job created. */
const created = new Map<string, string>();
const ALL_GROUPS = Array.from({ length: MK_GROUP_COUNT }, (_, i) => i);
/** Embedding axes for created memories: above the world's turn axes. */
let nextSlot = 600;

type Snapshot = Map<string, Set<string>>;

/** Every canary each main-tenant viewer gets from the MK search, per mode. */
export async function snapshot(n: NeonSeeded, groups: readonly number[] = ALL_GROUPS): Promise<Snapshot> {
  const out: Snapshot = new Map();
  const cache = new Map<string, Set<string>>();
  for (const v of contractViewers().filter((x) => x.tenant === 'main')) {
    for (const mode of MODES) {
      const options = turnSearchOptions(v, mode, DEFAULT_SETTINGS, n.seeded.users);
      const key = JSON.stringify(options);
      let got = cache.get(key);
      if (!got) {
        got = await admittedIn(n.seeded, v, 'memorable-knowledge', options, groups);
        cache.set(key, got);
      }
      out.set(`${viewerId(v)} · ${mode}`, got);
    }
  }
  return out;
}

function mkIdOf(n: NeonSeeded, canary: string): string | undefined {
  return created.get(canary) ?? n.seeded.location.get(canary);
}

/** Canaries someone gained between two snapshots without an audit row since `since`. */
async function unauditedWidening(
  n: NeonSeeded,
  before: Snapshot,
  afterSnap: Snapshot,
  since: Date,
): Promise<string[]> {
  const out: string[] = [];
  const audited = new Map<string, boolean>();
  for (const [key, got] of afterSnap) {
    for (const c of got) {
      if (before.get(key)?.has(c)) continue;
      const id = mkIdOf(n, c);
      if (!id) {
        out.push(`${key}: ${c} (unknown memory)`);
        continue;
      }
      if (!audited.has(id)) {
        const rows = await n.seeded.stores.main.graph.listMemoryAclAudit(id);
        audited.set(id, rows.some((r) => new Date(r.createdAt) >= since));
      }
      if (!audited.get(id)) out.push(`${key}: ${c}`);
    }
  }
  return out;
}

/** Runs `job` between two snapshots; returns every widening without an audit row. */
export async function widenedBy(n: NeonSeeded, job: () => Promise<void>): Promise<string[]> {
  const beforeSnap = await snapshot(n);
  assert.ok([...beforeSnap.values()].some((s) => s.size > 0), 'the snapshot sees nothing; it would prove nothing');
  const since = new Date(Date.now() - 1000);
  await job();
  return unauditedWidening(n, beforeSnap, await snapshot(n), since);
}

/** Runs `job` between two snapshots; fails on a widening without an audit row. */
export async function guarded(n: NeonSeeded, label: string, job: () => Promise<void>): Promise<void> {
  const leaks = await widenedBy(n, job);
  assert.deepEqual(leaks.slice(0, 30), [], `${label} widened access without an ACL audit row (${String(leaks.length)})`);
}

/**
 * A memory a job created, read by every viewer in every mode: present only
 * where the oracle allows an item of `shape`. Gives it a canary summary and
 * an embedding axis of its own first. Returns how many reads were allowed.
 */
export async function assertOracleBounds(n: NeonSeeded, id: string, shape: MkItem): Promise<number> {
  const slot = nextSlot++;
  created.set(shape.canary, id);
  await pool!.query(
    `UPDATE graph_nodes SET properties = properties || jsonb_build_object('summary', $3::text),
            embedding = $4::vector
      WHERE tenant_id = $1 AND external_id = $2`,
    [n.tenants.main, id, `Wissen ${shape.canary}`, `[${axis(slot).join(',')}]`],
  );
  const graph = n.seeded.stores.main.graph;
  const problems: string[] = [];
  let allowed = 0;
  for (const v of contractViewers().filter((x) => x.tenant === 'main')) {
    for (const mode of MODES) {
      const hits = await graph.searchMemorableKnowledgeByEmbedding({
        ...turnSearchOptions(v, mode, DEFAULT_SETTINGS, n.seeded.users),
        queryEmbedding: axis(slot),
        minSimilarity: MIN_SIMILARITY,
        limit: 10,
      });
      const present = canariesIn(JSON.stringify(hits.map((h) => h.mk.props))).includes(shape.canary);
      const verdict = expected(v, mode, shape);
      if (present && !verdict.allowed) problems.push(`${viewerId(v)} · ${mode}: ${verdict.source}`);
      if (present) allowed++;
    }
  }
  for (const u of USER_KEYS) {
    const owners = shape.owners === 'absent' ? [] : shape.owners;
    const read = await graph.getMemorableKnowledge(id, n.seeded.users.main[u]);
    if (read && !owners.includes(u)) problems.push(`${u} reads it by id without owning it`);
  }
  assert.deepEqual(problems, [], `${shape.canary} is readable beyond the oracle`);
  return allowed;
}

export const mkShape = (canary: string, owners: readonly UserKey[], originAgent: MkItem['originAgent']): MkItem => ({
  store: 'memorable-knowledge',
  canary,
  tenant: 'main',
  owners,
  visibility: 'private',
  originAgent,
  authorship: 'conversation',
  provenance: 'protected',
});

before(async () => {
  if (!pool) return;
  neon = await seedNeon(pool, buildWorld());
  await runMemoryMigrations(pool);
});

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM memory_files WHERE virtual_path = $1', [reaperPath]);
  await neon?.clean();
  await pool.end();
});
