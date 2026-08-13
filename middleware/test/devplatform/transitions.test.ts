import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeTransition,
  isForward,
  phaseOrder,
  type PhaseResult,
  type TransitionContext,
} from '../../src/devplatform/pipeline/transitions.js';

const gated: TransitionContext = { mode: 'gated', kind: 'fix_issue' };
const collapsed: TransitionContext = { mode: 'collapsed', kind: 'implement' };

function ok(phase: PhaseResult['phase'], extra: Partial<PhaseResult> = {}): PhaseResult {
  return { phase, ok: true, ...extra };
}

describe('devplatform/transitions — gated mode, the full §4 table', () => {
  it('analyze → bootstrap', () => {
    assert.deepEqual(computeTransition(ok('analyze'), gated), { kind: 'advance', to: 'bootstrap', sameProvision: true });
  });
  it('bootstrap → plan', () => {
    assert.deepEqual(computeTransition(ok('bootstrap'), gated), { kind: 'advance', to: 'plan', sameProvision: true });
  });
  it('plan → clarify', () => {
    assert.deepEqual(computeTransition(ok('plan'), gated), { kind: 'advance', to: 'clarify', sameProvision: true });
  });
  it('clarify → park (the gate opens, runner exits) — even with zero questions', () => {
    assert.deepEqual(computeTransition(ok('clarify', { hasQuestions: false }), gated), { kind: 'park' });
    assert.deepEqual(computeTransition(ok('clarify', { hasQuestions: true }), gated), { kind: 'park' });
  });
  it('await_human → requeue at implement', () => {
    assert.deepEqual(computeTransition(ok('await_human'), gated), { kind: 'requeue', to: 'implement' });
  });
  it('implement → review', () => {
    assert.deepEqual(computeTransition(ok('implement'), gated), { kind: 'advance', to: 'review', sameProvision: true });
  });
  it('review approve → pr', () => {
    assert.deepEqual(computeTransition(ok('review', { reviewVerdict: 'approve' }), gated), {
      kind: 'advance',
      to: 'pr',
      sameProvision: true,
    });
  });
  it('review request_changes, not exhausted → retry implement', () => {
    assert.deepEqual(
      computeTransition(ok('review', { reviewVerdict: 'request_changes', reviewLoopExhausted: false }), gated),
      { kind: 'retry_implement' },
    );
  });
  it('review request_changes, exhausted → pr (findings annotated)', () => {
    assert.deepEqual(
      computeTransition(ok('review', { reviewVerdict: 'request_changes', reviewLoopExhausted: true }), gated),
      { kind: 'advance', to: 'pr', sameProvision: true },
    );
  });
  it('review with no verdict → fail', () => {
    assert.equal(computeTransition(ok('review'), gated).kind, 'fail');
  });
});

describe('devplatform/transitions — collapsed mode skips the gate', () => {
  it('analyze → implement (no bootstrap/plan/clarify)', () => {
    assert.deepEqual(computeTransition(ok('analyze'), collapsed), { kind: 'advance', to: 'implement', sameProvision: true });
  });
  it('implement → review → pr', () => {
    assert.deepEqual(computeTransition(ok('implement'), collapsed), { kind: 'advance', to: 'review', sameProvision: true });
    assert.deepEqual(computeTransition(ok('review', { reviewVerdict: 'approve' }), collapsed), {
      kind: 'advance',
      to: 'pr',
      sameProvision: true,
    });
  });
});

describe('devplatform/transitions — kind=analyze terminates after analyze', () => {
  it('runs analyze then done, in either mode', () => {
    assert.deepEqual(computeTransition(ok('analyze'), { mode: 'gated', kind: 'analyze' }), { kind: 'done' });
    assert.deepEqual(computeTransition(ok('analyze'), { mode: 'collapsed', kind: 'analyze' }), { kind: 'done' });
  });
  it('fails if an analyze-kind job somehow ran a later phase', () => {
    assert.equal(computeTransition(ok('implement'), { mode: 'gated', kind: 'analyze' }).kind, 'fail');
  });
});

describe('devplatform/transitions — any ok:false is a failure', () => {
  it('every phase fails on a not-ok result', () => {
    for (const phase of phaseOrder('gated')) {
      const t = computeTransition({ phase, ok: false }, gated);
      assert.equal(t.kind, 'fail', `${phase} must fail on ok:false`);
    }
  });
});

describe('devplatform/transitions — isForward guards against replayed/stale results', () => {
  it('a later phase is forward, an earlier or equal one is not', () => {
    assert.equal(isForward('analyze', 'plan', 'gated'), true);
    assert.equal(isForward('plan', 'analyze', 'gated'), false);
    assert.equal(isForward('review', 'review', 'gated'), false);
  });
  it('collapsed order has no bootstrap/plan/clarify', () => {
    assert.deepEqual(phaseOrder('collapsed'), ['analyze', 'implement', 'review', 'pr']);
  });
});
