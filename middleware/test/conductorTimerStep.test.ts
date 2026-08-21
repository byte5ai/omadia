import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { validate } from '@omadia/conductor-core';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import { extractFencedJson } from '../src/conductor/realStepEffects.js';

// #330 C3 — the timer step: deterministic park-then-fallback that makes
// bounded assess loops possible. Stateful fake-store harness in the
// conductorQuorumAndTimeout.test.ts mould.

describe('validate — timer step rules', () => {
  const base: WorkflowGraph = {
    entryStepId: 'w',
    steps: [
      { id: 'w', kind: 'timer', timer: { duration: 'PT1H' }, fallbackTransitionId: 't-tick' },
      { id: 'a', kind: 'agent', agentId: 'facilitator', prompt: 'p' },
    ],
    transitions: [{ id: 't-tick', source: 'w', target: 'a' }],
  };

  it('accepts a well-formed timer step and a guarded cycle through it', () => {
    assert.deepEqual(validate(base).errors, []);
    const looped: WorkflowGraph = {
      ...base,
      steps: base.steps,
      transitions: [
        ...base.transitions,
        { id: 't-loop', source: 'a', target: 'w', guard: { op: 'lt', path: 'ctx.stepAttempts.a', value: 3 } },
      ],
    };
    const result = validate(looped);
    assert.ok(!result.errors.some((e) => e.code === 'unguarded_cycle'), JSON.stringify(result.errors));
  });

  it('rejects a missing/invalid duration and a timer without the on-expiry edge', () => {
    const noDuration = validate({
      ...base,
      steps: [{ id: 'w', kind: 'timer', fallbackTransitionId: 't-tick' }, base.steps[1]!],
    });
    assert.ok(noDuration.errors.some((e) => e.code === 'timer_step_invalid_duration'));

    const zero = validate({
      ...base,
      steps: [{ id: 'w', kind: 'timer', timer: { duration: 'PT' }, fallbackTransitionId: 't-tick' }, base.steps[1]!],
    });
    assert.ok(zero.errors.some((e) => e.code === 'timer_step_invalid_duration'));

    const noFallback = validate({
      entryStepId: 'w',
      steps: [{ id: 'w', kind: 'timer', timer: { duration: 'PT1H' } }, base.steps[1]!],
      transitions: [{ id: 't-tick', source: 'w', target: 'a' }],
    });
    assert.ok(noFallback.errors.some((e) => e.code === 'timer_requires_fallback'));
  });
});

// ── stateful fake harness ────────────────────────────────────────────────────

interface RecordedStep {
  stepId: string;
  actor: unknown;
  transitionTaken: string | null;
  status: string;
  context: Record<string, unknown>;
}

function makeHarness(graph: WorkflowGraph, opts?: { agentText?: (stepId: string, callIndex: number) => string }) {
  const recorded: RecordedStep[] = [];
  const awaitsCreated: Array<Record<string, unknown>> = [];
  let agentCalls = 0;
  const run: Record<string, unknown> = {
    id: 'run1', workflowVersionId: 'v1', status: 'running', currentStepId: graph.entryStepId,
    context: {}, triggerKind: 'agent', triggerSource: null, isDryRun: false,
    startedAt: new Date(0), endedAt: null, cancelRequestedBy: null, cancelRequestedAt: null,
  };
  const awaitRows: Array<Record<string, unknown>> = [];

  const executor = new ConductorRunExecutor({
    workflowStore: {
      getBySlug: async () => ({ id: 'w1', slug: 'eph-x', status: 'enabled', activeVersionId: 'v1' }),
      getVersion: async () => ({ id: 'v1', workflowId: 'w1', version: 1, graph }),
    } as never,
    runStore: {
      create: async () => run,
      get: async () => run,
      acquireLease: async () => undefined,
      stepsForRun: async () => recorded,
      isCancelRequested: async () => false,
      park: async (_runId: string, stepId: string, context: Record<string, unknown>) => {
        run.status = 'waiting';
        run.currentStepId = stepId;
        run.context = context;
      },
      recordStepAndAdvance: async (input: RecordedStep & { nextStepId: string | null; status: string }) => {
        recorded.push(input);
        run.status = input.status;
        run.context = input.context;
      },
    } as never,
    awaitStore: {
      create: async (input: Record<string, unknown>) => {
        const row = { id: `aw${String(awaitsCreated.length + 1)}`, status: 'waiting', createdAt: new Date(0), ...input };
        awaitsCreated.push(input);
        awaitRows.push(row);
        return row;
      },
      get: async (id: string) => awaitRows.find((a) => a.id === id) ?? null,
      close: async () => true,
    } as never,
    effects: {
      runAgentStep: async (step: { id: string }) => {
        agentCalls += 1;
        const text = opts?.agentText?.(step.id, agentCalls) ?? 'ok';
        const data = extractFencedJson(text);
        return { result: { text, ...(data !== undefined ? { data } : {}) }, actor: { kind: 'agent', agentSlug: 'x' } };
      },
      runActionStep: async () => ({ result: { text: 'action' }, actor: { kind: 'action' } }),
    } as never,
    resolveRoleHolders: async () => ({ holders: [], partial: false, bySource: [] }),
  });
  return { executor, recorded, awaitsCreated, awaitRows, run, agentCallCount: () => agentCalls };
}

