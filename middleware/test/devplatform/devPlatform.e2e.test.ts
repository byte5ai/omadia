import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import express, { type RequestHandler } from 'express';
import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { devPlatformBootRefusals } from '../../src/config.js';
import { DevJobStore } from '../../src/devplatform/devJobStore.js';
import { NUMSTAT_MARKER } from '../../src/devplatform/devJobWorkerPolicy.js';
import { DevRepoStore } from '../../src/devplatform/devRepoStore.js';
import { DevRepoCredentialStore } from '../../src/devplatform/devRepoCredentials.js';
import { mintRunnerToken } from '../../src/devplatform/jobToken.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { assembleDevPlatform, mountDevPlatform } from '../../src/devplatform/wireDevPlatform.js';
import { InMemorySecretVault } from '../../src/secrets/vault.js';
import type {
  ApplyDiffInput,
  ApplyDiffResult,
  CreatePrInput,
  CreatePrResult,
  ForgeClient,
  ForgeIssue,
} from '../../src/devplatform/forgeClient.js';
import type {
  DevJobProvisionInput,
  DevRepo,
  RunnerBackend,
  RunnerHandle,
} from '../../src/devplatform/types.js';

/**
 * Epic #470 W0 — the wire unit's end-to-end proof (spec §11/§12). Two parts:
 *
 *  - boot refusals (no DB): the subscription/unsafe-local safety gates.
 *  - the full loop (DB-gated, skips without a test Postgres like the other
 *    `*.pg.test.ts`): assemble the real subsystem from the pool + an in-memory
 *    vault, mount both routers the way index.ts does, then drive a job with a
 *    FAKE backend that plays the runner (phones home over HTTP against the
 *    mounted runner router) and a STUB forge. Asserts the epic's headline
 *    guarantees, above all: the runner router carries NO session guard — its
 *    only authentication is the per-job bearer token, and a regression there is
 *    a full auth bypass.
 */

// ---------------------------------------------------------------------------
// Part 1 — boot refusals. Pure, always runs.
// ---------------------------------------------------------------------------

