import { describe, it, expect } from 'vitest';
import { nextStep } from '../src/engine.js';
import type { JsonObject, WorkflowGraph } from '../src/types.js';

// Three-step workflow: s1 (postcondition + two outgoing) -> s2 | fallback s_fail; s2 terminal.
const graph: WorkflowGraph = {
  entryStepId: 's1',
  steps: [
    {
      id: 's1',
      kind: 'agent',
      agentId: 'a1',
      postcondition: { op: 'exists', path: 'stepResult.notes' },
      fallbackTransitionId: 't_fail',
    },
    { id: 's2', kind: 'action', actionId: 'act.done' },
    { id: 's_fail', kind: 'action', actionId: 'act.fail' },
  ],
  transitions: [
    { id: 't_ok', source: 's1', target: 's2', guard: { op: 'eq', path: 'stepResult.ok', value: true } },
    { id: 't_fail', source: 's1', target: 's_fail' },
  ],
};

const noCtx: JsonObject = {};

describe('nextStep — US1 acceptance', () => {
  it('1. satisfied postcondition + exactly one matching guard advances to its target', () => {
    const d = nextStep(graph, 's1', { notes: 'x', ok: true }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't_ok', targetStepId: 's2', reason: 'guard_matched', postcondition: 'met' });
  });

  it('2a. unmet postcondition does NOT take happy path; takes declared fallback', () => {
    const d = nextStep(graph, 's1', { ok: true }, noCtx); // no notes → postcondition unmet
    expect(d).toEqual({ kind: 'advance', transitionId: 't_fail', targetStepId: 's_fail', reason: 'postcondition_unmet_fallback', postcondition: 'unmet' });
  });

  it('2b. unmet postcondition with no fallback is a precise stuck', () => {
    const g2: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'a1', postcondition: { op: 'exists', path: 'stepResult.notes' } }],
      transitions: [],
    };
    const d = nextStep(g2, 's1', {}, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') expect(d.code).toBe('postcondition_unmet_no_fallback');
  });

  it('met postcondition but no happy guard matched → fallback fires', () => {
    const d = nextStep(graph, 's1', { notes: 'x', ok: false }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't_fail', targetStepId: 's_fail', reason: 'no_transition_matched_fallback', postcondition: 'met' });
  });

  it('terminal step (no outgoing) completes the run', () => {
    const d = nextStep(graph, 's2', { anything: 1 }, noCtx);
    expect(d).toEqual({ kind: 'complete', postcondition: 'n/a' });
  });

  it('ambiguous guards → deterministic stuck naming the transitions', () => {
    const g3: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'a1' }, { id: 'a', kind: 'action', actionId: 'x' }, { id: 'b', kind: 'action', actionId: 'y' }],
      transitions: [
        { id: 't_a', source: 's1', target: 'a', guard: { op: 'always' } },
        { id: 't_b', source: 's1', target: 'b', guard: { op: 'always' } },
      ],
    };
    const d = nextStep(g3, 's1', {}, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') {
      expect(d.code).toBe('ambiguous_guards');
      expect(d.nodeIds).toEqual(['t_a', 't_b']);
    }
  });

  it('unknown step id → stuck', () => {
    const d = nextStep(graph, 'nope', {}, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') expect(d.code).toBe('unknown_step');
  });

  it('4. determinism — identical inputs yield identical decisions', () => {
    const result = { notes: 'x', ok: true };
    const a = nextStep(graph, 's1', result, noCtx);
    const b = nextStep(graph, 's1', result, noCtx);
    expect(a).toEqual(b);
  });
});
