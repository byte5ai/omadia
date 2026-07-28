import { strict as assert } from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import {
  createTriggerJob,
  hasActiveTriggerJob,
} from '../../src/devplatform/triggers/triggerJobService.js';
import { WebhookDeliveryStore } from '../../src/devplatform/triggers/webhookDeliveryStore.js';
import { createDevWebhooksRouter, type DevWebhooksRouterDeps } from '../../src/routes/devWebhooks.js';
import type { DevRepo } from '../../src/devplatform/types.js';

/**
 * Epic #470 W4 — CONCURRENCY regression for the three defects a cross-family
 * (Forge/GPT-5.4) audit found in the GitHub webhook trigger. These fire N real
 * HTTP deliveries with `Promise.all` against the REAL Postgres stores — exactly
 * what the 24 sequential unit tests in `devWebhooks.test.ts` cannot exercise.
 * Skips when no test Postgres is reachable, like the other `*.pg.test.ts`.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'pg-webhook-concurrency';
const SECRET = 'whsec_concurrency_test_secret';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
}
await probePool.end().catch(() => undefined);

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function issuesBody(fullName: string, issueNumber: number, sender = 'alice'): string {
  return JSON.stringify({
    action: 'labeled',
    label: { name: 'omadia-dev' },
    issue: { number: issueNumber, title: 'Fix the thing', body: 'It is broken' },
    repository: { full_name: fullName },
    sender: { login: sender },
  });
}

describe('devplatform/webhook concurrency (pg)', { skip: !pgAvailable }, () => {
  // Dedicated pool with headroom > fan-out so N reservers can each hold a client
  // while blocked on the per-repo advisory lock without starving the pool.
  const pool = new Pool({ connectionString: PG_URL, max: 20 });
  const repoStore = new DevRepoStore(pool);
  const jobStore = new DevJobStore(pool);
  const deliveries = new WebhookDeliveryStore(pool);

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]); // cascades dev_jobs
    await pool.query('DELETE FROM dev_webhook_deliveries WHERE repo LIKE $1', [`${MARK}/%`]);
  }

  /** A github_app repo opted into webhook triggers with `alice` allow-listed. */
  async function newWebhookRepo(): Promise<DevRepo> {
    const created = await repoStore.createRepo({
      owner: MARK,
      name: `r-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://example.com/x/y.git',
      credentialKind: 'github_app',
      credentialRef: 'repo/x',
      allowedTriggers: ['admin', 'webhook'],
      createdBy: MARK,
    });
    const updated = await repoStore.updateRepo(created.id, { webhookSenders: ['alice'] });
    return updated!;
  }

  /** Wire the real route to real stores for `repo`, with the given rate caps. */
  async function makeApp(repo: DevRepo, caps: { perRepo: number; perSender: number }) {
    const gateStore = { open: async () => ({}) };
    const deps: DevWebhooksRouterDeps = {
      listWebhookSecrets: async () => [SECRET],
      repos: { getByFullName: async (fn) => (fn === `${repo.owner}/${repo.name}` ? repo : null) },
      deliveries,
      hasActiveWebhookJob: (repoId, sourceRef) => hasActiveTriggerJob(pool, repoId, sourceRef, 'webhook'),
      createTriggerJob: (input) => createTriggerJob({ jobStore, gateStore }, input),
      mintRunnerToken: () => mintRunnerToken(),
      webhookBackend: 'docker',
      webhooksEnabled: true,
      maxJobsPerRepoHour: caps.perRepo,
      maxJobsPerSenderHour: caps.perSender,
      now: () => Date.now(),
      log: () => {},
    };
    const app = express();
    app.use(createDevWebhooksRouter(deps));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  async function fire(base: string, fullName: string, issueNumber: number): Promise<number> {
    const body = issuesBody(fullName, issueNumber);
    const res = await fetch(`${base}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': `d-${randomUUID()}`,
        'x-hub-signature-256': sign(body),
      },
      body,
    });
    await res.text().catch(() => undefined);
    return res.status;
  }

  async function countWebhookJobs(repoId: string, sourceRef?: string): Promise<number> {
    const r = sourceRef
      ? await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM dev_jobs WHERE repo_id = $1 AND source = 'webhook' AND source_ref = $2`,
          [repoId, sourceRef],
        )
      : await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM dev_jobs WHERE repo_id = $1 AND source = 'webhook'`,
          [repoId],
        );
    return Number(r.rows[0]!.n);
  }

  async function outcomeCounts(fullName: string): Promise<Record<string, number>> {
    const r = await pool.query<{ outcome: string; n: string }>(
      `SELECT outcome, COUNT(*)::text AS n FROM dev_webhook_deliveries WHERE repo = $1 GROUP BY outcome`,
      [fullName],
    );
    return Object.fromEntries(r.rows.map((x) => [x.outcome, Number(x.n)]));
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await pool.end().catch(() => undefined);
  });

  // --- Fix #1 — rate-limit TOCTOU ------------------------------------------
  it('#1 N concurrent distinct-issue deliveries honour the per-sender cap EXACTLY', async () => {
    // FAIL-IF-REVERTED: without the advisory-lock reservation, all N deliveries read
    // the same pre-reservation count of 0, all pass a cap of 2, and >2 jobs are born.
    const repo = await newWebhookRepo();
    const full = `${repo.owner}/${repo.name}`;
    const app = await makeApp(repo, { perRepo: 100, perSender: 2 }); // repo cap loose; sender cap = 2
    try {
      const N = 10;
      // Distinct issue numbers ⇒ distinct source_ref ⇒ the #3 unique index never
      // fires, so ONLY the rate limit can gate. Exactly 2 must survive.
      const statuses = await Promise.all(Array.from({ length: N }, (_, i) => fire(app.base, full, 1000 + i)));
      const created = statuses.filter((s) => s === 201).length;
      assert.equal(created, 2, `expected exactly 2 HTTP 201s, got ${created}`);
      assert.equal(await countWebhookJobs(repo.id), 2);
      const oc = await outcomeCounts(full);
      assert.equal(oc['job_created'], 2);
      assert.equal(oc['rate_limited'], N - 2);
    } finally {
      await app.close();
    }
  });

  // --- Fix #2 — gated first-source job is never queued ----------------------
  it('#2 a gated first-source job is BORN waiting/await_human and is unclaimable', async () => {
    // FAIL-IF-REVERTED: a gated job created as status='queued' (then flipped later)
    // is grabbable by claimNextQueued in the window before it parks. It must never
    // exist in 'queued'. claimNextQueued only ever selects status='queued' rows.
    const repo = await newWebhookRepo();
    const { hash } = mintRunnerToken();
    const gateStore = { open: async () => ({}) };

    const gated = await createTriggerJob(
      { jobStore, gateStore },
      {
        repo,
        backend: 'docker',
        kind: 'fix_issue',
        brief: 'b',
        sourceRef: `${repo.owner}/${repo.name}#77`,
        source: 'webhook',
        createdBy: 'webhook:github',
        runnerTokenHash: hash,
        requireGate: true,
        senderLogin: 'alice',
      },
    );
    assert.equal(gated.decision, 'created');
    assert.equal(gated.gated, true);
    const job = await jobStore.getJob(gated.job!.id);
    assert.equal(job!.status, 'waiting');
    assert.equal(job!.phase, 'await_human');
    // Not selectable by claimNextQueued (which requires status='queued').
    const queuedRow = await pool.query(`SELECT 1 FROM dev_jobs WHERE id = $1 AND status = 'queued'`, [job!.id]);
    assert.equal(queuedRow.rowCount, 0);

    // Contrast: a NON-gated trigger job IS born 'queued' (claimable) — proves the
    // gating is what changes the born-status, not a blanket 'waiting'.
    const open = await createTriggerJob(
      { jobStore, gateStore },
      {
        repo,
        backend: 'docker',
        kind: 'fix_issue',
        brief: 'b',
        sourceRef: `${repo.owner}/${repo.name}#78`,
        source: 'webhook',
        createdBy: 'webhook:github',
        runnerTokenHash: mintRunnerToken().hash,
        requireGate: false,
        senderLogin: 'alice',
      },
    );
    const openJob = await jobStore.getJob(open.job!.id);
    assert.equal(openJob!.status, 'queued');
  });

  // --- Fix #3 — active-job dedupe race -------------------------------------
  it('#3 N concurrent same-issue deliveries create EXACTLY one active job', async () => {
    // FAIL-IF-REVERTED: without the partial unique index, the check-then-act
    // pre-check lets multiple same-issue deliveries create duplicate jobs.
    const repo = await newWebhookRepo();
    const full = `${repo.owner}/${repo.name}`;
    const sourceRef = `${full}#99`;
    const app = await makeApp(repo, { perRepo: 100, perSender: 100 }); // caps loose; ONLY the index gates
    try {
      const N = 10;
      // SAME issue number ⇒ SAME source_ref for all N.
      const statuses = await Promise.all(Array.from({ length: N }, () => fire(app.base, full, 99)));
      const created = statuses.filter((s) => s === 201).length;
      assert.equal(created, 1, `expected exactly 1 HTTP 201, got ${created}`);
      assert.equal(await countWebhookJobs(repo.id, sourceRef), 1);
      const oc = await outcomeCounts(full);
      assert.equal(oc['job_created'], 1);
      assert.equal(oc['deduped_active_job'], N - 1);
    } finally {
      await app.close();
    }
  });
});
