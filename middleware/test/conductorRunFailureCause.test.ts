import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { WorkflowGraph } from '@omadia/conductor-core';

import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import {
  asRunErrorCode,
  redactRunErrorMessage,
  runErrorFromThrow,
  RUN_ERROR_MESSAGE_MAX,
} from '../src/conductor/runError.js';
import type { ConductorRunError } from '../src/conductor/runError.js';

// #1699 — a failed run must say WHY. Before this, seven sites wrote
// `status: 'failed'` and the cause reached the container log only. These tests
// pin the cause recorded at each one, and the redaction/truncation of the text
// that is persisted. The store-level read-back (the columns themselves) lives in
// conductorRunError.pg.test.ts — this file is the executor's classification.

// ── helpers ──────────────────────────────────────────────────────────────────

describe('runError helpers', () => {
  it('validates a stored code against the closed vocabulary', () => {
    assert.equal(asRunErrorCode('effect_threw'), 'effect_threw');
    // The engine's own StuckCode values are part of the vocabulary unchanged.
    assert.equal(asRunErrorCode('ambiguous_guards'), 'ambiguous_guards');
    // A code this build cannot interpret must read like a pre-0013 row.
    assert.equal(asRunErrorCode('invented_by_a_newer_build'), null);
    assert.equal(asRunErrorCode(null), null);
    assert.equal(asRunErrorCode(42), null);
    // Not a code just because Object.prototype has the property.
    assert.equal(asRunErrorCode('toString'), null);
  });

  it('strips credentials and provider correlation handles from the message', () => {
    const raw =
      'llm completion failed: 401 {"type":"error","error":{"message":"invalid x-api-key"},' +
      '"request_id":"req_011CdcPnpMTB8iyAmMBnbem8"} authorization: Bearer sk-abcdef0123456789';
    const out = redactRunErrorMessage(raw);
    assert.ok(!out.includes('req_011CdcPnpMTB8iyAmMBnbem8'), out);
    assert.ok(!out.includes('sk-abcdef0123456789'), out);
    // The cause itself survives — redaction must not shred the sentence.
    assert.ok(out.includes('llm completion failed: 401'), out);
  });

  it('flattens whitespace and truncates to the persisted cap', () => {
    assert.equal(redactRunErrorMessage('two\n\n  lines'), 'two lines');
    const long = redactRunErrorMessage('x'.repeat(RUN_ERROR_MESSAGE_MAX + 500));
    assert.equal(long.length, RUN_ERROR_MESSAGE_MAX);
    assert.ok(long.endsWith('…'));
  });

  it('tells a blown step budget apart from any other throw', () => {
    const timeout = new Error('agent step exceeded the 900000ms step timeout');
    timeout.name = 'StepTimeoutError';
    assert.equal(runErrorFromThrow(timeout).code, 'step_timeout');
    assert.equal(runErrorFromThrow(new Error('boom')).code, 'effect_threw');
    assert.equal(runErrorFromThrow('not an error at all').code, 'effect_threw');
    // The name is carried into the message so the class is never lost.
    assert.match(String(runErrorFromThrow(new Error('boom')).message), /^Error: boom$/);
  });
});

// ── stateful fake harness (conductorTimerStep.test.ts mould) ─────────────────

interface RecordedStep {
  stepId: string;
  actor: unknown;
  transitionTaken: string | null;
  status: string;
  startedAt?: Date | null;
  error?: ConductorRunError | null;
}

interface HarnessOpts {
  holders?: { holders: string[]; partial: boolean };
  agent?: () => never;
  currentStepId?: string | null;
  awaitCreatedAt?: Date;
}

