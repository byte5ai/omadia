import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { routeTurnPersona } from '../packages/harness-orchestrator/src/personaRouter.js';

/**
 * Wave 8 — per-turn direct-answer persona router. Twin of modelRouter.test.ts:
 * verifies the candidate → skillId mapping, the zero-candidate short-circuit
 * (cost guard), and the never-throws fallback contract.
 */

const candidates = [
  { skillId: 'sk-sales', slug: 'sales-bot', name: 'Sales', description: 'Handles pricing and quotes' },
  { skillId: 'sk-support', slug: 'support-bot', name: 'Support', description: 'Handles bug reports' },
];

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

describe('routeTurnPersona', () => {
  it('matches a candidate by slug', async () => {
    const r = await routeTurnPersona(
      clientReturning('sales-bot') as never,
      candidates,
      'what does this cost?',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'matched');
    assert.equal(r.skillId, 'sk-sales');
    assert.equal(r.classifierModel, 'claude-haiku-4-5');
  });

  it('matches despite quotes/backticks/trailing punctuation around the slug', async () => {
    const r = await routeTurnPersona(
      clientReturning('`sales-bot`.') as never,
      candidates,
      'what does this cost?',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'matched');
    assert.equal(r.skillId, 'sk-sales');
  });

  it('matches case-insensitively', async () => {
    const r = await routeTurnPersona(
      clientReturning('SUPPORT-BOT') as never,
      candidates,
      'my thing is broken',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'matched');
    assert.equal(r.skillId, 'sk-support');
  });

  it('NONE verdict → default identity, not an error', async () => {
    const r = await routeTurnPersona(
      clientReturning('NONE') as never,
      candidates,
      'hi',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'none');
    assert.equal(r.skillId, null);
  });

  it('a candidate literally slugged "none" is still selectable (no collision with the opt-out sentinel)', async () => {
    const withNoneSlug = [
      ...candidates,
      { skillId: 'sk-none', slug: 'none', name: 'None Bot', description: 'A persona literally named none' },
    ];
    const r = await routeTurnPersona(
      clientReturning('none') as never,
      withNoneSlug,
      'talk to none bot',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'matched');
    assert.equal(r.skillId, 'sk-none');
  });

  it('unrecognised/ambiguous reply → default identity, not an error', async () => {
    const r = await routeTurnPersona(
      clientReturning('uhh not sure') as never,
      candidates,
      'x',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'none');
    assert.equal(r.skillId, null);
  });

  it('zero candidates short-circuits before any classifier call', async () => {
    let called = false;
    const client = {
      complete: () => {
        called = true;
        return Promise.resolve({
          content: [{ type: 'text', text: 'NONE' }],
          finishReason: 'stop',
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    };
    const r = await routeTurnPersona(client as never, [], 'hi', 'claude-haiku-4-5');
    assert.equal(r.bucket, 'none');
    assert.equal(r.skillId, null);
    assert.equal(called, false);
  });

  it('empty message → default identity without calling the classifier', async () => {
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
    const r = await routeTurnPersona(client as never, candidates, '   ', 'claude-haiku-4-5');
    assert.equal(r.bucket, 'none');
    assert.equal(called, false);
  });

  it('classifier error → fallback bucket + default identity, never throws', async () => {
    const r = await routeTurnPersona(
      clientThrowing() as never,
      candidates,
      'x',
      'claude-haiku-4-5',
    );
    assert.equal(r.bucket, 'fallback');
    assert.equal(r.skillId, null);
    assert.equal(r.classifierModel, 'claude-haiku-4-5');
  });
});
