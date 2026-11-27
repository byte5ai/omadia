/** #1769 — joining a turn's renders into the one answer the kernel takes. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { joinRenderedAnswers } from '@omadia/plugin-privacy-guard/dist/v4/renderedAnswers.js';

describe('joinRenderedAnswers', () => {
  it('returns undefined for no render and the render itself for one', () => {
    assert.equal(joinRenderedAnswers([]), undefined);
    const one = { text: 'a', maskedValues: ['x'], prose: '' };
    assert.equal(joinRenderedAnswers([one]), one);
  });

  it('joins text and prose in call order and unions masked values', () => {
    const joined = joinRenderedAnswers([
      { text: 'P1\n\n| a |', maskedValues: ['Anna', 'Bob'], prose: 'P1' },
      { text: '| b |', maskedValues: ['Bob', 'Cleo'], prose: '' },
      { text: 'P3\n\n| c |', maskedValues: [], prose: 'P3' },
    ]);
    assert.deepEqual(joined, {
      text: 'P1\n\n| a |\n\n| b |\n\nP3\n\n| c |',
      maskedValues: ['Anna', 'Bob', 'Cleo'],
      prose: 'P1\n\nP3',
    });
  });

  it('is an error only when every render is one', () => {
    const err = { text: 'Error: x', maskedValues: [], prose: '', isError: true };
    const ok = { text: 'ok', maskedValues: [], prose: '' };
    assert.equal(joinRenderedAnswers([err, ok])?.isError, undefined);
    assert.equal(joinRenderedAnswers([err, err])?.isError, true);
  });

  it('drops prose when one render predates the field, so the kernel fails closed', () => {
    const joined = joinRenderedAnswers([
      { text: 'a', maskedValues: [], prose: 'P' },
      { text: 'b', maskedValues: [] },
    ]);
    assert.ok(joined);
    assert.equal('prose' in joined, false);
  });
});
