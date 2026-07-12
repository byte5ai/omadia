import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import { DevRetentionRunner } from '../../src/devplatform/retention.js';
import type { DevJob, DevJobEvent, DevRepo } from '../../src/devplatform/types.js';

/**
 * Epic #470 W5 — DB-gated integration for the data-lifecycle unit (spec §7).
 * Skips when no test Postgres is reachable, mirroring the other `*.pg.test.ts`.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'pg-devplatform-retention-test';
const MS_PER_DAY = 86_400_000;
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

const isoDaysAgo = (days: number): string => new Date(Date.now() - days * MS_PER_DAY).toISOString();

function truncatedStatusEvents(events: DevJobEvent[]): DevJobEvent[] {
  return events.filter((e) => e.type === 'status' && e.payload['state'] === 'events_truncated');
}

describe('devplatform/retention (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const repoStore = new DevRepoStore(pool);
  // Windows: heartbeat/log pruned at 30d, everything at the 365d outer bound.
  const runner = new DevRetentionRunner(pool, { eventRetentionDays: 30, auditRetentionDays: 365 });
  let repo: DevRepo;

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
  }

  async function newQueuedJob(store: DevJobStore): Promise<DevJob> {
    const { hash } = mintRunnerToken();
    return store.createJob({
      repoId: repo.id,
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
    repo = await repoStore.createRepo({
      owner: MARK,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      createdBy: MARK,
    });
  });

  after(async () => {
    await cleanup();
    await pool.end().catch(() => undefined);
  });

  it('two-tier prune: low-value telemetry past 30d deleted, audit-grade of same age KEPT', async () => {
    const store = new DevJobStore(pool);
    const job = await newQueuedJob(store);
    // 40 days old: 2 low-value (heartbeat/log) + 2 audit-grade (gate/token).
    await store.appendEvents(job.id, 1, [
      { seq: 0, type: 'heartbeat', ts: isoDaysAgo(40) },
      { seq: 1, type: 'log', ts: isoDaysAgo(40) },
      { seq: 2, type: 'gate', ts: isoDaysAgo(40) },
      { seq: 3, type: 'token', ts: isoDaysAgo(40) },
    ]);

    const deleted = await runner.pruneLowValueEvents();
    assert.ok(deleted >= 2, `expected >= 2 low-value deletions, got ${String(deleted)}`);

    const remaining = await store.listEvents(job.id);
    const types = remaining.map((e) => e.type).sort();
    // heartbeat + log gone; gate + token survive the short tier.
    assert.deepEqual(types, ['gate', 'token']);
  });

  it('outer bound: an event past 365d is deleted regardless of type', async () => {
    const store = new DevJobStore(pool);
    const job = await newQueuedJob(store);
    await store.appendEvents(job.id, 1, [
      { seq: 0, type: 'gate', ts: isoDaysAgo(400) }, // audit-grade but past the outer bound
      { seq: 1, type: 'token', ts: isoDaysAgo(10) }, // in-window: survives
    ]);

    await runner.run(); // low tier + outer bound

    const remaining = await store.listEvents(job.id);
    const types = remaining.map((e) => e.type);
    assert.deepEqual(types, ['token'], 'the 400d-old gate must be gone; the 10d token kept');
  });

  it('per-job cap: log dropped, ONE events_truncated status, audit-grade still accepted', async () => {
    const capped = new DevJobStore(pool, { maxEvents: 3 });
    const job = await newQueuedJob(capped);

    // Fill to the cap with audit-grade events (seq 0..2).
    await capped.appendEvents(job.id, 1, [
      { seq: 0, type: 'tool' },
      { seq: 1, type: 'tool' },
      { seq: 2, type: 'tool' },
    ]);

    // Over cap: a log (dropped) + a token (audit-grade, accepted).
    const inserted = await capped.appendEvents(job.id, 1, [
      { seq: 3, type: 'log' },
      { seq: 4, type: 'token' },
    ]);
    assert.equal(inserted, 1, 'only the audit-grade token should be inserted');

    let events = await capped.listEvents(job.id);
    assert.ok(!events.some((e) => e.type === 'log'), 'the over-cap log must be dropped');
    assert.ok(events.some((e) => e.type === 'token' && e.seq === 4), 'the token must be accepted');
    assert.equal(truncatedStatusEvents(events).length, 1, 'exactly one events_truncated marker');

    // Another over-cap log: dropped, and NO second truncation marker.
    const inserted2 = await capped.appendEvents(job.id, 1, [{ seq: 5, type: 'log' }]);
    assert.equal(inserted2, 0);
    events = await capped.listEvents(job.id);
    assert.equal(truncatedStatusEvents(events).length, 1, 'still exactly one events_truncated');

    // A gate (audit-grade) is still accepted past the cap.
    const inserted3 = await capped.appendEvents(job.id, 1, [{ seq: 6, type: 'gate' }]);
    assert.equal(inserted3, 1);
    events = await capped.listEvents(job.id);
    assert.ok(events.some((e) => e.type === 'gate' && e.seq === 6), 'the gate must be accepted');
  });

  it('the events_truncated marker survives a provision-0 seq race with host events (Forge W5 A3b)', async () => {
    const capped = new DevJobStore(pool, { maxEvents: 2 });
    const job = await newQueuedJob(capped);
    await capped.appendEvents(job.id, 1, [{ seq: 0, type: 'tool' }, { seq: 1, type: 'tool' }]); // at cap

    // Fire the cap-triggering log drops (→ recordTruncationOnce, provision 0) CONCURRENTLY
    // with finalize-style host status events that compete for the SAME provision-0 seq.
    // COUNTER-PROOF: the pre-fix recordTruncationOnce did not retry, so on a seq
    // collision its ON CONFLICT (…,seq) inserted zero and the marker was LOST (0
    // markers) — the "log never lies" invariant broken. The retry + partial-unique
    // index (0030) guarantee EXACTLY ONE regardless of who wins the seq.
    await Promise.all([
      capped.appendEvents(job.id, 1, [{ seq: 2, type: 'log' }]),
      capped.appendHostEvent(job.id, 'status', { state: 'done' }),
      capped.appendEvents(job.id, 1, [{ seq: 3, type: 'log' }]),
      capped.appendHostEvent(job.id, 'phase', { phase: 'review' }),
      capped.appendEvents(job.id, 1, [{ seq: 4, type: 'log' }]),
      capped.appendHostEvent(job.id, 'status', { state: 'x' }),
    ]);

    const events = await capped.listEvents(job.id);
    assert.equal(truncatedStatusEvents(events).length, 1, 'exactly one events_truncated marker survives the race');
  });

  it('artifact ceiling: oversized content is marked+refused inline, small content stored as-is', async () => {
    const store = new DevJobStore(pool, { artifactCeiling: { maxBytes: 1024 } });
    const job = await newQueuedJob(store);

    const small = 'a small transcript';
    const smallId = await store.addArtifact(job.id, 'analysis', small);
    const smallArt = await store.getArtifact(smallId);
    assert.equal(smallArt?.content, small, 'in-ceiling content stored verbatim');
    assert.notEqual(smallArt?.meta['oversized'], true);

    const big = 'x'.repeat(2000); // > 1024-byte ceiling
    const bigId = await store.addArtifact(job.id, 'analysis', big);
    const bigArt = await store.getArtifact(bigId);
    assert.ok(bigArt, 'oversized artifact row still created');
    assert.ok(bigArt.content.length < big.length, 'oversized content NOT stored inline unbounded');
    assert.equal(bigArt.meta['oversized'], true, 'marked oversized (no object store configured)');
    assert.equal(bigArt.meta['originalBytes'], 2000);
  });

  it('purge: deletes terminal jobs older than the window, leaves active + in-window untouched', async () => {
    const store = new DevJobStore(pool);

    // Old terminal job (ended 100d ago) with events + an artifact.
    const oldJob = await newQueuedJob(store);
    await store.appendEvents(oldJob.id, 1, [{ seq: 0, type: 'status' }]);
    await store.addArtifact(oldJob.id, 'summary', 's');
    await pool.query(
      `UPDATE dev_jobs SET status = 'done', ended_at = now() - interval '100 days' WHERE id = $1`,
      [oldJob.id],
    );

    // In-window terminal job (ended 5d ago) — must survive.
    const recentJob = await newQueuedJob(store);
    await store.appendEvents(recentJob.id, 1, [{ seq: 0, type: 'status' }]);
    await pool.query(
      `UPDATE dev_jobs SET status = 'done', ended_at = now() - interval '5 days' WHERE id = $1`,
      [recentJob.id],
    );

    // Active job (never ended) — must survive.
    const activeJob = await newQueuedJob(store);
    await store.appendEvents(activeJob.id, 1, [{ seq: 0, type: 'status' }]);

    const purged = await runner.purgeTerminalJobs(30);
    assert.ok(purged >= 1, `expected >= 1 purged job, got ${String(purged)}`);

    assert.equal(await store.getJob(oldJob.id), null, 'old terminal job purged');
    assert.equal((await store.listEvents(oldJob.id)).length, 0, 'its events cascaded away');

    assert.ok(await store.getJob(recentJob.id), 'in-window terminal job kept');
    assert.equal((await store.listEvents(recentJob.id)).length, 1, 'in-window events untouched');
    assert.ok(await store.getJob(activeJob.id), 'active job kept');
    assert.equal((await store.listEvents(activeJob.id)).length, 1, 'active events untouched');
  });
});
