import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { TERMINAL_FINISH_BRAND, type TerminalPatch } from '../../src/devplatform/devJobStore.js';
import type { ApplyInput, ApplyResult } from '../../src/devplatform/diffApplyService.js';
import type { FinalizeStore } from '../../src/devplatform/finalizeDevJob.js';
import { RunnerBackendError } from '../../src/devplatform/runnerBackend.js';
import {
  DevJobWorker,
  type DevJobApplyService,
  type DevJobWorkerRepoStore,
  type DevJobWorkerStore,
} from '../../src/devplatform/devJobWorker.js';
import {
  DevJobWorkerError,
  NUMSTAT_MARKER,
  assertAuthModeAdmissible,
  splitDiffBundle,
} from '../../src/devplatform/devJobWorkerPolicy.js';
import {
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobArtifact,
  type DevJobStatus,
  type DevRepo,
  type RunnerBackend,
  type RunnerHandle,
} from '../../src/devplatform/types.js';

/**
 * Epic #470 W0 — DevJobWorker with injected fakes (no DB, no real backend).
 * Proves the six acceptance behaviors: bounded claiming, stall/wall-clock
 * enforcement through finalizeDevJob, single-shot apply, auth-mode admission at
 * the boundary, a terminate that throws `local_terminate_incomplete` still
 * finalizing + logging, and reap results finalized as stalled exactly once
 * (finalizeDevJob idempotency).
 */

const ACTIVE: readonly DevJobStatus[] = ['provisioning', 'running', 'waiting', 'applying'];
const ACTIVE_WITH_RUNNER: readonly DevJobStatus[] = ['provisioning', 'running', 'applying'];

