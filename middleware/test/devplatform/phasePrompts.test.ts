import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEV_JOB_PHASES, type DevJobPhase } from '../../src/devplatform/types.js';
import {
  ADVERSARIAL_REVIEW_DIRECTIVE,
  AGENT_SESSION_PHASES,
  buildPhaseSpec,
  phaseSystemPrompt,
  UNTRUSTED_BRIEF_NOTE,
  type ReviewInputs,
} from '../../src/devplatform/pipeline/phasePrompts.js';
import type { ReviewFinding } from '../../src/devplatform/pipeline/reviewLoop.js';

/** Phases whose prompt includes the brief (spec §4 phase-spec table). */
const BRIEF_BEARING_PHASES: DevJobPhase[] = ['analyze', 'plan', 'clarify', 'implement'];

describe('devplatform/phasePrompts — phaseSystemPrompt', () => {
  it('returns a non-empty prompt for every DevJobPhase', () => {
    for (const phase of DEV_JOB_PHASES) {
      const prompt = phaseSystemPrompt(phase);
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.trim().length > 0, `phase ${phase} has an empty prompt`);
    }
  });

  it('names the phase it is for in each prompt', () => {
    for (const phase of DEV_JOB_PHASES) {
      const prompt = phaseSystemPrompt(phase).toLowerCase();
      // Each prompt references its own phase name (await_human as "await_human").
      assert.ok(prompt.includes(phase.toLowerCase()), `phase ${phase} prompt does not name itself`);
    }
  });

  it('contains no XML tags in any prompt (codebase forbids them)', () => {
    // Reject an opening tag like <foo ...> or </foo>. The JSON shapes use braces,
    // and the em-dash/comparisons never form `<word`.
    const xmlish = /<\/?[a-zA-Z][\w-]*(\s|>|\/)/;
    for (const phase of DEV_JOB_PHASES) {
      assert.ok(!xmlish.test(phaseSystemPrompt(phase)), `phase ${phase} prompt contains an XML-ish tag`);
    }
  });

  it('marks the brief UNTRUSTED in every prompt that includes the brief', () => {
    for (const phase of BRIEF_BEARING_PHASES) {
      assert.ok(
        phaseSystemPrompt(phase).includes('UNTRUSTED'),
        `brief-bearing phase ${phase} does not mark the brief untrusted`,
      );
    }
    // The shared note itself carries the marker word.
    assert.ok(UNTRUSTED_BRIEF_NOTE.includes('UNTRUSTED'));
  });

  it('does not inject the brief-untrusted note into the review prompt (review gets no brief)', () => {
    // Review reads plan + diff only (spec §6), so it must not carry the brief note.
    assert.ok(!phaseSystemPrompt('review').includes(UNTRUSTED_BRIEF_NOTE));
  });
});

describe('devplatform/phasePrompts — the adversarial review prompt (spec §6)', () => {
  const review = phaseSystemPrompt('review');

  it('contains the verbatim adversarial sentence', () => {
    assert.ok(review.includes(ADVERSARIAL_REVIEW_DIRECTIVE));
    assert.ok(
      ADVERSARIAL_REVIEW_DIRECTIVE.startsWith('You did not write this diff.'),
      'the exported directive is not the spec §6 sentence',
    );
  });

  it('flags CI/workflow files, dependency manifests, and credentials handling', () => {
    assert.ok(review.includes('CI/workflow files'), 'review prompt omits CI/workflow files');
    assert.ok(review.includes('dependency manifests'), 'review prompt omits dependency manifests');
    assert.ok(review.includes('credentials handling'), 'review prompt omits credentials handling');
  });

  it('demands the review_verdict schema', () => {
    assert.ok(review.includes('review_verdict'));
    assert.ok(review.includes('request_changes'));
    assert.ok(review.includes('blocker'));
  });
});

describe('devplatform/phasePrompts — the analyze prompt artifact contract (spec §4)', () => {
  const analyze = phaseSystemPrompt('analyze');
  it('names every analysis field', () => {
    for (const field of ['affectedAreas', 'reproduction', 'constraints', 'buildCommand', 'testCommand', 'projectType']) {
      assert.ok(analyze.includes(field), `analyze prompt omits ${field}`);
    }
  });
});