describe('devplatform boot refusals', () => {
  it('refuses subscription mode without the acknowledgment', () => {
    const refusals = devPlatformBootRefusals({
      subscriptionMode: true,
      subscriptionAck: undefined,
      unsafeLocal: false,
      localUid: undefined,
    });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!, /DEV_PLATFORM_SUBSCRIPTION_ACK/);
  });

  it('accepts subscription mode WITH an acknowledgment', () => {
    assert.deepEqual(
      devPlatformBootRefusals({
        subscriptionMode: true,
        subscriptionAck: 'I understand',
        unsafeLocal: false,
        localUid: undefined,
      }),
      [],
    );
  });

  it('refuses the unsafe-local backend without a uid', () => {
    const refusals = devPlatformBootRefusals({
      subscriptionMode: false,
      subscriptionAck: undefined,
      unsafeLocal: true,
      localUid: undefined,
    });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!, /DEV_PLATFORM_LOCAL_UID/);
  });

  it('accepts the unsafe-local backend WITH a uid; safe defaults raise nothing', () => {
    assert.deepEqual(
      devPlatformBootRefusals({
        subscriptionMode: false,
        subscriptionAck: undefined,
        unsafeLocal: true,
        localUid: 1500,
      }),
      [],
    );
    assert.deepEqual(
      devPlatformBootRefusals({
        subscriptionMode: false,
        subscriptionAck: undefined,
        unsafeLocal: false,
        localUid: undefined,
      }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the full loop (DB-gated).
// ---------------------------------------------------------------------------

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const MARK = 'e2e-devplatform-test';
const E2E_DAEMON_TOKEN = 'e2e-daemon-secret-token-0123456789abcdef';
/** The retiring half of a rotation: DEV_RUNNER_DAEMON_TOKEN is a comma list so a
 *  token can be replaced with zero downtime, and BOTH ends must accept both. */
const E2E_DAEMON_TOKEN_OLD = 'e2e-daemon-secret-token-fedcba9876543210';
const E2E_RUNNER_IMAGE = 'ghcr.io/byte5ai/omadia-dev-runner@sha256:e2e';
const E2E_PROVIDER_KEY = 'sk-ant-e2e-REAL-PROVIDER-KEY';
const E2E_MODEL = 'claude-opus-4-8';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

// A single-add unified diff + a matching numstat. The stub forge does not parse
// hunks (that is githubForgeClient's job, unit-tested elsewhere); DiffApplyService
// still parses the diff and cross-checks it against the numstat before any apply.
const DIFF = [
  'diff --git a/hello.txt b/hello.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/hello.txt',
  '@@ -0,0 +1,1 @@',
  '+hello',
  '',
].join('\n');
const NUMSTAT = '1\t0\thello.txt\n';

/** A stub forge: records the apply/PR calls, invents shas, never touches network. */
class StubForge implements ForgeClient {
  applyCalls: ApplyDiffInput[] = [];
  prCalls: CreatePrInput[] = [];

  applyDiff(input: ApplyDiffInput): Promise<ApplyDiffResult> {
    this.applyCalls.push(input);
    return Promise.resolve({
      commitSha: 'commit-sha-1',
      treeSha: 'tree-sha-1',
      branchRef: `refs/heads/${input.branch}`,
    });
  }
  createPR(input: CreatePrInput): Promise<CreatePrResult> {
    this.prCalls.push(input);
    return Promise.resolve({ prUrl: 'https://example.com/pr/7', prNumber: 7 });
  }
  getIssue(): Promise<ForgeIssue> {
    return Promise.reject(new Error('not used'));
  }
  listOpenIssues(): Promise<ForgeIssue[]> {
    return Promise.resolve([]);
  }
  createIssue(): Promise<ForgeIssue> {
    return Promise.reject(new Error('not used'));
  }
  commentIssue(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A fake `RunnerBackend` that plays the runner: on `provision()` it drives the
 * whole phone-home sequence (spec → events → diff → result:diff_ready) over HTTP
 * against the mounted runner router, using ONLY the per-job bearer token it was
 * handed. It records the job it drove and exposes a promise that resolves once
 * the result is posted, so the test can await a real round trip.
 */
class FakeRunnerBackend implements RunnerBackend {
  readonly kind = 'local' as const;
  driven: { jobId: string; done: Promise<void> } | null = null;

  provision(input: DevJobProvisionInput): Promise<RunnerHandle> {
    const done = this.drive(input);
    this.driven = { jobId: input.jobId, done };
    return Promise.resolve({
      backend: 'local',
      id: `fake-${input.jobId}`,
      startedAt: new Date().toISOString(),
    });
  }
  terminate(): Promise<void> {
    return Promise.resolve();
  }
  reap(): Promise<RunnerHandle[]> {
    return Promise.resolve([]);
  }

  private async drive(input: DevJobProvisionInput): Promise<void> {
    const base = `${input.baseUrl}/api/v1/dev-runner/jobs/${input.jobId}`;
    const auth = { Authorization: `Bearer ${input.jobToken}` };

    const specRes = await fetch(`${base}/spec`, { headers: auth });
    const spec = (await specRes.json()) as { provision: number };

    await fetch(`${base}/events`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        provision: spec.provision,
        events: [
          { seq: 0, type: 'status', payload: { state: 'agent_started' } },
          { seq: 1, type: 'log', payload: { stream: 'agent', text: 'editing' } },
          { seq: 2, type: 'status', payload: { state: 'agent_done' } },
        ],
      }),
    });

    const diffRes = await fetch(`${base}/diff`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'text/plain' },
      body: `${DIFF}${NUMSTAT_MARKER}${NUMSTAT}`,
    });
    const { artifactId } = (await diffRes.json()) as { artifactId: string };

    await fetch(`${base}/result`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'diff_ready', diffArtifactId: artifactId, summary: 'done' }),
    });
  }
}

