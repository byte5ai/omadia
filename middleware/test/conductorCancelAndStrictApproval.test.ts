/**
 * #759 — operator run cancellation + strict approval semantics + validator
 * warnings + role-holder audit. Executor tests use the same minimal-fake
 * harness as `conductorQuorumAndTimeout.test.ts`; route tests bind an
 * express app on 127.0.0.1 like `conductorTemplateRoutes.test.ts`.
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { validate } from '@omadia/conductor-core';
import type { WorkflowGraph } from '@omadia/conductor-core';
import {
  ConductorRunExecutor,
  RunAlreadyEndedError,
  WorkflowNotFoundError,
} from '../src/conductor/runExecutor.js';
import { createConductorRouter } from '../src/conductor/routes.js';

// ── executor harness ────────────────────────────────────────────────────────

interface RecordedStep {
  stepId: string;
  actor: unknown;
  status: string;
  context: Record<string, unknown>;
}

function humanGraph(strictApproval: boolean): WorkflowGraph {
  return {
    entryStepId: 'h1',
    steps: [
      {
        id: 'h1',
        kind: 'human',
        human: {
          principal: { kind: 'role', ref: 'approvers' },
          channel: 'teams',
          message: 'ok?',
          ...(strictApproval ? { strictApproval: true } : {}),
        },
      },
    ],
    transitions: [],
  } as unknown as WorkflowGraph;
}

function makeHarness(opts: {
  graph: WorkflowGraph;
  run: Record<string, unknown>;
  holders?: string[];
  quorum?: 'any' | 'all';
  responses?: Array<{ responderId: string; response: unknown }>;
  cancelRequested?: boolean;
  requestCancelResult?: Record<string, unknown> | null;
}) {
  const recorded: RecordedStep[] = [];
  const cancelledAwaitRuns: string[] = [];
  const ended: string[] = [];
  const awaitRow = {
    id: 'aw1', runId: 'run1', stepId: 'h1', principalKind: 'role', principalRef: 'approvers',
    channelType: 'teams', message: 'ok?', quorum: opts.quorum ?? 'any', reminderIntervalMs: null,
    deadlineAt: null, fallbackTransitionId: null, status: 'waiting', createdAt: new Date(0),
  };
  const awaitStore = {
    async get() { return awaitRow; },
    async recordResponse() {},
    async listResponses() { return opts.responses ?? []; },
    async close() { return true; },
    async cancelForRun(runId: string) { cancelledAwaitRuns.push(runId); return 1; },
  };
  const runStore = {
    async get() { return opts.run; },
    async acquireLease() {},
    async stepsForRun() { return []; },
    async isCancelRequested() { return opts.cancelRequested ?? false; },
    async requestCancel(_runId: string, requestedBy: string) {
      if ('requestCancelResult' in opts) return opts.requestCancelResult;
      // Model the real store: the flag columns are written on the run row.
      (opts.run as { cancelRequestedBy?: string; cancelRequestedAt?: Date }).cancelRequestedBy = requestedBy;
      (opts.run as { cancelRequestedBy?: string; cancelRequestedAt?: Date }).cancelRequestedAt = new Date();
      return opts.run;
    },
    async recordStepAndAdvance(input: RecordedStep & { runId: string }) {
      recorded.push({ stepId: input.stepId, actor: input.actor, status: input.status, context: input.context });
    },
  };
  const workflowStore = {
    async getVersion() { return { id: 'v1', workflowId: 'w1', version: 1, graph: opts.graph }; },
  };
  const executor = new ConductorRunExecutor({
    workflowStore: workflowStore as never,
    runStore: runStore as never,
    awaitStore: awaitStore as never,
    effects: {
      async runAgentStep() { throw new Error('effects must not run in these tests'); },
      async runActionStep() { throw new Error('effects must not run in these tests'); },
    } as never,
    resolveRoleHolders: async () => ({
      holders: opts.holders ?? ['alice'],
      partial: false,
      bySource: [],
    }),
    notifyRunEnded: (run) => { ended.push(String((run as { status: string }).status)); },
  });
  return { executor, recorded, cancelledAwaitRuns, ended };
}

const WAITING_RUN = {
  id: 'run1', workflowVersionId: 'v1', status: 'waiting', currentStepId: 'h1', context: {},
  triggerKind: 'manual', triggerSource: null, isDryRun: false, startedAt: new Date(0), endedAt: null,
  cancelRequestedBy: null, cancelRequestedAt: null,
};

describe('#759 ConductorRunExecutor.cancelRun', () => {
  it("finalizes a 'waiting' run immediately: awaits close as cancelled, synthetic step records the actor", async () => {
    // get() must return the terminal run after the cancel writes — model with a mutable status.
    const run = { ...WAITING_RUN };
    const h = makeHarness({ graph: humanGraph(false), run });
    const origRecord = h.recorded;
    // After recordStepAndAdvance sets 'cancelled', the store's get() should reflect it:
    const p = h.executor.cancelRun('run1', 'marcel');
    await p;
    assert.deepEqual(h.cancelledAwaitRuns, ['run1']);
    assert.equal(origRecord.length, 1);
    assert.equal(origRecord[0]!.status, 'cancelled');
    assert.equal(origRecord[0]!.stepId, 'h1');
    assert.deepEqual(origRecord[0]!.actor, { kind: 'operator_cancel', requestedBy: 'marcel' });
  });

  it("only flags a 'running' run — no await close, no synthetic step; the driver honours it later", async () => {
    const run = { ...WAITING_RUN, status: 'running' };
    const h = makeHarness({ graph: humanGraph(false), run });
    const out = await h.executor.cancelRun('run1', 'marcel');
    assert.equal((out as { status: string }).status, 'running');
    assert.equal(h.cancelledAwaitRuns.length, 0);
    assert.equal(h.recorded.length, 0);
  });

  it('throws RunAlreadyEndedError for a terminal run (409 surface)', async () => {
    const run = { ...WAITING_RUN, status: 'completed' };
    const h = makeHarness({ graph: humanGraph(false), run, requestCancelResult: null });
    await assert.rejects(h.executor.cancelRun('run1', 'marcel'), RunAlreadyEndedError);
  });

  it('throws WorkflowNotFoundError for an unknown run', async () => {
    const h = makeHarness({
      graph: humanGraph(false),
      run: null as unknown as Record<string, unknown>,
      requestCancelResult: null,
    });
    await assert.rejects(h.executor.cancelRun('missing', 'marcel'), WorkflowNotFoundError);
  });

  it('a resumed drive honours a pending cancel at the step boundary — the effect never runs', async () => {
    const run = { ...WAITING_RUN, status: 'running', currentStepId: 'a1' };
    const graph = {
      entryStepId: 'a1',
      steps: [{ id: 'a1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
    } as unknown as WorkflowGraph;
    const h = makeHarness({ graph, run, cancelRequested: true });
    await h.executor.resumeRun('run1', 'lease-1');
    // The cancelled step record was written INSTEAD of running the effect
    // (the fake effects throw if invoked — reaching here proves they didn't).
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0]!.status, 'cancelled');
    assert.deepEqual(h.recorded[0]!.actor, { kind: 'operator_cancel' });
  });
});

describe('#759 strictApproval semantics', () => {
  it("quorum 'any' + strict: a garbage response is normalized to approved:false", async () => {
    const h = makeHarness({ graph: humanGraph(true), run: { ...WAITING_RUN }, holders: ['alice'] });
    await h.executor.resolveAwait('aw1', 'alice', {});
    assert.equal(h.recorded.length, 1);
    const stepResult = (h.recorded[0]!.context as { steps: Record<string, { approved?: boolean }> }).steps.h1;
    assert.equal(stepResult!.approved, false);
  });

  it("quorum 'any' + strict: an explicit approve stays approved:true", async () => {
    const h = makeHarness({ graph: humanGraph(true), run: { ...WAITING_RUN }, holders: ['alice'] });
    await h.executor.resolveAwait('aw1', 'alice', { approved: true });
    const stepResult = (h.recorded[0]!.context as { steps: Record<string, { approved?: boolean }> }).steps.h1;
    assert.equal(stepResult!.approved, true);
  });

  it("quorum 'any' + strict: a non-object response is rejected AND preserved under raw", async () => {
    const h = makeHarness({ graph: humanGraph(true), run: { ...WAITING_RUN }, holders: ['alice'] });
    await h.executor.resolveAwait('aw1', 'alice', 'yes please');
    const stepResult = (
      h.recorded[0]!.context as { steps: Record<string, { approved?: boolean; raw?: unknown }> }
    ).steps.h1;
    // A string is not an explicit {approved:true} → rejection under strict —
    // but the payload the decision was made on must survive in the record.
    assert.equal(stepResult!.approved, false);
    assert.equal(stepResult!.raw, 'yes please');
  });

  it("quorum 'any' WITHOUT strict: legacy fail-open — a garbage response passes through unnormalized", async () => {
    const h = makeHarness({ graph: humanGraph(false), run: { ...WAITING_RUN }, holders: ['alice'] });
    await h.executor.resolveAwait('aw1', 'alice', {});
    const stepResult = (h.recorded[0]!.context as { steps: Record<string, { approved?: boolean }> }).steps.h1;
    // byte-identical legacy behaviour: no approved field is injected
    assert.equal(stepResult!.approved, undefined);
  });

  it("quorum 'all' + strict: garbage responses aggregate to approved:false", async () => {
    const h = makeHarness({
      graph: humanGraph(true),
      run: { ...WAITING_RUN },
      holders: ['alice', 'bob'],
      quorum: 'all',
      responses: [
        { responderId: 'alice', response: {} },
        { responderId: 'bob', response: {} },
      ],
    });
    await h.executor.resolveAwait('aw1', 'bob', {});
    const stepResult = (h.recorded[0]!.context as { steps: Record<string, { approved?: boolean }> }).steps.h1;
    assert.equal(stepResult!.approved, false);
  });

  it("quorum 'all' WITHOUT strict: the same garbage aggregates to approved:true (documented fail-open)", async () => {
    const h = makeHarness({
      graph: humanGraph(false),
      run: { ...WAITING_RUN },
      holders: ['alice', 'bob'],
      quorum: 'all',
      responses: [
        { responderId: 'alice', response: {} },
        { responderId: 'bob', response: {} },
      ],
    });
    await h.executor.resolveAwait('aw1', 'bob', {});
    const stepResult = (h.recorded[0]!.context as { steps: Record<string, { approved?: boolean }> }).steps.h1;
    assert.equal(stepResult!.approved, true);
  });
});

describe('#759 validator warnings', () => {
  const base = (human: Record<string, unknown>, fallbackTransitionId?: string): WorkflowGraph =>
    ({
      entryStepId: 'h1',
      steps: [
        { id: 'h1', kind: 'human', human, ...(fallbackTransitionId ? { fallbackTransitionId } : {}) },
        { id: 'act', kind: 'action', actionId: 'send_mail' },
      ],
      transitions: [
        { id: 't-ok', source: 'h1', target: 'act', guard: { op: 'eq', path: 'stepResult.approved', value: true } },
        { id: 't-fb', source: 'h1', target: 'act' },
      ],
    }) as unknown as WorkflowGraph;

  it('warns timeout_equals_approval when the fallback lands on the approval target', () => {
    const result = validate(
      base({ principal: { kind: 'role', ref: 'approvers' }, channel: 'teams', message: 'ok?', deadline: 'PT6H' }, 't-fb'),
    );
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const codes = (result.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes('timeout_equals_approval'), codes.join(','));
  });

  it('warns approval_fail_open when a non-strict human step gates an action step', () => {
    const result = validate(
      base({ principal: { kind: 'role', ref: 'approvers' }, channel: 'teams', message: 'ok?', deadline: 'PT6H' }, 't-fb'),
    );
    const codes = (result.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes('approval_fail_open'), codes.join(','));
  });

  it('strictApproval silences approval_fail_open (and passes the shape gate)', () => {
    const result = validate(
      base(
        { principal: { kind: 'role', ref: 'approvers' }, channel: 'teams', message: 'ok?', deadline: 'PT6H', strictApproval: true },
        't-fb',
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const codes = (result.warnings ?? []).map((w) => w.code);
    assert.ok(!codes.includes('approval_fail_open'), codes.join(','));
  });

  it('a clean graph carries no warnings key at all', () => {
    const graph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
    } as unknown as WorkflowGraph;
    const result = validate(graph);
    assert.equal(result.ok, true);
    assert.equal(result.warnings, undefined);
  });
});

// ── route harness ───────────────────────────────────────────────────────────

describe('#759 routes: cancel endpoint + role-holder audit', () => {
  const servers: Server[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  async function serve(overrides: {
    cancelRun?: (runId: string, requestedBy: string) => Promise<unknown>;
    auditRoleChange?: (entry: unknown) => Promise<void>;
  }): Promise<{ baseUrl: string; holderCalls: string[] }> {
    const holderCalls: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { session?: unknown }).session = { sub: 'op-1' } as never;
      next();
    });
    const deps = {
      workflowStore: {} as never,
      runStore: {} as never,
      awaitStore: {} as never,
      roleStore: {
        async addHolder(key: string, holder: string) { holderCalls.push(`add:${key}:${holder}`); },
        async removeHolder() {},
        async resolve() { return ['op-1']; },
        async listRoles() { return []; },
      } as never,
      scheduleStore: {} as never,
      executor: {
        cancelRun: overrides.cancelRun ?? (async () => ({ id: 'run1', status: 'cancelled' })),
      } as never,
      eventRouter: {} as never,
      ...(overrides.auditRoleChange ? { auditRoleChange: overrides.auditRoleChange } : {}),
    };
    app.use('/api/v1/operator/conductors', createConductorRouter(deps as never));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`, holderCalls };
  }

  it('POST /:slug/runs/:runId/cancel returns the run and threads the session actor', async () => {
    const calls: Array<[string, string]> = [];
    const { baseUrl } = await serve({
      cancelRun: async (runId, requestedBy) => {
        calls.push([runId, requestedBy]);
        return { id: runId, status: 'cancelled' };
      },
    });
    const res = await fetch(`${baseUrl}/wf/runs/run1/cancel`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['run1', 'op-1']]);
  });

  it('maps RunAlreadyEndedError to 409 and WorkflowNotFoundError to 404', async () => {
    const { baseUrl } = await serve({
      cancelRun: async (runId) => {
        if (runId === 'ended') throw new RunAlreadyEndedError('already completed');
        throw new WorkflowNotFoundError('nope');
      },
    });
    const ended = await fetch(`${baseUrl}/wf/runs/ended/cancel`, { method: 'POST' });
    assert.equal(ended.status, 409);
    assert.equal(((await ended.json()) as { code: string }).code, 'conductor.run_already_ended');
    const missing = await fetch(`${baseUrl}/wf/runs/missing/cancel`, { method: 'POST' });
    assert.equal(missing.status, 404);
  });

  it('a role-holder change lands in the audit sink with actor + resulting holders', async () => {
    const audited: unknown[] = [];
    const { baseUrl, holderCalls } = await serve({
      auditRoleChange: async (entry) => { audited.push(entry); },
    });
    const res = await fetch(`${baseUrl}/roles/approvers/holders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holderId: 'op-1' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(holderCalls, ['add:approvers:op-1']);
    assert.equal(audited.length, 1);
    assert.deepEqual(audited[0], {
      actor: 'op-1',
      roleKey: 'approvers',
      action: 'add',
      holderId: 'op-1',
      holdersAfter: ['op-1'],
    });
  });

  it('an audit-sink failure never fails the mutation (loud, not blocking)', async () => {
    const { baseUrl } = await serve({
      auditRoleChange: async () => { throw new Error('audit db down'); },
    });
    const res = await fetch(`${baseUrl}/roles/approvers/holders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holderId: 'op-1' }),
    });
    assert.equal(res.status, 200);
  });
});