function makeHarness(graph: WorkflowGraph, opts?: HarnessOpts) {
  const recorded: RecordedStep[] = [];
  const awaitRows: Array<Record<string, unknown>> = [];
  const run: Record<string, unknown> = {
    id: 'run1', workflowVersionId: 'v1', status: 'running',
    currentStepId: opts?.currentStepId === undefined ? graph.entryStepId : opts.currentStepId,
    context: {}, triggerKind: 'manual', triggerSource: null, isDryRun: false,
    startedAt: new Date(0), endedAt: null, cancelRequestedBy: null, cancelRequestedAt: null,
    errorCode: null, errorMessage: null,
  };

  const executor = new ConductorRunExecutor({
    workflowStore: {
      getBySlug: async () => ({ id: 'w1', slug: 'wf', status: 'enabled', activeVersionId: 'v1' }),
      getVersion: async () => ({ id: 'v1', workflowId: 'w1', version: 1, graph }),
      getById: async () => ({ id: 'w1', slug: 'wf' }),
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
      recordStepAndAdvance: async (input: RecordedStep & { status: string }) => {
        recorded.push(input);
        run.status = input.status;
        // The real store mirrors the cause onto the run only on a terminal write.
        if (input.status === 'failed' || input.status === 'completed' || input.status === 'cancelled') {
          run.errorCode = input.error?.code ?? null;
          run.errorMessage = input.error?.message ?? null;
        }
      },
    } as never,
    awaitStore: {
      create: async (input: Record<string, unknown>) => {
        const row = {
          id: `aw${String(awaitRows.length + 1)}`,
          status: 'waiting',
          createdAt: opts?.awaitCreatedAt ?? new Date(0),
          ...input,
        };
        awaitRows.push(row);
        return row;
      },
      get: async (id: string) => awaitRows.find((a) => a.id === id) ?? null,
      close: async () => true,
    } as never,
    effects: {
      runAgentStep: async () => {
        if (opts?.agent) opts.agent();
        return { result: { text: 'ok' }, actor: { kind: 'agent', agentSlug: 'x' } };
      },
      runActionStep: async () => ({ result: { text: 'action' }, actor: { kind: 'action' } }),
    } as never,
    resolveRoleHolders: async () => ({
      holders: opts?.holders?.holders ?? [],
      partial: opts?.holders?.partial ?? false,
      bySource: [],
    }),
  });
  return { executor, recorded, awaitRows, run };
}

const agentStepGraph: WorkflowGraph = {
  entryStepId: 'a',
  steps: [{ id: 'a', kind: 'agent', agentId: 'fallback', prompt: 'p' }],
  transitions: [],
};

function lastFailure(recorded: RecordedStep[]): RecordedStep {
  const row = recorded.at(-1);
  assert.ok(row, 'expected a recorded step');
  return row;
}

