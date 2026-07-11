import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { createChatDevJobService } from '../../src/devplatform/chatDevJobService.js';
import { DevJobEventBus } from '../../src/devplatform/devJobEventBus.js';
import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { isPermittedLauncher } from '../../src/routes/devPlatformShared.js';
import type { DevRepo } from '../../src/devplatform/types.js';

/**
 * Epic #470 W3 §3 — DB-gated integration for the chat dev-job service. Skips
 * when no test Postgres is reachable, mirroring the other `*.pg.test.ts`.
 * Applies the real top-level migrations via the same runner the app uses.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const OWNER = 'pg-chatdevjob-test';
const CALLER = { sub: `${OWNER}:operator`, email: 'op@acme.test', role: 'dev' };
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

describe('devplatform/createChatDevJobService (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const jobStore = new DevJobStore(pool, { eventBus: new DevJobEventBus() });
  const repoStore = new DevRepoStore(pool);

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM dev_repos WHERE owner = $1', [OWNER]);
  }

  async function newRepo(over: { createdBy: string; allowedLaunchers?: string[] }): Promise<DevRepo> {
    return repoStore.createRepo({
      owner: OWNER,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      createdBy: over.createdBy,
      ...(over.allowedLaunchers ? { allowedLaunchers: over.allowedLaunchers } : {}),
    });
  }

  function service(allowedRepoIds: readonly string[]) {
    return createChatDevJobService({
      repoStore,
      jobStore,
      caller: CALLER,
      allowedRepoIds,
      isPermittedLauncher,
      resolveJobPlacement: () => ({ backend: 'local' }),
    });
  }

  before(async () => {
    // Idempotent: applies pending migrations, a no-op on an already-migrated DB.
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await pool.end().catch(() => undefined);
  });

  it('creates a source=chat job attributed to the operator, then reads it back', async () => {
    const repo = await newRepo({ createdBy: CALLER.sub }); // caller is creator ⇒ launcher
    const svc = service([repo.id]);

    const resolved = await svc.resolveLaunchableRepo(repo.name);
    assert.ok(resolved);
    assert.equal(resolved!.repoId, repo.id);

    const d = await svc.startJob({ repoId: repo.id, kind: 'implement', brief: 'do the thing' });
    assert.equal(d.repoId, repo.id);
    assert.equal(d.status, 'queued');

    // Provenance is persisted as a chat job owned by the operator.
    const row = await pool.query<{ source: string; created_by: string }>(
      'SELECT source, created_by FROM dev_jobs WHERE id = $1',
      [d.id],
    );
    assert.equal(row.rows[0]?.source, 'chat');
    assert.equal(row.rows[0]?.created_by, CALLER.sub);

    // Authorized reads see it.
    const status = await svc.getJob(d.id);
    assert.ok(status);
    assert.equal(status!.descriptor.id, d.id);

    const list = await svc.listJobs({});
    assert.ok(list.some((j) => j.id === d.id));
    assert.deepEqual(await svc.listJobs({ status: 'done' }), []);
  });

  it('refuses a repo the operator cannot launch (not creator, no launcher role)', async () => {
    const repo = await newRepo({ createdBy: `${OWNER}:someone-else`, allowedLaunchers: ['admins'] });
    const svc = service([repo.id]); // granted to the agent, but caller is not a launcher

    assert.equal(await svc.resolveLaunchableRepo(repo.id), null);
    await assert.rejects(() => svc.startJob({ repoId: repo.id, kind: 'analyze', brief: 'x' }));
    // And it never surfaces in the caller's list.
    assert.deepEqual(await svc.listJobs({ repoId: repo.id }), []);
  });
});