describe('devplatform e2e (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  const vault = new InMemorySecretVault();
  const jobStore = new DevJobStore(pool);
  const repoStore = new DevRepoStore(pool);
  const credentials = new DevRepoCredentialStore(vault);
  const stubForge = new StubForge();
  const fakeBackend = new FakeRunnerBackend();

  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';
  let wired: ReturnType<typeof assembleDevPlatform>;
  let repo: DevRepo;

  // A fake requireAuth: a session iff the `x-test-sub` header is present. It
  // consults the SAME public-paths allowlist production's createRequireAuth
  // does, so a path dropped from that list fails this test instead of only
  // failing in production. Mounted both at `/api` (like index.ts) and around
  // the admin router (like mountDevPlatform).
  const allowlist = publicPaths({ devEndpointsEnabled: false });
  const requireAuth: RequestHandler = (req, res, next) => {
    const url = req.originalUrl || req.url;
    if (allowlist.some((rx) => rx.test(url))) {
      next();
      return;
    }
    const sub = req.header('x-test-sub');
    if (!sub) {
      res.status(401).json({ code: 'unauthorized', message: 'no session' });
      return;
    }
    (req as unknown as { session: { sub: string; email: string; role: string } }).session = {
      sub,
      email: `${sub}@test.local`,
      role: '',
    };
    next();
  };

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM dev_repos WHERE created_by = $1', [MARK]);
  }

  async function newQueuedJob(sourceRef: string | null = null): Promise<string> {
    const { hash } = mintRunnerToken();
    const job = await jobStore.createJob({
      repoId: repo.id,
      kind: 'implement',
      brief: 'Add a hello file',
      source: 'admin',
      sourceRef,
      backend: 'local',
      createdBy: MARK,
      runnerTokenHash: hash,
    });
    return job.id;
  }

  /** A job flipped to `provisioning` with a freshly minted one-time runner token
   *  (its hash stored), so the phone-home + LLM-proxy token paths can resolve it. */
  async function provisionedJob(): Promise<{ jobId: string; token: string }> {
    const jobId = await newQueuedJob();
    const lease = randomUUID();
    await pool.query(
      `UPDATE dev_jobs SET status = 'provisioning', claimed_by = $2, started_at = now() WHERE id = $1`,
      [jobId, lease],
    );
    const job = await jobStore.getJob(jobId);
    const { token } = await jobStore.prepareProvision(job!, lease);
    return { jobId, token };
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    repo = await repoStore.createRepo({
      owner: 'e2e-owner',
      name: `repo-${randomUUID().slice(0, 8)}`,
      cloneUrl: 'https://github.com/e2e-owner/repo.git',
      credentialKind: 'pat',
      credentialRef: 'repo/x',
      runsTests: false, // local backend is admitted only for no-exec repos
      createdBy: MARK,
    });
    await credentials.save(repo.id, { token: 'ghp_e2e_token', kind: 'pat', login: 'e2e-owner' });
    // W1 keystone: the LLM proxy resolves the provider key from this Vault slot.
    await vault.set('core:dev-platform', 'llm/anthropic/api_key', E2E_PROVIDER_KEY);

    const app = express();
    // Reproduce production's guard topology, not a convenient subset. index.ts
    // mounts `app.use('/api', requireAuth, chatRouter)` BEFORE the dev-platform
    // routers, and express runs that middleware for every `/api/*` request
    // whichever router answers. A bare express() app here would let the runner
    // router look unguarded while it 401s in production — which is exactly the
    // bug this test exists to prevent. The public-paths allowlist is imported
    // from the same module index.ts uses, so the two cannot drift.
    app.use('/api', requireAuth, (_req, _res, next) => {
      next();
    });
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    wired = assembleDevPlatform({
      pool,
      vault,
      baseUrl,
      cliBin: 'claude',
      wallClockMs: 10 * 60_000,
      heartbeatTimeoutMs: 10 * 60_000,
      maxConcurrentJobs: 1,
      commitAuthor: 'omadia-dev <dev-platform@omadia.ai>',
      subscriptionModeEnabled: false,
      workspaceDir: '/tmp/e2e-dev-jobs',
      unsafeLocal: false,
      shimEntry: '/dev/null',
      backends: [fakeBackend],
      forgeFactory: () => stubForge,
      // W1 keystones (spec §4/§6b): the daemon job-policy endpoint + the LLM
      // proxy, wired exactly as index.ts does — so this test fails if either is
      // left unmounted, instead of the routes silently not existing.
      daemonToken: `${E2E_DAEMON_TOKEN},${E2E_DAEMON_TOKEN_OLD}`,
      runnerImage: E2E_RUNNER_IMAGE,
      egressBaseAllowlist: ['registry.npmjs.org'],
      llm: {
        allowedModels: [E2E_MODEL],
        // A fake upstream so a POST reaches the proxy without real network.
        fetchImpl: (async () =>
          new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      },
    });
    mountDevPlatform(app, requireAuth, wired);
  });

  after(async () => {
    wired?.worker.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    await pool.end();
  });

  it('mounts the runner router WITHOUT a session guard — the job token is the only auth', async () => {
    const jobId = await newQueuedJob();
    const claimed = await jobStore.claimNextQueued(randomUUID());
    assert.ok(claimed, 'a queued job was claimed');
    // prepareProvision (seam 3) mints the ONE-TIME token whose hash is stored.
    const { token } = await jobStore.prepareProvision(claimed!, claimed!.claimedBy!);

    // No session header at all — the runner router must still serve the spec on a
    // valid job token. A regression that put a session guard here would 401.
    const withToken = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${claimed!.id}/spec`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(withToken.status, 200, 'valid job token reaches the spec with no session');
    const spec = (await withToken.json()) as Record<string, unknown> & {
      repo: Record<string, unknown>;
    };
    // Regression: the spec carries NO credential (spec §4 review finding).
    assert.ok(!('token' in spec), 'spec has no top-level token');
    assert.ok(!('token' in spec.repo), 'spec.repo carries no clone credential');

    // No token → 401 (the job token IS the gate).
    const noToken = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${claimed!.id}/spec`);
    assert.equal(noToken.status, 401, 'no bearer → 401');

    void jobId;
  });

  it('findActiveByHandleId maps a running job to its handle and EXCLUDES applying (seam 2)', async () => {
    const jobId = await newQueuedJob();
    const claimed = await jobStore.claimNextQueued(randomUUID());
    assert.ok(claimed);
    const handle: RunnerHandle = {
      backend: 'local',
      id: `handle-${randomUUID().slice(0, 8)}`,
      startedAt: new Date().toISOString(),
    };
    await jobStore.setRunnerHandle(claimed!.id, claimed!.claimedBy!, handle);

    const found = await jobStore.findActiveByHandleId(handle.id);
    assert.equal(found?.id, claimed!.id, 'a provisioning/running job maps back from its handle');

    // Once the job enters `applying`, the handle must NOT match — that phase has
    // no live runner, and matching it would let reap finalize a completing job
    // as stalled and strand its PR.
    await jobStore.recordResult(claimed!.id, { outcome: 'diff_ready', diffArtifactId: 'x' });
    const afterApplying = await jobStore.findActiveByHandleId(handle.id);
    assert.equal(afterApplying, null, 'an applying job is excluded from the handle lookup');

    void jobId;
  });

  it('full loop: queued → runner phones home → diff → server-side PR → done', async () => {
    const drivenId = await newQueuedJob('gh-issue:123');

    // Provision this specific job. The global claim/apply loop
    // (`worker.tick()`) is unit-tested in devJobWorker.test.ts; here we target
    // ONE job id so the integration is deterministic and cannot be perturbed by
    // any other job sharing the test database. The lease + provisioning flip is
    // exactly what `claimNextQueued` does, applied to our row.
    const lease = randomUUID();
    await pool.query(
      `UPDATE dev_jobs SET status = 'provisioning', claimed_by = $2, started_at = now() WHERE id = $1`,
      [drivenId, lease],
    );
    const job = await jobStore.getJob(drivenId);
    assert.ok(job);
    // Seam 3: prepareProvision mints the one-time token + pins the branch.
    const { token } = await jobStore.prepareProvision(job!, lease);

    // The fake runner phones home over HTTP with just that token.
    await fakeBackend.provision({ jobId: drivenId, jobToken: token, baseUrl });
    assert.equal(fakeBackend.driven?.jobId, drivenId);
    await fakeBackend.driven!.done;

    const applying = await jobStore.getJob(drivenId);
    assert.equal(applying?.status, 'applying', 'diff_ready moved the job to applying');
    // prepareProvision pinned a fresh omadia/job branch.
    assert.match(applying?.branch ?? '', /^omadia\/job-/);

    // The worker applies the diff host-side and opens the PR (targeted apply).
    await wired.worker.applyJob(drivenId);

    const done = await jobStore.getJob(drivenId);
    assert.equal(done?.status, 'done', 'the job is done after the server-side apply');
    assert.equal(done?.prUrl, 'https://example.com/pr/7', 'the PR url is stored on the job');

    // The middleware built the commit + PR from the uploaded diff — the runner
    // never pushed. Exactly one apply + one PR against the pinned branch.
    assert.equal(stubForge.applyCalls.length, 1, 'exactly one server-side apply');
    assert.equal(stubForge.prCalls.length, 1, 'exactly one PR opened');
    assert.equal(stubForge.applyCalls[0]!.branch, done?.branch);

    // Events were persisted and stream in identity-id order, ending in a terminal
    // status event (what the SSE tail closes on).
    const events = await jobStore.listEvents(drivenId);
    assert.ok(events.length >= 3, 'runner + host events persisted');
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i]!.id > events[i - 1]!.id, 'events are ordered by identity id');
    }
    assert.ok(
      events.some((e) => e.type === 'status' && (e.payload as { status?: string }).status === 'done'),
      'a terminal done status event was appended by finalizeDevJob',
    );
  });

  it('admin router is behind requireAuth (401 without a session, 200 with one)', async () => {
    const anon = await fetch(`${baseUrl}/api/v1/admin/dev-platform/repos`);
    assert.equal(anon.status, 401, 'no session → 401 on the admin surface');

    const authed = await fetch(`${baseUrl}/api/v1/admin/dev-platform/repos`, {
      headers: { 'x-test-sub': MARK },
    });
    assert.equal(authed.status, 200, 'a session reaches the admin surface');
    const body = (await authed.json()) as { repos: unknown[] };
    assert.ok(Array.isArray(body.repos), 'repos list is returned');
  });

  it('W1 job-policy endpoint IS mounted: a DAEMON token returns the server-derived policy', async () => {
    const { jobId } = await provisionedJob();
    const res = await fetch(`${baseUrl}/api/v1/dev-runner/internal/job-policy/${jobId}`, {
      headers: { Authorization: `Bearer ${E2E_DAEMON_TOKEN}` },
    });
    assert.equal(res.status, 200, 'the endpoint exists and the daemon token is accepted');
    const policy = (await res.json()) as { image: string; env: Record<string, string>; egressAllowlist: string[] };
    assert.equal(policy.image, E2E_RUNNER_IMAGE);
    assert.ok(policy.egressAllowlist.includes('github.com'), 'forge host derived from clone_url');
    assert.ok(policy.egressAllowlist.includes('registry.npmjs.org'), 'operator base allowlist folded in');
  });

  it('W1 job-policy endpoint accepts EVERY token in a rotation list, and nothing else', async () => {
    const { jobId } = await provisionedJob();
    const ask = (token: string) =>
      fetch(`${baseUrl}/api/v1/dev-runner/internal/job-policy/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    // Mid-rotation both halves must work: the daemon presents the first entry,
    // but an operator may still be running a daemon holding the retiring one.
    assert.equal((await ask(E2E_DAEMON_TOKEN)).status, 200, 'the incoming token is accepted');
    assert.equal((await ask(E2E_DAEMON_TOKEN_OLD)).status, 200, 'the retiring token is accepted');
    // The list is not a prefix match and not a substring match.
    assert.equal((await ask(`${E2E_DAEMON_TOKEN},${E2E_DAEMON_TOKEN_OLD}`)).status, 401);
    assert.equal((await ask('e2e-daemon-secret-token-0123456789abcde')).status, 401);
    assert.equal((await ask('not-a-daemon-token-at-all-0123456789')).status, 401);
  });

  it('W1 job-policy endpoint REJECTS a per-job djr_ runner bearer (S3 guarantee)', async () => {
    const { jobId, token } = await provisionedJob();
    // The SAME token is valid on /jobs/:id/* but must be refused here.
    const ok = await fetch(`${baseUrl}/api/v1/dev-runner/jobs/${jobId}/spec`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200, 'the runner token is valid on the phone-home surface');
    const rejected = await fetch(`${baseUrl}/api/v1/dev-runner/internal/job-policy/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(rejected.status, 401, 'a runner token can never read a job policy');
  });

  it('W1 LLM proxy IS mounted: GET /llm/ probes 2xx and a job token reaches the proxy + model gate', async () => {
    const probe = await fetch(`${baseUrl}/api/v1/dev-runner/llm/`);
    assert.equal(probe.status, 200, 'the CLI origin probe answers 2xx');
    await probe.text();

    const { token } = await provisionedJob();
    const reached = await fetch(`${baseUrl}/api/v1/dev-runner/llm/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: E2E_MODEL, messages: [] }),
    });
    // An unmounted (or wrongly session-guarded) route would 401; reaching the
    // fake upstream returns 200.
    assert.equal(reached.status, 200, 'a valid job token reaches the proxy and the upstream');
    await reached.text();

    // The allowlist actually runs inside the proxy: a forbidden model → 403.
    const { token: token2 } = await provisionedJob();
    const forbidden = await fetch(`${baseUrl}/api/v1/dev-runner/llm/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ model: 'claude-forbidden', messages: [] }),
    });
    assert.equal(forbidden.status, 403, 'the model allowlist is enforced by the mounted proxy');
  });
});