function makeJob(overrides: Partial<DevJob> = {}): DevJob {
  const t = new Date().toISOString();
  return {
    id: overrides.id ?? 'job-1',
    repoId: 'repo-1',
    kind: 'implement',
    brief: 'Fix the thing\nmore detail',
    source: 'admin',
    sourceRef: null,
    baseSha: 'base-sha-abc',
    backend: 'local',
    agentKind: 'claude-cli',
    authMode: 'api_key',
    provision: 1,
    phase: 'implement',
    status: 'queued',
    claimedBy: null,
    claimedAt: null,
    lastHeartbeatAt: t,
    runnerHandle: null,
    runnerTokenHash: 'deadbeef',
    branch: null,
    prUrl: null,
    result: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    createdBy: 'op',
    createdAt: t,
    startedAt: null,
    endedAt: null,
    updatedAt: t,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<DevRepo> = {}): DevRepo {
  const t = new Date().toISOString();
  return {
    id: 'repo-1',
    forgeKind: 'github',
    owner: 'byte5ai',
    name: 'omadia',
    cloneUrl: 'https://github.com/byte5ai/omadia.git',
    defaultBranch: 'main',
    credentialKind: 'device_flow',
    credentialRef: 'repo/repo-1',
    trackerKind: null,
    trackerConfig: {},
    allowedTriggers: ['admin'],
    allowedLaunchers: [],
    egressAllowlist: [],
    runsTests: false,
    branchProtectionOk: true,
    branchProtectionCheckedAt: t,
    createdBy: 'op',
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

/** In-memory store mirroring the real terminal-guard + lease semantics. */
class FakeStore implements DevJobWorkerStore {
  readonly jobs = new Map<string, DevJob>();
  readonly artifacts = new Map<string, DevJobArtifact>();
  readonly finishCalls = new Map<string, number>();
  readonly hostEvents: Array<{ jobId: string; type: string; payload: Record<string, unknown> }> = [];
  claimCalls = 0;
  activeOverride: number | null = null;

  add(job: DevJob): DevJob {
    this.jobs.set(job.id, job);
    return job;
  }

  addArtifact(a: DevJobArtifact): DevJobArtifact {
    this.artifacts.set(a.id, a);
    return a;
  }

  async getJob(id: string): Promise<DevJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async claimNextQueued(claimedBy: string): Promise<DevJob | null> {
    this.claimCalls++;
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = queued[0];
    if (!job) return null;
    const claimed: DevJob = {
      ...job,
      status: 'provisioning',
      claimedBy,
      claimedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, claimed);
    return claimed;
  }

  async releaseClaim(jobId: string, claimedBy: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    // Mirror the SQL guard exactly: own the lease, still provisioning, nothing spawned.
    if (!job || job.claimedBy !== claimedBy || job.status !== 'provisioning' || job.runnerHandle) {
      return false;
    }
    this.jobs.set(jobId, {
      ...job,
      status: 'queued',
      claimedBy: null,
      claimedAt: null,
      startedAt: null,
    });
    return true;
  }

  async setRunnerHandle(jobId: string, claimedBy: string, handle: RunnerHandle): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.claimedBy !== claimedBy || isTerminalDevJobStatus(job.status)) {
      // Mirror DevJobLeaseLostError shape enough for the worker's instanceof-free path.
      throw new Error(`dev job '${jobId}' lease lost`);
    }
    this.jobs.set(jobId, { ...job, runnerHandle: handle });
  }

  async listJobs(filter: { status?: DevJobStatus }): Promise<DevJob[]> {
    return [...this.jobs.values()].filter((j) => !filter.status || j.status === filter.status);
  }

  async countActiveJobs(): Promise<number> {
    if (this.activeOverride !== null) return this.activeOverride;
    return [...this.jobs.values()].filter((j) => ACTIVE.includes(j.status)).length;
  }

  async getArtifact(id: string): Promise<DevJobArtifact | null> {
    return this.artifacts.get(id) ?? null;
  }

  async findActiveByHandleId(handleId: string): Promise<DevJob | null> {
    return (
      [...this.jobs.values()].find(
        (j) => ACTIVE_WITH_RUNNER.includes(j.status) && j.runnerHandle?.id === handleId,
      ) ?? null
    );
  }

  async findStalled(cutoff: Date): Promise<DevJob[]> {
    return [...this.jobs.values()].filter((j) => {
      if (!ACTIVE_WITH_RUNNER.includes(j.status)) return false;
      const beat = j.lastHeartbeatAt ?? j.startedAt ?? j.claimedAt;
      return beat !== null && new Date(beat).getTime() < cutoff.getTime();
    });
  }

  async findOverWallClock(startedBefore: Date): Promise<DevJob[]> {
    return [...this.jobs.values()].filter(
      (j) =>
        ACTIVE_WITH_RUNNER.includes(j.status) &&
        j.startedAt !== null &&
        new Date(j.startedAt).getTime() < startedBefore.getTime(),
    );
  }

  async finishTerminal(
    brand: typeof TERMINAL_FINISH_BRAND,
    jobId: string,
    status: DevJobStatus,
    patch: TerminalPatch = {},
  ): Promise<DevJob | null> {
    if (brand !== TERMINAL_FINISH_BRAND) throw new Error('finishTerminal reserved for finalizeDevJob');
    this.finishCalls.set(jobId, (this.finishCalls.get(jobId) ?? 0) + 1);
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (isTerminalDevJobStatus(job.status)) return job; // idempotent guard
    const next: DevJob = {
      ...job,
      status,
      error: patch.error ?? job.error,
      result: patch.result ?? job.result,
      branch: patch.branch ?? job.branch,
      prUrl: patch.prUrl ?? job.prUrl,
      endedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, next);
    return next;
  }

  async appendHostEvent(jobId: string, type: string, payload: Record<string, unknown> = {}) {
    this.hostEvents.push({ jobId, type, payload });
    return {
      id: this.hostEvents.length,
      jobId,
      provision: 0,
      seq: this.hostEvents.length - 1,
      type: type as never,
      ts: new Date().toISOString(),
      payload,
    };
  }
}

class FakeRepoStore implements DevJobWorkerRepoStore {
  constructor(private readonly repo: DevRepo | null) {}
  async getRepo(): Promise<DevRepo | null> {
    return this.repo;
  }
}

class FakeBackend implements RunnerBackend {
  readonly kind = 'local' as const;
  readonly provisioned: RunnerHandle[] = [];
  readonly terminated: RunnerHandle[] = [];
  provisionError: Error | null = null;
  terminateError: Error | null = null;
  reapResult: RunnerHandle[] = [];
  private seq = 0;

  async provision(): Promise<RunnerHandle> {
    if (this.provisionError) throw this.provisionError;
    const handle: RunnerHandle = {
      backend: 'local',
      id: `/tmp/ws-${String(++this.seq)}`,
      pid: 1000 + this.seq,
      startedAt: new Date().toISOString(),
    };
    this.provisioned.push(handle);
    return handle;
  }

  async terminate(handle: RunnerHandle): Promise<void> {
    this.terminated.push(handle);
    if (this.terminateError) throw this.terminateError;
  }

  async reap(): Promise<RunnerHandle[]> {
    return this.reapResult;
  }
}

class FakeApplyService implements DevJobApplyService {
  readonly calls: ApplyInput[] = [];
  result: ApplyResult = {
    prUrl: 'https://github.com/byte5ai/omadia/pull/7',
    prNumber: 7,
    commitSha: 'commit-sha',
    branch: 'omadia/job-abc',
  };
  error: Error | null = null;

  async apply(input: ApplyInput): Promise<ApplyResult> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return { ...this.result, branch: input.job.branch };
  }
}

