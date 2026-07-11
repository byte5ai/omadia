import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import {
  createTriggerJob,
  hasActiveTriggerJob,
} from '../../src/devplatform/triggers/triggerJobService.js';
import {
  createTrackerPoller,
  effectivePollIntervalS,
  PgTrackerPollStore,
} from '../../src/devplatform/triggers/trackerPoller.js';
import type { Ticket } from '../../src/devplatform/githubIssuesTracker.js';
import type { DevPlatformTracker } from '../../src/routes/devPlatformShared.js';
import type { DevRepo, RunnerBackendKind } from '../../src/devplatform/types.js';

/**
 * Epic #470 W4 — the tracker poller against REAL Postgres (job + cursor writes)
 * with a FAKE tracker. Each `it` is FAIL-IF-REVERTED: create-on-new-ticket, active-
 * job dedupe, cursor advance, structural refusals, interval floor, and skipping a
 * repo without 'tracker' in allowed_triggers. Skips when no test Postgres reachable.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'pg-tracker-poller';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
}
await probePool.end().catch(() => undefined);

function mkTicket(number: number, updatedAt: string, extra: Partial<Ticket> = {}): Ticket {
  return {
    number,
    title: `Ticket ${String(number)}`,
    body: 'do the thing',
    labels: ['omadia-dev'],
    htmlUrl: '',
    authorLogin: 'reporter',
    updatedAt,
    ...extra,
  };
}

describe('devplatform/trackerPoller (pg)', { skip: !pgAvailable }, () => {
  const pool = new Pool({ connectionString: PG_URL, max: 10 });
  const repoStore = new DevRepoStore(pool);
  const jobStore = new DevJobStore(pool);
  const store = new PgTrackerPollStore(pool, repoStore);
  const gateStore = { open: async () => ({}) };

  // Fake tracker: per-repo ticket sets the tests mutate. Label is ignored (the
  // seam's job); the poller's cursor/dedupe logic is what's under test.
  const ticketsByRepo = new Map<string, Ticket[]>();
  let failNextList = false;
  const resolveTracker = async (repo: DevRepo): Promise<DevPlatformTracker | null> => ({
    getTicket: async () => {
      throw new Error('unused');
    },
    listOpenTickets: async () => {
      if (failNextList) {
        failNextList = false;
        throw new Error('tracker unreachable');
      }
      return ticketsByRepo.get(repo.id) ?? [];
    },
  });

  // Controllable clock so the per-repo interval gate is deterministic.
  let clock = Date.parse('2026-07-01T00:00:00.000Z');

  function makePoller(backend: RunnerBackendKind = 'docker') {
    return createTrackerPoller({
      store,
      resolveTracker,
      hasActiveJob: (repoId, sourceRef, source) => hasActiveTriggerJob(pool, repoId, sourceRef, source),
      createTriggerJob: (input) => createTriggerJob({ jobStore, gateStore }, input),
      mintRunnerToken: () => mintRunnerToken(),
      trackerBackend: backend,
      now: () => clock,
      log: () => {},
    });
  }

  async function newRepo(opts: {
    credentialKind?: DevRepo['credentialKind'];
    allowedTriggers?: string[];
    trackerKind?: string | null;
  } = {}): Promise<DevRepo> {
    return repoStore.createRepo({
      owner: MARK,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: opts.credentialKind ?? 'pat',
      credentialRef: 'repo/x',
      allowedTriggers: opts.allowedTriggers ?? ['admin', 'tracker'],
      trackerKind: opts.trackerKind ?? 'jira',
      createdBy: MARK,
    });
  }

  async function countTrackerJobs(repoId: string, sourceRef?: string): Promise<number> {
    const r = sourceRef
      ? await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM dev_jobs WHERE repo_id = $1 AND source = 'tracker' AND source_ref = $2`,
          [repoId, sourceRef],
        )
      : await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM dev_jobs WHERE repo_id = $1 AND source = 'tracker'`,
          [repoId],
        );
    return Number(r.rows[0]!.n);
  }

  async function readCursor(repoId: string): Promise<string | null> {
    const r = await pool.query<{ c: Date | null }>(
      `SELECT tracker_poll_cursor AS c FROM dev_repos WHERE id = $1`,
      [repoId],
    );
    const c = r.rows[0]?.c ?? null;
    return c == null ? null : new Date(c).toISOString();
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
  });

  // Isolate every test: a single sweep polls ALL MARK repos, so leftover repos from
  // a prior test would pollute the fake tracker's shared state and job counts.
  beforeEach(async () => {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]); // cascades dev_jobs
    ticketsByRepo.clear();
    failNextList = false;
  });

  after(async () => {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
    await pool.end().catch(() => undefined);
  });

  it('floors the effective poll interval at 60s', () => {
    assert.equal(effectivePollIntervalS(300), 300);
    assert.equal(effectivePollIntervalS(10), 60);
    assert.equal(effectivePollIntervalS(0), 60);
    assert.equal(effectivePollIntervalS(Number.NaN), 60);
  });

  it('creates a tracker job for a new labeled ticket (source=tracker, source_ref=key)', async () => {
    const repo = await newRepo();
    const sourceRef = `${repo.owner}/${repo.name}#101`;
    ticketsByRepo.set(repo.id, [mkTicket(101, '2026-07-01T09:00:00.000Z')]);

    await makePoller().pollOnce();

    assert.equal(await countTrackerJobs(repo.id, sourceRef), 1);
    const r = await pool.query<{ kind: string; created_by: string; backend: string }>(
      `SELECT kind, created_by, backend FROM dev_jobs WHERE repo_id = $1 AND source_ref = $2`,
      [repo.id, sourceRef],
    );
    assert.equal(r.rows[0]!.kind, 'fix_issue');
    assert.equal(r.rows[0]!.created_by, 'tracker:poll');
    assert.equal(r.rows[0]!.backend, 'docker');
    // Cursor advanced to the ticket's updatedAt.
    assert.equal(await readCursor(repo.id), '2026-07-01T09:00:00.000Z');
  });

  it('dedupes when an active job already exists for the ticket', async () => {
    const repo = await newRepo();
    const sourceRef = `${repo.owner}/${repo.name}#202`;

    // Poll 1: ticket updated at T1 → one job, cursor → T1.
    ticketsByRepo.set(repo.id, [mkTicket(202, '2026-07-01T09:00:00.000Z')]);
    await makePoller().pollOnce();
    assert.equal(await countTrackerJobs(repo.id, sourceRef), 1);

    // Ticket gets bumped (T2 > cursor) while the job is still active. A fresh poller
    // (interval gate reset) sees it past the cursor, but the active-job dedupe holds.
    ticketsByRepo.set(repo.id, [mkTicket(202, '2026-07-01T10:00:00.000Z')]);
    clock += 3_600_000;
    await makePoller().pollOnce();

    assert.equal(await countTrackerJobs(repo.id, sourceRef), 1, 'active-job dedupe must prevent a second job');
  });

  it('advances the cursor so a completed ticket is not re-created', async () => {
    const repo = await newRepo();
    const sourceRef = `${repo.owner}/${repo.name}#303`;

    // Poll 1: create the job, cursor → T1.
    ticketsByRepo.set(repo.id, [mkTicket(303, '2026-07-01T09:00:00.000Z')]);
    await makePoller().pollOnce();
    assert.equal(await countTrackerJobs(repo.id, sourceRef), 1);

    // Job completes → active-job dedupe no longer applies; ONLY the cursor prevents
    // a re-create. Same ticket, unchanged updatedAt.
    await pool.query(`UPDATE dev_jobs SET status = 'done' WHERE repo_id = $1 AND source_ref = $2`, [
      repo.id,
      sourceRef,
    ]);
    clock += 3_600_000;
    await makePoller().pollOnce();

    assert.equal(await countTrackerJobs(repo.id, sourceRef), 1, 'cursor must skip an already-processed ticket');
  });

  it('respects the structural refusal for a device_flow repo (no job)', async () => {
    const repo = await newRepo({ credentialKind: 'device_flow', trackerKind: 'jira' });
    ticketsByRepo.set(repo.id, [mkTicket(404, '2026-07-01T09:00:00.000Z')]);

    await makePoller().pollOnce();

    assert.equal(await countTrackerJobs(repo.id), 0, 'device_flow repos are structurally refused');
  });

  it('respects the structural refusal for the local backend (no job)', async () => {
    const repo = await newRepo();
    ticketsByRepo.set(repo.id, [mkTicket(505, '2026-07-01T09:00:00.000Z')]);

    // A poller wired to the local backend: createTriggerJob refuses every job.
    await makePoller('local').pollOnce();

    assert.equal(await countTrackerJobs(repo.id), 0, 'local backend is structurally refused');
  });

  it("skips a repo without 'tracker' in allowed_triggers", async () => {
    const tracked = await newRepo({ allowedTriggers: ['admin', 'tracker'], trackerKind: 'jira' });
    const untracked = await newRepo({ allowedTriggers: ['admin', 'webhook'], trackerKind: 'jira' });
    ticketsByRepo.set(tracked.id, [mkTicket(606, '2026-07-01T09:00:00.000Z')]);
    ticketsByRepo.set(untracked.id, [mkTicket(707, '2026-07-01T09:00:00.000Z')]);

    await makePoller().pollOnce();

    assert.equal(await countTrackerJobs(tracked.id), 1, 'tracker-enabled repo is polled');
    assert.equal(await countTrackerJobs(untracked.id), 0, 'webhook-only repo is not polled by the tracker loop');
  });

  it('does not advance the cursor when the tracker errors (backoff)', async () => {
    const repo = await newRepo();
    ticketsByRepo.set(repo.id, [mkTicket(808, '2026-07-01T09:00:00.000Z')]);

    failNextList = true; // first list() throws
    await makePoller().pollOnce();

    assert.equal(await countTrackerJobs(repo.id), 0, 'no job on a tracker error');
    assert.equal(await readCursor(repo.id), null, 'cursor must not advance on a tracker error');
  });

  it('floors the per-repo poll cadence at 60s (short interval is clamped)', async () => {
    const repo = await newRepo();
    // Configure an aggressive 10s interval; the floor must clamp it to 60s.
    await pool.query(`UPDATE dev_repos SET tracker_poll_interval_s = 10 WHERE id = $1`, [repo.id]);

    const poller = makePoller(); // ONE instance: its in-memory interval gate persists.
    ticketsByRepo.set(repo.id, [mkTicket(901, '2026-07-01T09:00:00.000Z')]);
    await poller.pollOnce();
    assert.equal(await countTrackerJobs(repo.id, `${repo.owner}/${repo.name}#901`), 1);

    // 30s later a NEW ticket appears. With the 60s floor the repo is not due, so no
    // job. Only if the floor were removed (10s interval) would it be polled again.
    clock += 30_000;
    ticketsByRepo.set(repo.id, [mkTicket(902, '2026-07-01T09:00:30.000Z')]);
    await poller.pollOnce();
    assert.equal(
      await countTrackerJobs(repo.id, `${repo.owner}/${repo.name}#902`),
      0,
      'interval floor (60s) must suppress a re-poll at +30s',
    );
  });
});
