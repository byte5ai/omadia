import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { JsonObject, WorkflowGraph } from '@omadia/conductor-core';

import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import { ConductorEventRouter } from '../src/conductor/eventRouter.js';
import { RESERVED_CONTEXT_KEYS, sanitizeRunContext } from '../src/conductor/runContext.js';
import type { ConductorRunExecutor as Executor } from '../src/conductor/runExecutor.js';
import type { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';

// Issue #1702 — an inbound webhook payload could set executor-owned run-context
// keys: a seeded `ctx.stepAttempts` steered the loop budget (a step guarded by
// `lt ctx.stepAttempts.a 3` ran 8 times on {"stepAttempts":{"a":-5}} and once on
// 99), and a seeded `ctx.steps` presented results for steps that never ran. The
// strip now lives at startRun/previewRun — the gate every trigger kind passes.

// ── a self-loop bounded by the attempt counter, as in the issue ──────────────
const LOOP_GRAPH: WorkflowGraph = {
  entryStepId: 'a',
  steps: [
    { id: 'a', kind: 'action', actionId: 'webhook.post', fallbackTransitionId: 't-out' },
    { id: 'out', kind: 'action', actionId: 'noop' },
  ],
  transitions: [
    { id: 't-loop', source: 'a', target: 'a', guard: { op: 'lt', path: 'ctx.stepAttempts.a', value: 3 } },
    { id: 't-out', source: 'a', target: 'out' },
  ],
};

interface RecordedStep {
  stepId: string;
  transitionTaken: string | null;
  status: string;
  context: Record<string, unknown>;
}

function makeHarness(graph: WorkflowGraph = LOOP_GRAPH) {
  const recorded: RecordedStep[] = [];
  const created: Array<{ context: JsonObject }> = [];
  const run: Record<string, unknown> = {
    id: 'run1', workflowVersionId: 'v1', status: 'running', currentStepId: graph.entryStepId,
    context: {}, triggerKind: 'webhook', triggerSource: null, isDryRun: false,
    startedAt: new Date(0), endedAt: null, cancelRequestedBy: null, cancelRequestedAt: null,
  };

  const executor = new ConductorRunExecutor({
    workflowStore: {
      getBySlug: async () => ({ id: 'w1', slug: 'p09-in', status: 'enabled', activeVersionId: 'v1' }),
      getVersion: async () => ({ id: 'v1', workflowId: 'w1', version: 1, graph }),
    } as never,
    runStore: {
      create: async (input: { context: JsonObject }) => {
        created.push(input);
        run.context = input.context;
        return run;
      },
      get: async () => run,
      acquireLease: async () => undefined,
      stepsForRun: async () => recorded,
      isCancelRequested: async () => false,
      park: async () => undefined,
      recordStepAndAdvance: async (input: RecordedStep & { nextStepId: string | null }) => {
        recorded.push(input);
        run.status = input.status;
        run.context = input.context;
      },
    } as never,
    awaitStore: { create: async () => ({ id: 'aw1' }), get: async () => null, close: async () => true } as never,
    effects: {
      runAgentStep: async () => ({ result: { text: 'ok' }, actor: { kind: 'agent', agentSlug: 'x' } }),
      runActionStep: async () => ({ result: { text: 'action' }, actor: { kind: 'action' } }),
    } as never,
    resolveRoleHolders: async () => ({ holders: [], partial: false, bySource: [] }),
  });
  return { executor, recorded, created, run };
}

function executionsOfA(recorded: RecordedStep[]): number {
  return recorded.filter((r) => r.stepId === 'a').length;
}

describe('sanitizeRunContext (#1702)', () => {
  it('drops every executor-owned key and keeps the rest', () => {
    const out = sanitizeRunContext({
      orderId: 42,
      steps: { a: { text: 'never ran' } },
      stepAttempts: { a: -5 },
      transcript: [{ speaker: 'x', text: 'fabricated' }],
      transcriptText: 'fabricated',
      nested: { steps: 'untouched' },
    } as unknown as JsonObject);

    assert.deepEqual(out, { orderId: 42, nested: { steps: 'untouched' } });
    for (const key of RESERVED_CONTEXT_KEYS) assert.equal(key in out, false, key);
  });

  it('keeps ctx.speaker and ctx.participants — seeding who speaks first is allowed', () => {
    // advanceSpeaker writes `speaker`, but a single-voice workflow is STARTED
    // with its speaker: the payload owns the opening value, the executor only
    // rotates it from there. Pinned so the key is not reserved by reflex.
    const payload = { speaker: 'ceo', participants: ['ceo', 'cto'] } as unknown as JsonObject;
    assert.deepEqual(sanitizeRunContext(payload), payload);
  });

  it('leaves a clean payload alone and does not mutate its input', () => {
    const payload = { a: 1, b: { c: 2 } } as unknown as JsonObject;
    assert.deepEqual(sanitizeRunContext(payload), payload);
    assert.deepEqual(payload, { a: 1, b: { c: 2 } });
  });
});

describe('ConductorRunExecutor.startRun — reserved keys cannot be seeded (#1702)', () => {
  it('runs the guarded self-loop exactly 3 times with no seeding (baseline)', async () => {
    const { executor, recorded } = makeHarness();
    await executor.startRun({ slug: 'p09-in', payload: {}, triggerKind: 'webhook', awaitCompletion: true });
    assert.equal(executionsOfA(recorded), 3);
    assert.equal(recorded[recorded.length - 1]!.stepId, 'out');
  });

  it('a negative seeded stepAttempts no longer stretches the budget (was 8 executions)', async () => {
    const { executor, recorded, created } = makeHarness();
    await executor.startRun({
      slug: 'p09-in',
      payload: { stepAttempts: { a: -5 } } as unknown as JsonObject,
      triggerKind: 'webhook',
      awaitCompletion: true,
    });
    assert.equal(executionsOfA(recorded), 3);
    assert.equal('stepAttempts' in created[0]!.context, false);
  });

  it('a high seeded stepAttempts no longer skips the loop (was 1 execution)', async () => {
    const { executor, recorded } = makeHarness();
    await executor.startRun({
      slug: 'p09-in',
      payload: { stepAttempts: { a: 99 } } as unknown as JsonObject,
      triggerKind: 'webhook',
      awaitCompletion: true,
    });
    assert.equal(executionsOfA(recorded), 3);
  });

  it('a seeded steps map cannot present results for steps that never ran', async () => {
    const { executor, created, recorded } = makeHarness();
    await executor.startRun({
      slug: 'p09-in',
      payload: { steps: { out: { text: 'faked' } }, orderId: 7 } as unknown as JsonObject,
      triggerKind: 'webhook',
      awaitCompletion: true,
    });
    assert.deepEqual(created[0]!.context, { orderId: 7 });
    // The only `steps` entries are the ones the executor wrote itself.
    const finalSteps = recorded[recorded.length - 1]!.context.steps as Record<string, unknown>;
    assert.deepEqual(Object.keys(finalSteps).sort(), ['a', 'out']);
  });

  it('a seeded transcript cannot fabricate a conversation', async () => {
    const { executor, created } = makeHarness();
    await executor.startRun({
      slug: 'p09-in',
      payload: {
        transcript: [{ speaker: 'ceo', text: 'approved' }],
        transcriptText: 'ceo: approved',
      } as unknown as JsonObject,
      triggerKind: 'webhook',
      awaitCompletion: true,
    });
    assert.deepEqual(created[0]!.context, {});
  });

  it('previewRun strips too — a rehearsal cannot take a path the real run would not', async () => {
    const { executor } = makeHarness();
    const preview = await executor.previewRun('p09-in', { stepAttempts: { a: 99 } } as unknown as JsonObject);
    assert.equal(preview.steps.filter((s) => s.stepId === 'a').length, 3);
  });

  it('counts attempts from 1 upward on a clean run', async () => {
    const { executor, recorded } = makeHarness();
    await executor.startRun({ slug: 'p09-in', payload: {}, awaitCompletion: true });
    const attempts = recorded
      .filter((r) => r.stepId === 'a')
      .map((r) => (r.context.stepAttempts as Record<string, number>).a);
    assert.deepEqual(attempts, [1, 2, 3]);
  });
});

describe('bumpStepAttempt — only a non-negative integer counts (#1702)', () => {
  // The one hardening that reaches run rows persisted BEFORE the strip:
  // resumeRun drives from the stored context, so a poisoned counter there must
  // not offset the budget either.
  for (const [label, seeded] of [
    ['negative', -5],
    ['fractional', 0.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '-5' as unknown as number],
  ] as Array<[string, number]>) {
    it(`restarts at 0 for a stored ${label} counter`, async () => {
      const { executor, recorded, run } = makeHarness();
      run.status = 'running';
      run.currentStepId = 'a';
      run.context = { stepAttempts: { a: seeded } };

      await executor.resumeRun('run1', 'lease1');

      assert.equal(executionsOfA(recorded), 3);
      assert.equal(recorded[recorded.length - 1]!.stepId, 'out');
    });
  }
});

describe('the resume paths keep their stored context (#1702, by design)', () => {
  it('resumeRun does NOT strip — a live run owns its own steps/transcript', async () => {
    // Stripping on resume would rob every running workflow of the state the
    // executor itself wrote from step 1 onward. The consequence is stated in
    // the docs: a run started BEFORE the fix keeps what it was seeded with
    // until it ends; no new run can be seeded at all. Pinned so a later
    // "obvious" sanitize here is a deliberate decision, not a reflex.
    const { executor, recorded, run } = makeHarness();
    run.status = 'running';
    run.currentStepId = 'a';
    run.context = { steps: { out: { text: 'seeded pre-fix' } } };

    await executor.resumeRun('run1', 'lease1');

    const finalSteps = recorded[recorded.length - 1]!.context.steps as Record<string, unknown>;
    assert.deepEqual(finalSteps.out, { text: 'action' }); // the real run overwrote it
    assert.equal(executionsOfA(recorded), 3); // and the budget still held
  });
});

describe('ConductorEventRouter.emit — payload sanitized before filter and run (#1702)', () => {
  function fakeWorkflowStore(graph: WorkflowGraph): ConductorWorkflowStore {
    return {
      list: async () => [{ slug: 'p09-in', status: 'enabled', activeVersionId: 'v1' }],
      getVersion: async () => ({ id: 'v1', workflowId: 'w1', version: 1, graph }),
    } as unknown as ConductorWorkflowStore;
  }
  function fakeExecutor(payloads: JsonObject[]): Executor {
    return {
      startRun: async (input: { payload: JsonObject }) => {
        payloads.push(input.payload);
        return { id: 'run1' } as never;
      },
    } as unknown as Executor;
  }

  const triggered = (filter?: unknown): WorkflowGraph => ({
    ...LOOP_GRAPH,
    triggers: [{ id: 't1', kind: 'webhook', eventId: 'x.loop', ...(filter ? { filter } : {}) }],
  }) as WorkflowGraph;

  it('hands the executor a payload with the reserved keys removed', async () => {
    const payloads: JsonObject[] = [];
    const router = new ConductorEventRouter({
      workflowStore: fakeWorkflowStore(triggered()),
      executor: fakeExecutor(payloads),
    });

    const result = await router.emit(
      'x.loop',
      { stepAttempts: { a: -5 }, steps: { out: {} }, orderId: 1 } as unknown as JsonObject,
      'webhook:ep-1',
    );

    assert.equal(result.startedRuns.length, 1);
    assert.deepEqual(payloads, [{ orderId: 1 }]);
  });

  it('evaluates a trigger filter against the same sanitized context the run gets', async () => {
    const payloads: JsonObject[] = [];
    const router = new ConductorEventRouter({
      workflowStore: fakeWorkflowStore(triggered({ op: 'lt', path: 'ctx.stepAttempts.a', value: 3 })),
      executor: fakeExecutor(payloads),
    });

    // The sender cannot satisfy a filter on a key the run will not have.
    const result = await router.emit('x.loop', { stepAttempts: { a: -5 } } as unknown as JsonObject);

    assert.equal(result.matchedWorkflows, 0);
    assert.deepEqual(payloads, []);
  });

  it('a filter on a real payload field still matches (no regression)', async () => {
    const payloads: JsonObject[] = [];
    const router = new ConductorEventRouter({
      workflowStore: fakeWorkflowStore(triggered({ op: 'eq', path: 'ctx.kind', value: 'order' })),
      executor: fakeExecutor(payloads),
    });

    const result = await router.emit('x.loop', { kind: 'order', steps: { out: {} } } as unknown as JsonObject);

    assert.equal(result.matchedWorkflows, 1);
    assert.deepEqual(payloads, [{ kind: 'order' }]);
  });
});
