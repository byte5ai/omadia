import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobEventBus } from '../../src/devplatform/devJobEventBus.js';
import {
  DevJobLeaseLostError,
  DevJobStore,
  TERMINAL_FINISH_BRAND,
} from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { hashRunnerToken, mintRunnerToken } from '../../src/devplatform/jobToken.js';
import type { DevRepo } from '../../src/devplatform/types.js';

/**
 * Epic #470 W0 — DB-gated integration for DevJobStore (spec §11). Skips when no
 * test Postgres is reachable, mirroring the other `*.pg.test.ts`. Applies the
 * real top-level migrations (0021 included) via the same runner the app uses.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'pg-devplatform-test';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

describe('devplatform/DevJobStore (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const bus = new DevJobEventBus();
  const store = new DevJobStore(pool, { eventBus: bus });
  const repoStore = new DevRepoStore(pool);
  let repo: DevRepo;

  async function cleanup(): Promise<void> {
    // Cascades to dev_jobs → dev_job_events → dev_job_artifacts.
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

  async function newQueuedJob(repoId: string) {
    const { hash } = mintRunnerToken();
    return store.createJob({
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
    // Idempotent: applies pending migrations, a no-op on an already-migrated DB.
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir); // re-apply is a no-op
    await cleanup();
    repo = await newRepo();
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  it('createJob defaults: queued, provision 1, phase implement, api_key', async () => {
    const job = await newQueuedJob(repo.id);
    assert.equal(job.status, 'queued');
    assert.equal(job.provision, 1);
    assert.equal(job.phase, 'implement');
    assert.equal(job.authMode, 'api_key');
    // Only the sha256 hash is stored — never the plaintext token.
    assert.match(job.runnerTokenHash ?? '', /^[0-9a-f]{64}$/);
  });

  it('two concurrent claimNextQueued return disjoint jobs (FOR UPDATE SKIP LOCKED)', async () => {
    const localRepo = await newRepo();
    await newQueuedJob(localRepo.id);
    await newQueuedJob(localRepo.id);

    const [a, b] = await Promise.all([
      store.claimNextQueued(randomUUID()),
      store.claimNextQueued(randomUUID()),
    ]);
    assert.ok(a && b, 'both workers claimed a job');
    assert.notEqual(a!.id, b!.id, 'the two claims are disjoint');
    assert.equal(a!.status, 'provisioning');
    assert.equal(b!.status, 'provisioning');
  });

  it('claimNextQueued rejects a non-UUID lease loudly', async () => {
    await assert.rejects(() => store.claimNextQueued('not-a-uuid'), /must be a UUID/);
  });

  it('a lease-fenced write with a stale claimed_by affects 0 rows and raises the typed error', async () => {
    const job = await newQueuedJob(repo.id);
    const claimed = await store.claimNextQueued(randomUUID());
    // Claim whichever queued job we got; then re-find OUR job's lease by claiming
    // until we hold it. Simpler: claim directly and use its lease.
    assert.ok(claimed);
    const lease = claimed!.claimedBy!;
    const handle = { backend: 'local' as const, id: '/tmp/x', pid: 1, startedAt: new Date().toISOString() };

    // Correct lease succeeds.
    await store.setRunnerHandle(claimed!.id, lease, handle);

    // Stale lease → 0 rows → typed error.
    await assert.rejects(
      () => store.setRunnerHandle(claimed!.id, randomUUID(), handle),
      DevJobLeaseLostError,
    );
    void job;
  });

  it('appendEvents conflict-ignores within a provision and accepts the same seq under another provision', async () => {
    const job = await newQueuedJob(repo.id);

    const first = await store.appendEvents(job.id, 1, [{ seq: 0, type: 'log', payload: { text: 'a' } }]);
    assert.equal(first, 1, 'first insert accepted');

    const retry = await store.appendEvents(job.id, 1, [{ seq: 0, type: 'log', payload: { text: 'a' } }]);
    assert.equal(retry, 0, 'same (provision, seq) is an idempotent no-op');

    const otherProvision = await store.appendEvents(job.id, 2, [{ seq: 0, type: 'log', payload: { text: 'b' } }]);
    assert.equal(otherProvision, 1, 'the SAME seq under a DIFFERENT provision is accepted');

    const events = await store.listEvents(job.id);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.provision),
      [1, 2],
      'ordered by id (insertion), not by seq',
    );
    assert.ok(events[0]!.id < events[1]!.id, 'id is strictly increasing');
  });

  it('listEvents orders by the IDENTITY id across provisions, never by seq', async () => {
    const job = await newQueuedJob(repo.id);
    // Insert a high seq under provision 2 FIRST, then a low seq under provision 1.
    await store.appendEvents(job.id, 2, [{ seq: 99, type: 'status', payload: {} }]);
    await store.appendEvents(job.id, 1, [{ seq: 3, type: 'log', payload: {} }]);

    const events = await store.listEvents(job.id);
    assert.equal(events.length, 2);
    assert.ok(events[0]!.id < events[1]!.id, 'id ascending regardless of seq');
    assert.deepEqual(
      events.map((e) => e.seq),
      [99, 3],
      'insertion order wins — the low seq comes second',
    );
  });

  it('appendEvents publishes newly stored events to the live bus', async () => {
    const job = await newQueuedJob(repo.id);
    const seen: number[] = [];
    const unsub = bus.subscribe(job.id, (e) => seen.push(e.seq));
    await store.appendEvents(job.id, 1, [
      { seq: 0, type: 'log', payload: {} },
      { seq: 1, type: 'tool', payload: {} },
    ]);
    unsub();
    assert.deepEqual(seen, [0, 1]);
  });

  it('verifyRunnerToken is sha256-based and rejects the wrong token / unknown job', async () => {
    const { token } = mintRunnerToken();
    const hash = hashRunnerToken(token);
    const job = await store.createJob({
      repoId: repo.id,
      kind: 'implement',
      brief: 'b',
      source: 'admin',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });

    assert.equal(await store.verifyRunnerToken(job.id, token), true);
    assert.equal(await store.verifyRunnerToken(job.id, mintRunnerToken().token), false);
    assert.equal(await store.verifyRunnerToken(randomUUID(), token), false, 'unknown job → false');
  });

  it('recordResult moves diff_ready → applying and persists usage', async () => {
    const job = await newQueuedJob(repo.id);
    await store.recordResult(job.id, {
      outcome: 'diff_ready',
      summary: 'ok',
      usage: { tokensIn: 10, tokensOut: 20, costUsd: 0.5 },
    });
    const after = await store.getJob(job.id);
    assert.equal(after?.status, 'applying');
    assert.equal(after?.tokensIn, 10);
    assert.equal(after?.tokensOut, 20);
    assert.equal(after?.costUsd, 0.5);
  });

  it('finishTerminal is the only terminal write, is brand-gated, and is idempotent', async () => {
    const job = await newQueuedJob(repo.id);

    await assert.rejects(
      // @ts-expect-error — a caller without the brand cannot finalize.
      () => store.finishTerminal(Symbol('spoof'), job.id, 'done'),
      /reserved for finalizeDevJob/,
    );

    const done = await store.finishTerminal(TERMINAL_FINISH_BRAND, job.id, 'done', {
      prUrl: 'https://example.com/pr/1',
      branch: 'omadia/job-x',
    });
    assert.equal(done?.status, 'done');
    assert.equal(done?.prUrl, 'https://example.com/pr/1');
    assert.ok(done?.endedAt, 'ended_at stamped');

    // Second call on an already-terminal job is a no-op returning existing state.
    const again = await store.finishTerminal(TERMINAL_FINISH_BRAND, job.id, 'failed', { error: 'x' });
    assert.equal(again?.status, 'done', 'idempotent — status unchanged, not flipped to failed');
    assert.equal(again?.error, null, 'the no-op did not write the failure error');
  });

  it('findStalled surfaces active jobs past the heartbeat cutoff', async () => {
    const localRepo = await newRepo();
    const job = await newQueuedJob(localRepo.id);
    const claimed = await store.claimNextQueued(randomUUID());
    assert.ok(claimed);
    // Cutoff in the future ⇒ every active job counts as stale.
    const stalled = await store.findStalled(new Date(Date.now() + 60_000));
    assert.ok(stalled.some((j) => j.id === claimed!.id), 'the active job is a stall candidate');
    void job;
  });

  it('a real addArtifact id is a uuid and passes the ownership pre-filter', async () => {
    const localRepo = await newRepo();
    const job = await newQueuedJob(localRepo.id);
    const artifactId = await store.addArtifact(job.id, 'diff', 'diff --git a/x b/x\n', { bytes: 20 });
    // The ownership guard rejects a non-uuid before it queries; a legitimate id
    // must clear it, or the job's own diff would 400. gen_random_uuid() (0021)
    // guarantees the shape, and this covers the pre-filter no unit test reaches.
    assert.match(artifactId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(await store.artifactBelongsToJob(job.id, artifactId), true);
    assert.equal(await store.artifactBelongsToJob('00000000-0000-0000-0000-000000000000', artifactId), false);
    assert.equal(await store.artifactBelongsToJob(job.id, 'not-a-uuid'), false);
  });
});
