import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { TaskLeaseLostError } from '@omadia/orchestrator';

import {
  createDevJobTaskStore,
  projectDevJobStatus,
  type DevJobTaskJobStore,
} from '../../src/devplatform/devJobTaskStore.js';
import type { DevJob, DevJobStatus } from '../../src/devplatform/types.js';

/**
 * W2-2 — the dev_job adapter's orphan sweep, isolated.
 *
 * Why not in the pg suite: `DevJobStore.findStalled` is DATABASE-GLOBAL (no
 * tenant predicate), so triggering a real sweep in a shared test cluster
 * finalizes other suites' in-flight jobs as `stalled`. That is correct
 * production behaviour and an untenable test, so the sweep is driven here
 * against a controlled `findStalled`.
 */

function job(overrides: Partial<DevJob> = {}): DevJob {
  return {
    id: randomUUID(),
    repoId: 'repo-1',
    kind: 'implement',
    brief: 'b',
    source: 'admin',
    sourceRef: null,
    baseSha: null,
    backend: 'local',
    agentKind: 'claude-cli',
    authMode: 'api_key',
    provision: 1,
    phase: 'analyze',
    pipelineMode: 'gated',
    reviewAttempt: 0,
    reviewFingerprint: null,
    retryOf: null,
    status: 'running',
    claimedBy: null,
    claimedAt: null,
    lastHeartbeatAt: null,
    runnerHandle: null,
    runnerTokenHash: null,
    branch: null,
    prUrl: null,
    result: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    budgetCostUsd: null,
    budgetTokens: null,
    usageEstimated: false,
    createdBy: 'test',
    createdAt: new Date(0).toISOString(),
    startedAt: null,
    endedAt: null,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as DevJob;
}

interface Harness {
  readonly store: ReturnType<typeof createDevJobTaskStore>;
  readonly finalizeCalls: { jobId: string; status: DevJobStatus; error?: string }[];
  readonly stalledCutoffs: Date[];
  readonly purgeCalls: { days: number; now: Date }[];
}

function harness(opts: {
  stalled?: DevJob[];
  jobs?: DevJob[];
  purged?: number;
  finalizeReturnsNull?: boolean;
}): Harness {
  const finalizeCalls: Harness['finalizeCalls'] = [];
  const stalledCutoffs: Date[] = [];
  const purgeCalls: Harness['purgeCalls'] = [];
  const byId = new Map((opts.jobs ?? []).map((j) => [j.id, j]));

  const jobStore: DevJobTaskJobStore = {
    createJob: async () => {
      throw new Error('unused');
    },
    getJob: async (id) => byId.get(id) ?? null,
    listJobs: async () => [...byId.values()],
    claimNextQueued: async () => null,
    touchHeartbeat: async () => true,
    appendEvents: async () => 0,
    findStalled: async (cutoff) => {
      stalledCutoffs.push(cutoff);
      return opts.stalled ?? [];
    },
  };

  const store = createDevJobTaskStore({
    jobStore,
    createJob: async () => {
      throw new Error('unused');
    },
    finalize: async (jobId, status, patch) => {
      finalizeCalls.push({
        jobId,
        status,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
      });
      if (opts.finalizeReturnsNull) return null;
      const existing = byId.get(jobId) ?? job({ id: jobId });
      const updated = job({ ...existing, status, error: patch.error ?? null });
      byId.set(jobId, updated);
      return updated;
    },
    purgeTerminalJobs: async (days, now) => {
      purgeCalls.push({ days, now });
      return opts.purged ?? 0;
    },
  });

  return { store, finalizeCalls, stalledCutoffs, purgeCalls };
}

describe('devplatform/devJobTaskStore — orphan sweep', () => {
  it('finalizes every stalled job as dev_job `stalled` with an abandoned reason', async () => {
    const a = job();
    const b = job();
    const h = harness({ stalled: [a, b], jobs: [a, b] });

    const r = await h.store.reapOrphans({
      now: new Date(1_000_000),
      staleAfterMs: 300_000,
      purgeTerminalAfterMs: 3_600_000,
    });

    assert.equal(r.staleFailed, 2);
    assert.deepEqual(
      h.finalizeCalls.map((c) => c.jobId).sort(),
      [a.id, b.id].sort(),
    );
    for (const call of h.finalizeCalls) {
      assert.equal(call.status, 'stalled');
      assert.match(String(call.error), /abandoned/);
    }
    // `stalled` is what dev_job records; the seam reports the projection.
    assert.equal(projectDevJobStatus('stalled'), 'failed');
  });

  it('derives the stale cutoff from now minus the window', async () => {
    const h = harness({});
    await h.store.reapOrphans({
      now: new Date(1_000_000),
      staleAfterMs: 300_000,
      purgeTerminalAfterMs: 3_600_000,
    });
    assert.equal(h.stalledCutoffs.length, 1);
    assert.equal(h.stalledCutoffs[0]?.getTime(), 700_000);
  });

  it('does not count a job the terminal write refused', async () => {
    // `finishTerminal` returns the existing row (or null) when the job is
    // already terminal or absent — a double sweep must not inflate the count.
    const a = job();
    const h = harness({ stalled: [a], jobs: [a], finalizeReturnsNull: true });
    const r = await h.store.reapOrphans({
      now: new Date(1_000_000),
      staleAfterMs: 1,
      purgeTerminalAfterMs: 1,
    });
    assert.equal(r.staleFailed, 0, 'a refused finalize is not a reap');
    assert.equal(h.finalizeCalls.length, 1, 'but it WAS attempted');
  });

  it('converts the retain window to whole days, rounding UP', async () => {
    // `purgeTerminalJobs` takes days; rounding DOWN would produce 0 and throw,
    // and would also purge more aggressively than the caller asked for.
    const h = harness({ purged: 4 });
    const r = await h.store.reapOrphans({
      now: new Date(0),
      staleAfterMs: 1,
      // 1.5 days
      purgeTerminalAfterMs: 129_600_000,
    });
    assert.equal(r.purged, 4);
    assert.equal(h.purgeCalls[0]?.days, 2, '1.5 days rounds up to 2');
  });

  it('never asks for a zero-day purge window', async () => {
    const h = harness({ purged: 0 });
    await h.store.reapOrphans({
      now: new Date(0),
      staleAfterMs: 1,
      purgeTerminalAfterMs: 1, // sub-day
    });
    assert.equal(h.purgeCalls[0]?.days, 1, 'clamped to a minimum of 1 day');
  });

  it('reports 0 purged when no purge hook is wired', async () => {
    const store = createDevJobTaskStore({
      jobStore: {
        createJob: async () => {
          throw new Error('unused');
        },
        getJob: async () => null,
        listJobs: async () => [],
        claimNextQueued: async () => null,
        touchHeartbeat: async () => true,
        appendEvents: async () => 0,
        findStalled: async () => [],
      },
      createJob: async () => {
        throw new Error('unused');
      },
      finalize: async () => null,
    });
    const r = await store.reapOrphans({
      staleAfterMs: 1,
      purgeTerminalAfterMs: 1,
    });
    assert.deepEqual(r, { staleFailed: 0, purged: 0 });
  });
});

describe('devplatform/devJobTaskStore — fence on a missing job', () => {
  it('treats an absent job as a lost lease, not a crash', async () => {
    const h = harness({});
    await assert.rejects(
      () => h.store.heartbeat(randomUUID(), randomUUID()),
      TaskLeaseLostError,
    );
  });

  it('setPhase is a documented no-op after the fence', async () => {
    // dev_job's phase machine is `advancePhase(from, to)`, fenced on the phase
    // being LEFT; a generic `setPhase(to)` cannot express that without racing.
    // So the seam checks the fence and declines to drive the phase.
    const a = job({ claimedBy: 'lease-1' });
    const h = harness({ jobs: [a] });
    await h.store.setPhase(a.id, 'lease-1', 'implement');
    assert.equal(a.phase, 'analyze', 'the phase is untouched');
    await assert.rejects(
      () => h.store.setPhase(a.id, 'other-lease', 'implement'),
      TaskLeaseLostError,
      'but the fence still applies',
    );
  });
});