interface Harness {
  worker: DevJobWorker;
  store: FakeStore;
  backend: FakeBackend;
  apply: FakeApplyService;
  logs: string[];
  prepared: Array<{ jobId: string; lease: string }>;
}

function makeWorker(opts: {
  store: FakeStore;
  repo?: DevRepo | null;
  maxConcurrent?: number;
  wallClockMs?: number;
  heartbeatTimeoutMs?: number;
  subscriptionModeEnabled?: boolean;
  now?: () => Date;
}): Harness {
  const backend = new FakeBackend();
  const apply = new FakeApplyService();
  const logs: string[] = [];
  const prepared: Array<{ jobId: string; lease: string }> = [];
  const worker = new DevJobWorker({
    store: opts.store,
    repoStore: new FakeRepoStore(opts.repo === undefined ? makeRepo() : opts.repo),
    backends: [backend],
    applyService: apply,
    prepareProvision: async (job, lease) => {
      prepared.push({ jobId: job.id, lease });
      return { token: 'djr_test-token', job };
    },
    baseUrl: 'http://127.0.0.1:3333',
    maxConcurrent: opts.maxConcurrent,
    wallClockMs: opts.wallClockMs,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    subscriptionModeEnabled: opts.subscriptionModeEnabled,
    now: opts.now,
    log: (m) => logs.push(m),
  });
  return { worker, store: opts.store, backend, apply, logs, prepared };
}

describe('devplatform/devJobWorker — claim loop', () => {
  it('claims up to DEV_PLATFORM_MAX_CONCURRENT_JOBS and no further', async () => {
    const store = new FakeStore();
    for (let i = 0; i < 3; i++) {
      store.add(makeJob({ id: `job-${String(i)}`, createdAt: `2026-07-09T00:00:0${String(i)}.000Z` }));
    }
    const h = makeWorker({ store, maxConcurrent: 2 });
    await h.worker.claimAndProvision();

    assert.equal(h.store.claimCalls, 2, 'claimed exactly the max, never a third');
    assert.equal(h.backend.provisioned.length, 2, 'provisioned two runners');
    const provisioning = [...store.jobs.values()].filter((j) => j.status === 'provisioning');
    assert.equal(provisioning.length, 2);
    assert.equal([...store.jobs.values()].filter((j) => j.status === 'queued').length, 1, 'one job left queued');
    for (const j of provisioning) assert.ok(j.runnerHandle, 'each provisioned job has its handle attached');
  });

  it('subtracts already-active jobs from the slot budget', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'q1', createdAt: '2026-07-09T00:00:01.000Z' }));
    store.add(makeJob({ id: 'q2', createdAt: '2026-07-09T00:00:02.000Z' }));
    store.activeOverride = 1; // one slot already taken
    const h = makeWorker({ store, maxConcurrent: 2 });
    await h.worker.claimAndProvision();
    assert.equal(h.store.claimCalls, 1, 'only the single free slot was claimed');
  });

  it('finalizes a claimed job failed when the backend refuses to provision', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'j' }));
    const h = makeWorker({ store, maxConcurrent: 1 });
    h.backend.provisionError = new RunnerBackendError('devplatform.local_backend_requires_no_exec', 'nope');
    await h.worker.claimAndProvision();
    const job = await store.getJob('j');
    assert.equal(job?.status, 'failed');
    assert.match(job?.error ?? '', /nope/);
  });
});

