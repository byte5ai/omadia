/**
 * #2317 (ADR-0278) — the conversation's data block (a chat's routine
 * deliveries) is masked like a caller hint, but a block that cannot be masked
 * is left out of the turn instead of failing it.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { wireConversationContextHint } from '../packages/harness-orchestrator/src/orchestrator.js';

type Handle = Parameters<typeof wireConversationContextHint>[0];

const handle = (outcome: 'masked' | 'blocked' | 'throws'): Handle =>
  ({
    maskUserPrompt: (text: string) => {
      if (outcome === 'throws') return Promise.reject(new Error('privacy service down'));
      return Promise.resolve(
        outcome === 'masked'
          ? { outcome: 'masked', maskedText: text.replace('Alice', '«PERSON_1»') }
          : { outcome: 'blocked', reason: 'residual-leak' },
      );
    },
  }) as unknown as Handle;

describe('wireConversationContextHint (#2317)', () => {
  it('masks the block through the turn', async () => {
    assert.equal(await wireConversationContextHint(handle('masked'), 'report for Alice'), 'report for «PERSON_1»');
  });

  it('drops a block whose masking is blocked, and one whose masking throws — the turn goes on', async () => {
    assert.equal(await wireConversationContextHint(handle('blocked'), 'report for Alice'), undefined);
    assert.equal(await wireConversationContextHint(handle('throws'), 'report for Alice'), undefined);
  });

  it('passes the block through unprotected turns and ignores an empty one', async () => {
    assert.equal(await wireConversationContextHint(undefined, 'report'), 'report');
    assert.equal(await wireConversationContextHint(handle('masked'), '   '), undefined);
  });
});
