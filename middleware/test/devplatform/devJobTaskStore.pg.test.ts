import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { TaskLeaseLostError, runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobEventBus } from '../../src/devplatform/devJobEventBus.js';
import {
  DevJobStore,
  TERMINAL_FINISH_BRAND,
} from '../../src/devplatform/devJobStore.js';
import {
  createDevJobTaskStore,
  projectDevJobStatus,
  toTaskDescriptor,
} from '../../src/devplatform/devJobTaskStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import { DEV_JOB_STATUSES } from '../../src/devplatform/types.js';
import type { DevJob, DevJobStatus, DevRepo } from '../../src/devplatform/types.js';

/**
 * W2-2 — SEAM CONFORMANCE: `dev_job` driven through the generic `TaskStore`
 * interface against real Postgres.
 *
 * The point is not "the adapter compiles" — it is that dev_job's REAL
 * claim/lease and terminal-transition behaviour is what the seam's contract
 * describes. So these assertions deliberately mirror the ones
 * `devJobStore.pg.test.ts` already makes on the same operations, reached through
 * the seam instead of directly.
 *
 * TENANT ISOLATION: `MARK` carries a fresh UUID per run, so a concurrently
 * running dev-platform pg suite in the same cluster cannot see or delete these
 * rows (the migration advisory lock is database-wide, and `CREATE/DROP DATABASE`
 * is cluster-wide — hence neither is used here).
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

/** Unique per run — this is the tenant id. */
const MARK = `pg-task-seam-${randomUUID()}`;
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