describe('ConductorRunExecutor — timer park + tick loop', () => {
  const graph: WorkflowGraph = {
    entryStepId: 'moderate',
    steps: [
      { id: 'moderate', kind: 'agent', agentId: 'facilitator', prompt: 'assess', fallbackTransitionId: 't-exhausted' },
      { id: 'wait', kind: 'timer', timer: { duration: 'PT1S' }, fallbackTransitionId: 't-tick' },
      { id: 'done', kind: 'agent', agentId: 'facilitator', prompt: 'report' },
      { id: 'aborted', kind: 'agent', agentId: 'facilitator', prompt: 'abort' },
    ],
    transitions: [
      { id: 't-met', source: 'moderate', target: 'done', guard: { op: 'eq', path: 'stepResult.data.dodMet', value: true } },
      {
        id: 't-wait',
        source: 'moderate',
        target: 'wait',
        guard: {
          op: 'and',
          args: [
            { op: 'ne', path: 'stepResult.data.dodMet', value: true },
            { op: 'lt', path: 'ctx.stepAttempts.moderate', value: 3 },
          ],
        },
      },
      { id: 't-exhausted', source: 'moderate', target: 'aborted' },
      { id: 't-tick', source: 'wait', target: 'moderate' },
    ],
  };

  it('parks on the timer with a timer-kind await and the on-expiry fallback', async () => {
    const { executor, awaitsCreated, run } = makeHarness(graph, {
      agentText: () => 'thinking\n```json\n{"dodMet": false}\n```',
    });
    const out = await executor.startRun({ slug: 'eph-x', payload: {}, awaitCompletion: true });

    assert.equal(out.status, 'waiting');
    assert.equal(run.currentStepId, 'wait');
    assert.equal(awaitsCreated.length, 1);
    const aw = awaitsCreated[0]!;
    assert.equal(aw.principalKind, 'timer');
    assert.equal(aw.channelType, 'timer');
    assert.equal(aw.reminderIntervalMs, null);
    assert.equal(aw.fallbackTransitionId, 't-tick');
    assert.ok(aw.deadlineAt instanceof Date);
  });

  it('expireAwait follows the tick edge with an honest timer actor and re-runs the assess step', async () => {
    const texts = ['```json\n{"dodMet": false}\n```', '```json\n{"dodMet": true, "summary": "done"}\n```', 'final report'];
    const { executor, recorded, awaitRows, run, agentCallCount } = makeHarness(graph, {
      agentText: (_stepId, call) => texts[call - 1] ?? 'ok',
    });
    await executor.startRun({ slug: 'eph-x', payload: {}, awaitCompletion: true });
    assert.equal(run.status, 'waiting');

    await executor.expireAwait(awaitRows[0]!.id as string);

    // tick actor recorded honestly, moderate re-ran, verdict routed to 'done'.
    const tick = recorded.find((r) => r.stepId === 'wait');
    assert.deepEqual(tick?.actor, { kind: 'timer', ticked: true });
    assert.equal(tick?.transitionTaken, 't-tick');
    assert.equal(run.status, 'completed');
    assert.equal(agentCallCount(), 3); // moderate ×2 + done ×1
    const last = recorded[recorded.length - 1]!;
    assert.equal(last.stepId, 'done');
  });

  it('ctx.stepAttempts bounds the loop deterministically — exhausted rounds take the fallback', async () => {
    // dodMet never true → guard 'lt stepAttempts.moderate 3' admits rounds 1+2;
    // round 3 matches neither guard → moderate's fallback → aborted.
    const { executor, recorded, awaitRows, run } = makeHarness(graph, {
      agentText: () => '```json\n{"dodMet": false}\n```',
    });
    await executor.startRun({ slug: 'eph-x', payload: {}, awaitCompletion: true });
    await executor.expireAwait(awaitRows[0]!.id as string); // round 2 → waits again
    assert.equal(run.status, 'waiting');
    await executor.expireAwait(awaitRows[1]!.id as string); // round 3 → exhausted

    assert.equal(run.status, 'completed');
    const moderateSteps = recorded.filter((r) => r.stepId === 'moderate');
    assert.equal(moderateSteps.length, 3);
    assert.equal(moderateSteps[2]!.transitionTaken, 't-exhausted');
    assert.equal((moderateSteps[2]!.context.stepAttempts as Record<string, number>).moderate, 3);
    assert.equal(recorded[recorded.length - 1]!.stepId, 'aborted');
  });

  it('previewRun simulates a timer instantly along the on-expiry edge', async () => {
    const { executor } = makeHarness(graph, {
      agentText: (_s, call) => (call === 1 ? '```json\n{"dodMet": false}\n```' : '```json\n{"dodMet": true}\n```'),
    });
    const preview = await executor.previewRun('eph-x', {});
    const timerStep = preview.steps.find((s) => s.kind === 'timer');
    assert.equal(timerStep?.actor, 'timer (simulated instant)');
    assert.equal(timerStep?.transition, 't-tick');
    assert.equal(preview.status, 'completed');
  });
});

describe('extractFencedJson', () => {
  it('takes the LAST fenced json block, tolerates prose around it', () => {
    const text = 'thoughts\n```json\n{"a": 1}\n```\nmore\n```json\n{"dodMet": true}\n```\n';
    assert.deepEqual(extractFencedJson(text), { dodMet: true });
  });

  it('returns undefined for missing, malformed or oversized blocks', () => {
    assert.equal(extractFencedJson('no json here'), undefined);
    assert.equal(extractFencedJson('```json\n{broken\n```'), undefined);
    assert.equal(extractFencedJson('```json\n' + '"'.repeat(20000) + '\n```'), undefined);
  });
});
