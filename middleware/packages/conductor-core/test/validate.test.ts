import { describe, it, expect } from 'vitest';
import { validate } from '../src/validate.js';
import type { ValidationCode, WorkflowGraph } from '../src/types.js';

function codes(graph: WorkflowGraph, knownRefs?: Parameters<typeof validate>[1]): ValidationCode[] {
  return validate(graph, knownRefs).errors.map((e) => e.code);
}

describe('validate', () => {
  it('accepts a well-formed graph', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'a1', fallbackTransitionId: 't_fail' },
        { id: 's2', kind: 'action', actionId: 'act.done' },
        { id: 's_fail', kind: 'action', actionId: 'act.fail' },
      ],
      transitions: [
        { id: 't_ok', source: 's1', target: 's2', guard: { op: 'eq', path: 'stepResult.ok', value: true } },
        { id: 't_fail', source: 's1', target: 's_fail' },
      ],
    };
    expect(validate(g)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a bad shape with a single shape error', () => {
    const r = validate({ steps: [], transitions: [] } as unknown as WorkflowGraph);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['shape']);
  });

  it('names an unreachable step', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'a1' },
        { id: 's2', kind: 'action', actionId: 'x' },
        { id: 'orphan', kind: 'action', actionId: 'y' },
      ],
      transitions: [{ id: 't1', source: 's1', target: 's2' }],
    };
    const r = validate(g);
    expect(r.ok).toBe(false);
    const err = r.errors.find((e) => e.code === 'unreachable_step');
    expect(err?.nodeIds).toEqual(['orphan']);
  });

  it('detects an unguarded cycle', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'a1' }, { id: 's2', kind: 'agent', agentId: 'a2' }],
      transitions: [
        { id: 'tA', source: 's1', target: 's2' },
        { id: 'tB', source: 's2', target: 's1' },
      ],
    };
    expect(codes(g)).toContain('unguarded_cycle');
  });

  it('allows a guarded cycle (guard can break out)', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'a1' }, { id: 's2', kind: 'agent', agentId: 'a2' }],
      transitions: [
        { id: 'tA', source: 's1', target: 's2' },
        { id: 'tB', source: 's2', target: 's1', guard: { op: 'eq', path: 'stepResult.retry', value: true } },
      ],
    };
    expect(codes(g)).not.toContain('unguarded_cycle');
  });

  it('rejects a deadline-bearing human step without a fallback', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'human', human: { principal: { kind: 'role', ref: 'r' }, channel: 'teams', message: 'm', deadline: 'PT1H' } },
        { id: 's2', kind: 'action', actionId: 'x' },
      ],
      transitions: [{ id: 't1', source: 's1', target: 's2', guard: { op: 'always' } }],
    };
    expect(codes(g)).toContain('deadline_without_fallback');
  });

  it('flags a fallback that does not originate from its step', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [
        { id: 's1', kind: 'agent', agentId: 'a1', fallbackTransitionId: 't2' },
        { id: 's2', kind: 'action', actionId: 'x' },
      ],
      transitions: [
        { id: 't1', source: 's1', target: 's2' },
        { id: 't2', source: 's2', target: 's1' },
      ],
    };
    expect(codes(g)).toContain('fallback_wrong_source');
  });

  it('checks known references when supplied', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'ghost' }],
      transitions: [],
    };
    expect(codes(g, { agentIds: ['real'] })).toContain('unknown_agent_ref');
    expect(codes(g, { agentIds: ['ghost'] })).not.toContain('unknown_agent_ref');
  });

  it('rejects an event trigger with an unknown event id', () => {
    const g: WorkflowGraph = {
      entryStepId: 's1',
      steps: [{ id: 's1', kind: 'agent', agentId: 'a1' }],
      transitions: [],
      triggers: [{ id: 'tr1', kind: 'event', eventId: 'x.y' }],
    };
    expect(codes(g, { eventIds: ['a.b'] })).toContain('unknown_event_ref');
  });
});