describe('ConductorRunExecutor — every failed write names its cause (#1699)', () => {
  it('records effect_threw with a redacted message and the step ref', async () => {
    const { executor, recorded, run } = makeHarness(agentStepGraph, {
      agent: () => {
        throw new Error('429 Rate limit exceeded (request_id: req_0123456789abcdef)');
      },
    });
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed');
    assert.equal(row.error?.code, 'effect_threw');
    assert.match(String(row.error?.message), /429 Rate limit exceeded/);
    assert.ok(!String(row.error?.message).includes('req_0123456789abcdef'), String(row.error?.message));
    assert.deepEqual(row.error?.detail, { stepKind: 'agent', ref: 'fallback' });
    // The run-level copy is what the run LIST renders.
    assert.equal(run.errorCode, 'effect_threw');
  });

  it('records step_timeout when the effect blew its budget', async () => {
    const { executor, recorded } = makeHarness(agentStepGraph, {
      agent: () => {
        const err = new Error('agent step exceeded the 900000ms step timeout');
        err.name = 'StepTimeoutError';
        throw err;
      },
    });
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });
    assert.equal(lastFailure(recorded).error?.code, 'step_timeout');
  });

  it('records step_not_in_graph when the run points at a step the graph lacks', async () => {
    const { executor, recorded } = makeHarness(agentStepGraph, { currentStepId: 'ghost' });
    await executor.resumeRun('run1', 'lease1');

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed');
    assert.equal(row.error?.code, 'step_not_in_graph');
    assert.match(String(row.error?.message), /'ghost'/);
  });

  it('records resume_no_current_step for a running run with no next step', async () => {
    const { executor, recorded } = makeHarness(agentStepGraph, { currentStepId: null });
    const before = Date.now();
    await executor.resumeRun('run1', 'lease1');

    const row = lastFailure(recorded);
    assert.equal(row.stepId, '(resume)');
    assert.equal(row.error?.code, 'resume_no_current_step');
    // The synthetic row is a step record like any other — it carries a start.
    assert.ok(row.startedAt instanceof Date);
    assert.ok(row.startedAt.getTime() >= before);
  });

  it('records max_steps_exceeded instead of leaving the run running for ever (US2-AS4)', async () => {
    // A guarded self-loop the engine will happily walk until the budget ends it.
    const graph: WorkflowGraph = {
      entryStepId: 'a',
      steps: [{ id: 'a', kind: 'action', actionId: 'noop' }],
      transitions: [{ id: 't-loop', source: 'a', target: 'a' }],
    };
    const { executor, recorded, run } = makeHarness(graph);
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed', 'the budget exit used to record nothing at all');
    assert.equal(row.error?.code, 'max_steps_exceeded');
    assert.deepEqual(row.error?.detail, { maxSteps: 1000, stepId: 'a' });
    assert.ok(row.startedAt instanceof Date);
    assert.equal(run.status, 'failed');
    assert.equal(run.errorCode, 'max_steps_exceeded');
  });

  it('records timer_misconfigured for a timer step reached without its on-expiry edge', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'w',
      steps: [{ id: 'w', kind: 'timer', timer: { duration: 'PT1H' } }],
      transitions: [],
    };
    const { executor, recorded } = makeHarness(graph);
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed');
    assert.equal(row.error?.code, 'timer_misconfigured');
    assert.match(String(row.error?.message), /no on-expiry fallback transition/);
    assert.deepEqual(row.error?.detail, { duration: 'PT1H', fallbackTransitionId: null });
  });

  it('records timer_misconfigured for an unparsable duration', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'w',
      steps: [{ id: 'w', kind: 'timer', timer: { duration: 'PT' }, fallbackTransitionId: 't' }],
      transitions: [{ id: 't', source: 'w', target: 'w' }],
    };
    const { executor, recorded } = makeHarness(graph);
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });
    assert.match(String(lastFailure(recorded).error?.message), /no parsable duration \('PT'\)/);
  });

  it('records no_role_holder when a human step has nobody to ask', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'h',
      steps: [
        {
          id: 'h',
          kind: 'human',
          human: { principal: { kind: 'role', ref: 'reviewer' }, channel: 'teams', message: 'ok?' },
        },
      ],
      transitions: [],
    };
    const { executor, recorded } = makeHarness(graph, { holders: { holders: [], partial: false } });
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed');
    assert.equal(row.error?.code, 'no_role_holder');
    assert.match(String(row.error?.message), /'reviewer'/);
  });

  it('records no_role_holder on the RECOVERED path too (the run advances via its fallback)', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'h',
      steps: [
        {
          id: 'h',
          kind: 'human',
          human: { principal: { kind: 'role', ref: 'reviewer' }, channel: 'teams', message: 'ok?' },
          fallbackTransitionId: 't-skip',
        },
        { id: 'a', kind: 'agent', agentId: 'fallback', prompt: 'p' },
      ],
      transitions: [{ id: 't-skip', source: 'h', target: 'a' }],
    };
    const { executor, recorded } = makeHarness(graph, { holders: { holders: [], partial: false } });
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const human = recorded.find((r) => r.stepId === 'h');
    assert.equal(human?.status, 'running', 'the fallback keeps the run alive');
    assert.equal(human?.error?.code, 'no_role_holder');
    assert.equal(
      (human?.error?.detail as { fallbackTransitionId?: string } | undefined)?.fallbackTransitionId,
      't-skip',
    );
    // …and the run itself is not stamped with a cause it recovered from.
    assert.equal(recorded.at(-1)?.status, 'completed');
    assert.equal(recorded.at(-1)?.error ?? null, null);
  });

  it("carries the engine's own stuck code and nodes instead of dropping them", async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'a',
      steps: [{ id: 'a', kind: 'agent', agentId: 'fallback', prompt: 'p' }, { id: 'b', kind: 'agent', agentId: 'x', prompt: 'p' }],
      // The only outgoing transition is guarded false and there is no fallback.
      transitions: [{ id: 't', source: 'a', target: 'b', guard: { op: 'eq', path: 'ctx.nope', value: true } }],
    };
    const { executor, recorded } = makeHarness(graph);
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed');
    assert.equal(row.error?.code, 'no_transition_no_fallback');
    assert.deepEqual((row.error?.detail as { nodeIds: string[] }).nodeIds, ['a', 't']);
  });

  it('records await_timed_out for a human deadline, and the await start as the step start', async () => {
    const createdAt = new Date('2026-01-01T10:00:00.000Z');
    const graph: WorkflowGraph = {
      entryStepId: 'h',
      steps: [
        {
          id: 'h',
          kind: 'human',
          human: {
            principal: { kind: 'user', ref: 'sophie@example.com' },
            channel: 'teams',
            message: 'ok?',
            deadline: 'PT1H',
          },
        },
      ],
      transitions: [],
    };
    const { executor, recorded, awaitRows } = makeHarness(graph, { awaitCreatedAt: createdAt });
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });
    assert.equal(awaitRows.length, 1, 'the human step parked');

    await executor.expireAwait('aw1');

    const row = lastFailure(recorded);
    assert.equal(row.status, 'failed');
    assert.equal(row.error?.code, 'await_timed_out');
    assert.match(String(row.error?.message), /'sophie@example.com'/);
    // The step began when the await was opened, not when the deadline fired.
    assert.equal(row.startedAt?.getTime(), createdAt.getTime());
  });

  it('records NO cause when a timer ticks — the step did exactly its job', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'w',
      steps: [{ id: 'w', kind: 'timer', timer: { duration: 'PT1H' }, fallbackTransitionId: 't' }],
      transitions: [{ id: 't', source: 'w', target: 'w' }],
    };
    const { executor, recorded, awaitRows } = makeHarness(graph);
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });
    assert.equal(awaitRows.length, 1);

    await executor.expireAwait('aw1');
    const row = recorded.find((r) => r.stepId === 'w');
    assert.equal(row?.transitionTaken, 't');
    assert.equal(row?.error ?? null, null);
  });

  it('stamps every drive-loop step with the instant it began, not the instant it ended', async () => {
    const { executor, recorded } = makeHarness(agentStepGraph, {
      agent: () => {
        throw new Error('boom');
      },
    });
    const before = Date.now();
    await executor.startRun({ slug: 'wf', payload: {}, awaitCompletion: true });

    const row = lastFailure(recorded);
    assert.ok(row.startedAt instanceof Date, 'the driver passes the step start');
    assert.ok(row.startedAt.getTime() >= before);
    assert.ok(row.startedAt.getTime() <= Date.now());
  });
});

