import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { WorkflowGraph } from '@omadia/conductor-core';

import { applyGraphPatches, emptyGraph } from '../src/conductor/graphPatch.js';
import { ConductorBuilderAgent, ConductorBuilderUnavailableError, parseTurnResponse } from '../src/conductor/builderAgent.js';

// Conductor US7 — conversational builder: pure patch algebra + the stateless turn (graph,message)→(graph,reply).

describe('applyGraphPatches', () => {
  it('add_step on an empty graph makes the first step the entry', () => {
    const r = applyGraphPatches(emptyGraph(), [
      { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'hi' } },
    ]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.applied, 1);
    assert.equal(r.graph.entryStepId, 's1');
    assert.equal(r.graph.steps.length, 1);
  });

  it('update_step merges fields but never changes the id', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [],
    };
    // patch tries to also change the id — applyGraphPatches must preserve the original id.
    const r = applyGraphPatches(base, [{ op: 'update_step', id: 's1', patch: { prompt: 'do the thing', id: 'hacked' } }]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.graph.steps[0].id, 's1');
    assert.equal(r.graph.steps[0].prompt, 'do the thing');
  });

  it('remove_step drops the step AND its dangling transitions', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'fallback' },
        { id: 's2', kind: 'agent', agentId: 'fallback' },
      ],
      transitions: [{ id: 't1', source: 's1', target: 's2' }],
      triggers: [],
    };
    const r = applyGraphPatches(base, [{ op: 'remove_step', id: 's2' }]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.graph.steps.length, 1);
    assert.equal(r.graph.transitions.length, 0); // dangling transition removed
  });

  it('reports errors for unknown ids and duplicates, applying the rest', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [],
    };
    const r = applyGraphPatches(base, [
      { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } }, // duplicate
      { op: 'update_step', id: 'ghost', patch: { prompt: 'x' } }, // unknown
      { op: 'remove_transition', id: 'nope' }, // unknown
      { op: 'add_step', step: { id: 's2', kind: 'agent', agentId: 'fallback' } }, // valid
    ]);
    assert.equal(r.applied, 1);
    assert.equal(r.errors.length, 3);
    assert.equal(r.graph.steps.length, 2);
  });

  it('set_trigger replaces (single-trigger parity) and set_entry sets the entry', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [{ id: 'old', kind: 'manual' }],
    };
    const r = applyGraphPatches(base, [
      { op: 'set_trigger', trigger: { id: 'tr', kind: 'event', eventId: 'github.pull_request.merged' } },
      { op: 'set_entry', stepId: 's1' },
    ]);
    assert.equal(r.graph.triggers?.length, 1);
    assert.equal(r.graph.triggers?.[0].id, 'tr');
    assert.equal(r.graph.entryStepId, 's1');
  });

  it('does not mutate the input graph', () => {
    const base = emptyGraph();
    applyGraphPatches(base, [{ op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } }]);
    assert.equal(base.steps.length, 0);
  });

  it('tolerates a malformed input graph (non-array steps/transitions) without throwing', () => {
    const bad = { entryStepId: '', steps: 'nope', transitions: undefined } as unknown as WorkflowGraph;
    const r = applyGraphPatches(bad, [{ op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } }]);
    assert.equal(r.applied, 1);
    assert.equal(r.graph.steps.length, 1);
  });

  it('update_step with a missing patch field records nothing-to-do but never throws', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'keep' }],
      transitions: [],
      triggers: [],
    };
    // LLM emitted update_step with no `patch` key — must not throw (would 500 the whole turn).
    const r = applyGraphPatches(base, [{ op: 'update_step', id: 's1' } as unknown as Parameters<typeof applyGraphPatches>[1][number]]);
    assert.equal(r.errors.length, 0);
    assert.equal(r.graph.steps[0].prompt, 'keep');
  });

  it('update_step never changes a step kind (preserves it; use remove+add to change kind)', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [],
    };
    const r = applyGraphPatches(base, [{ op: 'update_step', id: 's1', patch: { kind: 'human', prompt: 'x' } }]);
    assert.equal(r.graph.steps[0].kind, 'agent');
  });

  it('remove_step clears an orphaned fallbackTransitionId on a surviving step', () => {
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'fallback', fallbackTransitionId: 't2' },
        { id: 's2', kind: 'agent', agentId: 'fallback' },
        { id: 's3', kind: 'agent', agentId: 'fallback' },
      ],
      transitions: [{ id: 't2', source: 's3', target: 's2' }],
      triggers: [],
    };
    const r = applyGraphPatches(base, [{ op: 'remove_step', id: 's2' }]); // drops t2 (targets s2)
    assert.equal(r.graph.transitions.length, 0);
    assert.equal(r.graph.steps.find((s) => s.id === 's1')?.fallbackTransitionId, undefined);
  });
});