describe('devplatform/devJobWorker — enforcement', () => {
  it('finalizes a stale-heartbeat job as stalled through finalizeDevJob', async () => {
    const store = new FakeStore();
    const old = new Date('2026-07-09T00:00:00.000Z').toISOString();
    store.add(
      makeJob({ id: 'j', status: 'running', claimedBy: 'lease', startedAt: old, lastHeartbeatAt: old }),
    );
    const now = () => new Date('2026-07-09T01:00:00.000Z');
    const h = makeWorker({ store, heartbeatTimeoutMs: 120_000, wallClockMs: 9_999_999_999, now });
    await h.worker.enforceTimeouts();

    const job = await store.getJob('j');
    assert.equal(job?.status, 'stalled');
    assert.equal(store.finishCalls.get('j'), 1, 'exactly one terminal write');
    assert.ok(store.hostEvents.some((e) => e.jobId === 'j' && e.payload['status'] === 'stalled'));
  });

  it('finalizes a wall-clock-exceeded job as budget_exceeded through finalizeDevJob', async () => {
    const store = new FakeStore();
    const now = () => new Date('2026-07-09T01:00:00.000Z');
    // Fresh heartbeat (not stalled) but started well before the wall-clock window.
    store.add(
      makeJob({
        id: 'j',
        status: 'running',
        claimedBy: 'lease',
        startedAt: '2026-07-09T00:00:00.000Z',
        lastHeartbeatAt: '2026-07-09T00:59:59.000Z',
      }),
    );
    const h = makeWorker({ store, heartbeatTimeoutMs: 120_000, wallClockMs: 1_800_000, now });
    await h.worker.enforceTimeouts();

    const job = await store.getJob('j');
    assert.equal(job?.status, 'budget_exceeded');
    assert.equal(store.finishCalls.get('j'), 1);
  });

  it('leaves an applying job alone even when it is BOTH stale and over its wall clock', async () => {
    // Regression (review major): an `applying` job has no runner to heartbeat, so
    // across a restart / long agent run it looks both stale and over-budget. It
    // must still be applied, never finalized stalled/budget_exceeded.
    const store = new FakeStore();
    const old = '2026-07-09T00:00:00.000Z';
    store.add(
      makeJob({
        id: 'j',
        status: 'applying',
        claimedBy: 'lease',
        startedAt: old,
        lastHeartbeatAt: old,
        result: { outcome: 'diff_ready', diffArtifactId: 'art-1' },
      }),
    );
    const now = () => new Date('2026-07-09T01:00:00.000Z');
    const h = makeWorker({ store, heartbeatTimeoutMs: 120_000, wallClockMs: 1_800_000, now });
    await h.worker.enforceTimeouts();

    const job = await store.getJob('j');
    assert.equal(job?.status, 'applying', 'the host-side apply phase is exempt from liveness enforcement');
    assert.equal(store.finishCalls.get('j') ?? 0, 0, 'no terminal write against an applying job');
  });
});

