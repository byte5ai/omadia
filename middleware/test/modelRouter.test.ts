import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { routeTurnModel } from '../packages/harness-orchestrator/src/modelRouter.js';

/**
 * Per-turn Haiku-triage router. Verifies the decision → model mapping and the
 * routing metadata the streaming path surfaces inline in the UI.
 */

const cfg = {
  classifierModel: 'claude-haiku-4-5',
  simpleModel: 'claude-sonnet-4-6',
  complexModel: 'claude-opus-4-8',
};

// Minimal structural stub for the neutral LlmProvider — only `.complete()`
// is exercised. `usage` is required: the router records it (no-op without a
// wired recorder pool, as in tests) after every classification call.
function clientReturning(text: string) {
  return {
    complete: () =>
      Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
  };
}
function clientThrowing() {
  return {
    complete: () => Promise.reject(new Error('boom')),
  };
}

describe('routeTurnModel', () => {
  it('SIMPLE verdict → simple bucket + simpleModel', async () => {
    const r = await routeTurnModel(clientReturning('SIMPLE') as never, cfg, 'hi', 'fb');
    assert.equal(r.bucket, 'simple');
    assert.equal(r.model, cfg.simpleModel);
    assert.equal(r.classifierModel, cfg.classifierModel);
  });

  it('COMPLEX verdict → complex bucket + complexModel', async () => {
    const r = await routeTurnModel(
      clientReturning('COMPLEX') as never,
      cfg,
      'plan a migration',
      'fb',
    );
    assert.equal(r.bucket, 'complex');
    assert.equal(r.model, cfg.complexModel);
  });

  it('ambiguous verdict defaults to complex', async () => {
    const r = await routeTurnModel(clientReturning('huh?') as never, cfg, 'x', 'fb');
    assert.equal(r.bucket, 'complex');
    assert.equal(r.model, cfg.complexModel);
  });

  it('empty message → complex without calling the classifier', async () => {
    let called = false;
    const client = {
      complete: () => {
        called = true;
        return Promise.resolve({
          content: [],
          finishReason: 'stop',
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    };
    const r = await routeTurnModel(client as never, cfg, '   ', 'fb');
    assert.equal(r.bucket, 'complex');
    assert.equal(r.model, cfg.complexModel);
    assert.equal(called, false);
  });

  it('classifier error → fallback bucket + fallbackModel', async () => {
    const r = await routeTurnModel(
      clientThrowing() as never,
      cfg,
      'x',
      'claude-fallback',
    );
    assert.equal(r.bucket, 'fallback');
    assert.equal(r.model, 'claude-fallback');
    assert.equal(r.classifierModel, cfg.classifierModel);
  });
});
