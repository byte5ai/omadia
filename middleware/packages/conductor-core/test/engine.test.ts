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

// #1698 — a rejected human approval must not leave the step on an edge that never asked
// about the answer. These assert the TRANSITION, which is where the bug lived: the approval
// flag was always computed correctly and then ignored by the path decision.
describe('nextStep — #1698 rejected human step', () => {
  const humanGraph = (
    transitions: WorkflowGraph['transitions'],
    fallbackTransitionId?: string,
  ): WorkflowGraph => ({
    entryStepId: 'h1',
    steps: [
      {
        id: 'h1',
        kind: 'human',
        human: { principal: { kind: 'role', ref: 'approvers' }, channel: 'teams', message: 'ok?' },
        ...(fallbackTransitionId !== undefined ? { fallbackTransitionId } : {}),
      },
      { id: 'act', kind: 'action', actionId: 'webhook.post' },
      { id: 'nope', kind: 'action', actionId: 'act.rejected' },
    ],
    transitions,
  });

  const unguarded = humanGraph([{ id: 't2', source: 'h1', target: 'act' }]);

  it('does NOT take the unguarded transition on {approved:false} — the whole bug', () => {
    const d = nextStep(unguarded, 'h1', { approved: false }, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') {
      expect(d.code).toBe('approval_rejected_no_transition');
      expect(d.nodeIds).toEqual(['h1', 't2']);
    }
  });

  it('still takes the unguarded transition on an approval', () => {
    const d = nextStep(unguarded, 'h1', { approved: true }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't2', targetStepId: 'act', reason: 'guard_matched', postcondition: 'n/a' });
  });

  it('an absent `approved` is not a rejection — fail-open graphs keep their path', () => {
    const d = nextStep(unguarded, 'h1', { comment: 'looks fine' }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't2', targetStepId: 'act', reason: 'guard_matched', postcondition: 'n/a' });
  });

  it('a guard that asks for the rejection fires', () => {
    const g = humanGraph([
      { id: 't-ok', source: 'h1', target: 'act', guard: { op: 'eq', path: 'stepResult.approved', value: true } },
      { id: 't-no', source: 'h1', target: 'nope', guard: { op: 'eq', path: 'stepResult.approved', value: false } },
    ]);
    const d = nextStep(g, 'h1', { approved: false }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't-no', targetStepId: 'nope', reason: 'guard_matched', postcondition: 'n/a' });
  });

  // The deadline fallback is an unguarded edge too, and firing it on a rejection reports an
  // explicit "no" as a missed deadline (expense-approval's escalation step would tell the
  // operator the request "was not decided within 48 hours").
  it('an UNGUARDED fallback is not taken on a rejection either', () => {
    const g = humanGraph(
      [
        { id: 't2', source: 'h1', target: 'act' },
        { id: 't-fb', source: 'h1', target: 'nope' },
      ],
      't-fb',
    );
    const d = nextStep(g, 'h1', { approved: false }, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') expect(d.code).toBe('approval_rejected_no_transition');
  });

  it('a fallback whose guard asks for the rejection IS taken', () => {
    const g = humanGraph(
      [
        { id: 't2', source: 'h1', target: 'act' },
        { id: 't-fb', source: 'h1', target: 'nope', guard: { op: 'eq', path: 'stepResult.approved', value: false } },
      ],
      't-fb',
    );
    const d = nextStep(g, 'h1', { approved: false }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't-fb', targetStepId: 'nope', reason: 'no_transition_matched_fallback', postcondition: 'n/a' });
  });

  it('a timeout fallback is untouched for every answer that is not a rejection', () => {
    const g = humanGraph(
      [
        { id: 't-ok', source: 'h1', target: 'act', guard: { op: 'eq', path: 'stepResult.approved', value: true } },
        { id: 't-fb', source: 'h1', target: 'nope' },
      ],
      't-fb',
    );
    const d = nextStep(g, 'h1', { comment: 'no flag at all' }, noCtx);
    expect(d).toEqual({ kind: 'advance', transitionId: 't-fb', targetStepId: 'nope', reason: 'no_transition_matched_fallback', postcondition: 'n/a' });
  });

  it('an unmet postcondition does not route a rejection through the unguarded fallback', () => {
    const g: WorkflowGraph = {
      entryStepId: 'h1',
      steps: [
        {
          id: 'h1',
          kind: 'human',
          human: { principal: { kind: 'role', ref: 'approvers' }, channel: 'teams', message: 'ok?' },
          postcondition: { op: 'exists', path: 'stepResult.note' },
          fallbackTransitionId: 't-fb',
        },
        { id: 'act', kind: 'action', actionId: 'webhook.post' },
      ],
      transitions: [{ id: 't-fb', source: 'h1', target: 'act' }],
    };
    const d = nextStep(g, 'h1', { approved: false }, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') {
      expect(d.code).toBe('approval_rejected_no_transition');
      expect(d.postcondition).toBe('unmet');
    }
  });

  // A terminal human step gates nothing, but ending the run `complete` makes a refusal
  // indistinguishable from an approval in the run list and in every run-ended webhook.
  it('a rejected TERMINAL human step is reported, not completed', () => {
    const d = nextStep(humanGraph([]), 'h1', { approved: false }, noCtx);
    expect(d.kind).toBe('stuck');
    if (d.kind === 'stuck') {
      expect(d.code).toBe('approval_rejected_no_transition');
      expect(d.message).toContain('no outgoing transition at all');
      expect(d.nodeIds).toEqual(['h1']);
    }
  });

  it('an APPROVED terminal human step still completes', () => {
    const d = nextStep(humanGraph([]), 'h1', { approved: true }, noCtx);
    expect(d).toEqual({ kind: 'complete', postcondition: 'n/a' });
  });

  it('only human steps are affected — an agent step reporting approved:false still advances', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'a1' }, { id: 'act', kind: 'action', actionId: 'x' }],
      transitions: [{ id: 't1', source: 's1', target: 'act' }],
    };
    const d = nextStep(g, 's1', { approved: false }, noCtx);
    expect(d.kind).toBe('advance');
  });
});