describe('devplatform/devJobWorker — apply', () => {
  function seedApplyable(store: FakeStore): DevJob {
    store.addArtifact({
      id: 'art-1',
      jobId: 'j',
      kind: 'diff',
      content: `diff --git a/x b/x${NUMSTAT_MARKER}1\t0\tx`,
      meta: {},
      createdAt: new Date().toISOString(),
    });
    return store.add(
      makeJob({
        id: 'j',
        status: 'applying',
        branch: 'omadia/job-abc',
        result: { outcome: 'diff_ready', diffArtifactId: 'art-1' },
      }),
    );
  }

  it('applies once, stores pr_url, and finalizes done', async () => {
    const store = new FakeStore();
    seedApplyable(store);
    const h = makeWorker({ store });
    await h.worker.applyReady();

    assert.equal(h.apply.calls.length, 1, 'apply invoked exactly once');
    const call = h.apply.calls[0]!;
    assert.equal(call.diff, 'diff --git a/x b/x');
    assert.equal(call.numstat, '1\t0\tx');
    assert.equal(call.job.branch, 'omadia/job-abc');
    assert.equal(call.job.baseSha, 'base-sha-abc');

    const job = await store.getJob('j');
    assert.equal(job?.status, 'done');
    assert.equal(job?.prUrl, 'https://github.com/byte5ai/omadia/pull/7');
    assert.equal(store.finishCalls.get('j'), 1);
  });

  it('does not apply the same job twice within a tick', async () => {
    const store = new FakeStore();
    seedApplyable(store);
    const h = makeWorker({ store });
    await Promise.all([h.worker.applyReady(), h.worker.applyReady()]);
    assert.equal(h.apply.calls.length, 1, 'the in-flight guard prevents a double apply');
  });

  it('on apply failure finalizes failed and retains the diff artifact', async () => {
    const store = new FakeStore();
    seedApplyable(store);
    const h = makeWorker({ store });
    h.apply.error = new Error('git-data 422');
    await h.worker.applyReady();

    const job = await store.getJob('j');
    assert.equal(job?.status, 'failed');
    assert.match(job?.error ?? '', /git-data 422/);
    assert.ok(await store.getArtifact('art-1'), 'the diff artifact is retained for a manual retry');
    assert.equal(h.apply.calls.length, 1);
  });

  it('applyJob rejects a job that is neither applying nor failed-after-diff', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'j', status: 'running' }));
    const h = makeWorker({ store });
    await assert.rejects(() => h.worker.applyJob('j'), (e) => e instanceof DevJobWorkerError && /apply_not_allowed/.test(e.code));
  });
});

describe('devplatform/devJobWorker — auth-mode admission (spec §6b)', () => {
  it('refuses subscription when the flag is unset', () => {
    assert.throws(
      () => assertAuthModeAdmissible(
        { authMode: 'subscription', source: 'admin', backend: 'local' },
        { runsTests: false },
        { subscriptionModeEnabled: false },
      ),
      (e) => e instanceof DevJobWorkerError && e.code === 'devplatform.subscription_disabled',
    );
  });

  it('refuses subscription for a runs_tests repo', () => {
    assert.throws(
      () => assertAuthModeAdmissible(
        { authMode: 'subscription', source: 'admin', backend: 'local' },
        { runsTests: true },
        { subscriptionModeEnabled: true },
      ),
      (e) => e instanceof DevJobWorkerError && e.code === 'devplatform.subscription_requires_no_exec',
    );
  });

  it('refuses subscription from a non-admin source', () => {
    assert.throws(
      () => assertAuthModeAdmissible(
        { authMode: 'subscription', source: 'chat', backend: 'local' },
        { runsTests: false },
        { subscriptionModeEnabled: true },
      ),
      (e) => e instanceof DevJobWorkerError && e.code === 'devplatform.subscription_operator_only',
    );
  });

  it('admits an api_key job unconditionally and a well-formed subscription job', () => {
    assert.doesNotThrow(() =>
      assertAuthModeAdmissible(
        { authMode: 'api_key', source: 'chat', backend: 'fly' },
        { runsTests: true },
        { subscriptionModeEnabled: false },
      ),
    );
    assert.doesNotThrow(() =>
      assertAuthModeAdmissible(
        { authMode: 'subscription', source: 'admin', backend: 'local' },
        { runsTests: false },
        { subscriptionModeEnabled: true },
      ),
    );
  });

  it('the worker boundary finalizes a subscription job failed when the mode is off', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'j', authMode: 'subscription' }));
    const h = makeWorker({ store, maxConcurrent: 1, subscriptionModeEnabled: false });
    await h.worker.claimAndProvision();

    const job = await store.getJob('j');
    assert.equal(job?.status, 'failed');
    assert.match(job?.error ?? '', /subscription_disabled/);
    assert.equal(h.backend.provisioned.length, 0, 'no runner was ever provisioned');
  });
});

