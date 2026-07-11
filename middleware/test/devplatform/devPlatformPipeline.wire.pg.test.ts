import { strict as assert } from 'node:assert';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express, { type Request, type RequestHandler } from 'express';
import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { assembleDevPlatform, mountDevPlatform } from '../../src/devplatform/wireDevPlatform.js';
import { DevGithubAppStore } from '../../src/devplatform/githubApp/appStore.js';
import { DevJobGateStore } from '../../src/devplatform/pipeline/gateStore.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import type { TokenFetch } from '../../src/devplatform/githubApp/installationTokens.js';
import type { PhaseDirective } from '../../src/devplatform/pipeline/phaseEngine.js';

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

let pgAvailable = true;
try {
  const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
  await probe.query('SELECT 1');
  await probe.end();
} catch {
  pgAvailable = false;
}

const MARK = 'gate-pipeline-wire';
/** The operator who holds the gate (principal = ('user', createdBy) — no role). */
const HOLDER = MARK;

describe('dev-platform wiring — a real gated job, end to end through the assembled platform', {
  skip: !pgAvailable,
}, () => {
  let pool: Pool;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';
  let wired: ReturnType<typeof assembleDevPlatform>;
  let gates: DevJobGateStore;
  let repoId = '';
  // A mutable test clock threaded into the platform (deps.now) AND the test's own
  // gate store, so gate deadlines are driven deterministically — the expiry test
  // advances it instead of sleeping.
  let nowMs = Date.now();
  const now = (): Date => new Date(nowMs);

  // Fake GitHub App API — answers the scoped mint + revoke (used only by the
  // expiry test's token-revocation assertion).
  const appCalls: Array<{ method: string; url: string }> = [];
  const githubAppFetch: TokenFetch = async (url, init) => {
    appCalls.push({ method: init.method, url });
    if (init.method === 'POST' && url.includes('/access_tokens')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: 'ghs_scoped_readonly', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      };
    }
    if (init.method === 'DELETE' && url.includes('/installation/token')) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };

  // --- phone-home helpers ---------------------------------------------------
  async function getSpec(jobId: string, token: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${jobId}/spec`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.status;
  }

  async function postPhase(jobId: string, token: string, body: unknown): Promise<PhaseDirective> {
    const res = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${jobId}/phase-result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200, `phase-result ${JSON.stringify(body)} → HTTP ${String(res.status)}`);
    return (await res.json()) as PhaseDirective;
  }

  /** Claim + provision the job for its next runner session, returning the
   *  per-provision bearer token the runner phones home with. */
  async function provision(jobId: string, baseSha: string): Promise<string> {
    const lease = randomUUID();
    let claimed = await wired.jobStore.claimNextQueued(lease);
    while (claimed && claimed.id !== jobId) claimed = await wired.jobStore.claimNextQueued(lease);
    assert.ok(claimed, 'the job was claimable');
    const { token } = await wired.jobStore.prepareProvision(claimed!, lease, baseSha);
    return token;
  }

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await runMultiOrchestratorMigrations(pool);
    const vault = new InMemorySecretVault();
    const appStore = new DevGithubAppStore(pool, vault);
    const repoStore = new DevRepoStore(pool);
    // Same clock the platform's gate store uses (wired reads deps.now().getTime()).
    gates = new DevJobGateStore(pool, () => nowMs);

    // A github_app-bound repo (so the expiry test can assert token revocation).
    // approver_role_key stays NULL ⇒ the gate principal is ('user', createdBy).
    const app = await appStore.saveApp(
      {
        id: 909,
        slug: 'omadia-dev-byte5ai',
        ownerLogin: 'byte5ai',
        clientId: 'Iv1.x',
        clientSecret: 'shh',
        webhookSecret: 'wh',
        pem: generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey.export({ type: 'pkcs1', format: 'pem' })
          .toString(),
        htmlUrl: 'https://github.com/apps/omadia-dev-byte5ai',
      },
      'https://api.github.com',
      MARK,
    );
    const installation = await appStore.upsertInstallation(app.id, '5151', 'byte5ai');
    const repo = await repoStore.createRepo({
      owner: 'byte5ai',
      name: `gated-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://github.com/byte5ai/omadia.git',
      credentialKind: 'github_app',
      credentialRef: `github_app:${app.id}:${installation.installationId}`,
      runsTests: false,
      createdBy: MARK,
    });
    repoId = repo.id;

    wired = assembleDevPlatform({
      pool,
      vault,
      baseUrl: 'http://127.0.0.1:3333',
      cliBin: 'claude',
      wallClockMs: 600_000,
      heartbeatTimeoutMs: 600_000,
      maxConcurrentJobs: 1,
      commitAuthor: 'omadia-dev <dev-platform@omadia.ai>',
      subscriptionModeEnabled: false,
      workspaceDir: '/tmp/gate-wire',
      unsafeLocal: false,
      shimEntry: '/dev/null',
      // No backends started — this test drives the phone-home router by hand and
      // provisions jobs directly (never calls wired.start(), so the claim worker
      // never races the manual claims).
      backends: [],
      githubAppFetch,
      now,
    });

    const app_ = express();
    app_.use(express.json());
    // The gates router reads req.session.sub; the pass-through auth stamps the
    // holder so the resolve is authorized.
    const requireAuth: RequestHandler = (req: Request, _res, next) => {
      (req as { session?: { sub: string } }).session = { sub: HOLDER };
      next();
    };
    mountDevPlatform(app_, requireAuth, wired);
    server = app_.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    wired?.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(
      `DELETE FROM dev_jobs WHERE repo_id IN (SELECT id FROM dev_repos WHERE created_by = $1)`,
      [MARK],
    );
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
    await pool.query('DELETE FROM dev_github_apps WHERE created_by = $1', [MARK]);
    await pool.end();
  });

  it('drives analyze→…→clarify→PARK, then approve→resume→implement→review→pr', async () => {
    const BASE_SHA = 'basesha-deadbeef';
    const { hash } = mintRunnerToken();
    const job = await wired.jobStore.createJob({
      repoId,
      kind: 'fix_issue',
      brief: 'BASE BRIEF: fix the thing',
      source: 'admin',
      sourceRef: 'gh-issue:1',
      baseSha: BASE_SHA,
      phase: 'analyze', // a gated pipeline starts at analyze (createJob defaults to implement)
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });

    // --- Provision A: analyze → bootstrap → plan → clarify → PARK -----------
    const tokenA = await provision(job.id, BASE_SHA);
    assert.equal(await getSpec(job.id, tokenA), 200, 'GET /spec flips provisioning → running');

    assert.deepEqual(await postPhase(job.id, tokenA, { phase: 'analyze', ok: true, artifact: { kind: 'analysis', content: '{}' } }), {
      directive: 'next',
      phase: 'bootstrap',
    });
    assert.deepEqual(
      await postPhase(job.id, tokenA, { phase: 'bootstrap', ok: true, artifact: { kind: 'bootstrap_report', content: '{}' } }),
      { directive: 'next', phase: 'plan' },
    );
    assert.deepEqual(
      await postPhase(job.id, tokenA, {
        phase: 'plan',
        ok: true,
        artifact: { kind: 'plan', content: 'THE PLAN', meta: { planSha256: 'planhash-abc123' } },
      }),
      { directive: 'next', phase: 'clarify' },
    );
    assert.deepEqual(
      await postPhase(job.id, tokenA, { phase: 'clarify', ok: true, questions: [{ id: 'q1', text: 'which database?' }] }),
      { directive: 'park' },
    );

    // The gate opened, pinning the PERSISTED plan hash + the base tree; the job parked.
    const waiting = (await gates.listWaiting()).filter((g) => g.jobId === job.id);
    assert.equal(waiting.length, 1, 'exactly one waiting gate opened');
    const gate = waiting[0]!;
    assert.equal(gate.planSha256, 'planhash-abc123', 'the gate pins the approved plan hash');
    assert.equal(gate.baseSha, BASE_SHA, 'the gate pins the base tree');
    assert.deepEqual(gate.questions, [{ id: 'q1', text: 'which database?' }]);
    assert.equal(gate.principalKind, 'user');
    assert.equal(gate.principalRef, MARK, 'no approver_role_key ⇒ the creator approves');
    const parked = await wired.jobStore.getJob(job.id);
    assert.equal(parked?.status, 'waiting');
    assert.equal(parked?.phase, 'await_human');

    // --- Approve via the gates router (holder-authorized) -------------------
    const resolveRes = await fetch(`${baseUrl}/api/v1/admin/dev-platform/gates/${gate.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true, answers: [{ questionId: 'q1', text: 'postgres' }] }),
    });
    assert.equal(resolveRes.status, 200, 'the holder resolves the gate');
    assert.deepEqual(await resolveRes.json(), { ok: true, jobId: job.id, status: 'resolved' });

    // The job re-queued at implement, and the answers landed in the brief.
    const resumed = await wired.jobStore.getJob(job.id);
    assert.equal(resumed?.status, 'queued', 'the approved job is re-queued');
    assert.equal(resumed?.phase, 'implement', 'the resume runs a fresh implement session');
    assert.ok(resumed?.brief.includes('## Operator answers'), 'the brief gained the answers section');
    assert.ok(resumed?.brief.includes('Q1: which database?'), 'the question text is in the brief');
    assert.ok(resumed?.brief.includes('A1: postgres'), 'the answer text is in the brief');
    assert.ok(resumed?.brief.startsWith('BASE BRIEF'), 'the original brief is preserved');

    // --- Provision B: implement → review(approve) → pr ---------------------
    const tokenB = await provision(job.id, BASE_SHA);
    assert.equal(await getSpec(job.id, tokenB), 200);
    assert.deepEqual(
      await postPhase(job.id, tokenB, { phase: 'implement', ok: true, artifact: { kind: 'diff', content: 'a diff' } }),
      { directive: 'next', phase: 'review' },
    );
    assert.deepEqual(
      await postPhase(job.id, tokenB, {
        phase: 'review',
        ok: true,
        artifact: { kind: 'review_verdict', content: '{}' },
        verdict: { verdict: 'approve', summary: 'lgtm', findings: [] },
      }),
      { directive: 'next', phase: 'pr' },
      'an approved review advances to the host-side pr phase',
    );
  });

  it('rejects a stale phase result from a runner one phase behind (409)', async () => {
    const BASE_SHA = 'basesha-stale';
    const { hash } = mintRunnerToken();
    const job = await wired.jobStore.createJob({
      repoId,
      kind: 'fix_issue',
      brief: 'stale-result job',
      source: 'admin',
      sourceRef: null,
      baseSha: BASE_SHA,
      phase: 'analyze',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
    const token = await provision(job.id, BASE_SHA);
    assert.equal(await getSpec(job.id, token), 200);
    // Advance to bootstrap, then replay analyze — the job already left it → 409.
    await postPhase(job.id, token, { phase: 'analyze', ok: true, artifact: { kind: 'analysis', content: '{}' } });
    const res = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${job.id}/phase-result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'analyze', ok: true }),
    });
    assert.equal(res.status, 409, 'a stale phase result is rejected');
  });

  it('the gate-deadline worker expires an overdue gate and cancels the job (reason gate_expired), revoking its token', async () => {
    const BASE_SHA = 'basesha-expire';
    const { hash } = mintRunnerToken();
    const job = await wired.jobStore.createJob({
      repoId,
      kind: 'fix_issue',
      brief: 'expiry job',
      source: 'admin',
      sourceRef: null,
      baseSha: BASE_SHA,
      phase: 'analyze',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
    // Provision + fetch the scoped clone token so a scoped App token is recorded
    // against the job — the thing finalize must revoke on cancel.
    const token = await provision(job.id, BASE_SHA);
    assert.equal(await getSpec(job.id, token), 200);
    const scmRes = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${job.id}/scm-token`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(scmRes.status, 200, 'the runner fetched a scoped clone token');

    // Open a gate with the repo default deadline (P7D from the current clock),
    // then advance the clock past it so the worker sees it as overdue.
    const gate = await gates.open({
      jobId: job.id,
      questions: [],
      principalKind: 'user',
      principalRef: MARK,
    });
    nowMs += 8 * 24 * 60 * 60 * 1000; // 8 days > P7D
    const revokeCallsBefore = appCalls.filter((c) => c.method === 'DELETE').length;

    // One worker tick — no timer, driven deterministically.
    const expired = await wired.gateDeadlineWorker.tick();
    assert.ok(expired >= 1, 'the tick expired at least the overdue gate');

    const after = await gates.get(gate.id);
    assert.equal(after?.status, 'expired', 'the overdue gate is marked expired');
    const cancelled = await wired.jobStore.getJob(job.id);
    assert.equal(cancelled?.status, 'cancelled', 'the job was cancelled by expiry');

    // The cancel carried reason gate_expired (surfaced on the host status event).
    const events = await wired.jobStore.listEvents(job.id);
    const statusEvents = events.filter((e) => e.type === 'status');
    assert.ok(
      statusEvents.some((e) => (e.payload as { reason?: string }).reason === 'gate_expired'),
      'the cancellation reason is gate_expired',
    );

    // Finalize revoked the job's scoped token — it does not outlive the cancel.
    const revokeCallsAfter = appCalls.filter((c) => c.method === 'DELETE').length;
    assert.ok(revokeCallsAfter > revokeCallsBefore, 'the scoped token was revoked on gate-expiry cancel');
  });

  it('after stop(), a deadline tick expires nothing — shutdown is a hard boundary (Forge #4)', async () => {
    const { hash } = mintRunnerToken();
    const job = await wired.jobStore.createJob({
      repoId,
      kind: 'fix_issue',
      brief: 'quiescent job',
      source: 'admin',
      sourceRef: null,
      baseSha: 'basesha-quiescent',
      phase: 'analyze',
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
    const gates = new DevJobGateStore(pool, () => nowMs);
    const gate = await gates.open({ jobId: job.id, questions: [], principalKind: 'user', principalRef: MARK });
    nowMs += 8 * 24 * 60 * 60 * 1000; // overdue (> P7D)

    await wired.stop();
    const expired = await wired.gateDeadlineWorker.tick();
    assert.equal(expired, 0, 'a stopped worker expires nothing');
    assert.equal((await gates.get(gate.id))?.status, 'waiting', 'the overdue gate is untouched after stop()');
  });
});
