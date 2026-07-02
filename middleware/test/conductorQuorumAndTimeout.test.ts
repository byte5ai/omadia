import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { RealStepEffects, StepTimeoutError, DEFAULT_STEP_TIMEOUT_MS } from '../src/conductor/realStepEffects.js';
import { DEFAULT_RESUME_STALE_MS } from '../src/conductor/runResumeWorker.js';
import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

describe('resume-safety invariant', () => {
  it('the default per-step timeout is strictly less than the resume worker stale window', () => {
    // If this fails, a stalled step could be re-driven before it settles → at-least-once re-execution.
    assert.ok(
      DEFAULT_STEP_TIMEOUT_MS < DEFAULT_RESUME_STALE_MS,
      `step timeout (${DEFAULT_STEP_TIMEOUT_MS}) must be < resume stale window (${DEFAULT_RESUME_STALE_MS})`,
    );
  });
});

// Conductor Wave 3 — quorum 'all' (US5) + per-step hard timeout (US2 resume safety).

describe('RealStepEffects per-step hard timeout', () => {
  it('rejects an agent step that exceeds stepTimeoutMs', async () => {
    const neverResolves = new Promise(() => {}); // a turn that hangs forever
    const registry = {
      get: () => ({ built: { bundle: { agent: { chat: () => neverResolves } } } }),
    };
    const effects = new RealStepEffects({
      getRegistry: () => registry as never,
      stepTimeoutMs: 20,
    });
    await assert.rejects(
      () => effects.runAgentStep({ id: 's1', kind: 'agent', agentId: 'fallback' } as never, {}, { runId: 'r1' }),
      (err: unknown) => err instanceof StepTimeoutError,
    );
  });

  it('returns normally when the agent answers within budget', async () => {
    const registry = {
      get: () => ({ built: { bundle: { agent: { chat: async () => ({ text: 'done' }) } } } }),
    };
    const effects = new RealStepEffects({ getRegistry: () => registry as never, stepTimeoutMs: 1000 });
    const out = await effects.runAgentStep({ id: 's1', kind: 'agent', agentId: 'fallback' } as never, {}, { runId: 'r1' });
    assert.deepEqual(out.result, { text: 'done' });
  });
});

describe('ConductorRunExecutor.resolveAwait quorum=all', () => {
  // Minimal graph: a single human step with no outgoing transition → resolving it completes the run
  // (no driveFrom needed), so the test stays focused on the quorum close-gating.
  const graph = {
    entryStepId: 'h1',
    steps: [{ id: 'h1', kind: 'human', human: { principal: { kind: 'role', ref: 'approvers' }, channel: 'teams', message: 'ok?' } }],
    transitions: [],
  };

  function makeExecutor(opts: { responders: string[]; holders: string[]; onClose: () => void }) {
    const responses = opts.responders.map((id) => ({ responderId: id, response: { approved: true } }));
    const awaitRow = {
      id: 'aw1', runId: 'run1', stepId: 'h1', principalKind: 'role', principalRef: 'approvers',
      channelType: 'teams', message: 'ok?', quorum: 'all', reminderIntervalMs: null, deadlineAt: null,
      fallbackTransitionId: null, status: 'waiting', createdAt: new Date(0),
    };
    const run = {
      id: 'run1', workflowVersionId: 'v1', status: 'waiting', currentStepId: 'h1', context: {},
      triggerKind: 'manual', triggerSource: null, isDryRun: false, startedAt: new Date(0), endedAt: null,
    };
    const awaitStore = {
      async get() { return awaitRow; },
      async recordResponse() {},
      async listResponses() { return responses; },
      async close() { opts.onClose(); return true; },
    };
    const runStore = {
      async get() { return run; },
      async acquireLease() {},
      async stepsForRun() { return []; },
      async recordStepAndAdvance() {},
    };
    const workflowStore = {
      async getVersion() { return { id: 'v1', workflowId: 'w1', version: 1, graph }; },
    };
    return new ConductorRunExecutor({
      workflowStore: workflowStore as never,
      runStore: runStore as never,
      awaitStore: awaitStore as never,
      effects: {} as never,
      resolveRoleHolders: async () => opts.holders,
    });
  }

  it('does NOT close while holders are still outstanding', async () => {
    let closed = false;
    // alice responded; bob has not → quorum 'all' over [alice, bob] is incomplete.
    const exec = makeExecutor({ responders: ['alice'], holders: ['alice', 'bob'], onClose: () => { closed = true; } });
    await exec.resolveAwait('aw1', 'alice', { approved: true });
    assert.equal(closed, false);
  });

  it('closes + resumes once every current holder has responded', async () => {
    let closed = false;
    const exec = makeExecutor({ responders: ['alice', 'bob'], holders: ['alice', 'bob'], onClose: () => { closed = true; } });
    await exec.resolveAwait('aw1', 'bob', { approved: true });
    assert.equal(closed, true);
  });
});