describe('devplatform/devJobWorker — terminate + reap', () => {
  it('a terminate() that throws local_terminate_incomplete still finalizes and is logged', async () => {
    const store = new FakeStore();
    const handle: RunnerHandle = { backend: 'local', id: '/tmp/ws-1', pid: 4242, startedAt: new Date().toISOString() };
    store.add(makeJob({ id: 'j', status: 'running', claimedBy: 'lease', runnerHandle: handle }));
    const h = makeWorker({ store });
    h.backend.terminateError = new RunnerBackendError(
      'devplatform.local_terminate_incomplete',
      'group did not confirm exit; workspace retained',
    );

    const out = await h.worker.finalize('j', 'stalled', { reason: 'test' });

    assert.equal(out?.status, 'stalled', 'the job is finalized despite the terminate failure');
    assert.deepEqual(h.backend.terminated, [handle], 'terminate was attempted on the live handle');
    assert.ok(
      h.logs.some((l) => /terminate side-effect failed/.test(l) && /workspace retained/.test(l)),
      'the terminate failure was logged, never swallowed silently',
    );
  });

  it('reap results are finalized as stalled exactly once each (finalizeDevJob is idempotent)', async () => {
    const store = new FakeStore();
    const h1: RunnerHandle = { backend: 'local', id: '/tmp/ws-a', pid: 11, startedAt: new Date().toISOString() };
    const h2: RunnerHandle = { backend: 'local', id: '/tmp/ws-b', pid: 22, startedAt: new Date().toISOString() };
    store.add(makeJob({ id: 'ja', status: 'running', claimedBy: 'l1', runnerHandle: h1 }));
    store.add(makeJob({ id: 'jb', status: 'running', claimedBy: 'l2', runnerHandle: h2 }));
    const h = makeWorker({ store });
    h.backend.reapResult = [h1, h2];

    await h.worker.reapBackends();
    assert.equal((await store.getJob('ja'))?.status, 'stalled');
    assert.equal((await store.getJob('jb'))?.status, 'stalled');
    assert.equal(store.finishCalls.get('ja'), 1);
    assert.equal(store.finishCalls.get('jb'), 1);

    // A second finalize of the same job is a no-op — the terminal write does not
    // run again. This is the idempotency guarantee the reap loop relies on.
    await h.worker.finalize('ja', 'stalled', { reason: 'again' });
    assert.equal(store.finishCalls.get('ja'), 1, 'no second terminal write on an already-terminal job');
  });

  it('reapBackends drops a reaped handle whose job is applying instead of stalling it', async () => {
    // Regression (review blocker): the shim posts its diff and exits 0 by design,
    // so the local backend reaps the dead pid while the job sits in `applying`.
    // reapBackends must NOT finalize that as `stalled` — the apply still has to run.
    const store = new FakeStore();
    const handle: RunnerHandle = { backend: 'local', id: '/tmp/ws-dead', pid: 4242, startedAt: new Date().toISOString() };
    store.add(
      makeJob({
        id: 'j',
        status: 'applying',
        claimedBy: 'lease',
        runnerHandle: handle,
        result: { outcome: 'diff_ready', diffArtifactId: 'art-1' },
      }),
    );
    const h = makeWorker({ store });
    h.backend.reapResult = [handle];

    await h.worker.reapBackends();

    const job = await store.getJob('j');
    assert.equal(job?.status, 'applying', 'the applying job is left for applyReady, not finalized stalled');
    assert.equal(store.finishCalls.get('j') ?? 0, 0, 'no terminal write');
  });

  it('a full tick applies an applying job whose runner pid is already dead, never stalling it', async () => {
    // Regression (review blocker): drives the exact sequence — job in `applying`,
    // its tracked handle already reaped (dead pid) — through a whole tick(). The
    // host-side apply MUST fire (epic #470's core guarantee): pr_url stored, job
    // `done`, and finalizeDevJob never called with `stalled`.
    const store = new FakeStore();
    const handle: RunnerHandle = { backend: 'local', id: '/tmp/ws-dead', pid: 4242, startedAt: new Date().toISOString() };
    store.addArtifact({
      id: 'art-1',
      jobId: 'j',
      kind: 'diff',
      content: `diff --git a/x b/x${NUMSTAT_MARKER}1\t0\tx`,
      meta: {},
      createdAt: new Date().toISOString(),
    });
    store.add(
      makeJob({
        id: 'j',
        status: 'applying',
        claimedBy: 'lease',
        runnerHandle: handle,
        branch: 'omadia/job-abc',
        result: { outcome: 'diff_ready', diffArtifactId: 'art-1' },
      }),
    );
    const h = makeWorker({ store });
    h.backend.reapResult = [handle]; // the backend already reaped the dead runner

    await h.worker.tick();

    assert.equal(h.apply.calls.length, 1, 'the host-side apply ran');
    const job = await store.getJob('j');
    assert.equal(job?.status, 'done', 'the apply drove the job to done, not stalled');
    assert.equal(job?.prUrl, 'https://github.com/byte5ai/omadia/pull/7', 'the PR url was stored');
    assert.equal(store.finishCalls.get('j'), 1, 'exactly one terminal write (done)');
    assert.ok(
      !store.hostEvents.some((e) => e.jobId === 'j' && e.payload['status'] === 'stalled'),
      'finalizeDevJob was never called with stalled',
    );
  });
});