describe('devplatform/phasePrompts — buildPhaseSpec', () => {
  it('analyze spec includes the brief', () => {
    const spec = buildPhaseSpec({ phase: 'analyze', brief: 'BRIEF-XYZ' });
    assert.equal(spec.phase, 'analyze');
    assert.equal(spec.systemPrompt, phaseSystemPrompt('analyze'));
    assert.equal(spec.inputs.brief, 'BRIEF-XYZ');
  });

  it('implement spec on a retry includes the plan, answers, attempt number, and prior findings', () => {
    const priorFindings: ReviewFinding[] = [
      { severity: 'blocker', file: 'src/a.ts', issue: 'null deref', suggestion: 'guard it' },
    ];
    const spec = buildPhaseSpec({
      phase: 'implement',
      brief: 'BRIEF',
      plan: 'PLAN-123',
      attempt: 2,
      answers: [{ questionId: 'q1', text: 'use option A' }],
      priorFindings,
    });
    assert.equal(spec.phase, 'implement');
    if (spec.phase !== 'implement') throw new Error('narrowing');
    assert.equal(spec.inputs.plan, 'PLAN-123');
    assert.equal(spec.inputs.attempt, 2);
    assert.deepEqual(spec.inputs.answers, [{ questionId: 'q1', text: 'use option A' }]);
    assert.deepEqual(spec.inputs.priorFindings, priorFindings);
  });

  it('implement spec on the first attempt defaults answers and prior findings to empty', () => {
    const spec = buildPhaseSpec({ phase: 'implement', brief: 'BRIEF', plan: 'PLAN', attempt: 0 });
    if (spec.phase !== 'implement') throw new Error('narrowing');
    assert.equal(spec.inputs.attempt, 0);
    assert.deepEqual(spec.inputs.answers, []);
    assert.deepEqual(spec.inputs.priorFindings, []);
  });

  it('plan and clarify specs carry their upstream artifacts', () => {
    const plan = buildPhaseSpec({ phase: 'plan', brief: 'B', analysis: 'A-1' });
    if (plan.phase !== 'plan') throw new Error('narrowing');
    assert.equal(plan.inputs.analysis, 'A-1');

    const clarify = buildPhaseSpec({ phase: 'clarify', brief: 'B', analysis: 'A-1', plan: 'P-1' });
    if (clarify.phase !== 'clarify') throw new Error('narrowing');
    assert.equal(clarify.inputs.analysis, 'A-1');
    assert.equal(clarify.inputs.plan, 'P-1');
  });

  it('review spec carries the plan and diff but NOT the brief (spec §6)', () => {
    const opts: ReviewInputs & { phase: 'review' } = {
      phase: 'review',
      plan: 'PLAN',
      diff: 'DIFF',
      diffstat: '1 file changed',
      commits: ['abc123'],
    };
    const spec = buildPhaseSpec(opts);
    if (spec.phase !== 'review') throw new Error('narrowing');
    assert.equal(spec.inputs.plan, 'PLAN');
    assert.equal(spec.inputs.diff, 'DIFF');
    assert.ok(!('brief' in spec.inputs), 'review inputs must not carry the brief');
  });

  it('is pure — same inputs produce a deeply-equal output', () => {
    const mk = () =>
      buildPhaseSpec({
        phase: 'implement',
        brief: 'BRIEF',
        plan: 'PLAN',
        attempt: 1,
        answers: [{ questionId: 'q1', text: 'x' }],
        priorFindings: [{ severity: 'major', file: 'f.ts', issue: 'i' }],
      });
    assert.deepEqual(mk(), mk());
  });

  it('every agent-session phase is buildable', () => {
    for (const phase of AGENT_SESSION_PHASES) {
      assert.ok(phaseSystemPrompt(phase).length > 0, `${phase} has no prompt`);
    }
  });
});