describe('devplatform/devJobTaskStore — seam conformance (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const jobStore = new DevJobStore(pool, { eventBus: new DevJobEventBus() });
  const repoStore = new DevRepoStore(pool);
  let repo: DevRepo;

  /** Mirrors `finalizeDevJob`'s terminal write; the seam's `finish` is bound to
   *  this so the brand-gated choke point is exercised, not bypassed. */
  async function finalize(
    jobId: string,
    status: DevJobStatus,
    patch: { error?: string },
  ): Promise<DevJob | null> {
    return jobStore.finishTerminal(TERMINAL_FINISH_BRAND, jobId, status, patch);
  }

  function seam(overrides: { createJob?: (input: unknown) => Promise<DevJob> } = {}) {
    return createDevJobTaskStore({
      jobStore,
      createJob:
        overrides.createJob ??
        (async () => {
          throw new Error('createJob not wired in this test');
        }),
      finalize,
    });
  }

  async function cleanup(): Promise<void> {
    // Cascades to dev_jobs → dev_job_events → dev_job_artifacts. Scoped to THIS
    // run's tenant id, so a parallel suite's rows are never touched.
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
  }

  async function newRepo(): Promise<DevRepo> {
    return repoStore.createRepo({
      owner: MARK,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      createdBy: MARK,
    });
  }

  async function newQueuedJob(repoId: string): Promise<DevJob> {
    const { hash } = mintRunnerToken();
    return jobStore.createJob({
      repoId,
      kind: 'implement',
      brief: 'b',
      source: 'admin',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    repo = await newRepo();
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  it('projects every DevJobStatus onto the four-value seam vocabulary', () => {
    // Exhaustive: a status added to the union without a projection is a build
    // error in the adapter, and this pins that none maps to undefined at runtime.
    for (const s of DEV_JOB_STATUSES) {
      const projected = projectDevJobStatus(s);
      assert.ok(
        ['working', 'input_required', 'completed', 'failed'].includes(projected),
        `${s} projected to ${String(projected)}`,
      );
    }
    assert.equal(projectDevJobStatus('queued'), 'working');
    assert.equal(projectDevJobStatus('running'), 'working');
    assert.equal(projectDevJobStatus('waiting'), 'input_required');
    assert.equal(projectDevJobStatus('done'), 'completed');
    // A cancel did not produce the result the caller asked for, so reporting it
    // as `completed` would make a poll claim an answer that does not exist.
    assert.equal(projectDevJobStatus('cancelled'), 'failed');
    assert.equal(projectDevJobStatus('budget_exceeded'), 'failed');
  });

  it('reads a real job through the seam with the projection applied', async () => {
    const job = await newQueuedJob(repo.id);
    const store = seam();
    const d = await store.get(job.id);
    assert.ok(d);
    assert.equal(d.id, job.id);
    assert.equal(d.status, 'working', 'queued projects to working');
    assert.equal(d.phase, job.phase, 'the pipeline phase survives the projection');
    assert.equal(d.claimedBy, null);
    assert.equal(d.endedAt, null);
    assert.deepEqual(d, toTaskDescriptor(job));
  });

  it('get() on an unknown id is null, not a throw', async () => {
    assert.equal(await seam().get(randomUUID()), null);
  });

  it('claimNextPending stamps a real lease via FOR UPDATE SKIP LOCKED', async () => {
    const localRepo = await newRepo();
    const job = await newQueuedJob(localRepo.id);
    const store = seam();
    const lease = randomUUID();

    const claimed = await store.claimNextPending(lease);
    assert.ok(claimed);
    // The claim is dev_job's own: status went queued → provisioning, which still
    // projects to `working`, and the lease is on the row in Postgres.
    assert.equal(claimed.descriptor.status, 'working');
    assert.equal(claimed.descriptor.claimedBy, lease);
    const row = await jobStore.getJob(claimed.descriptor.id);
    assert.equal(row?.claimedBy, lease);
    assert.equal(row?.status, 'provisioning');
    void job;
  });

  it('rejects a non-UUID lease before it reaches the uuid column', async () => {
    await assert.rejects(() => seam().claimNextPending('nope'), TypeError);
  });

  it('two concurrent claims through the seam never return the same job', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    await newQueuedJob(localRepo.id);
    const store = seam();

    const [a, b] = await Promise.all([
      store.claimNextPending(randomUUID()),
      store.claimNextPending(randomUUID()),
    ]);
    assert.ok(a && b, 'both claimers got a job (two were queued)');
    assert.notEqual(a.descriptor.id, b.descriptor.id, 'disjoint jobs');
  });

  it('FENCES a mismatched lease — the property the fence exists for', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    const store = seam();
    const good = randomUUID();
    const claimed = await store.claimNextPending(good);
    assert.ok(claimed);
    const id = claimed.descriptor.id;
    const stale = randomUUID();

    await assert.rejects(() => store.heartbeat(id, stale), TaskLeaseLostError);
    await assert.rejects(
      () => store.appendEvents(id, stale, [{ type: 'log', message: 'hijack' }]),
      TaskLeaseLostError,
    );
    await assert.rejects(
      () => store.finish(id, stale, { status: 'completed' }),
      TaskLeaseLostError,
    );

    // Nothing the stale lease attempted landed in Postgres.
    const row = await jobStore.getJob(id);
    assert.equal(row?.status, 'provisioning', 'still live, not finalized');
    assert.equal(row?.claimedBy, good, 'the real owner still holds the lease');
    assert.deepEqual(await store.eventTail(id, 10), []);
  });

  it('accepts an UNLEASED administrative finalize (cancel route / reaper)', async () => {
    // dev_job's finishTerminal is deliberately unfenced for exactly this case.
    // The adapter must not break it while still rejecting a mismatched lease.
    const localRepo = await newRepo();
    const job = await newQueuedJob(localRepo.id);
    assert.equal(job.claimedBy, null, 'never claimed');
    const store = seam();

    const done = await store.finish(job.id, randomUUID(), {
      status: 'failed',
      error: 'cancelled by operator',
    });
    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'cancelled by operator');
    assert.equal((await jobStore.getJob(job.id))?.status, 'failed');
  });

  it('finish routes through the brand-gated terminal write', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    const store = seam();
    const lease = randomUUID();
    const claimed = await store.claimNextPending(lease);
    assert.ok(claimed);

    const done = await store.finish(claimed.descriptor.id, lease, { status: 'completed' });
    assert.equal(done.status, 'completed', 'dev_job `done` projects to completed');
    assert.ok(done.endedAt !== null);
    const row = await jobStore.getJob(claimed.descriptor.id);
    assert.equal(row?.status, 'done', 'the underlying dev_job status is `done`');
    assert.ok(row?.endedAt !== null);
  });

  it('a terminal job refuses further seam writes', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    const store = seam();
    const lease = randomUUID();
    const claimed = await store.claimNextPending(lease);
    assert.ok(claimed);
    const id = claimed.descriptor.id;
    await store.finish(id, lease, { status: 'completed' });

    // `finishTerminal` is idempotent (0 rows, returns existing state), so the
    // outcome must be unchanged rather than flipped.
    const again = await store.finish(id, lease, { status: 'failed', error: 'nope' });
    assert.equal(again.status, 'completed', 'the recorded outcome is immutable');
    // A heartbeat on a terminal job touches 0 rows and must be reported as lost.
    await assert.rejects(() => store.heartbeat(id, lease), TaskLeaseLostError);
  });

  it('surfaces a real event tail through the seam', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    const store = seam();
    const lease = randomUUID();
    const claimed = await store.claimNextPending(lease);
    assert.ok(claimed);
    const id = claimed.descriptor.id;

    await store.appendEvents(id, lease, [
      { type: 'log', message: 'first' },
      { type: 'status', message: 'second' },
    ]);
    const tail = await store.eventTail(id, 5);
    assert.equal(tail.length, 2);
    assert.deepEqual(tail.map((e) => e.message), ['first', 'second']);
    // `seq` is the monotonic IDENTITY column, not dev_job's per-provision seq
    // (which restarts and would go backwards across a re-provision).
    assert.ok(tail[1] !== undefined && tail[0] !== undefined);
    assert.ok(tail[1].seq > tail[0].seq, 'seq is monotonic across the tail');
  });

  it('list() applies the LIMIT after projection, not before', async () => {
    // A `status: 'working'` filter must not silently return fewer live jobs
    // because terminal rows consumed the SQL LIMIT first.
    const localRepo = await newRepo();
    const live = await newQueuedJob(localRepo.id);
    const store = seam();
    const working = await store.list({ status: 'working' });
    assert.ok(
      working.some((d) => d.id === live.id),
      'the live job appears under the projected status',
    );
    assert.ok(working.every((d) => d.status === 'working'));
  });

  it('reapOrphans finalizes a stalled job as failed', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    const store = seam();
    const lease = randomUUID();
    const claimed = await store.claimNextPending(lease);
    assert.ok(claimed);
    const id = claimed.descriptor.id;

    // `findStalled` compares against COALESCE(last_heartbeat_at, started_at,
    // claimed_at); a zero-width window makes every claimed job stale.
    const r = await store.reapOrphans({
      now: new Date(Date.now() + 3_600_000),
      staleAfterMs: 1,
      purgeTerminalAfterMs: 3_600_000,
    });
    assert.ok(r.staleFailed >= 1);
    const row = await jobStore.getJob(id);
    assert.equal(row?.status, 'stalled', 'dev_job records its own `stalled`');
    assert.equal(projectDevJobStatus('stalled'), 'failed');
    assert.match(String(row?.error), /abandoned/);
  });
});