describe('devplatform/devJobWorker — splitDiffBundle', () => {
  it('splits on the marker and treats a marker-less body as all-diff', () => {
    assert.deepEqual(splitDiffBundle(`DIFF${NUMSTAT_MARKER}NUM`), { diff: 'DIFF', numstat: 'NUM' });
    assert.deepEqual(splitDiffBundle('just a diff'), { diff: 'just a diff', numstat: '' });
  });
});

describe('devplatform/devJobWorker — a backend at capacity requeues, it does not fail the job', () => {
  it('rewinds the claim on a retryable provision error and re-claims on the next poll', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'job-cap' }));
    const h = makeWorker({ store });
    const atCapacity = new RunnerBackendError('daemon_at_capacity', 'daemon at capacity');
    (atCapacity as RunnerBackendError & { retryable: boolean }).retryable = true;
    h.backend.provisionError = atCapacity;

    await h.worker.tick();

    const requeued = await store.getJob('job-cap');
    assert.equal(requeued?.status, 'queued', 'a full daemon is not a failed job');
    assert.equal(requeued?.claimedBy, null);
    assert.equal(requeued?.startedAt, null, 'the job never started, so it has no start time');
    assert.equal(store.finishCalls.get('job-cap') ?? 0, 0, 'nothing was finalized');
    assert.equal(h.backend.terminated.length, 0, 'nothing was spawned, so nothing to tear down');

    // Capacity frees up: the very next poll picks the same row back up.
    h.backend.provisionError = null;
    await h.worker.tick();
    assert.equal((await store.getJob('job-cap'))?.status, 'provisioning');
    assert.equal(h.backend.provisioned.length, 1);
  });

  it('still fails the job when the provision error is NOT retryable', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'job-broken' }));
    const h = makeWorker({ store });
    h.backend.provisionError = new RunnerBackendError('image_denied', 'image not allowlisted');

    await h.worker.tick();

    const job = await store.getJob('job-broken');
    assert.equal(job?.status, 'failed', 'a real provisioning fault must surface, not spin forever');
  });

  it('leaves the row alone when the lease moved on while we were provisioning', async () => {
    const store = new FakeStore();
    store.add(makeJob({ id: 'job-stolen' }));
    const h = makeWorker({ store });
    const atCapacity = new RunnerBackendError('daemon_at_capacity', 'daemon at capacity');
    (atCapacity as RunnerBackendError & { retryable: boolean }).retryable = true;
    // Another worker reaped the stalled claim and re-claimed the row *while* we
    // were talking to the daemon — the classic lease-lost window.
    h.backend.provision = async (): Promise<RunnerHandle> => {
      const stolen = store.jobs.get('job-stolen')!;
      store.jobs.set('job-stolen', { ...stolen, claimedBy: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
      throw atCapacity;
    };

    await h.worker.tick();

    const job = await store.getJob('job-stolen');
    assert.equal(job?.claimedBy, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'we did not stomp the new owner');
    assert.equal(job?.status, 'provisioning');
    assert.ok(h.logs.some((l) => l.includes('lease already lost')));
  });
});
