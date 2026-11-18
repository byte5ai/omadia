import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { nextStep } from '@omadia/conductor-core';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import { RealStepEffects } from '../src/conductor/realStepEffects.js';
import { WEBHOOK_POST_ACTION_ID, WEBHOOK_POST_DEFAULT_POSTCONDITION } from '../src/conductor/webhookPostAction.js';

// Issue #1703 — a `webhook.post` step whose receiver answered 4xx/5xx used to advance
// the graph exactly like a delivered one: the run completed, the history showed no
// error, and the refusal was visible only to someone who read the run context.
//
// The action reports the refusal (`{ ok: false, status }`) and the ENGINE turns it
// into a failed step, via the default postcondition the effects layer attaches. That
// split is the point: a throw is caught by the executor before `nextStep` runs, so a
// graph could never take its error path. These tests pin both halves plus the join —
// the action-level half lives in conductorWebhookPostAction.test.ts.

// ── engine: a default postcondition fills an absence, never overrides ─────────

describe('nextStep — defaultPostcondition (#1703)', () => {
  const graph: WorkflowGraph = {
    entryStepId: 'ping',
    steps: [
      { id: 'ping', kind: 'action', actionId: WEBHOOK_POST_ACTION_ID, fallbackTransitionId: 't-failed' },
      { id: 'notify', kind: 'agent', agentId: 'a', prompt: 'p' },
      { id: 'recover', kind: 'agent', agentId: 'a', prompt: 'p' },
    ],
    transitions: [
      { id: 't-ok', source: 'ping', target: 'notify' },
      { id: 't-failed', source: 'ping', target: 'recover' },
    ],
  };
  const opts = { defaultPostcondition: WEBHOOK_POST_DEFAULT_POSTCONDITION };
  const delivered = { text: '', data: { ok: true, status: 204 } };
  const refused = { text: '', data: { ok: false, status: 500 } };

  it('a refused delivery is unmet → the graph takes its error path', () => {
    const d = nextStep(graph, 'ping', refused, {}, opts);
    assert.equal(d.postcondition, 'unmet');
    assert.equal(d.kind, 'advance');
    assert.equal(d.kind === 'advance' ? d.transitionId : null, 't-failed');
    assert.equal(d.kind === 'advance' ? d.targetStepId : null, 'recover');
  });

  it('a delivered one is met → the happy path, unchanged', () => {
    const d = nextStep(graph, 'ping', delivered, {}, opts);
    assert.equal(d.postcondition, 'met');
    assert.equal(d.kind === 'advance' ? d.transitionId : null, 't-ok');
  });

  it('without a fallback a refusal is surfaced as stuck, not quietly completed', () => {
    const noFallback: WorkflowGraph = {
      entryStepId: 'ping',
      steps: [{ id: 'ping', kind: 'action', actionId: WEBHOOK_POST_ACTION_ID }],
      transitions: [],
    };
    const d = nextStep(noFallback, 'ping', refused, {}, opts);
    assert.equal(d.kind, 'stuck');
    assert.equal(d.kind === 'stuck' ? d.code : null, 'postcondition_unmet_no_fallback');
    assert.equal(d.postcondition, 'unmet');
    // The same step without the default is the old behaviour: n/a → complete.
    assert.equal(nextStep(noFallback, 'ping', refused, {}).kind, 'complete');
  });

  it("the step's own postcondition wins — an author may tolerate a 404", () => {
    const tolerant: WorkflowGraph = {
      ...graph,
      steps: [
        {
          ...graph.steps[0]!,
          postcondition: { op: 'ne', path: 'stepResult.data.status', value: 500 },
        },
        ...graph.steps.slice(1),
      ],
    };
    const ok404 = nextStep(tolerant, 'ping', { text: '', data: { ok: false, status: 404 } }, {}, opts);
    assert.equal(ok404.postcondition, 'met');
    assert.equal(ok404.kind === 'advance' ? ok404.transitionId : null, 't-ok');
  });
});

// ── effects: which steps get the default ─────────────────────────────────────

describe('RealStepEffects.runActionStep — default postcondition (#1703)', () => {
  const effects = (out: string) =>
    new RealStepEffects({ getRegistry: () => undefined, invokeAction: async () => out });

  const step = { id: 'ping', kind: 'action' as const, actionId: WEBHOOK_POST_ACTION_ID };
  const meta = { runId: 'run1' };

  it('attaches it to a webhook.post step that declares none', async () => {
    const exec = await effects('{"ok":false,"status":500}').runActionStep(step, {}, meta);
    assert.deepEqual(exec.defaultPostcondition, WEBHOOK_POST_DEFAULT_POSTCONDITION);
    assert.deepEqual(exec.result, { text: '{"ok":false,"status":500}', data: { ok: false, status: 500 } });
  });

  it('leaves a step that declares its own alone', async () => {
    const own = { ...step, postcondition: { op: 'eq' as const, path: 'stepResult.data.status', value: 429 } };
    const exec = await effects('{"ok":false,"status":500}').runActionStep(own, {}, meta);
    assert.equal(exec.defaultPostcondition, undefined);
  });

  it('leaves other actions alone — an `{ok:false}` from a plugin tool keeps its meaning', async () => {
    const other = { ...step, actionId: 'mcp:srv-1:attach_receipt' };
    const exec = await effects('{"ok":false}').runActionStep(other, {}, meta);
    assert.equal(exec.defaultPostcondition, undefined);
  });
});

