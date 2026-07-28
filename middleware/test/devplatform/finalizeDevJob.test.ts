import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { TERMINAL_FINISH_BRAND, type TerminalPatch } from '../../src/devplatform/devJobStore.js';
import {
  CredentialRevokerRegistry,
  finalizeDevJob,
  type FinalizeStore,
} from '../../src/devplatform/finalizeDevJob.js';
import { isTerminalDevJobStatus, type DevJob, type DevJobStatus, type RunnerHandle } from '../../src/devplatform/types.js';

/**
 * Epic #470 W0 — finalizeDevJob with an injected fake store (no DB). Asserts the
 * single-choke-point invariant: every terminal path routes through it exactly
 * once, it is idempotent on an already-terminal job, and its side effects
 * (status event, credential revoke, backend terminate) fire once — and never
 * block finalization when they fail.
 */

function makeJob(overrides: Partial<DevJob> = {}): DevJob {
  return {
    id: 'job-1',
    repoId: 'repo-1',
    kind: 'implement',
    brief: 'do the thing',
    source: 'admin',
    sourceRef: null,
    baseSha: null,
    backend: 'local',
    agentKind: 'claude-cli',
    authMode: 'api_key',
    provision: 1,
    phase: 'implement',
    status: 'running',
    claimedBy: '11111111-1111-4111-8111-111111111111',
    claimedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
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
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Fake store that mirrors the real store's terminal-guard semantics. */
class FakeStore implements FinalizeStore {
  finishCalls = 0;
  eventCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  brandSeen: unknown = undefined;

  constructor(private job: DevJob | null) {}

  async getJob(jobId: string): Promise<DevJob | null> {
    return this.job && this.job.id === jobId ? this.job : null;
  }

  async finishTerminal(
    brand: typeof TERMINAL_FINISH_BRAND,
    jobId: string,
    status: DevJobStatus,
    patch: TerminalPatch = {},
  ): Promise<DevJob | null> {
    this.finishCalls++;
    this.brandSeen = brand;
    if (!this.job || this.job.id !== jobId) return null;
    // Idempotent guard, exactly as the real UPDATE ... WHERE status NOT IN (terminal).
    if (isTerminalDevJobStatus(this.job.status)) return this.job;
    this.job = {
      ...this.job,
      status,
      error: patch.error ?? this.job.error,
      branch: patch.branch ?? this.job.branch,
      prUrl: patch.prUrl ?? this.job.prUrl,
      endedAt: new Date().toISOString(),
    };
    return this.job;
  }

  async appendHostEvent(_jobId: string, type: string, payload: Record<string, unknown> = {}) {
    this.eventCalls.push({ type, payload });
    return {
      id: this.eventCalls.length,
      jobId: _jobId,
      provision: 0,
      seq: this.eventCalls.length - 1,
      type: type as never,
      ts: new Date().toISOString(),
      payload,
    };
  }
}

describe('devplatform/finalizeDevJob', () => {
  it('flips status, appends one status event, and passes the brand', async () => {
    const store = new FakeStore(makeJob({ status: 'running' }));
    const out = await finalizeDevJob({ store }, 'job-1', 'failed', { error: 'boom', reason: 'stalled' });

    assert.equal(out?.status, 'failed');
    assert.equal(out?.error, 'boom');
    assert.equal(store.finishCalls, 1, 'terminal write happened exactly once');
    assert.equal(store.brandSeen, TERMINAL_FINISH_BRAND, 'the terminal brand was passed');
    assert.equal(store.eventCalls.length, 1, 'exactly one status event');
    assert.equal(store.eventCalls[0]?.type, 'status');
    assert.equal(store.eventCalls[0]?.payload['status'], 'failed');
    assert.equal(store.eventCalls[0]?.payload['previous'], 'running');
    assert.equal(store.eventCalls[0]?.payload['reason'], 'stalled');
  });

  it('is idempotent on an already-terminal job: no flip, no event, returns existing', async () => {
    const store = new FakeStore(makeJob({ status: 'done', prUrl: 'https://x/pr/1' }));
    const out = await finalizeDevJob({ store }, 'job-1', 'failed');

    assert.equal(out?.status, 'done', 'existing terminal state returned unchanged');
    assert.equal(out?.prUrl, 'https://x/pr/1');
    assert.equal(store.finishCalls, 0, 'no terminal write on an already-terminal job');
    assert.equal(store.eventCalls.length, 0, 'no status event on a no-op');
  });

  it('a second finalize is a no-op — the terminal write runs exactly once', async () => {
    const store = new FakeStore(makeJob({ status: 'running' }));
    const first = await finalizeDevJob({ store }, 'job-1', 'cancelled');
    const second = await finalizeDevJob({ store }, 'job-1', 'failed');

    assert.equal(first?.status, 'cancelled');
    assert.equal(second?.status, 'cancelled', 'second call returns the first terminal state');
    assert.equal(store.finishCalls, 1, 'finishTerminal ran once across two finalize calls');
    assert.equal(store.eventCalls.length, 1, 'one status event across two finalize calls');
  });

  it('returns null for an unknown job and never writes', async () => {
    const store = new FakeStore(makeJob());
    const out = await finalizeDevJob({ store }, 'missing', 'failed');
    assert.equal(out, null);
    assert.equal(store.finishCalls, 0);
  });

  it('rejects a non-terminal target status', async () => {
    const store = new FakeStore(makeJob());
    await assert.rejects(
      () => finalizeDevJob({ store }, 'job-1', 'running' as DevJobStatus),
      /not a terminal status/,
    );
    assert.equal(store.finishCalls, 0);
  });

  it('terminates a live backend handle and runs registered revokers once', async () => {
    const handle: RunnerHandle = { backend: 'local', id: '/tmp/x', pid: 4242, startedAt: new Date().toISOString() };
    const store = new FakeStore(makeJob({ status: 'running', runnerHandle: handle }));

    const terminated: RunnerHandle[] = [];
    const revoked: string[] = [];
    const revokers = new CredentialRevokerRegistry();
    revokers.register((job) => {
      revoked.push(job.id);
    });

    const out = await finalizeDevJob(
      { store, terminate: (h) => void terminated.push(h), revokers },
      'job-1',
      'budget_exceeded',
    );

    assert.equal(out?.status, 'budget_exceeded');
    assert.deepEqual(terminated, [handle], 'the live handle was terminated once');
    assert.deepEqual(revoked, ['job-1'], 'the revoker ran once');
  });

  it('does not terminate or revoke when the job is already terminal', async () => {
    const handle: RunnerHandle = { backend: 'local', id: '/tmp/x', pid: 1, startedAt: new Date().toISOString() };
    const store = new FakeStore(makeJob({ status: 'cancelled', runnerHandle: handle }));
    let terminatedCount = 0;
    let revokedCount = 0;

    await finalizeDevJob(
      { store, terminate: () => void terminatedCount++, revokers: [() => void revokedCount++] },
      'job-1',
      'failed',
    );

    assert.equal(terminatedCount, 0, 'no terminate on an already-terminal job');
    assert.equal(revokedCount, 0, 'no revoke on an already-terminal job');
  });

  it('a failing side effect does not block finalization; onError observes it', async () => {
    const store = new FakeStore(makeJob({ status: 'running' }));
    // Force the event append to throw.
    store.appendHostEvent = async () => {
      throw new Error('event store down');
    };
    const errors: Array<{ phase: string; msg: string }> = [];

    const out = await finalizeDevJob(
      {
        store,
        terminate: () => {
          throw new Error('terminate failed');
        },
        onError: (err, phase) => errors.push({ phase, msg: (err as Error).message }),
      },
      'job-1',
      'stalled',
    );

    assert.equal(out?.status, 'stalled', 'job still finalized despite side-effect failures');
    assert.ok(
      errors.some((e) => e.phase === 'event'),
      'the event-append failure was surfaced to onError',
    );
  });
});
