import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ensureWellFormedParams } from '@omadia/orchestrator/dist/privacyHandle.js';

// ---------------------------------------------------------------------------
// Outbound surrogate hardening — `ensureWellFormedParams`.
//
// A lone UTF-16 surrogate is legal in a JS string but not in JSON; the
// Anthropic SDK serialises the request body and the API rejects it with
// `400 invalid_request_error: invalid high surrogate in string`. This
// guard repairs the payload as a last resort before the API call —
// detector-driven span replacement can split a surrogate pair, and
// corrupt upstream tool-result data can carry one in directly.
// ---------------------------------------------------------------------------

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('ensureWellFormedParams', () => {
  it('replaces a lone high surrogate nested in a tool_result block', () => {
    const params = {
      model: 'claude',
      max_tokens: 1024,
      system: 'system prompt',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Erlöse 2025\uD83Dabgeschnitten', // lone high surrogate
            },
          ],
        },
      ],
    };
    const safe = ensureWellFormedParams(params);
    // The whole payload now serialises without throwing.
    assert.doesNotThrow(() => JSON.stringify(safe));
    const fixed = safe.messages[0]!.content[0]!.content;
    assert.doesNotMatch(fixed, LONE_SURROGATE);
    assert.equal(fixed, 'Erlöse 2025�abgeschnitten');
  });

  it('repairs a split surrogate pair across separate messages', () => {
    // 😀 is U+D83D U+DE00. A bad slice can leave the high half at the end
    // of one string and the low half at the start of another.
    const params = {
      messages: [
        { role: 'assistant', content: 'pre\uD83D' }, // dangling high
        { role: 'user', content: '\uDE00post' }, // dangling low
      ],
    };
    const safe = ensureWellFormedParams(params);
    assert.equal(safe.messages[0]!.content, 'pre�');
    assert.equal(safe.messages[1]!.content, '�post');
  });

  it('returns the input untouched when every string is well-formed', () => {
    const params = {
      system: 'plain ASCII',
      messages: [
        { role: 'user', content: 'Erlöse, Müller, 😀 emoji, 日本語' },
      ],
    };
    // No lone surrogates → same reference back, zero allocation.
    assert.equal(ensureWellFormedParams(params), params);
  });

  it('preserves a valid (paired) astral character', () => {
    const params = { messages: [{ role: 'user', content: '😀 ok' }] };
    const safe = ensureWellFormedParams(params);
    assert.equal(safe.messages[0]!.content, '😀 ok');
    assert.doesNotMatch(safe.messages[0]!.content, LONE_SURROGATE);
  });
});