// ── run: the reported bug, end to end ────────────────────────────────────────

interface RecordedStep {
  stepId: string;
  postconditionOutcome: string | null;
  transitionTaken: string | null;
  status: string;
  context: Record<string, unknown>;
}

/** Stateful fake-store harness in the conductorTimerStep.test.ts mould, wired to a
 *  REAL `RealStepEffects` so the effects→engine join is covered, not stubbed. */
function makeHarness(graph: WorkflowGraph, actionOut: string) {
  const recorded: RecordedStep[] = [];
  const run: Record<string, unknown> = {
    id: 'run1', workflowVersionId: 'v1', status: 'running', currentStepId: graph.entryStepId,
    context: {}, triggerKind: 'manual', triggerSource: null, isDryRun: false,
    startedAt: new Date(0), endedAt: null, cancelRequestedBy: null, cancelRequestedAt: null,
  };

  const executor = new ConductorRunExecutor({
    workflowStore: {
      getBySlug: async () => ({ id: 'w1', slug: 'ping-wf', status: 'enabled', activeVersionId: 'v1' }),
      getVersion: async () => ({ id: 'v1', workflowId: 'w1', version: 1, graph }),
    } as never,
    runStore: {
      create: async () => run,
      get: async () => run,
      acquireLease: async () => undefined,
      stepsForRun: async () => recorded,
      isCancelRequested: async () => false,
      recordStepAndAdvance: async (input: RecordedStep & { nextStepId: string | null }) => {
        recorded.push(input);
        run.status = input.status;
        run.context = input.context;
      },
    } as never,
    awaitStore: { create: async () => ({ id: 'aw1' }), get: async () => null, close: async () => true } as never,
    effects: new RealStepEffects({
      getRegistry: () => undefined,
      invokeAction: async () => actionOut,
    }),
    resolveRoleHolders: async () => ({ holders: [], partial: false, bySource: [] }),
  });
  return { executor, recorded, run };
}

const oneStep: WorkflowGraph = {
  entryStepId: 'ping',
  steps: [{ id: 'ping', kind: 'action', actionId: WEBHOOK_POST_ACTION_ID, input: { url: 'https://example.com/hook' } }],
  transitions: [],
};

describe('ConductorRunExecutor — a refused webhook.post delivery (#1703)', () => {
  it('fails the run instead of completing it (the reported httpbin /status/500 case)', async () => {
    const { executor, recorded, run } = makeHarness(oneStep, '{"ok":false,"status":500}');
    const out = await executor.startRun({ slug: 'ping-wf', payload: {}, awaitCompletion: true });

    assert.equal(out.status, 'failed');
    assert.equal(run.status, 'failed');
    const ping = recorded.find((r) => r.stepId === 'ping');
    // The history now carries the failure, not just the run context.
    assert.equal(ping?.postconditionOutcome, 'unmet');
    assert.equal(ping?.transitionTaken, null);
    // …and the context still says WHY, exactly as the reporter read it out of Postgres.
    assert.deepEqual((run.context as { steps: Record<string, unknown> }).steps.ping, {
      text: '{"ok":false,"status":500}',
      data: { ok: false, status: 500 },
    });
  });

  it('a 2xx delivery still completes', async () => {
    const { executor, recorded, run } = makeHarness(oneStep, '{"ok":true,"status":204}');
    const out = await executor.startRun({ slug: 'ping-wf', payload: {}, awaitCompletion: true });

    assert.equal(out.status, 'completed');
    assert.equal(run.status, 'completed');
    assert.equal(recorded.find((r) => r.stepId === 'ping')?.postconditionOutcome, 'met');
  });

  it('a graph with an error path takes it — the run continues down the fallback', async () => {
    const withFallback: WorkflowGraph = {
      entryStepId: 'ping',
      steps: [
        { id: 'ping', kind: 'action', actionId: WEBHOOK_POST_ACTION_ID, input: { url: 'https://example.com/hook' }, fallbackTransitionId: 't-failed' },
        { id: 'escalate', kind: 'action', actionId: 'other.action' },
      ],
      transitions: [{ id: 't-failed', source: 'ping', target: 'escalate' }],
    };
    const { executor, recorded, run } = makeHarness(withFallback, '{"ok":false,"status":429}');
    await executor.startRun({ slug: 'ping-wf', payload: {}, awaitCompletion: true });

    const ping = recorded.find((r) => r.stepId === 'ping');
    assert.equal(ping?.postconditionOutcome, 'unmet');
    assert.equal(ping?.transitionTaken, 't-failed');
    // The error path ran to the end; the run is not a failure, the graph handled it.
    assert.ok(recorded.some((r) => r.stepId === 'escalate'), 'expected the fallback step to run');
    assert.equal(run.status, 'completed');
  });
});
