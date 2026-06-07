import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { LoopGuard, canonicalize } from '@omadia/orchestrator';

/** Build a one-tool batch + its result, the common shape both loops feed. */
function batch(name: string, input: unknown, output: string) {
  return {
    uses: [{ name, input }],
    results: [{ content: output }],
  };
}

describe('LoopGuard', () => {
  it('returns continue for an empty tool batch', () => {
    const g = new LoopGuard();
    assert.equal(g.record([], []).action, 'continue');
  });

  it('never trips when arguments differ each call (paginated lookup)', () => {
    const g = new LoopGuard({ softRepeat: 3, hardRepeat: 5 });
    for (let page = 0; page < 20; page++) {
      const b = batch('odoo_search', { page }, `rows for page ${page}`);
      assert.equal(
        g.record(b.uses, b.results).action,
        'continue',
        `page ${page} must not trip the guard`,
      );
    }
  });

  it('never trips when identical args yield DIFFERENT results (progress)', () => {
    const g = new LoopGuard({ softRepeat: 3, hardRepeat: 5 });
    for (let i = 0; i < 10; i++) {
      // same args, but the result advances every call → real progress
      const b = batch('poll_job', { id: 'j1' }, `status tick ${i}`);
      assert.equal(g.record(b.uses, b.results).action, 'continue');
    }
  });

  it('nudges at the soft threshold, once, then stops at the hard threshold', () => {
    const g = new LoopGuard({ softRepeat: 3, hardRepeat: 5 });
    const b = () => batch('get_price', { sku: 'A' }, 'identical result');

    // calls 1,2 → continue
    assert.equal(g.record(b().uses, b().results).action, 'continue');
    assert.equal(g.record(b().uses, b().results).action, 'continue');
    // call 3 → nudge (soft), carries a steer text
    const soft = g.record(b().uses, b().results);
    assert.equal(soft.action, 'nudge');
    assert.equal(soft.repeats, 3);
    assert.ok(soft.nudge && soft.nudge.includes('get_price'));
    // call 4 → already nudged for this signature → continue (no spam)
    assert.equal(g.record(b().uses, b().results).action, 'continue');
    // call 5 → hard cap → stop
    const hard = g.record(b().uses, b().results);
    assert.equal(hard.action, 'stop');
    assert.equal(hard.repeats, 5);
  });

  it('treats a repeated multi-tool batch order-independently', () => {
    const g = new LoopGuard({ softRepeat: 2, hardRepeat: 3 });
    const forward = {
      uses: [
        { name: 'a', input: { x: 1 } },
        { name: 'b', input: { y: 2 } },
      ],
      results: [{ content: 'ra' }, { content: 'rb' }],
    };
    const reversed = {
      uses: [
        { name: 'b', input: { y: 2 } },
        { name: 'a', input: { x: 1 } },
      ],
      results: [{ content: 'rb' }, { content: 'ra' }],
    };
    // first sighting → continue; reversed-order sighting must hash the same
    assert.equal(g.record(forward.uses, forward.results).action, 'continue');
    assert.equal(g.record(reversed.uses, reversed.results).action, 'nudge');
  });

  it('canonicalize is key-order independent for objects', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
    // arrays keep order (semantically meaningful)
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });

  it('clamps invalid thresholds (hard always above soft)', () => {
    const g = new LoopGuard({ softRepeat: 1, hardRepeat: 1 });
    const b = () => batch('t', {}, 'r');
    // soft clamped to >=2, hard to >soft → first repeat that nudges is call 2
    assert.equal(g.record(b().uses, b().results).action, 'continue');
    assert.equal(g.record(b().uses, b().results).action, 'nudge');
    assert.equal(g.record(b().uses, b().results).action, 'stop');
  });
});
