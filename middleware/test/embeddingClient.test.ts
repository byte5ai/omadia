import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { cosineSimilarity } from '@omadia/embeddings';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });

  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it('returns negative for opposite vectors', () => {
    const r = cosineSimilarity([1, 1], [-1, -1]);
    assert.ok(r < 0 && r >= -1);
  });

  it('returns NaN for mismatched length', () => {
    assert.ok(Number.isNaN(cosineSimilarity([1, 2], [1, 2, 3])));
  });

  it('returns NaN for empty inputs', () => {
    assert.ok(Number.isNaN(cosineSimilarity([], [])));
  });

  it('returns NaN when one vector is all-zero', () => {
    assert.ok(Number.isNaN(cosineSimilarity([0, 0], [1, 1])));
  });
});
