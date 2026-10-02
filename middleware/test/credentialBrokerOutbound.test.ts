/**
 * #778 S3a — `brokerOutbound.ts` in isolation: the two caller-header rules
 * the allow-list alone does not cover. The reserved-injectionKey drop only
 * matters when an operator declares an allow-listed name (`User-Agent`) as
 * the credential's header; the value check keeps anything undici would
 * refuse locally — after the `once` grant is gone — off the request.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildOutboundRequest, filterCallerHeaders } from '../src/credentials/brokerOutbound.js';

const SECRET = 'sk-live-abcdefgh';

describe('#778 S3a brokerOutbound', () => {
  it('drops an allow-listed caller header that collides with the injectionKey, case-insensitively', () => {
    const filtered = filterCallerHeaders({ 'user-agent': 'forged', Accept: 'application/json' }, 'User-Agent');
    assert.deepEqual(filtered.headers, { accept: 'application/json' });
    assert.deepEqual(filtered.droppedHeaderNames, ['user-agent']);
  });

  it('buildOutboundRequest with an allow-listed injectionKey carries exactly one value, the secret', () => {
    const out = buildOutboundRequest('api.example.com', '/v1/x', '', 'header', 'User-Agent', SECRET, {
      'USER-AGENT': 'forged',
      'user-agent': 'forged-too',
    });
    const entries = Object.entries(out.headers).filter(([name]) => name.toLowerCase() === 'user-agent');
    assert.deepEqual(entries, [['User-Agent', SECRET]]);
    assert.deepEqual(out.droppedHeaderNames, ['user-agent']);
  });

  const REFUSED: Array<[string, string]> = [
    ['CR', 'a\rb'],
    ['LF', 'a\nb'],
    ['NUL', 'a\0b'],
    ['C0 control', 'a\u0001b'],
    ['DEL', 'a\u007fb'],
    ['non-Latin-1 (emoji)', 'bot \u{1F916}'],
    ['non-Latin-1 (U+0100)', 'aĀb'],
  ];

  for (const [label, value] of REFUSED) {
    it(`drops a header whose value undici would refuse (${label}) and audits only its name`, () => {
      const filtered = filterCallerHeaders({ Accept: value, 'Content-Type': 'application/json' }, undefined);
      assert.deepEqual(filtered.headers, { 'content-type': 'application/json' });
      assert.deepEqual(filtered.droppedHeaderNames, ['accept']);
      assert.ok(!JSON.stringify(filtered.droppedHeaderNames).includes(value));
    });
  }

  it('keeps a value with an inner tab or a Latin-1 character — both valid on the wire', () => {
    const filtered = filterCallerHeaders({ 'Idempotency-Key': 'a\tb', 'Content-Language': 'café' }, undefined);
    assert.deepEqual(filtered.headers, { 'idempotency-key': 'a\tb', 'content-language': 'café' });
    assert.deepEqual(filtered.droppedHeaderNames, []);
  });

  it('drops a non-string value (an LLM-built header object is untyped at runtime)', () => {
    const filtered = filterCallerHeaders({ Accept: 42 as unknown as string }, undefined);
    assert.deepEqual(filtered.headers, {});
    assert.deepEqual(filtered.droppedHeaderNames, ['accept']);
  });
});
