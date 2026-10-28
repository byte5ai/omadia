/**
 * #1527 — the shared JSON parser for the Haiku helper calls in
 * orchestrator-extras (excerpt extractor, fact extractor, significance
 * scorer, recall judge, inconsistency detector).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseLlmJson } from '@omadia/orchestrator-extras/dist/llmJson.js';

describe('#1527 parseLlmJson', () => {
  it('parses a bare JSON object or array', () => {
    assert.deepEqual(parseLlmJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseLlmJson('  [1,2]\n'), [1, 2]);
  });

  it('parses a fenced reply, with or without a language tag', () => {
    assert.deepEqual(parseLlmJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseLlmJson('```\n[{"s":"x"}]\n```'), [{ s: 'x' }]);
    assert.deepEqual(parseLlmJson('```JSON {"a":1}```'), { a: 1 });
  });

  it('parses a fenced reply with text before and after the fence', () => {
    const reply = 'Here you go:\n```json\n{"kind":"insight"}\n```\nLet me know if that helps.';
    assert.deepEqual(parseLlmJson(reply), { kind: 'insight' });
  });

  it('parses an unfenced object wrapped in prose', () => {
    assert.deepEqual(parseLlmJson('Result: {"score": 0.4} — done.'), { score: 0.4 });
  });

  it('keeps fence-like text inside a JSON string intact', () => {
    assert.deepEqual(parseLlmJson('{"summary":"use ```code``` here"}'), {
      summary: 'use ```code``` here',
    });
  });

  it('keeps a fence inside a JSON string intact when prose surrounds the object', () => {
    assert.deepEqual(parseLlmJson('Here: {"summary":"see ```code``` here"}'), {
      summary: 'see ```code``` here',
    });
  });

  it('parses a fenced reply whose JSON quotes a code block (verbatim excerpt)', () => {
    const reply =
      '```json\n{"summary":"x","excerpts":["```ts\\nconst a = 1\\n```"]}\n```\nDone.';
    assert.deepEqual(parseLlmJson(reply), {
      summary: 'x',
      excerpts: ['```ts\nconst a = 1\n```'],
    });
  });

  it('skips a bracket in the prose before the object', () => {
    assert.deepEqual(parseLlmJson('Ergebnis [kurz]: {"a":1}'), { a: 1 });
  });

  it('keeps an array reply whole instead of narrowing it to its first object', () => {
    assert.deepEqual(parseLlmJson('Facts: [{"s":"a"},{"s":"b"}] — end'), [{ s: 'a' }, { s: 'b' }]);
    assert.deepEqual(parseLlmJson('Facts: [{"s":"a"}]'), [{ s: 'a' }]);
  });

  it('returns undefined for prose, an empty reply, or a cut-off object', () => {
    assert.equal(parseLlmJson('just some prose, no JSON'), undefined);
    assert.equal(parseLlmJson('   '), undefined);
    assert.equal(parseLlmJson('```json\n{\n  "kind": "insight",\n  "summary": "Pauschal'), undefined);
  });
});
