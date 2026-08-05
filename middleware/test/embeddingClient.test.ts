import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  cosineSimilarity,
  resolveOllamaDimensions,
} from '@omadia/embeddings';

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

describe('resolveOllamaDimensions (#440)', () => {
  it('derives the width from a known model', () => {
    assert.deepEqual(resolveOllamaDimensions('nomic-embed-text', undefined), {
      kind: 'resolved',
      dimensions: 768,
    });
    assert.deepEqual(resolveOllamaDimensions('mxbai-embed-large', undefined), {
      kind: 'resolved',
      dimensions: 1024,
    });
  });

  it('ignores an Ollama tag when looking the model up', () => {
    assert.deepEqual(resolveOllamaDimensions('nomic-embed-text:v1.5', undefined), {
      kind: 'resolved',
      dimensions: 768,
    });
  });

  it('needs the operator for an unknown model rather than guessing 768', () => {
    assert.deepEqual(resolveOllamaDimensions('some-private-model', undefined), {
      kind: 'unknown',
    });
    assert.deepEqual(resolveOllamaDimensions('some-private-model', 512), {
      kind: 'resolved',
      dimensions: 512,
    });
  });

  it('refuses a configured width that contradicts the model', () => {
    assert.deepEqual(resolveOllamaDimensions('mxbai-embed-large', 768), {
      kind: 'conflict',
      configured: 768,
      known: 1024,
    });
  });
});