describe('parseTurnResponse', () => {
  it('parses a bare JSON object', () => {
    const r = parseTurnResponse('{"reply":"ok","patches":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'ok');
    assert.deepEqual(r.patches, []);
  });

  it('parses JSON wrapped in markdown fences and prose', () => {
    const r = parseTurnResponse('Sure! Here you go:\n```json\n{"reply":"added","patches":[{"op":"set_entry","stepId":"s1"}]}\n```\nDone.');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'added');
    assert.equal(r.patches.length, 1);
  });

  it('handles braces inside JSON strings without breaking balance', () => {
    const r = parseTurnResponse('{"reply":"use {{ctx.base}} here","patches":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'use {{ctx.base}} here');
  });

  it('falls back to ok:false with raw text when there is no JSON', () => {
    const r = parseTurnResponse('I cannot do that.');
    assert.equal(r.ok, false);
    assert.equal(r.reply, 'I cannot do that.');
    assert.deepEqual(r.patches, []);
  });

  it('parses the real object even when brace-bearing prose precedes it', () => {
    // First `{` is invalid JSON ({op:eq}); the scanner must try the next candidate.
    const r = parseTurnResponse('I will set the guard to {op:eq}. Here is the patch: {"reply":"ok","patches":[]}');
    assert.equal(r.ok, true);
    assert.equal(r.reply, 'ok');
  });
});

// ── stub orchestrator registry ──────────────────────────────────────────────

function stubRegistry(responses: string[]): { registry: OrchestratorRegistry; calls: () => number } {
  let i = 0;
  const registry = {
    get: (_slug: string) => ({
      built: {
        bundle: {
          agent: {
            chat: async (_args: { userMessage: string; sessionScope: string }) => {
              const text = responses[Math.min(i, responses.length - 1)];
              i += 1;
              return { text };
            },
          },
        },
      },
    }),
  } as unknown as OrchestratorRegistry;
  return { registry, calls: () => i };
}

describe('ConductorBuilderAgent.runTurn', () => {
  it('applies the agent-proposed patches and validates the result', async () => {
    const { registry } = stubRegistry([
      JSON.stringify({
        reply: 'Added a greeting step.',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback', prompt: 'Say hi' } },
          { op: 'set_trigger', trigger: { id: 'tr', kind: 'manual' } },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ message: 'start with a greeting' });
    assert.equal(res.validation.ok, true);
    assert.equal(res.graph.steps.length, 1);
    assert.equal(res.graph.entryStepId, 's1');
    assert.equal(res.reply, 'Added a greeting step.');
    assert.equal(res.applyErrors.length, 0);
  });

  it('surfaces validation errors (never publishes a broken graph) and still returns the draft', async () => {
    // Always returns a graph whose entry points at a missing step → invalid; both attempts fail.
    const { registry, calls } = stubRegistry([
      JSON.stringify({
        reply: 'here',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } },
          { op: 'set_entry', stepId: 'does-not-exist' },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ message: 'break it' });
    assert.equal(res.validation.ok, false);
    assert.ok(res.validation.errors.some((e) => e.code === 'unknown_entry_step'));
    assert.equal(res.graph.steps.length, 1); // draft still returned for the user to see
    assert.equal(calls(), 2); // retried once on the invalid result
  });

  it('self-corrects: retries once when the first response is unparseable, accepts the valid retry', async () => {
    const { registry, calls } = stubRegistry([
      'sorry, no json here',
      JSON.stringify({
        reply: 'fixed',
        patches: [
          { op: 'add_step', step: { id: 's1', kind: 'agent', agentId: 'fallback' } },
          { op: 'set_trigger', trigger: { id: 'tr', kind: 'manual' } },
        ],
      }),
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ message: 'make a step' });
    assert.equal(calls(), 2);
    assert.equal(res.validation.ok, true);
    assert.equal(res.reply, 'fixed');
    assert.equal(res.graph.steps.length, 1);
  });

  it('throws ConductorBuilderUnavailableError when no registry is present', async () => {
    const agent = new ConductorBuilderAgent({ getRegistry: () => undefined });
    await assert.rejects(() => agent.runTurn({ message: 'hi' }), ConductorBuilderUnavailableError);
  });

  it('keeps the BEST attempt: a parseable-but-invalid result outranks an unparseable retry', async () => {
    // Attempt 0: parseable, but sets entry to a missing step → invalid (still inspectable, score 5).
    // Attempt 1: unparseable junk → no patches → base unchanged & valid (vacuous, score 3).
    // The builder must return attempt 0, not the worse latest attempt.
    const base: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'fallback' }],
      transitions: [],
      triggers: [{ id: 'tr', kind: 'manual' }],
    };
    const { registry, calls } = stubRegistry([
      JSON.stringify({ reply: 'attempt0', patches: [{ op: 'set_entry', stepId: 'ghost' }] }),
      'sorry, no json here',
    ]);
    const agent = new ConductorBuilderAgent({ getRegistry: () => registry });
    const res = await agent.runTurn({ graph: base, message: 'edit it' });
    assert.equal(calls(), 2);
    assert.equal(res.reply, 'attempt0');
    assert.equal(res.validation.ok, false);
    assert.equal(res.graph.entryStepId, 'ghost');
  });
});