describe('ConductorRunExecutor — a dry run says why too (#1699)', () => {
  it('reports a throwing agent step as a failed preview instead of throwing out of the route', async () => {
    const { executor } = makeHarness(agentStepGraph, {
      agent: () => {
        throw new Error('Agent \'doesnotexist\' is not active in the orchestrator registry');
      },
    });
    const preview = await executor.previewRun('wf', {});
    assert.equal(preview.status, 'failed');
    assert.ok(preview.status === 'failed');
    assert.equal(preview.error.code, 'effect_threw');
    assert.match(String(preview.error.message), /doesnotexist/);
  });

  it('reports a budget-exhausted rehearsal as failed, not as a clean pass', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'a',
      steps: [{ id: 'a', kind: 'action', actionId: 'noop' }],
      transitions: [{ id: 't-loop', source: 'a', target: 'a' }],
    };
    const { executor } = makeHarness(graph);
    const preview = await executor.previewRun('wf', {});
    assert.equal(preview.status, 'failed');
    assert.equal(preview.status === 'failed' ? preview.error.code : null, 'max_steps_exceeded');
  });

  it('reports a stuck preview with the engine code', async () => {
    const graph: WorkflowGraph = {
      entryStepId: 'a',
      steps: [{ id: 'a', kind: 'agent', agentId: 'fallback', prompt: 'p' }, { id: 'b', kind: 'agent', agentId: 'x', prompt: 'p' }],
      transitions: [{ id: 't', source: 'a', target: 'b', guard: { op: 'eq', path: 'ctx.nope', value: true } }],
    };
    const { executor } = makeHarness(graph);
    const preview = await executor.previewRun('wf', {});
    assert.ok(preview.status === 'failed');
    assert.equal(preview.error.code, 'no_transition_no_fallback');
  });
});
