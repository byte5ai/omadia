/**
 * The claim extractor's two production fixes after the live diagnostic of
 * 2026-10-08 06:21Z (Haiku 4.5, run 3028130c):
 *
 *  1. The first call hit the fixed 1024-token cap (`finish=max_tokens`,
 *     `out=1024`) — an answer with about ten claims did not fit. The budget is
 *     now derived from `maxClaims` (`extractionTokenBudget`).
 *  2. The repair came back with `claims` as a 1391-character string that was
 *     not valid JSON. `record_claims` is now a STRICT tool: the provider
 *     constrains decoding to the schema, so `claims` is always an array. That
 *     needs a strict-clean schema — `additionalProperties: false` on every
 *     object, `anyOf` instead of a type array.
 *
 * Verified against the real API with synthetic text before merge: strict
 * accepted, 5/5 extractions of a ~20-claim answer returned arrays of 18–21
 * entries using 1063–1403 output tokens (each would have hit 1024).
 *
 * Imported from SOURCE so a mutation in `src/` cannot pass over stale `dist/`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmRequest } from '@omadia/llm-provider';

import {
  ClaimExtractor,
  extractionTokenBudget,
} from '../packages/harness-verifier/src/claimExtractor.js';

const INPUT = {
  userMessage: 'Wie hoch ist die Rechnung?',
  answer: 'Die Rechnung INV/2026/0042 beträgt 1.234,56 €.',
};

function recording(opts: { maxClaims?: number; maxTokens?: number } = {}) {
  const requests: LlmRequest[] = [];
  const extractor = new ClaimExtractor({
    llm: {
      id: 'anthropic',
      complete(req: LlmRequest) {
        requests.push(req);
        return Promise.resolve({
          content: [
            {
              type: 'tool_call',
              id: 't',
              name: 'record_claims',
              input: { claims: [{ text: '1.234,56 €', type: 'amount', expected_source: 'odoo' }] },
            },
          ],
          finishReason: 'tool_calls',
          model: 'claude-haiku-4-5-20251001',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    } as never,
    ...opts,
    log: () => undefined,
  });
  return { extractor, requests };
}

/** Every schema node, depth first. */
function nodes(schema: unknown): Record<string, unknown>[] {
  if (schema === null || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const children = [
    ...Object.values((node['properties'] as Record<string, unknown> | undefined) ?? {}),
    node['items'],
    ...((node['anyOf'] as unknown[] | undefined) ?? []),
  ];
  return [node, ...children.flatMap(nodes)];
}

describe('record_claims is a strict tool with a strict-clean schema', () => {
  it('asks the provider for constrained decoding', async () => {
    const { extractor, requests } = recording();
    await extractor.extract(INPUT);
    const tool = requests[0]?.tools?.[0];
    assert.equal(tool?.name, 'record_claims');
    assert.equal(tool?.strict, true);
  });

  it('closes every object and uses no type arrays', async () => {
    const { extractor, requests } = recording();
    await extractor.extract(INPUT);
    const all = nodes(requests[0]?.tools?.[0]?.inputSchema);
    const objects = all.filter((n) => n['type'] === 'object');
    assert.ok(objects.length >= 3, 'top level, claim entry, odoo_record');
    for (const object of objects) {
      assert.equal(object['additionalProperties'], false, JSON.stringify(Object.keys(object)));
    }
    for (const node of all) {
      assert.ok(!Array.isArray(node['type']), `type array in ${JSON.stringify(node)}`);
    }
    // The value union survives as anyOf.
    const claim = (requests[0]?.tools?.[0]?.inputSchema as { properties: { claims: { items: { properties: Record<string, unknown> } } } })
      .properties.claims.items.properties;
    assert.deepEqual((claim['value'] as { anyOf: unknown }).anyOf, [{ type: 'number' }, { type: 'string' }]);
  });
});

describe('the extraction token budget fits the list the prompt asks for', () => {
  it('derives the budget from maxClaims, never below the old 1024', () => {
    assert.equal(extractionTokenBudget(20), 2566);
    assert.equal(extractionTokenBudget(30), 3666);
    assert.equal(extractionTokenBudget(5), 1024);
    assert.equal(extractionTokenBudget(0), 1024);
  });

  it('sends the derived budget by default — 1024 cut real answers off at ~10 claims', async () => {
    const { extractor, requests } = recording();
    await extractor.extract(INPUT);
    assert.equal(requests[0]?.maxTokens, 2566);
  });

  it('follows the configured claim cap, and an explicit budget wins', async () => {
    const small = recording({ maxClaims: 5 });
    await small.extractor.extract(INPUT);
    assert.equal(small.requests[0]?.maxTokens, 1024);
    const explicit = recording({ maxTokens: 3000 });
    await explicit.extractor.extract(INPUT);
    assert.equal(explicit.requests[0]?.maxTokens, 3000);
  });
});
